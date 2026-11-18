import type { Host } from "../../features/host/service";
import { type Workspace, workspaceCanvas } from "../../features/solo/workspace";
import { BindingStore, type WorkspaceBinding } from "./binding";
import { prepareWorkspace, WorkspaceIntentConflict } from "./prepare";
import { reconcileWorkspaceStatus, type WorkspaceStatus } from "./status";
import {
  previewWorkspaceFinish,
  recoverWorkspaceRemoval,
  removeWorkspace,
  type WorkspaceFinishPreview,
} from "./finish";
import { countUnpublishedCommits, GitError, runGit } from "./git";

const INSTALL_ID_KEY = "buzz.worktrees.install.v1";
const MAX_DIFF_BYTES = 2_000_000;

export type WorktreeWorkspace = Readonly<{
  repository: string;
  baseBranch: string;
  location: string;
}>;

export type WorktreeDiffComparison = "uncommitted" | "since-base";

export type WorktreeDiff = Readonly<{
  content: string;
  path: string;
  branch: string;
  status: WorkspaceStatus;
  comparison?: WorktreeDiffComparison;
  baseRef?: string;
  unpublishedCommits?: number;
}>;

export type WorktreeSummary = Readonly<{
  repository: string;
  path: string;
  branch: string;
  baseRef: string;
  baseSha: string;
  lifecycle: WorkspaceBinding["state"];
  status?: WorkspaceStatus;
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
    canDiff(channelId: string): boolean;
    summary(channelId: string, signal?: AbortSignal): Promise<WorktreeSummary>;
    diff(
      channelId: string,
      signal?: AbortSignal,
      comparison?: WorktreeDiffComparison,
    ): Promise<WorktreeDiff>;
    previewFinish(
      channelId: string,
      inspectAgents: () => readonly string[],
      signal?: AbortSignal,
    ): Promise<WorkspaceFinishPreview>;
    remove(
      channelId: string,
      expectedHead: string,
      inspectAgents: () => readonly string[],
      signal?: AbortSignal,
    ): Promise<WorkspaceBinding>;
    reopen(channelId: string, signal?: AbortSignal): Promise<WorkspaceBinding>;
    recover(channelId: string): Promise<WorkspaceBinding>;
  }>;

const workspaceBlockStart = "<!-- buzz-session-workspace:v1 ";
const workspaceBlockEnd = "<!-- /buzz-session-workspace -->";

type WorkspaceCanvasBinding = Pick<
  WorkspaceBinding,
  "path" | "branch" | "repoRoot" | "baseRef" | "baseSha"
>;

/** Replaces create-time instructions with the worktree Buzz already prepared. */
export function preparedWorkspaceCanvas<T extends WorkspaceCanvasBinding>(
  value: Workspace,
  binding: T,
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

/** Retires Buzz's generated workspace text and preserves authored Canvas text. */
export function removedWorkspaceCanvas(
  content: string,
  binding: Pick<
    WorkspaceBinding,
    "path" | "branch" | "repoRoot" | "baseRef" | "baseSha"
  >,
): string {
  const start = content.indexOf(workspaceBlockStart);
  const end = start < 0 ? -1 : content.indexOf(workspaceBlockEnd, start);
  if (start < 0 || end < 0) return content;
  const metadataEnd = content.indexOf(" -->", start);
  if (metadataEnd < 0 || metadataEnd > end) return content;
  try {
    const metadata = JSON.parse(
      content.slice(start + workspaceBlockStart.length, metadataEnd),
    ) as { folders?: unknown };
    if (
      !Array.isArray(metadata.folders) ||
      !metadata.folders.includes(binding.path)
    )
      return content;
  } catch {
    return content;
  }

  const before = content.slice(0, start);
  const afterBlock = content
    .slice(end + workspaceBlockEnd.length)
    .replace(/^\n\n/, "");
  const generated = [
    "## Prepared worktree",
    "",
    `- Work in \`${binding.path}\` on branch \`${binding.branch}\`.`,
    `- The repository checkout \`${binding.repoRoot}\` is read-only reference; do not change it directly.`,
    `- The worktree already exists from \`${binding.baseRef}\` at \`${binding.baseSha}\`; do not create another worktree.`,
    "",
  ].join("\n");
  const after = afterBlock.startsWith(generated)
    ? afterBlock.slice(generated.length)
    : afterBlock;
  const retained = removedWorkspaceNotice(binding.branch);
  const remainder = `${before}${after}`;
  return remainder ? `${retained}\n\n${remainder}` : retained;
}

/** Restores worktree instructions while preserving authored Canvas text. */
export function reopenedWorkspaceCanvas<T extends WorkspaceCanvasBinding>(
  content: string,
  binding: T,
  options: Readonly<{ onlyIfRemovedNotice?: boolean }> = {},
): string {
  if (hasWorkspaceBlock(content, binding.path)) return content;
  const authored = withoutRemovedWorkspaceNotice(content);
  if (options.onlyIfRemovedNotice && authored === content) return content;
  return preparedWorkspaceCanvas(
    { folders: [binding.repoRoot], canvas: authored },
    binding,
  );
}

function hasWorkspaceBlock(content: string, path: string): boolean {
  const start = content.indexOf(workspaceBlockStart);
  const end = start < 0 ? -1 : content.indexOf(workspaceBlockEnd, start);
  const metadataEnd =
    start < 0
      ? -1
      : content.indexOf(" -->", start + workspaceBlockStart.length);
  if (start < 0 || end < 0 || metadataEnd < 0 || metadataEnd > end)
    return false;
  try {
    const metadata = JSON.parse(
      content.slice(start + workspaceBlockStart.length, metadataEnd),
    ) as { folders?: unknown };
    return Array.isArray(metadata.folders) && metadata.folders.includes(path);
  } catch {
    return false;
  }
}

function removedWorkspaceNotice(branch: string): string {
  return [
    "## Worktree removed",
    "",
    `The local worktree was removed. Branch \`${branch}\` and its commits remain in the repository.`,
    "Do not create another worktree yourself. If more work is needed, ask the user to choose Recreate worktree.",
  ].join("\n");
}

function withoutRemovedWorkspaceNotice(content: string): string {
  const heading = "## Worktree removed\n\n";
  if (!content.startsWith(heading)) return content;
  const paragraphEnd = content.indexOf("\n\n", heading.length);
  const notice = content.slice(
    heading.length,
    paragraphEnd < 0 ? content.length : paragraphEnd,
  );
  const firstLine = notice.split("\n", 1)[0] ?? "";
  if (
    !firstLine.startsWith("The local worktree was removed. Branch `") ||
    !firstLine.endsWith("` and its commits remain in the repository.")
  )
    return content;
  return paragraphEnd < 0 ? "" : content.slice(paragraphEnd + 2);
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
      return !!desktop && binding?.owned === true;
    },
    canDiff(channelId) {
      const binding = bindings.forChannel(channelId);
      return !!desktop && binding?.owned === true && binding.state === "ready";
    },
    async summary(channelId, signal) {
      if (!desktop) throw new Error("Local Git is unavailable");
      await recovery;
      const binding = ownedChannelBinding(bindings, channelId);
      if (binding.state !== "ready")
        return {
          repository: binding.repoRoot,
          path: binding.path,
          branch: binding.branch,
          baseRef: binding.baseRef,
          baseSha: binding.baseSha,
          lifecycle: binding.state,
        };
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
        baseSha: binding.baseSha,
        lifecycle: binding.state,
        status,
        ...(unpublishedCommits !== undefined && { unpublishedCommits }),
      };
    },
    async diff(channelId, signal, comparison = "uncommitted") {
      if (!desktop) throw new Error("Local Git is unavailable");
      await recovery;
      const binding = readyBinding(bindings, channelId);
      const status = await readyStatus(desktop.spawn, binding, signal);
      const base =
        comparison === "since-base"
          ? await diffBase(desktop.spawn, binding.path, binding.baseRef, signal)
          : "HEAD";
      const unpublishedCommits =
        comparison === "since-base"
          ? await countUnpublishedCommits(desktop.spawn, binding.path, signal)
          : undefined;
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
          base,
          "--",
        ],
        signal,
        undefined,
        MAX_DIFF_BYTES,
      );
      return {
        content,
        path: binding.path,
        branch: binding.branch,
        status,
        comparison,
        ...(comparison === "since-base" && { baseRef: binding.baseRef }),
        ...(unpublishedCommits !== undefined && { unpublishedCommits }),
      };
    },
    async previewFinish(channelId, inspectAgents, signal) {
      if (!desktop) throw new Error("Local Git is unavailable");
      await recovery;
      const binding = ownedChannelBinding(bindings, channelId);
      return previewWorkspaceFinish(
        desktop.spawn,
        bindings,
        binding.bindingId,
        {
          installId: binding.installId,
          inspectUse: async () => ({ agents: inspectAgents() }),
          ...(signal ? { signal } : {}),
        },
      );
    },
    async remove(channelId, expectedHead, inspectAgents, signal) {
      if (!desktop) throw new Error("Local Git is unavailable");
      await recovery;
      const binding = ownedChannelBinding(bindings, channelId);
      return removeWorkspace(
        desktop.spawn,
        bindings,
        binding.bindingId,
        expectedHead,
        {
          installId: binding.installId,
          inspectUse: async () => ({ agents: inspectAgents() }),
          ...(signal ? { signal } : {}),
        },
      );
    },
    async reopen(channelId, signal) {
      if (!desktop) throw new Error("Local Git is unavailable");
      await recovery;
      const binding = ownedChannelBinding(bindings, channelId);
      if (binding.state !== "removed" && binding.state !== "preparing")
        throw new Error("This chat has no recoverable local worktree");
      return prepareWorkspace(
        desktop,
        bindings,
        {
          channelId,
          repoRoot: binding.repoRoot,
          worktreeRoot: binding.worktreeRoot,
          worktreeName: pathLeaf(binding.path),
          branch: binding.branch,
          baseRef: binding.baseRef,
          installId: binding.installId,
        },
        signal ? { signal } : {},
      );
    },
    async recover(channelId) {
      if (!desktop) throw new Error("Local Git is unavailable");
      const binding = ownedChannelBinding(bindings, channelId);
      return recoverWorkspaceRemoval(
        desktop.spawn,
        bindings,
        binding.bindingId,
        binding.installId,
      );
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

function ownedChannelBinding(
  bindings: BindingStore,
  channelId: string,
): WorkspaceBinding {
  const binding = bindings.forChannel(channelId);
  if (!binding?.owned) throw new Error("This chat has no owned local worktree");
  return binding;
}

function readyBinding(
  bindings: BindingStore,
  channelId: string,
): WorkspaceBinding {
  const binding = ownedChannelBinding(bindings, channelId);
  if (binding.state !== "ready")
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

async function diffBase(
  spawn: NonNullable<Host["spawn"]>,
  path: string,
  baseRef: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    return parseCommit(
      await runGit(spawn, path, ["merge-base", "--", baseRef, "HEAD"], signal),
    );
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    const reason =
      error.code === 1
        ? `No common history exists between ${baseRef} and this worktree.`
        : `The configured base ${baseRef} is unavailable.`;
    throw new Error(
      `${reason} View local changes to inspect uncommitted changes.`,
    );
  }
}

function parseCommit(value: string): string {
  const commit = value.trim();
  if (!/^[0-9a-f]{40,64}$/.test(commit))
    throw new Error("Git returned an invalid merge base");
  return commit;
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
