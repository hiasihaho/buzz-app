// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { writeClipboardText } from "../../shared/clipboard";
import type { WorktreeSummary, Worktrees } from "./service";
import { WorktreeStatusBar } from "./WorktreeStatusBar";

vi.mock("../../shared/clipboard", () => ({
  writeClipboardText: vi.fn(async () => {}),
}));

afterEach(cleanup);

const summary: WorktreeSummary = {
  repository: "/repos/example",
  path: "/trees/example-task",
  branch: "buzz/example-task",
  baseRef: "origin/main",
  unpublishedCommits: 2,
  status: {
    state: "ready",
    path: "/trees/example-task",
    head: "a".repeat(40),
    branch: "buzz/example-task",
    detached: false,
    dirty: true,
    fileCount: 3,
    ahead: 2,
    behind: 0,
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function service(
  load: Worktrees["summary"] = vi.fn(async () => summary),
  available = true,
): Worktrees {
  return {
    has: () => available,
    summary: load,
    diff: async () => ({
      content: "",
      path: summary.path,
      branch: summary.branch,
      status: summary.status,
    }),
    workspace: () => undefined,
    prepare: async () => undefined,
  };
}

it("shows repository status and opens the diff and commit details", async () => {
  const user = userEvent.setup();
  const openDiff = vi.fn();
  const load = vi.fn(async () => summary);
  render(
    <WorktreeStatusBar
      channelId="channel"
      worktrees={service(load)}
      openDiff={openDiff}
      agentWorking={false}
    />,
  );

  expect(await screen.findByText("example")).toBeVisible();
  expect(screen.getByText("buzz/example-task")).toBeVisible();
  expect(screen.getByText("Base origin/main")).toBeVisible();
  expect(screen.getByText("Changed")).toBeVisible();

  await user.click(
    screen.getByRole("button", { name: /View 3 changed files/ }),
  );
  expect(openDiff).toHaveBeenCalledOnce();

  await user.click(screen.getByRole("button", { name: /2 local commits/ }));
  expect(await screen.findByText("Local commits")).toBeVisible();
  expect(screen.getByText(/2 commits ahead of origin\/main/)).toBeVisible();
  expect(screen.getByText(/evidence is informational/)).toBeVisible();

  await user.click(screen.getByRole("button", { name: "Copy worktree path" }));
  expect(writeClipboardText).toHaveBeenCalledWith(summary.path);
  expect(await screen.findByText("Worktree path copied")).toHaveClass(
    "sr-only",
  );

  await user.click(
    screen.getByRole("button", { name: "Refresh local worktree status" }),
  );
  expect(load).toHaveBeenCalledTimes(2);
});

it("does not load or render without a local binding", () => {
  const load = vi.fn(async () => summary);
  const { container } = render(
    <WorktreeStatusBar
      channelId="missing"
      worktrees={service(load, false)}
      openDiff={() => {}}
      agentWorking={false}
    />,
  );
  expect(container).toBeEmptyDOMElement();
  expect(load).not.toHaveBeenCalled();
});

it("keeps a failed refresh visible and retryable", async () => {
  const user = userEvent.setup();
  const load = vi
    .fn<Worktrees["summary"]>()
    .mockRejectedValueOnce(new Error("Repository identity changed"))
    .mockResolvedValueOnce(summary);
  render(
    <WorktreeStatusBar
      channelId="channel"
      worktrees={service(load)}
      openDiff={() => {}}
      agentWorking={false}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Repository identity changed",
  );
  expect(
    screen.getByRole("button", { name: "View local changes" }),
  ).toBeDisabled();

  await user.click(
    screen.getByRole("button", {
      name: "Local worktree needs attention; show reason",
    }),
  );
  await waitFor(() =>
    expect(screen.getAllByText("Repository identity changed")).toHaveLength(2),
  );

  await user.click(
    screen.getByRole("button", { name: "Refresh local worktree status" }),
  );
  expect(await screen.findByText("buzz/example-task")).toBeVisible();
});

it("refreshes on focus without replacing the last summary", async () => {
  const next = deferred<WorktreeSummary>();
  const load = vi
    .fn<Worktrees["summary"]>()
    .mockResolvedValueOnce(summary)
    .mockReturnValueOnce(next.promise);
  render(
    <WorktreeStatusBar
      channelId="channel"
      worktrees={service(load)}
      openDiff={() => {}}
      agentWorking={false}
    />,
  );
  expect(await screen.findByText("buzz/example-task")).toBeVisible();

  act(() => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  expect(screen.getByText("buzz/example-task")).toBeVisible();
  expect(
    screen.getByRole("button", { name: /View 3 changed files/ }),
  ).toBeEnabled();

  next.resolve(summary);
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
});

it("refreshes when agent work ends", async () => {
  const load = vi.fn(async () => summary);
  const trees = service(load);
  const view = render(
    <WorktreeStatusBar
      channelId="channel"
      worktrees={trees}
      openDiff={() => {}}
      agentWorking={false}
    />,
  );
  expect(await screen.findByText("buzz/example-task")).toBeVisible();

  view.rerender(
    <WorktreeStatusBar
      channelId="channel"
      worktrees={trees}
      openDiff={() => {}}
      agentWorking
    />,
  );
  view.rerender(
    <WorktreeStatusBar
      channelId="channel"
      worktrees={trees}
      openDiff={() => {}}
      agentWorking={false}
    />,
  );
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
});

it("aborts and ignores a stale channel request", async () => {
  const first = deferred<WorktreeSummary>();
  const second = deferred<WorktreeSummary>();
  const signals: AbortSignal[] = [];
  const load = vi.fn<Worktrees["summary"]>((channelId, signal) => {
    if (signal) signals.push(signal);
    return channelId === "first" ? first.promise : second.promise;
  });
  const trees = service(load);
  const view = render(
    <WorktreeStatusBar
      channelId="first"
      worktrees={trees}
      openDiff={() => {}}
      agentWorking={false}
    />,
  );
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));

  view.rerender(
    <WorktreeStatusBar
      channelId="second"
      worktrees={trees}
      openDiff={() => {}}
      agentWorking={false}
    />,
  );
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  expect(signals[0]?.aborted).toBe(true);

  first.resolve({ ...summary, branch: "buzz/stale" });
  second.resolve({ ...summary, branch: "buzz/current" });
  expect(await screen.findByText("buzz/current")).toBeVisible();
  expect(screen.queryByText("buzz/stale")).not.toBeInTheDocument();
});

it("aborts the current request when unmounted", async () => {
  const pending = deferred<WorktreeSummary>();
  let signal: AbortSignal | undefined;
  const load = vi.fn<Worktrees["summary"]>((_channelId, nextSignal) => {
    signal = nextSignal;
    return pending.promise;
  });
  const view = render(
    <WorktreeStatusBar
      channelId="channel"
      worktrees={service(load)}
      openDiff={() => {}}
      agentWorking={false}
    />,
  );
  await waitFor(() => expect(load).toHaveBeenCalledOnce());

  view.unmount();
  expect(signal?.aborted).toBe(true);
});
