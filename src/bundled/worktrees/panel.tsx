import type { Context } from "@deepseek-ai/cordis";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
type RefreshListener = (invalidate: boolean) => void;
const refreshListeners = new Map<string, Set<RefreshListener>>();

function subscribeToRefresh(channelId: string, listener: RefreshListener) {
  const listeners = refreshListeners.get(channelId) ?? new Set();
  listeners.add(listener);
  refreshListeners.set(channelId, listeners);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) refreshListeners.delete(channelId);
  };
}

/** Refreshes an already-open diff panel; opening a closed panel loads normally. */
export function refreshWorktreeDiff(channelId: string, invalidate = false) {
  for (const listener of refreshListeners.get(channelId) ?? [])
    listener(invalidate);
}

export function worktreeDiffTarget(channelId: string) {
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
    result?: WorktreeDiff;
    error?: Error;
  }>();
  const request = useRef<AbortController | undefined>(undefined);
  const load = useCallback(
    (invalidate = false) => {
      if (!channelId) return;
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setState((current) => {
        if (invalidate || current?.channelId !== channelId) return undefined;
        if (!current.error) return current;
        const { error: _error, ...withoutError } = current;
        return withoutError;
      });
      worktrees.diff(channelId, controller.signal).then(
        (result) => {
          if (!controller.signal.aborted) setState({ channelId, result });
        },
        (reason: unknown) => {
          if (controller.signal.aborted) return;
          setState((current) => ({
            ...(current?.channelId === channelId ? current : { channelId }),
            error: new Error(message(reason)),
          }));
        },
      );
    },
    [worktrees, channelId],
  );
  useEffect(() => {
    if (!channelId) return;
    const unsubscribe = subscribeToRefresh(channelId, load);
    load();
    return () => {
      unsubscribe();
      request.current?.abort();
    };
  }, [channelId, load]);
  const current = state?.channelId === channelId ? state : undefined;
  const result = current?.result;
  const error = current?.error;
  const files = useMemo(
    () => (result ? parsePatch(result.content) : undefined),
    [result],
  );
  if (!channelId)
    return <p role="alert">This local diff is no longer attached to a chat.</p>;
  return (
    <div className={styles.root}>
      <LoadingRegion
        pending={result === undefined && error === undefined}
        label="Loading local changes…"
        feedback={error ? <p role="alert">{error.message}</p> : null}
      >
        {result && (
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
      eligible: (channel) => worktrees.canDiff(channel.id),
    },
    channelPlacement: "side",
    component: (props) => (
      <WorktreeDiffPanel {...props} worktrees={worktrees} />
    ),
  });
  ctx.conversation.registerChatMenu(({ channelId }) =>
    worktrees.canDiff(channelId) ? (
      <MenuItem
        onClick={() => {
          refreshWorktreeDiff(channelId);
          ctx.panels.requestOpen({
            channelId,
            target: worktreeDiffTarget(channelId),
          });
        }}
      >
        <MenuIcon>
          <GitBranchIcon size={14} />
        </MenuIcon>
        View local changes
      </MenuItem>
    ) : null,
  );
}
