import type { Host } from "../../features/host/service";
import type { BindingStore, WorkspaceBinding } from "./binding";
import {
  assertPathWithinRoot,
  parseStatus,
  parseWorktreeList,
  runGit,
} from "./git";

type Spawn = NonNullable<Host["spawn"]>;

export type WorkspaceStatus = Readonly<{
  state: "ready" | "missing" | "mismatched";
  path: string;
  head?: string;
  branch?: string;
  detached: boolean;
  dirty: boolean;
  fileCount: number;
  ahead?: number;
  behind?: number;
  reason?: string;
}>;

/** Resolves a saved binding id and reconciles it without mutating the repository. */
export async function getWorkspaceStatus(
  spawn: Spawn,
  bindings: Pick<BindingStore, "get">,
  bindingId: string,
  signal?: AbortSignal,
): Promise<WorkspaceStatus> {
  const binding = bindings.get(bindingId);
  if (!binding) throw new Error("Workspace binding not found");
  return reconcileWorkspaceStatus(spawn, binding, signal);
}

/** Reads and reconciles one validated local binding. */
export async function reconcileWorkspaceStatus(
  spawn: Spawn,
  binding: WorkspaceBinding,
  signal?: AbortSignal,
): Promise<WorkspaceStatus> {
  assertPathWithinRoot(binding.worktreeRoot, binding.path);
  await requireGit236(spawn, binding.repoRoot, signal);

  const worktrees = parseWorktreeList(
    await runGit(
      spawn,
      binding.repoRoot,
      ["worktree", "list", "--porcelain", "-z"],
      signal,
    ),
  );
  const worktree = worktrees.find(({ path }) => samePath(path, binding.path));
  if (!worktree || worktree.prunable)
    return emptyStatus(binding.path, "missing");

  const commonDir = trimLine(
    await runGit(
      spawn,
      binding.path,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      signal,
    ),
  );
  if (!samePath(commonDir, binding.gitCommonDir))
    return emptyStatus(
      binding.path,
      "mismatched",
      "Repository identity changed",
    );

  const expectedBranch = `refs/heads/${binding.branch}`;
  if (!worktree.detached && worktree.branch !== expectedBranch)
    return emptyStatus(binding.path, "mismatched", "Worktree branch changed");

  const parsed = parseStatus(
    await runGit(
      spawn,
      binding.path,
      ["status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z"],
      signal,
    ),
  );
  if (worktree.head && parsed.oid && worktree.head !== parsed.oid)
    return emptyStatus(
      binding.path,
      "mismatched",
      "Worktree HEAD changed during status",
    );

  const { ahead, behind } = parseAheadBehind(
    await runGit(
      spawn,
      binding.path,
      ["rev-list", "--left-right", "--count", `${binding.baseRef}...HEAD`],
      signal,
    ),
  );
  return {
    state: "ready",
    path: binding.path,
    ...(parsed.oid && { head: parsed.oid }),
    ...(parsed.head && { branch: parsed.head }),
    detached: worktree.detached,
    dirty: parsed.entries.length > 0,
    fileCount: parsed.entries.length,
    ahead,
    behind,
  };
}

async function requireGit236(
  spawn: Spawn,
  repoRoot: string,
  signal?: AbortSignal,
): Promise<void> {
  const output = await runGit(spawn, repoRoot, ["version"], signal);
  const match = /^git version (\d+)\.(\d+)(?:\.\d+)?(?:\s|$)/.exec(
    output.trim(),
  );
  if (
    !match ||
    Number(match[1]) < 2 ||
    (match[1] === "2" && Number(match[2]) < 36)
  )
    throw new Error("Git 2.36 or newer is required");
}

function parseAheadBehind(output: string): { ahead: number; behind: number } {
  const match = /^(\d+)\s+(\d+)\s*$/.exec(output);
  if (!match) throw new Error("Invalid git revision counts");
  return { behind: Number(match[1]), ahead: Number(match[2]) };
}

function emptyStatus(
  path: string,
  state: "missing" | "mismatched",
  reason?: string,
): WorkspaceStatus {
  return {
    state,
    path,
    detached: false,
    dirty: false,
    fileCount: 0,
    ...(reason && { reason }),
  };
}

function trimLine(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\n") || trimmed.includes("\r"))
    throw new Error("Invalid git path output");
  return trimmed;
}

function samePath(left: string, right: string): boolean {
  const windows = /^[A-Za-z]:[\\/]/.test(left) && /^[A-Za-z]:[\\/]/.test(right);
  const normalize = (value: string) =>
    value.replace(/[\\/]+$/, "").replace(windows ? /\\/g : /$^/, "/");
  return windows
    ? normalize(left).toLowerCase() === normalize(right).toLowerCase()
    : normalize(left) === normalize(right);
}
