// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { writeClipboardText } from "../../shared/clipboard";
import {
  preparedWorkspaceCanvas,
  type WorktreeSummary,
  type Worktrees,
} from "./service";
import { WorktreeStatusBar } from "./WorktreeStatusBar";

vi.mock("../../shared/clipboard", () => ({
  writeClipboardText: vi.fn(async () => {}),
}));

afterEach(cleanup);

const head = "a".repeat(40);
const readyStatus = {
  state: "ready" as const,
  path: "/trees/example-task",
  head,
  branch: "buzz/example-task",
  detached: false,
  dirty: true,
  fileCount: 3,
  ahead: 2,
  behind: 0,
};

const summary: WorktreeSummary = {
  repository: "/repos/example",
  path: "/trees/example-task",
  branch: "buzz/example-task",
  baseRef: "origin/main",
  baseSha: "b".repeat(40),
  unpublishedCommits: 2,
  lifecycle: "ready",
  status: readyStatus,
};

const session = {
  agentActivity: {
    subscribe: () => () => {},
    snapshot: () => ({
      status: "listening",
      records: [],
      turns: [],
      typing: [],
      trimmed: 0,
    }),
  },
  typing: { subscribe: () => () => {}, snapshot: () => [] },
  agentChoices: {
    subscribe: () => () => {},
    snapshot: () => ({ identities: [] }),
  },
} as never;
const canvas = { read: vi.fn(), save: vi.fn() } as never;

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
  overrides: Partial<Worktrees> = {},
): Worktrees {
  return {
    has: () => available,
    canDiff: () => available,
    summary: load,
    diff: async () => ({
      content: "",
      path: summary.path,
      branch: summary.branch,
      status: readyStatus,
    }),
    workspace: () => undefined,
    prepare: async () => undefined,
    previewFinish: async () => ({
      bindingId: "binding",
      path: summary.path,
      branch: summary.branch,
      head: head,
      blockers: [],
    }),
    remove: async () => {
      throw new Error("not implemented");
    },
    recover: async () => {
      throw new Error("not implemented");
    },
    ...overrides,
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
      session={session}
      canvas={canvas}
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

it("shows blocker paths and withholds destructive confirmation", async () => {
  const user = userEvent.setup();
  const previewFinish = vi.fn(async () => ({
    bindingId: "binding",
    path: summary.path,
    branch: summary.branch,
    head: head,
    unpublishedCommits: 2,
    blockers: [
      {
        kind: "dirty" as const,
        message: "Worktree has tracked or untracked changes",
        count: 12,
        paths: Array.from({ length: 12 }, (_, index) => `file-${index}.txt`),
      },
    ],
  }));
  render(
    <WorktreeStatusBar
      channelId="channel"
      worktrees={service(undefined, true, { previewFinish })}
      openDiff={() => {}}
      agentWorking={false}
      session={session}
      canvas={canvas}
    />,
  );
  await screen.findByText("buzz/example-task");
  await user.click(screen.getByRole("button", { name: "Finish" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "cannot be removed",
  );
  expect(screen.getByText("file-0.txt")).toBeVisible();
  expect(screen.getByText("2 other paths")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Remove worktree" }),
  ).not.toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus(),
  );
});

it("removes the exact previewed HEAD and updates Canvas", async () => {
  const user = userEvent.setup();
  const remove = vi.fn(async () => ({ state: "removed" as const }) as never);
  const prepared = preparedWorkspaceCanvas(
    { folders: ["/repo"], canvas: "Keep this authored text." },
    {
      bindingId: "binding",
      channelId: "channel",
      repoRoot: summary.repository,
      worktreeRoot: "/trees",
      path: summary.path,
      branch: summary.branch,
      baseRef: summary.baseRef,
      baseSha: "b".repeat(40),
      gitCommonDir: "/repo/.git",
      createdAt: 1,
      installId: "install",
      owned: true,
      state: "ready",
    },
  );
  const canvasFixture = {
    read: vi.fn(async () => ({ id: "canvas-head", content: prepared })),
    save: vi.fn(async () => ({ id: "saved" })),
  } as never;
  render(
    <WorktreeStatusBar
      channelId="channel"
      worktrees={service(undefined, true, { remove })}
      openDiff={() => {}}
      agentWorking={false}
      session={session}
      canvas={canvasFixture}
    />,
  );
  await screen.findByText("buzz/example-task");
  await user.click(screen.getByRole("button", { name: "Finish" }));
  await user.click(
    await screen.findByRole("button", { name: "Remove worktree" }),
  );

  await waitFor(() =>
    expect(remove).toHaveBeenCalledWith("channel", head, expect.any(Function)),
  );
  expect(
    (canvasFixture as { save: ReturnType<typeof vi.fn> }).save,
  ).toHaveBeenCalledWith(
    "channel",
    expect.not.stringContaining(summary.path),
    "canvas-head",
  );
});

it("replaces confirmation with fresh blockers when HEAD changes", async () => {
  const user = userEvent.setup();
  const previewFinish = vi
    .fn<Worktrees["previewFinish"]>()
    .mockResolvedValueOnce({
      bindingId: "binding",
      path: summary.path,
      branch: summary.branch,
      head: head,
      blockers: [],
    })
    .mockResolvedValueOnce({
      bindingId: "binding",
      path: summary.path,
      branch: summary.branch,
      head: "c".repeat(40),
      blockers: [{ kind: "dirty", message: "Worktree HEAD changed" }],
    });
  const remove = vi.fn(async () => {
    throw new Error("Worktree HEAD changed since finish preview");
  });
  render(
    <WorktreeStatusBar
      channelId="channel"
      worktrees={service(undefined, true, { previewFinish, remove })}
      openDiff={() => {}}
      agentWorking={false}
      session={session}
      canvas={canvas}
    />,
  );
  await screen.findByText("buzz/example-task");
  await user.click(screen.getByRole("button", { name: "Finish" }));
  await user.click(
    await screen.findByRole("button", { name: "Remove worktree" }),
  );

  expect(await screen.findByText("Worktree HEAD changed")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Remove worktree" }),
  ).not.toBeInTheDocument();
});

it("does not load or render without a local binding", () => {
  const load = vi.fn(async () => summary);
  const { container } = render(
    <WorktreeStatusBar
      channelId="missing"
      worktrees={service(load, false)}
      openDiff={() => {}}
      agentWorking={false}
      session={session}
      canvas={canvas}
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
      session={session}
      canvas={canvas}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Repository identity changed",
  );
  expect(
    screen.getByRole("button", { name: "View local changes" }),
  ).toBeDisabled();

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
      session={session}
      canvas={canvas}
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
      session={session}
      canvas={canvas}
    />,
  );
  expect(await screen.findByText("buzz/example-task")).toBeVisible();

  view.rerender(
    <WorktreeStatusBar
      channelId="channel"
      worktrees={trees}
      openDiff={() => {}}
      agentWorking
      session={session}
      canvas={canvas}
    />,
  );
  view.rerender(
    <WorktreeStatusBar
      channelId="channel"
      worktrees={trees}
      openDiff={() => {}}
      agentWorking={false}
      session={session}
      canvas={canvas}
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
      session={session}
      canvas={canvas}
    />,
  );
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));

  view.rerender(
    <WorktreeStatusBar
      channelId="second"
      worktrees={trees}
      openDiff={() => {}}
      agentWorking={false}
      session={session}
      canvas={canvas}
    />,
  );
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  expect(signals[0]?.aborted).toBe(true);

  act(() => first.resolve({ ...summary, branch: "buzz/stale" }));
  expect(screen.queryByText("buzz/stale")).not.toBeInTheDocument();

  act(() => second.resolve({ ...summary, branch: "buzz/current" }));
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
      session={session}
      canvas={canvas}
    />,
  );
  await waitFor(() => expect(load).toHaveBeenCalledOnce());

  view.unmount();
  expect(signal?.aborted).toBe(true);
});
