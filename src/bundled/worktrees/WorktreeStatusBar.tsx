import { useCallback, useEffect, useRef, useState } from "react";
import type { ChannelCanvas } from "../../features/channel-templates/capability";
import type { RelaySession } from "../../features/relay/session";
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
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
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
import type { FinishBlocker, WorkspaceFinishPreview } from "./finish";
import {
  removedWorkspaceCanvas,
  type WorktreeSummary,
  type Worktrees,
} from "./service";
import { workspaceAgents } from "./usage";
import styles from "./WorktreeStatusBar.module.css";

type State =
  | Readonly<{ channelId: string; status: "loading" }>
  | Readonly<{ channelId: string; status: "ready"; summary: WorktreeSummary }>
  | Readonly<{
      channelId: string;
      status: "error";
      message: string;
      summary?: WorktreeSummary;
    }>;

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

function Blocker({ blocker }: { blocker: FinishBlocker }) {
  const paths = blocker.paths ?? [];
  const shown = paths.slice(0, 10);
  return (
    <li>
      <strong>{blocker.message}</strong>
      {shown.length > 0 && (
        <ul>
          {shown.map((path) => (
            <li key={path}>
              <code>{path}</code>
            </li>
          ))}
          {paths.length > shown.length && (
            <li>{countLabel(paths.length - shown.length, "other path")}</li>
          )}
        </ul>
      )}
    </li>
  );
}

export function WorktreeStatusBar({
  channelId,
  worktrees,
  openDiff,
  agentWorking,
  session,
  canvas,
}: {
  channelId: string;
  worktrees: Worktrees;
  openDiff(): void;
  agentWorking: boolean;
  session: Pick<RelaySession, "agentActivity" | "typing" | "agentChoices">;
  canvas: ChannelCanvas;
}) {
  const available = worktrees.has(channelId);
  const [stored, setStored] = useState<State>({
    channelId,
    status: "loading",
  });
  const [busy, setBusy] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const [finish, setFinish] = useState<
    | { status: "loading" }
    | { status: "ready"; preview: WorkspaceFinishPreview }
    | { status: "error"; message: string }
  >();
  const [removing, setRemoving] = useState(false);
  const [canvasError, setCanvasError] = useState("");
  const cancel = useRef<HTMLButtonElement>(null);
  const request = useRef<AbortController | undefined>(undefined);
  const refresh = useCallback(() => {
    request.current?.abort();
    if (!available) {
      setBusy(false);
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setCopyStatus("");
    setStored((current) => {
      if (current.channelId !== channelId)
        return { channelId, status: "loading" };
      return current;
    });
    worktrees.summary(channelId, controller.signal).then(
      (summary) => {
        if (controller.signal.aborted) return;
        setStored({ channelId, status: "ready", summary });
        if (request.current === controller) setBusy(false);
      },
      (reason: unknown) => {
        if (controller.signal.aborted) return;
        setStored((current) => ({
          channelId,
          status: "error",
          message: message(reason),
          ...(current.channelId === channelId && "summary" in current
            ? { summary: current.summary }
            : {}),
        }));
        if (request.current === controller) setBusy(false);
      },
    );
  }, [available, channelId, worktrees]);
  const loadPreview = useCallback(async () => {
    setFinish({ status: "loading" });
    try {
      const preview = await worktrees.previewFinish(channelId, () =>
        workspaceAgents(session, channelId),
      );
      setFinish({ status: "ready", preview });
    } catch (reason) {
      setFinish({ status: "error", message: message(reason) });
    }
  }, [channelId, session, worktrees]);
  const updateCanvas = useCallback(
    async (
      workspace: Pick<
        WorktreeSummary,
        "path" | "branch" | "baseRef" | "baseSha"
      > &
        ({ repository: string } | { repoRoot: string }),
    ) => {
      const head = await canvas.read(channelId);
      if (!head) throw new Error("Canvas could not be read");
      const content = removedWorkspaceCanvas(head.content, {
        ...workspace,
        repoRoot:
          "repoRoot" in workspace ? workspace.repoRoot : workspace.repository,
      });
      if (content !== head.content)
        await canvas.save(channelId, content, head.id);
      setCanvasError("");
    },
    [canvas, channelId],
  );
  useEffect(() => {
    refresh();
    return () => request.current?.abort();
  }, [refresh]);
  useEffect(() => {
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);
  const previousWork = useRef({ channelId, agentWorking });
  useEffect(() => {
    const previous = previousWork.current;
    previousWork.current = { channelId, agentWorking };
    if (
      previous.channelId === channelId &&
      previous.agentWorking &&
      !agentWorking
    )
      refresh();
  }, [agentWorking, channelId, refresh]);
  useEffect(() => {
    if (
      stored.channelId !== channelId ||
      !("summary" in stored) ||
      stored.summary?.lifecycle !== "removed"
    )
      return;
    void updateCanvas(stored.summary).catch((reason) =>
      setCanvasError(
        `Worktree removed, but Canvas could not be updated: ${message(reason)}`,
      ),
    );
  }, [channelId, stored, updateCanvas]);

  if (!available) return null;
  const state: State =
    stored.channelId === channelId ? stored : { channelId, status: "loading" };
  const summary = "summary" in state ? state.summary : undefined;
  const fileCount = summary?.status?.fileCount ?? 0;
  const ahead = summary?.status?.ahead;
  const unpublished = summary?.unpublishedCommits;
  const changed = summary?.status?.dirty;
  const ready = summary?.lifecycle === "ready";
  const removed = summary?.lifecycle === "removed";
  const recovery = summary?.lifecycle === "removing";
  const statusLabel =
    state.status === "loading"
      ? "Checking local worktree"
      : state.status === "error"
        ? "Local worktree needs attention"
        : changed
          ? countLabel(fileCount, "changed file")
          : "Local worktree is clean";
  const StatusIcon =
    state.status === "loading"
      ? CircleDashedIcon
      : state.status === "error"
        ? WarningCircleIcon
        : changed
          ? CircleDashedIcon
          : CheckCircleIcon;

  const confirmRemoval = async () => {
    if (finish?.status !== "ready" || !finish.preview.head || !summary) return;
    setRemoving(true);
    try {
      await worktrees.remove(channelId, finish.preview.head, () =>
        workspaceAgents(session, channelId),
      );
      try {
        await updateCanvas(summary);
      } catch (reason) {
        setCanvasError(
          `Worktree removed, but Canvas could not be updated: ${message(reason)}`,
        );
      }
      setFinish(undefined);
      refresh();
    } catch {
      await loadPreview();
    } finally {
      setRemoving(false);
    }
  };
  const recover = async () => {
    setBusy(true);
    try {
      const binding = await worktrees.recover(channelId);
      if (binding.state === "removed") {
        try {
          await updateCanvas(binding);
        } catch (reason) {
          setCanvasError(
            `Worktree removed, but Canvas could not be updated: ${message(reason)}`,
          );
        }
      }
    } catch (reason) {
      setCanvasError(message(reason));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  return (
    <>
      <section className={styles.root} aria-label="Local worktree status">
        <div className={styles.identity} title={summary?.path}>
          <GitBranchIcon size={14} aria-hidden="true" />
          {summary ? (
            <>
              <strong>{repositoryName(summary.repository)}</strong>
              <span aria-hidden="true">/</span>
              <span>{summary.branch}</span>
              {ready && (
                <span className={styles.base}>Base {summary.baseRef}</span>
              )}
            </>
          ) : (
            <span>{statusLabel}</span>
          )}
        </div>
        <div className={styles.actions}>
          {removed ? (
            <span className={styles.state} role="status">
              Worktree removed; branch {summary?.branch} remains
            </span>
          ) : recovery ? (
            <>
              <span className={styles.state}>Removal needs checking</span>
              <Button
                size="inline"
                variant="ghost"
                onClick={() => void recover()}
                loading={busy}
              >
                Check again
              </Button>
            </>
          ) : (
            <>
              {state.status === "error" ? (
                <span className={styles.state}>
                  <WarningCircleIcon size={14} aria-hidden="true" />
                  <span className={styles.statusText}>Check needed</span>
                </span>
              ) : (
                <span
                  className={styles.state}
                  role="status"
                  title={statusLabel}
                >
                  <StatusIcon size={14} aria-hidden="true" />
                  <span className={styles.statusText}>
                    {state.status === "loading"
                      ? "Checking…"
                      : changed
                        ? "Changed"
                        : "Clean"}
                  </span>
                </span>
              )}
              <Button
                size="inline"
                variant="ghost"
                aria-label={
                  summary
                    ? `View ${countLabel(fileCount, "changed file")} in local changes`
                    : "View local changes"
                }
                onClick={openDiff}
                disabled={!ready}
              >
                <FileTextIcon size={14} aria-hidden="true" />
                <span>{fileCount}</span>
              </Button>
              <PopoverRoot>
                <PopoverTrigger
                  disabled={!ready}
                  render={
                    <Button
                      size="inline"
                      variant="ghost"
                      aria-label={
                        ahead === undefined
                          ? "Local commit details"
                          : `${countLabel(ahead, "local commit")}; show details`
                      }
                    >
                      <GitCommitIcon size={14} aria-hidden="true" />
                      <span>{ahead ?? "—"}</span>
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
                      : `${countLabel(unpublished, "commit")} not found on a local remote-tracking branch.`}{" "}
                    This evidence is informational.
                  </PopoverDescription>
                </PopoverPopup>
              </PopoverRoot>
              <IconButton
                size="xs"
                variant="ghost"
                disabled={!summary}
                aria-label="Copy worktree path"
                icon={<CopyIcon size={13} aria-hidden="true" />}
                onClick={() =>
                  summary &&
                  void writeClipboardText(summary.path).then(
                    () => setCopyStatus("Worktree path copied"),
                    () => setCopyStatus("Worktree path could not be copied"),
                  )
                }
              />
              <Button
                size="inline"
                variant="ghost"
                disabled={!ready}
                loading={finish?.status === "loading"}
                onClick={() => void loadPreview()}
              >
                Finish
              </Button>
              <IconButton
                size="xs"
                variant="ghost"
                onClick={refresh}
                aria-label="Refresh local worktree status"
                loading={busy}
                icon={<ArrowsClockwiseIcon size={13} />}
              />
            </>
          )}
        </div>
        {(state.status === "error" || canvasError) && (
          <span className={styles.error} role="alert">
            {canvasError || (state.status === "error" ? state.message : "")}
          </span>
        )}
        {removed && canvasError && summary && (
          <Button
            size="inline"
            variant="ghost"
            onClick={() =>
              void updateCanvas(summary).catch((reason) =>
                setCanvasError(message(reason)),
              )
            }
          >
            Retry Canvas update
          </Button>
        )}
        <span className="sr-only" role="status">
          {copyStatus}
        </span>
      </section>
      {finish && finish.status !== "loading" && (
        <AlertDialog
          title="Remove local worktree?"
          description="Branch, commits, and chat remain after the local folder is removed."
          onClose={() => !removing && setFinish(undefined)}
          pending={removing}
          initialFocus={cancel}
          actions={
            <>
              <Button
                ref={cancel}
                variant="subtle"
                onClick={() => setFinish(undefined)}
                disabled={removing}
              >
                Cancel
              </Button>
              {finish.status === "ready" &&
                finish.preview.blockers.length === 0 && (
                  <Button
                    variant="destructive"
                    onClick={() => void confirmRemoval()}
                    loading={removing}
                  >
                    Remove worktree
                  </Button>
                )}
            </>
          }
        >
          {finish.status === "error" ? (
            <p role="alert">{finish.message}</p>
          ) : (
            <>
              <dl className={styles.details}>
                <div>
                  <dt>Path</dt>
                  <dd>
                    <code>{finish.preview.path}</code>
                  </dd>
                </div>
                <div>
                  <dt>Branch</dt>
                  <dd>
                    <code>{finish.preview.branch}</code>
                  </dd>
                </div>
                <div>
                  <dt>HEAD</dt>
                  <dd>
                    <code>{finish.preview.head?.slice(0, 8) ?? "Unknown"}</code>
                  </dd>
                </div>
                <div>
                  <dt>Not on a remote</dt>
                  <dd>
                    {finish.preview.unpublishedCommits === undefined
                      ? "Unknown"
                      : countLabel(finish.preview.unpublishedCommits, "commit")}
                  </dd>
                </div>
              </dl>
              <p>
                Buzz cannot see terminals, editors, or other programs using this
                folder. Close them before removing it.
              </p>
              {finish.preview.blockers.length > 0 && (
                <div role="alert">
                  <strong>This worktree cannot be removed yet:</strong>
                  <ul className={styles.blockers}>
                    {finish.preview.blockers.map((blocker) => (
                      <Blocker
                        key={`${blocker.kind}:${blocker.message}`}
                        blocker={blocker}
                      />
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </AlertDialog>
      )}
    </>
  );
}
