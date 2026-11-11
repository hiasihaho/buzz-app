import type { Context } from "@deepseek-ai/cordis";
import { useEffect, useMemo, useState } from "react";
import type { PanelProps } from "../../features/panels/service";
import { usePanelTabTitle } from "../../features/panels/PanelWorkspace";
import { GitBranchIcon } from "../../shared/design-system/icons";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { MenuIcon, MenuItem } from "../../shared/design-system/ui/Menu";
import { DiffViewer } from "../diffs/DiffViewer";
import { parsePatch } from "../diffs/parse";
import type { WorktreeDiff, Worktrees } from "./service";
import styles from "./WorktreeDiffPanel.module.css";

const targetPrefix = "buzz:worktree-diff:";
const tabIcon = <GitBranchIcon size="1rem" />;

function target(channelId: string) {
  return `${targetPrefix}${channelId}`;
}

function message(reason: unknown) {
  return reason instanceof Error
    ? reason.message
    : "The local worktree diff could not be loaded";
}

export function WorktreeDiffPanel({
  worktrees,
  context,
  channelContext,
}: Pick<PanelProps, "context" | "channelContext"> & { worktrees: Worktrees }) {
  usePanelTabTitle("Local changes", tabIcon);
  const channelId = context?.channelId ?? channelContext?.channelId;
  const [state, setState] = useState<{
    channelId: string;
    result: WorktreeDiff | Error;
  }>();
  useEffect(() => {
    if (!channelId) return;
    const controller = new AbortController();
    worktrees.diff(channelId, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) setState({ channelId, result });
      },
      (reason: unknown) => {
        if (!controller.signal.aborted)
          setState({ channelId, result: new Error(message(reason)) });
      },
    );
    return () => controller.abort();
  }, [worktrees, channelId]);
  const result =
    state && state.channelId === channelId ? state.result : undefined;
  const files = useMemo(
    () =>
      result && !(result instanceof Error)
        ? parsePatch(result.content)
        : undefined,
    [result],
  );
  if (!channelId)
    return <p role="alert">This local diff is no longer attached to a chat.</p>;
  return (
    <div className={styles.root}>
      <LoadingRegion
        pending={result === undefined}
        label="Loading local changes…"
        feedback={
          result instanceof Error ? <p role="alert">{result.message}</p> : null
        }
      >
        {result && !(result instanceof Error) && (
          <>
            <p className={styles.location} title={result.path}>
              <strong>{result.branch}</strong>
              <span>{result.path}</span>
            </p>
            {result.content ? (
              <DiffViewer content={result.content} files={files} />
            ) : (
              <p role="status" className={styles.empty}>
                {result.status.dirty
                  ? `No tracked diff. Git reports ${result.status.fileCount} changed or untracked ${result.status.fileCount === 1 ? "file" : "files"}.`
                  : "The local worktree has no changes."}
              </p>
            )}
          </>
        )}
      </LoadingRegion>
    </div>
  );
}

/** Registers one read-only local-diff panel and its Solo chat-menu entry. */
export function registerWorktreeDiff(ctx: Context, worktrees: Worktrees) {
  ctx.panels.register({
    id: "worktree-diff",
    title: "Local changes",
    matches: (value) => value.startsWith(targetPrefix),
    channelMenu: {
      label: "View local changes",
      eligible: (channel) => worktrees.has(channel.id),
    },
    channelPlacement: "side",
    component: (props) => (
      <WorktreeDiffPanel {...props} worktrees={worktrees} />
    ),
  });
  ctx.conversation.registerChatMenu(({ channelId }) =>
    worktrees.has(channelId) ? (
      <MenuItem
        onClick={() =>
          ctx.panels.requestOpen({ channelId, target: target(channelId) })
        }
      >
        <MenuIcon>
          <GitBranchIcon size={14} />
        </MenuIcon>
        View local changes
      </MenuItem>
    ) : null,
  );
}
