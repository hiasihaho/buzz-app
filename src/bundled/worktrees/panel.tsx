import type { Context } from "@deepseek-ai/cordis";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PanelProps } from "../../features/panels/service";
import { usePanelTabTitle } from "../../features/panels/PanelWorkspace";
import { GitBranchIcon } from "../../shared/design-system/icons";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { MenuIcon, MenuItem } from "../../shared/design-system/ui/Menu";
import { DiffViewer } from "../diffs/DiffViewer";
import { parsePatch } from "../diffs/parse";
import type {
  WorktreeDiff,
  WorktreeDiffComparison,
  Worktrees,
} from "./service";
import styles from "./WorktreeDiffPanel.module.css";

const targetPrefix = "buzz:worktree-diff:";
const tabIcon = <GitBranchIcon size="1rem" />;
type RefreshListener = (
  invalidate: boolean,
  comparison?: WorktreeDiffComparison,
) => void;
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
export function refreshWorktreeDiff(
  channelId: string,
  invalidate = false,
  comparison?: WorktreeDiffComparison,
) {
  for (const listener of refreshListeners.get(channelId) ?? [])
    listener(invalidate, comparison);
}

export function worktreeDiffTarget(
  channelId: string,
  comparison: WorktreeDiffComparison = "uncommitted",
) {
  return `${targetPrefix}${channelId}${comparison === "since-base" ? ":since-base" : ""}`;
}

function targetComparison(target: string | undefined): WorktreeDiffComparison {
  return target?.endsWith(":since-base") ? "since-base" : "uncommitted";
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
  target,
}: Pick<PanelProps, "context" | "channelContext"> &
  Partial<Pick<PanelProps, "target">> & { worktrees: Worktrees }) {
  const comparison = targetComparison(target);
  usePanelTabTitle(
    comparison === "since-base" ? "Branch diff" : "Local changes",
    tabIcon,
  );
  const channelId = context?.channelId ?? channelContext?.channelId;
  const [state, setState] = useState<{
    channelId: string;
    comparison: WorktreeDiffComparison;
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
        if (
          invalidate ||
          current?.channelId !== channelId ||
          current.comparison !== comparison
        )
          return undefined;
        if (!current.error) return current;
        const { error: _error, ...withoutError } = current;
        return withoutError;
      });
      worktrees.diff(channelId, controller.signal, comparison).then(
        (result) => {
          if (!controller.signal.aborted)
            setState({ channelId, comparison, result });
        },
        (reason: unknown) => {
          if (controller.signal.aborted) return;
          setState((current) => ({
            ...(current?.channelId === channelId &&
            current.comparison === comparison
              ? current
              : { channelId, comparison }),
            error: new Error(message(reason)),
          }));
        },
      );
    },
    [worktrees, channelId, comparison],
  );
  useEffect(() => {
    if (!channelId) return;
    const unsubscribe = subscribeToRefresh(
      channelId,
      (invalidate, requestedComparison) => {
        if (!requestedComparison || requestedComparison === comparison)
          load(invalidate);
      },
    );
    load();
    return () => {
      unsubscribe();
      request.current?.abort();
    };
  }, [channelId, load, comparison]);
  const current =
    state && state.channelId === channelId && state.comparison === comparison
      ? state
      : undefined;
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
            <p className={styles.location}>
              <strong>{result.branch}</strong>
              {result.comparison === "since-base" && (
                <>
                  <span>
                    Changes since the merge base with {result.baseRef}
                  </span>
                  <span className={styles.evidence}>
                    {result.status.ahead === undefined
                      ? `Commits ahead of ${result.baseRef} could not be determined.`
                      : `${result.status.ahead} ${result.status.ahead === 1 ? "commit" : "commits"} ahead of ${result.baseRef}.`}{" "}
                    {result.unpublishedCommits === undefined
                      ? "Remote-tracking evidence is unavailable."
                      : `${result.unpublishedCommits} ${result.unpublishedCommits === 1 ? "commit" : "commits"} not found on a local remote-tracking branch.`}{" "}
                    This evidence is informational.
                  </span>
                </>
              )}
              <span title={result.path}>{result.path}</span>
            </p>
            {result.content ? (
              <DiffViewer content={result.content} files={files} />
            ) : (
              <p role="status" className={styles.empty}>
                {result.status.dirty
                  ? `No tracked diff. Git reports ${result.status.fileCount} changed or untracked ${result.status.fileCount === 1 ? "file" : "files"}.`
                  : result.comparison === "since-base"
                    ? `No changes since the merge base with ${result.baseRef}.`
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
          refreshWorktreeDiff(channelId, false, "uncommitted");
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
