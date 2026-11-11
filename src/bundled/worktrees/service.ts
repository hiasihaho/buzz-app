import type { Host } from "../../features/host/service";
import type { Workspace } from "../../features/solo/workspace";
import { BindingStore, type WorkspaceBinding } from "./binding";
import { prepareWorkspace } from "./prepare";

const INSTALL_ID_KEY = "buzz.worktrees.install.v1";

export type WorktreeWorkspace = Readonly<{
  repository: string;
  baseBranch: string;
  location: string;
}>;

export type Worktrees = Readonly<{
  workspace(value: Workspace): WorktreeWorkspace | undefined;
  prepare(
    channelId: string,
    value: Workspace,
    task: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceBinding | undefined>;
}>;

export function createWorktrees(
  host: Pick<Host, "spawn" | "resolveDirectory">,
  storage: Storage,
): Worktrees {
  const bindings = new BindingStore(storage);
  const desktop =
    host.spawn && host.resolveDirectory
      ? { spawn: host.spawn, resolveDirectory: host.resolveDirectory }
      : undefined;
  return {
    workspace(value) {
      return desktop ? workspace(value) : undefined;
    },
    async prepare(channelId, value, task, signal) {
      const selected = desktop ? workspace(value) : undefined;
      if (!selected || !desktop) return undefined;
      const suffix = channelId.replaceAll("-", "").slice(0, 4).toLowerCase();
      const slug = taskSlug(task);
      return prepareWorkspace(
        desktop,
        bindings,
        {
          channelId,
          repoRoot: selected.repository,
          worktreeRoot: selected.location,
          worktreeName: `${slug}-${suffix}`,
          branch: `buzz/${slug}-${suffix}`,
          baseRef: selected.baseBranch,
          installId: installId(storage),
        },
        signal ? { signal } : {},
      );
    },
  };
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
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "work";
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
