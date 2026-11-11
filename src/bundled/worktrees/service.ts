import type { Host } from "../../features/host/service";
import { type Workspace, workspaceCanvas } from "../../features/solo/workspace";
import { BindingStore, type WorkspaceBinding } from "./binding";
import { prepareWorkspace, WorkspaceIntentConflict } from "./prepare";
import { reconcileWorkspaceStatus, type WorkspaceStatus } from "./status";
import { recoverWorkspaceRemoval } from "./finish";
import { countUnpublishedCommits, runGit } from "./git";

const INSTALL_ID_KEY = "buzz.worktrees.install.v1";
const MAX_DIFF_BYTES = 2_000_000;

export type WorktreeWorkspace = Readonly<{
  repository: string;
  baseBranch: string;
  location: string;
}>;

export type WorktreeDiff = Readonly<{
  content: string;
  path: string;
  branch: string;
  status: WorkspaceStatus;
}>;

export type WorktreeSummary = Readonly<{
  repository: string;
  path: string;
  branch: string;
  baseRef: string;
  status: WorkspaceStatus;
  /** Local evidence only: commits not reached by any local remote-tracking ref. */
  unpublishedCommits?: number;
}>;

export type WorktreePreparation = Readonly<{
  workspace(value: Workspace): WorktreeWorkspace | undefined;
  prepare(
    channelId: string,
    value: Workspace,
    task: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceBinding | undefined>;
}>;

export type Worktrees = WorktreePreparation &
  Readonly<{
    has(channelId: string): boolean;
    summary(channelId: string, signal?: AbortSignal): Promise<WorktreeSummary>;
    diff(channelId: string, signal?: AbortSignal): Promise<WorktreeDiff>;
  }>;

/** Replaces create-time instructions with the worktree Buzz already prepared. */
export function preparedWorkspaceCanvas(
  value: Workspace,
  binding: WorkspaceBinding,
): string {
  const instructions = [
    "## Prepared worktree",
    "",
    `- Work in \`${binding.path}\` on branch \`${binding.branch}\`.`,
    `- The repository checkout \`${binding.repoRoot}\` is read-only reference; do not change it directly.`,
    `- The worktree already exists from \`${binding.baseRef}\` at \`${binding.baseSha}\`; do not create another worktree.`,
    "",
    value.canvas,
  ].join("\n");
  return workspaceCanvas({ folders: [binding.path], canvas: instructions });
}

export function createWorktrees(
  host: Pick<Host, "spawn" | "resolveDirectory">,
  storage: Storage,
): Worktrees {
  const bindings = new BindingStore(storage);
  const desktop =
    host.spawn && host.resolveDirectory
      ? { spawn: host.spawn, resolveDirectory: host.resolveDirectory }
      : undefined;
  const savedInstallId = storage.getItem(INSTALL_ID_KEY);
  const recovery = desktop
    ? Promise.allSettled(
        bindings
          .all()
          .flatMap((binding) =>
            binding.owned &&
            binding.state === "removing" &&
            savedInstallId === binding.installId
              ? [
                  recoverWorkspaceRemoval(
                    desktop.spawn,
                    bindings,
                    binding.bindingId,
                    savedInstallId,
                  ),
                ]
              : [],
          ),
      )
    : Promise.resolve([]);
  return {
    has(channelId) {
      const binding = bindings.forChannel(channelId);
      return !!desktop && binding?.owned === true && binding.state === "ready";
    },
    async summary(channelId, signal) {
      if (!desktop) throw new Error("Local Git is unavailable");
      await recovery;
      const binding = readyBinding(bindings, channelId);
      const status = await readyStatus(desktop.spawn, binding, signal);
      const unpublishedCommits = await countUnpublishedCommits(
        desktop.spawn,
        binding.path,
        signal,
      );
      return {
        repository: binding.repoRoot,
        path: binding.path,
        branch: binding.branch,
        baseRef: binding.baseRef,
        status,
        ...(unpublishedCommits !== undefined && { unpublishedCommits }),
      };
    },
    async diff(channelId, signal) {
      if (!desktop) throw new Error("Local Git is unavailable");
      await recovery;
      const binding = readyBinding(bindings, channelId);
      const status = await readyStatus(desktop.spawn, binding, signal);
      const content = await runGit(
        desktop.spawn,
        binding.path,
        [
          "diff",
          "--no-ext-diff",
          "--no-color",
          "--src-prefix=a/",
          "--dst-prefix=b/",
          "--full-index",
          "HEAD",
          "--",
        ],
        signal,
        undefined,
        MAX_DIFF_BYTES,
      );
      return { content, path: binding.path, branch: binding.branch, status };
    },
    workspace(value) {
      return desktop ? workspace(value) : undefined;
    },
    async prepare(channelId, value, task, signal) {
      const selected = desktop ? workspace(value) : undefined;
      if (!selected || !desktop) return undefined;
      await recovery;
      const suffix = channelId.replaceAll("-", "").slice(0, 4).toLowerCase();
      const slug = taskSlug(task);
      const existing = bindings.forChannel(channelId);
      const reusable = existing?.owned === true;
      try {
        return await prepareWorkspace(
          desktop,
          bindings,
          {
            channelId,
            repoRoot: selected.repository,
            worktreeRoot: selected.location,
            worktreeName: reusable
              ? pathLeaf(existing.path)
              : `${slug}-${suffix}`,
            branch: reusable ? existing.branch : `buzz/${slug}-${suffix}`,
            baseRef: selected.baseBranch,
            installId: installId(storage),
          },
          signal ? { signal } : {},
        );
      } catch (error) {
        if (existing?.owned && error instanceof WorkspaceIntentConflict)
          throw new Error(
            `This draft already prepared ${existing.path} on ${existing.branch}. Switch back to its original workspace to retry, or close and reopen New chat before choosing a different workspace.`,
          );
        throw error;
      }
    },
  };
}

function readyBinding(
  bindings: BindingStore,
  channelId: string,
): WorkspaceBinding {
  const binding = bindings.forChannel(channelId);
  if (!binding?.owned || binding.state !== "ready")
    throw new Error("This chat has no ready local worktree");
  return binding;
}

async function readyStatus(
  spawn: NonNullable<Host["spawn"]>,
  binding: WorkspaceBinding,
  signal?: AbortSignal,
): Promise<WorkspaceStatus> {
  const status = await reconcileWorkspaceStatus(spawn, binding, signal);
  if (status.state !== "ready" || status.detached)
    throw new Error(
      status.reason ??
        (status.detached
          ? "The local worktree is detached"
          : "The local worktree no longer matches this chat"),
    );
  return status;
}

function workspace(value: Workspace): WorktreeWorkspace | undefined {
  if (!value.worktree || value.folders.length !== 1) return undefined;
  return {
    repository: value.folders[0] as string,
    baseBranch: value.worktree.baseBranch,
    location: value.worktree.location,
  };
}

function taskSlug(task: string): string {
  const slug = task
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "work";
}

function pathLeaf(path: string): string {
  const leaf = path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .at(-1);
  if (!leaf) throw new Error("Workspace binding path has no leaf");
  return leaf;
}

function installId(storage: Storage): string {
  const saved = storage.getItem(INSTALL_ID_KEY);
  if (saved) return saved;
  const created = crypto.randomUUID();
  storage.setItem(INSTALL_ID_KEY, created);
  return created;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    worktrees: Worktrees;
  }
}
