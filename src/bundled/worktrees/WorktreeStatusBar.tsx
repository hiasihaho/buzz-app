import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowsClockwiseIcon,
  CheckCircleIcon,
  CircleDashedIcon,
  CopyIcon,
  FileTextIcon,
  GitBranchIcon,
  GitCommitIcon,
  WarningCircleIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  PopoverDescription,
  PopoverPopup,
  PopoverRoot,
  PopoverTitle,
  PopoverTrigger,
} from "../../shared/design-system/ui/Popover";
import { writeClipboardText } from "../../shared/clipboard";
import type { WorktreeSummary, Worktrees } from "./service";
import styles from "./WorktreeStatusBar.module.css";

type State =
  | Readonly<{ channelId: string; status: "loading" }>
  | Readonly<{ channelId: string; status: "ready"; summary: WorktreeSummary }>
  | Readonly<{ channelId: string; status: "error"; message: string }>;

function message(reason: unknown) {
  return reason instanceof Error
    ? reason.message
    : "The local worktree status could not be loaded";
}

function repositoryName(path: string) {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .at(-1) || path
  );
}

function countLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function WorktreeStatusBar({
  channelId,
  worktrees,
  openDiff,
}: {
  channelId: string;
  worktrees: Worktrees;
  openDiff(): void;
}) {
  const available = worktrees.has(channelId);
  const [stored, setStored] = useState<State>({
    channelId,
    status: "loading",
  });
  const [copyStatus, setCopyStatus] = useState("");
  const request = useRef<AbortController | undefined>(undefined);
  const refresh = useCallback(() => {
    request.current?.abort();
    if (!available) return;
    const controller = new AbortController();
    request.current = controller;
    setCopyStatus("");
    setStored({ channelId, status: "loading" });
    worktrees.summary(channelId, controller.signal).then(
      (summary) => {
        if (!controller.signal.aborted)
          setStored({ channelId, status: "ready", summary });
      },
      (reason: unknown) => {
        if (!controller.signal.aborted)
          setStored({
            channelId,
            status: "error",
            message: message(reason),
          });
      },
    );
  }, [available, channelId, worktrees]);
  useEffect(() => {
    refresh();
    return () => request.current?.abort();
  }, [refresh]);

  if (!available) return null;
  const state: State =
    stored.channelId === channelId ? stored : { channelId, status: "loading" };
  const summary = state.status === "ready" ? state.summary : undefined;
  const fileCount = summary?.status.fileCount ?? 0;
  const ahead = summary?.status.ahead;
  const unpublished = summary?.unpublishedCommits;
  const changed = summary?.status.dirty;
  const statusLabel =
    state.status === "loading"
      ? "Checking local worktree"
      : state.status === "error"
        ? "Local worktree needs attention"
        : changed
          ? countLabel(fileCount, "changed file")
          : "Local worktree is clean";
  const StatusIcon =
    state.status === "error"
      ? WarningCircleIcon
      : changed
        ? CircleDashedIcon
        : CheckCircleIcon;

  return (
    <section className={styles.root} aria-label="Local worktree status">
      <div className={styles.identity} title={summary?.path}>
        <GitBranchIcon size={14} aria-hidden="true" />
        {summary ? (
          <>
            <strong>{repositoryName(summary.repository)}</strong>
            <span aria-hidden="true">/</span>
            <span>{summary.branch}</span>
            <span className={styles.base}>Base {summary.baseRef}</span>
          </>
        ) : (
          <span>{statusLabel}</span>
        )}
      </div>
      <div className={styles.actions}>
        <span className={styles.state} role="status" title={statusLabel}>
          <StatusIcon size={14} aria-hidden="true" />
          <span>
            {state.status === "loading"
              ? "Checking…"
              : changed
                ? "Changed"
                : state.status === "error"
                  ? "Check needed"
                  : "Clean"}
          </span>
        </span>
        <Button
          size="inline"
          variant="ghost"
          aria-label={
            summary
              ? `View ${countLabel(fileCount, "changed file")} in local changes`
              : "View local changes"
          }
          onClick={openDiff}
          disabled={!summary}
          title={summary ? "View local changes" : "Local changes are loading"}
        >
          <FileTextIcon size={14} aria-hidden="true" />
          <span>{fileCount}</span>
        </Button>
        <PopoverRoot>
          <PopoverTrigger
            disabled={!summary}
            render={
              <Button
                size="inline"
                variant="ghost"
                aria-label={
                  ahead === undefined
                    ? "Local commit details"
                    : `${countLabel(ahead, "local commit")}; show details`
                }
                title="Local commit details"
              >
                <GitCommitIcon size={14} aria-hidden="true" />
                <span>{ahead ?? unpublished ?? "—"}</span>
              </Button>
            }
          />
          <PopoverPopup side="top" align="end" size="compact">
            <PopoverTitle>Local commits</PopoverTitle>
            <PopoverDescription>
              {ahead === undefined
                ? `Commits ahead of ${summary?.baseRef ?? "the base"} could not be determined.`
                : `${countLabel(ahead, "commit")} ahead of ${summary?.baseRef}.`}{" "}
              {unpublished === undefined
                ? "Remote-tracking evidence is unavailable."
                : `${countLabel(unpublished, "commit")} not found on a local remote-tracking branch.`}
              {" This is informational and does not block safe finish."}
            </PopoverDescription>
          </PopoverPopup>
        </PopoverRoot>
        <IconButton
          size="xs"
          variant="ghost"
          disabled={!summary}
          aria-label="Copy worktree path"
          title={summary ? "Copy worktree path" : "Worktree path is loading"}
          icon={<CopyIcon size={13} aria-hidden="true" />}
          onClick={() => {
            if (!summary) return;
            void writeClipboardText(summary.path).then(
              () => setCopyStatus("Worktree path copied"),
              () => setCopyStatus("Worktree path could not be copied"),
            );
          }}
        />
        <IconButton
          size="xs"
          variant="ghost"
          onClick={refresh}
          aria-label="Refresh local worktree status"
          title="Refresh local worktree status"
          loading={state.status === "loading"}
          icon={<ArrowsClockwiseIcon size={13} />}
        />
      </div>
      {state.status === "error" && (
        <span className={styles.error} role="alert">
          {state.message}
        </span>
      )}
      <span className="sr-only" role="status">
        {copyStatus}
      </span>
    </section>
  );
}
