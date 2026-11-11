import type { Host } from "../../features/host/service";
import type { BindingStore, WorkspaceBinding } from "./binding";
import {
  assertPathWithinRoot,
  GitError,
  type GitWorktree,
  parseWorktreeList,
  runGit,
} from "./git";

type DesktopHost = Required<Pick<Host, "spawn" | "resolveDirectory">>;

export type PrepareWorkspaceInput = Readonly<{
  channelId: string;
  repoRoot: string;
  worktreeRoot: string;
  worktreeName: string;
  branch: string;
  baseRef: string;
  installId: string;
}>;

type PrepareOptions = Readonly<{
  newId?: () => string;
  now?: () => number;
  signal?: AbortSignal;
}>;

/** Creates or resumes one owned worktree and records its local lifecycle. */
export async function prepareWorkspace(
  host: DesktopHost,
  bindings: Pick<BindingStore, "forChannel" | "set">,
  input: PrepareWorkspaceInput,
  options: PrepareOptions = {},
): Promise<WorkspaceBinding> {
  validateText("channel id", input.channelId);
  validateText("install id", input.installId);
  validateLeaf(input.worktreeName);
  validateRef(input.branch, "branch");
  validateRef(input.baseRef, "base ref");

  const repoRoot = await host.resolveDirectory(input.repoRoot);
  const worktreeRoot = await host.resolveDirectory(input.worktreeRoot);
  const requestedPath = joinLeaf(worktreeRoot, input.worktreeName);
  assertPathWithinRoot(worktreeRoot, requestedPath);
  // Creating the empty leaf is safe and lets the host resolve a pre-existing
  // leaf symlink before Git can write through it.
  const path = await host.resolveDirectory(requestedPath);
  assertPathWithinRoot(worktreeRoot, path);
  const existing = bindings.forChannel(input.channelId);
  if (
    existing?.owned &&
    !sameIntent(existing, input, repoRoot, worktreeRoot, path)
  )
    throw new Error("Channel already owns a different workspace binding");

  const baseSha = existing?.owned
    ? existing.baseSha
    : trimSha(
        await runGit(
          host.spawn,
          repoRoot,
          [
            "rev-parse",
            "--verify",
            "--end-of-options",
            `${input.baseRef}^{commit}`,
          ],
          options.signal,
        ),
      );
  await runGit(
    host.spawn,
    repoRoot,
    ["check-ref-format", "--branch", input.branch],
    options.signal,
  );
  const gitCommonDir = await canonicalGitCommonDir(
    host,
    repoRoot,
    options.signal,
  );

  const identity = {
    repoRoot,
    worktreeRoot,
    path,
    branch: input.branch,
    baseRef: input.baseRef,
    baseSha,
    gitCommonDir,
  };
  if (existing?.owned && !sameResolvedIntent(existing, identity))
    throw new Error("Channel already owns a different workspace binding");

  const preparing: WorkspaceBinding = {
    bindingId: existing?.bindingId ?? options.newId?.() ?? crypto.randomUUID(),
    channelId: input.channelId,
    ...identity,
    createdAt: existing?.createdAt ?? (options.now ?? Date.now)(),
    installId: input.installId,
    owned: true,
    state: "preparing",
  };
  let worktree = await findWorktree(host, preparing, options.signal);
  if (!existing?.owned && worktree)
    throw new Error("Workspace path is already registered as a worktree");
  if (existing?.owned)
    worktree = await recoverPrunableWorktree(
      host,
      preparing,
      worktree,
      options.signal,
    );
  if (!worktree) await assertBranchAtBase(host, preparing, options.signal);
  bindings.set(preparing);

  try {
    await ensureWorktree(host, preparing, options.signal);
    const canonicalPath = await host.resolveDirectory(preparing.path);
    assertPathWithinRoot(preparing.worktreeRoot, canonicalPath);
    const ready = {
      ...preparing,
      path: canonicalPath,
      state: "ready",
    } as const;
    bindings.set(ready);
    return ready;
  } catch (error) {
    bindings.set({ ...preparing, state: "failed" });
    throw error;
  }
}

async function ensureWorktree(
  host: DesktopHost,
  binding: WorkspaceBinding,
  signal?: AbortSignal,
): Promise<void> {
  let worktree = await findWorktree(host, binding, signal);
  if (!worktree) {
    const existingBranchSha = await resolveBranchSha(host, binding, signal);
    const addArgs = existingBranchSha
      ? ["worktree", "add", binding.path, binding.branch]
      : [
          "worktree",
          "add",
          "-b",
          binding.branch,
          binding.path,
          binding.baseSha,
        ];
    try {
      await runGit(host.spawn, binding.repoRoot, addArgs, signal);
    } catch (error) {
      // A prior or racing attempt may have completed before its result reached us.
      worktree = await findWorktree(host, binding, signal);
      if (!worktree) throw error;
    }
    worktree ??= await findWorktree(host, binding, signal);
  }
  if (!worktree) throw new Error("Git did not register the new worktree");
  if (worktree.locked)
    throw new Error(
      worktree.lockReason
        ? `Workspace worktree is locked: ${worktree.lockReason}`
        : "Workspace worktree is locked",
    );
  if (worktree.detached || worktree.branch !== `refs/heads/${binding.branch}`)
    throw new Error("Workspace path is attached to a different branch");

  const commonDir = await canonicalGitCommonDir(host, binding.path, signal);
  if (!samePath(commonDir, binding.gitCommonDir))
    throw new Error("Workspace path belongs to a different repository");
}

async function assertBranchAtBase(
  host: DesktopHost,
  binding: WorkspaceBinding,
  signal?: AbortSignal,
): Promise<void> {
  const sha = await resolveBranchSha(host, binding, signal);
  if (sha && sha !== binding.baseSha)
    throw new Error("Workspace branch already exists at a different commit");
}

async function resolveBranchSha(
  host: DesktopHost,
  binding: WorkspaceBinding,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    return trimSha(
      await runGit(
        host.spawn,
        binding.repoRoot,
        [
          "rev-parse",
          "--verify",
          "--end-of-options",
          `refs/heads/${binding.branch}^{commit}`,
        ],
        signal,
      ),
    );
  } catch (error) {
    if (error instanceof GitError) return undefined;
    throw error;
  }
}

async function recoverPrunableWorktree(
  host: DesktopHost,
  binding: WorkspaceBinding,
  worktree: GitWorktree | undefined,
  signal?: AbortSignal,
): Promise<GitWorktree | undefined> {
  if (!worktree?.prunable) return worktree;
  if (worktree.locked)
    throw new Error(
      worktree.lockReason
        ? `Workspace worktree is locked: ${worktree.lockReason}`
        : "Workspace worktree is locked",
    );
  await runGit(
    host.spawn,
    binding.repoRoot,
    ["worktree", "remove", "--force", "--force", binding.path],
    signal,
  );
  return findWorktree(host, binding, signal);
}

async function findWorktree(
  host: DesktopHost,
  binding: WorkspaceBinding,
  signal?: AbortSignal,
): Promise<GitWorktree | undefined> {
  const worktrees = parseWorktreeList(
    await runGit(
      host.spawn,
      binding.repoRoot,
      ["worktree", "list", "--porcelain", "-z"],
      signal,
    ),
  );
  return worktrees.find(({ path }) => samePath(path, binding.path));
}

async function canonicalGitCommonDir(
  host: DesktopHost,
  repoPath: string,
  signal?: AbortSignal,
): Promise<string> {
  const path = trimLine(
    await runGit(
      host.spawn,
      repoPath,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      signal,
    ),
  );
  return host.resolveDirectory(path);
}

function sameIntent(
  binding: WorkspaceBinding,
  input: PrepareWorkspaceInput,
  repoRoot: string,
  worktreeRoot: string,
  path: string,
): boolean {
  return (
    samePath(binding.repoRoot, repoRoot) &&
    samePath(binding.worktreeRoot, worktreeRoot) &&
    samePath(binding.path, path) &&
    binding.branch === input.branch &&
    binding.baseRef === input.baseRef &&
    binding.installId === input.installId
  );
}

function sameResolvedIntent(
  binding: WorkspaceBinding,
  identity: Pick<
    WorkspaceBinding,
    | "repoRoot"
    | "worktreeRoot"
    | "path"
    | "branch"
    | "baseRef"
    | "baseSha"
    | "gitCommonDir"
  >,
): boolean {
  return (
    samePath(binding.repoRoot, identity.repoRoot) &&
    samePath(binding.worktreeRoot, identity.worktreeRoot) &&
    samePath(binding.path, identity.path) &&
    binding.branch === identity.branch &&
    binding.baseRef === identity.baseRef &&
    binding.baseSha === identity.baseSha &&
    samePath(binding.gitCommonDir, identity.gitCommonDir)
  );
}

function validateText(name: string, value: string): void {
  if (!value || value.trim() !== value || value.includes("\0"))
    throw new Error(`Invalid ${name}`);
}

function validateLeaf(value: string): void {
  validateText("worktree name", value);
  if (value === "." || value === ".." || /[\\/]/.test(value))
    throw new Error("Worktree name must be one path segment");
}

function validateRef(value: string, name: string): void {
  validateText(name, value);
  if (
    value.startsWith("-") ||
    value.includes("..") ||
    value.includes("@{") ||
    /[\s~^:?*[\\]/.test(value) ||
    value.endsWith(".") ||
    value.endsWith("/") ||
    value.endsWith(".lock") ||
    value.split("/").some((part) => !part || part.startsWith("."))
  )
    throw new Error(`Invalid ${name}`);
}

function joinLeaf(root: string, leaf: string): string {
  const separator = /^[A-Za-z]:[\\/]/.test(root) ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}${leaf}`;
}

function trimSha(value: string): string {
  const sha = trimLine(value);
  if (!/^[0-9a-f]{40,64}$/i.test(sha))
    throw new Error("Git returned an invalid SHA");
  return sha.toLowerCase();
}

function trimLine(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\n") || trimmed.includes("\r"))
    throw new Error("Git returned invalid single-line output");
  return trimmed;
}

function samePath(left: string, right: string): boolean {
  const windows = /^[A-Za-z]:[\\/]/.test(left) && /^[A-Za-z]:[\\/]/.test(right);
  const normalize = (value: string) =>
    value.replace(/[\\/]+$/, "").replaceAll("\\", "/");
  return windows
    ? normalize(left).toLowerCase() === normalize(right).toLowerCase()
    : normalize(left) === normalize(right);
}
