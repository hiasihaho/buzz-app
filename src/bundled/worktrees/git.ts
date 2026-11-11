import type { Host } from "../../features/host/service";

type Spawn = NonNullable<Host["spawn"]>;

export class GitUnavailable extends Error {}

export class GitOutputTooLarge extends Error {}

export class GitError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message);
  }
}

const DEADLINE_MS = 20_000;

/** Runs the manifest's Git process in `repoPath`. Git always receives `-C`;
 * cwd is deliberately unused because the host creates a missing cwd. */
export async function runGit(
  spawn: Spawn,
  repoPath: string,
  args: readonly string[],
  signal?: AbortSignal,
  deadlineMs = DEADLINE_MS,
  maxOutputBytes = Number.POSITIVE_INFINITY,
): Promise<string> {
  signal?.throwIfAborted();
  if (!absolutePath(repoPath, nativePathStyle()))
    throw new GitError("Git path must be absolute on this platform", null, "");
  let stdout = "";
  let stdoutBytes = 0;
  let outputTooLarge = false;
  let stderr = "";
  let process: Awaited<ReturnType<Spawn>>;
  try {
    process = await spawn("git", {
      args: ["--no-optional-locks", "-C", repoPath, ...args],
      env: { LC_ALL: "C" },
      onStdout: (data) => {
        if (outputTooLarge) return;
        stdoutBytes += new TextEncoder().encode(data).length;
        if (stdoutBytes > maxOutputBytes) {
          outputTooLarge = true;
          stdout = "";
          void process?.kill();
        } else stdout += data;
      },
      onStderr: (data) => {
        stderr += data;
      },
    });
  } catch (error) {
    throw new GitUnavailable(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (outputTooLarge) void process.kill();
  const timeout = AbortSignal.timeout(deadlineMs);
  const abort = AbortSignal.any(signal ? [signal, timeout] : [timeout]);
  const stop = () => void process.kill();
  abort.addEventListener("abort", stop, { once: true });
  try {
    if (abort.aborted) {
      stop();
      abort.throwIfAborted();
    }
    await process.end().catch(() => undefined);
    const code = await process.exited;
    abort.throwIfAborted();
    if (outputTooLarge)
      throw new GitOutputTooLarge(`Git output exceeds ${maxOutputBytes} bytes`);
    if (code === 0) return stdout;
    const reason = stderr.trim() || `git exited with code ${code ?? "unknown"}`;
    throw new GitError(reason, code, stderr);
  } finally {
    abort.removeEventListener("abort", stop);
  }
}

export async function countUnpublishedCommits(
  spawn: Spawn,
  path: string,
  signal?: AbortSignal,
): Promise<number | undefined> {
  try {
    const output = await runGit(
      spawn,
      path,
      ["rev-list", "--count", "HEAD", "--not", "--remotes", "--"],
      signal,
    );
    const value = output.trim();
    if (!/^\d+$/.test(value)) return undefined;
    const count = Number(value);
    return Number.isSafeInteger(count) ? count : undefined;
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
}

export type GitWorktree = Readonly<{
  path: string;
  head?: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  lockReason?: string;
  prunable: boolean;
  prunableReason?: string;
}>;

/** Parses `git worktree list --porcelain -z`. */
export function parseWorktreeList(output: string): readonly GitWorktree[] {
  const records: GitWorktree[] = [];
  for (const block of output.split("\0\0")) {
    if (!block) continue;
    const fields = new Map<string, string>();
    for (const line of block.split("\0")) {
      const space = line.indexOf(" ");
      fields.set(
        space < 0 ? line : line.slice(0, space),
        space < 0 ? "" : line.slice(space + 1),
      );
    }
    const path = fields.get("worktree");
    const head = fields.get("HEAD");
    if (!path || (!head && !fields.has("bare")))
      throw new Error("Invalid git worktree output");
    const branch = fields.get("branch");
    const lockReason = fields.get("locked");
    const prunableReason = fields.get("prunable");
    records.push({
      path,
      ...(head !== undefined && { head }),
      ...(branch !== undefined && { branch }),
      detached: fields.has("detached"),
      bare: fields.has("bare"),
      locked: fields.has("locked"),
      ...(lockReason && { lockReason }),
      prunable: fields.has("prunable"),
      ...(prunableReason && { prunableReason }),
    });
  }
  return records;
}

export type GitStatusEntry = Readonly<{
  kind: "ordinary" | "renamed" | "unmerged" | "untracked" | "ignored";
  path: string;
  originalPath?: string;
  index: string;
  worktree: string;
}>;

export type GitStatus = Readonly<{
  oid?: string;
  head?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  entries: readonly GitStatusEntry[];
}>;

/** Parses `git status --porcelain=v2 --branch -z`, including paths with spaces
 * and the separate NUL field used for rename/copy source paths. */
export function parseStatus(output: string): GitStatus {
  const fields = output.split("\0");
  const entries: GitStatusEntry[] = [];
  let oid: string | undefined;
  let head: string | undefined;
  let upstream: string | undefined;
  let ahead: number | undefined;
  let behind: number | undefined;
  for (let i = 0; i < fields.length; i += 1) {
    const line = fields[i];
    if (!line) continue;
    if (line.startsWith("# branch.oid ")) {
      const value = line.slice(13);
      oid = value === "(initial)" ? undefined : value;
    } else if (line.startsWith("# branch.head ")) {
      const value = line.slice(14);
      head = value === "(detached)" ? undefined : value;
    } else if (line.startsWith("# branch.upstream ")) upstream = line.slice(18);
    else if (line.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line);
      if (!match) throw new Error("Invalid git status branch counts");
      ahead = Number(match[1]);
      behind = Number(match[2]);
    } else if (line.startsWith("# ")) {
      // Porcelain v2 requires clients to ignore unknown headers.
    } else if (line.startsWith("1 ")) {
      entries.push(statusEntry("ordinary", line, 8));
    } else if (line.startsWith("2 ")) {
      const entry = statusEntry("renamed", line, 9);
      const originalPath = fields[++i];
      if (!originalPath) throw new Error("Invalid git rename status");
      entries.push({ ...entry, originalPath });
    } else if (line.startsWith("u ")) {
      entries.push(statusEntry("unmerged", line, 10));
    } else if (line.startsWith("? ") || line.startsWith("! ")) {
      entries.push({
        kind: line[0] === "?" ? "untracked" : "ignored",
        path: line.slice(2),
        index: "?",
        worktree: "?",
      });
    } else throw new Error("Invalid git status output");
  }
  return {
    ...(oid && { oid }),
    ...(head && { head }),
    ...(upstream && { upstream }),
    ...(ahead !== undefined && { ahead }),
    ...(behind !== undefined && { behind }),
    entries,
  };
}

function statusEntry(
  kind: GitStatusEntry["kind"],
  line: string,
  pathField: number,
): GitStatusEntry {
  const parts = line.split(" ");
  const xy = parts[1];
  const path = parts.slice(pathField).join(" ");
  if (xy?.length !== 2 || !path) throw new Error("Invalid git status entry");
  return { kind, path, index: xy.charAt(0), worktree: xy.charAt(1) };
}

/** Requires already-canonical absolute paths and rejects the root itself. */
export function assertPathWithinRoot(root: string, candidate: string): void {
  const rootParts = pathParts(root);
  const candidateParts = pathParts(candidate);
  if (
    rootParts.style !== candidateParts.style ||
    rootParts.parts.length >= candidateParts.parts.length ||
    rootParts.parts.some((part, index) =>
      rootParts.style === "windows"
        ? part.toLowerCase() !== candidateParts.parts[index]?.toLowerCase()
        : part !== candidateParts.parts[index],
    )
  )
    throw new Error("Worktree path must be inside the configured root");
}

function nativePathStyle(): "posix" | "windows" {
  return typeof navigator !== "undefined" &&
    /Windows/i.test(navigator.userAgent)
    ? "windows"
    : "posix";
}

function absolutePath(path: string, style?: "posix" | "windows"): boolean {
  if (path.includes("\0")) return false;
  const windows = /^[A-Za-z]:[\\/]/.test(path);
  return style === "windows"
    ? windows
    : style === "posix"
      ? path.startsWith("/")
      : path.startsWith("/") || windows;
}

function pathParts(path: string): {
  style: "posix" | "windows";
  parts: string[];
} {
  if (!absolutePath(path) || path.includes("\0"))
    throw new Error("Path must be absolute");
  const windows = /^[A-Za-z]:[\\/]/.test(path);
  const parts = path.split(windows ? /[\\/]+/ : /\/+/).filter(Boolean);
  // Canonical paths cannot contain traversal components. Reject them rather than
  // normalizing here, so callers must resolve symlinks before this boundary.
  if (parts.some((part) => part === "." || part === ".."))
    throw new Error("Path must be canonical");
  return { style: windows ? "windows" : "posix", parts };
}
