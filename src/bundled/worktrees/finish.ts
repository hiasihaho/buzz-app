import type { Host } from "../../features/host/service";
import type { BindingStore, WorkspaceBinding } from "./binding";
import {
  assertPathWithinRoot,
  type GitWorktree,
  parseStatus,
  parseWorktreeList,
  runGit,
} from "./git";

type Spawn = NonNullable<Host["spawn"]>;

type FinishBlockerKind =
  | "binding-state"
  | "detached"
  | "dirty"
  | "ignored"
  | "locked"
  | "missing"
  | "repository"
  | "unpublished"
  | "usage"
  | "usage-unknown";

export type FinishBlocker = Readonly<{
  kind: FinishBlockerKind;
  message: string;
  count?: number;
}>;

export type WorkspaceUse = Readonly<{
  agents: readonly string[];
  terminals: readonly string[];
}>;

export type WorkspaceFinishPreview = Readonly<{
  bindingId: string;
  path: string;
  branch: string;
  head?: string;
  unpublishedCommits?: number;
  blockers: readonly FinishBlocker[];
}>;

type FinishOptions = Readonly<{
  installId: string;
  inspectUse(
    binding: WorkspaceBinding,
    signal?: AbortSignal,
  ): Promise<WorkspaceUse>;
  signal?: AbortSignal;
}>;

/** Reads every fact needed before offering removal. Unknown evidence blocks. */
export async function previewWorkspaceFinish(
  spawn: Spawn,
  bindings: Pick<BindingStore, "get">,
  bindingId: string,
  options: FinishOptions,
): Promise<WorkspaceFinishPreview> {
  const binding = ownedBinding(bindings, bindingId, options.installId);
  const blockers: FinishBlocker[] = [];
  if (binding.state !== "ready")
    blockers.push({
      kind: "binding-state",
      message: `Workspace binding is ${binding.state}, not ready`,
    });
  assertPathWithinRoot(binding.worktreeRoot, binding.path);

  const worktrees = parseWorktreeList(
    await runGit(
      spawn,
      binding.repoRoot,
      ["worktree", "list", "--porcelain", "-z"],
      options.signal,
    ),
  );
  const worktree = worktrees.find(({ path }) => samePath(path, binding.path));
  if (!worktree || worktree.prunable) {
    blockers.push({ kind: "missing", message: "Worktree is not registered" });
    return preview(binding, blockers);
  }
  validateRegisteredWorktree(binding, worktree, blockers);

  const commonDir = trimLine(
    await runGit(
      spawn,
      binding.path,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      options.signal,
    ),
    "Git common directory",
  );
  if (!samePath(commonDir, binding.gitCommonDir))
    blockers.push({
      kind: "repository",
      message: "Worktree belongs to a different repository",
    });

  const status = parseStatus(
    await runGit(
      spawn,
      binding.path,
      [
        "status",
        "--porcelain=v2",
        "--branch",
        "--untracked-files=all",
        "--ignored=matching",
        "-z",
      ],
      options.signal,
    ),
  );
  const tracked = status.entries.filter(
    ({ kind }) => kind !== "untracked" && kind !== "ignored",
  ).length;
  const untracked = status.entries.filter(
    ({ kind }) => kind === "untracked",
  ).length;
  const ignored = status.entries.filter(
    ({ kind }) => kind === "ignored",
  ).length;
  if (tracked + untracked > 0)
    blockers.push({
      kind: "dirty",
      message: "Worktree has tracked or untracked changes",
      count: tracked + untracked,
    });
  if (ignored > 0)
    blockers.push({
      kind: "ignored",
      message: "Worktree has ignored files",
      count: ignored,
    });

  const head = status.oid ?? worktree.head;
  if (!head || !validSha(head))
    throw new Error("Git did not report a valid worktree HEAD");
  if (worktree.head && status.oid && worktree.head !== status.oid)
    throw new Error("Worktree HEAD changed during finish preview");
  const unpublishedCommits = parseCount(
    await runGit(
      spawn,
      binding.path,
      ["rev-list", "--count", "HEAD", "--not", "--remotes", "--"],
      options.signal,
    ),
  );
  if (unpublishedCommits > 0)
    blockers.push({
      kind: "unpublished",
      message: "Worktree has commits not found on a remote",
      count: unpublishedCommits,
    });

  try {
    const use = await options.inspectUse(binding, options.signal);
    const count = use.agents.length + use.terminals.length;
    if (count > 0)
      blockers.push({
        kind: "usage",
        message: "Agents or terminals are using this worktree",
        count,
      });
  } catch {
    options.signal?.throwIfAborted();
    blockers.push({
      kind: "usage-unknown",
      message:
        "Could not verify whether agents or terminals are using this worktree",
    });
  }
  return {
    ...preview(binding, blockers),
    head: head.toLowerCase(),
    unpublishedCommits,
  };
}

/** Reconciles a persisted removal interrupted by an app or process exit. */
export async function recoverWorkspaceRemoval(
  spawn: Spawn,
  bindings: Pick<BindingStore, "get" | "set">,
  bindingId: string,
  installId: string,
): Promise<WorkspaceBinding> {
  const binding = ownedBinding(bindings, bindingId, installId);
  if (binding.state !== "removing") return binding;
  const state = await recoverRemovalState(spawn, binding);
  const recovered = { ...binding, state } as const;
  bindings.set(recovered);
  return recovered;
}

/** Removes only the exact previewed HEAD after a fresh fail-closed preview. */
export async function removeWorkspace(
  spawn: Spawn,
  bindings: Pick<BindingStore, "get" | "set">,
  bindingId: string,
  expectedHead: string,
  options: FinishOptions,
): Promise<WorkspaceBinding> {
  if (!validSha(expectedHead))
    throw new Error("Invalid expected worktree HEAD");
  const result = await previewWorkspaceFinish(
    spawn,
    bindings,
    bindingId,
    options,
  );
  if (result.blockers.length > 0)
    throw new Error(result.blockers.map(({ message }) => message).join("; "));
  if (result.head !== expectedHead.toLowerCase())
    throw new Error("Worktree HEAD changed since finish preview");

  const binding = ownedBinding(bindings, bindingId, options.installId);
  const immediateHead = trimSha(
    await runGit(spawn, binding.path, ["rev-parse", "HEAD"], options.signal),
  );
  if (immediateHead !== expectedHead.toLowerCase())
    throw new Error("Worktree HEAD changed since finish preview");

  const removing = { ...binding, state: "removing" } as const;
  bindings.set(removing);
  try {
    await runGit(
      spawn,
      binding.repoRoot,
      ["worktree", "remove", "--", binding.path],
      options.signal,
    );
    await assertRepositoryIdentity(spawn, binding);
    await assertBranchHead(spawn, binding, expectedHead);
    const remaining = parseWorktreeList(
      await runGit(
        spawn,
        binding.repoRoot,
        ["worktree", "list", "--porcelain", "-z"],
        options.signal,
      ),
    );
    if (remaining.some(({ path }) => samePath(path, binding.path)))
      throw new Error("Git still reports the removed worktree");
    const removed = { ...binding, state: "removed" } as const;
    bindings.set(removed);
    return removed;
  } catch (error) {
    const recovered = await recoverRemovalState(
      spawn,
      binding,
      expectedHead,
    ).catch(() => undefined);
    if (recovered === "removed") {
      const removed = { ...binding, state: "removed" } as const;
      bindings.set(removed);
      return removed;
    }
    bindings.set({
      ...binding,
      state: recovered === "ready" ? "ready" : "removing",
    });
    throw error;
  }
}

async function recoverRemovalState(
  spawn: Spawn,
  binding: WorkspaceBinding,
  expectedHead?: string,
): Promise<"ready" | "removed"> {
  await assertRepositoryIdentity(spawn, binding);
  let worktrees = parseWorktreeList(
    await runGit(spawn, binding.repoRoot, [
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]),
  );
  let worktree = worktrees.find(({ path }) => samePath(path, binding.path));
  if (!worktree) {
    await assertBranchHead(spawn, binding, expectedHead);
    return "removed";
  }
  if (
    worktree.detached ||
    !worktree.head ||
    !validSha(worktree.head) ||
    worktree.branch !== `refs/heads/${binding.branch}` ||
    (expectedHead && worktree.head.toLowerCase() !== expectedHead.toLowerCase())
  )
    throw new Error("Worktree state is unknown after failed removal");
  await assertBranchHead(spawn, binding, worktree.head);
  if (worktree.prunable) {
    await runGit(spawn, binding.repoRoot, [
      "worktree",
      "remove",
      "--",
      binding.path,
    ]);
    worktrees = parseWorktreeList(
      await runGit(spawn, binding.repoRoot, [
        "worktree",
        "list",
        "--porcelain",
        "-z",
      ]),
    );
    worktree = worktrees.find(({ path }) => samePath(path, binding.path));
    if (worktree)
      throw new Error("Git still reports the prunable worktree after removal");
    return "removed";
  }
  const commonDir = trimLine(
    await runGit(spawn, binding.path, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]),
    "Git common directory",
  );
  if (!samePath(commonDir, binding.gitCommonDir))
    throw new Error("Worktree repository changed after failed removal");
  return "ready";
}

async function assertBranchHead(
  spawn: Spawn,
  binding: WorkspaceBinding,
  expectedHead?: string,
): Promise<void> {
  const branchHead = trimSha(
    await runGit(spawn, binding.repoRoot, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `refs/heads/${binding.branch}^{commit}`,
    ]),
  );
  if (expectedHead && branchHead !== expectedHead.toLowerCase())
    throw new Error("Workspace branch changed during removal");
}

async function assertRepositoryIdentity(
  spawn: Spawn,
  binding: WorkspaceBinding,
): Promise<void> {
  const commonDir = trimLine(
    await runGit(spawn, binding.repoRoot, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]),
    "Git common directory",
  );
  if (!samePath(commonDir, binding.gitCommonDir))
    throw new Error("Workspace repository changed during removal");
}

function ownedBinding(
  bindings: Pick<BindingStore, "get">,
  bindingId: string,
  installId: string,
): WorkspaceBinding {
  const binding = bindings.get(bindingId);
  if (!binding) throw new Error("Workspace binding not found");
  if (!binding.owned || binding.installId !== installId)
    throw new Error("Workspace binding is not owned by this installation");
  return binding;
}

function validateRegisteredWorktree(
  binding: WorkspaceBinding,
  worktree: GitWorktree,
  blockers: FinishBlocker[],
): void {
  if (worktree.locked)
    blockers.push({ kind: "locked", message: "Worktree is locked" });
  if (worktree.detached)
    blockers.push({ kind: "detached", message: "Worktree is detached" });
  else if (worktree.branch !== `refs/heads/${binding.branch}`)
    blockers.push({
      kind: "repository",
      message: "Worktree branch no longer matches this chat",
    });
}

function preview(
  binding: WorkspaceBinding,
  blockers: readonly FinishBlocker[],
): WorkspaceFinishPreview {
  return {
    bindingId: binding.bindingId,
    path: binding.path,
    branch: binding.branch,
    blockers,
  };
}

function parseCount(output: string): number {
  const value = trimLine(output, "Git count");
  if (!/^\d+$/.test(value)) throw new Error("Git returned an invalid count");
  const count = Number(value);
  if (!Number.isSafeInteger(count))
    throw new Error("Git returned an invalid count");
  return count;
}

function trimSha(output: string): string {
  const value = trimLine(output, "Git SHA").toLowerCase();
  if (!validSha(value)) throw new Error("Git returned an invalid SHA");
  return value;
}

function validSha(value: string): boolean {
  return /^[0-9a-f]{40,64}$/i.test(value);
}

function trimLine(output: string, name: string): string {
  const value = output.trim();
  if (!value || value.includes("\n") || value.includes("\r"))
    throw new Error(`${name} is invalid`);
  return value;
}

function samePath(left: string, right: string): boolean {
  const windows = /^[A-Za-z]:[\\/]/.test(left) && /^[A-Za-z]:[\\/]/.test(right);
  const normalize = (value: string) =>
    value.replace(/[\\/]+$/, "").replaceAll("\\", "/");
  return windows
    ? normalize(left).toLowerCase() === normalize(right).toLowerCase()
    : normalize(left) === normalize(right);
}
