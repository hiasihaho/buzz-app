// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { writeClipboardText } from "../../shared/clipboard";
import type { WorkspaceFinishPreview } from "./finish";
import {
  preparedWorkspaceCanvas,
  removedWorkspaceCanvas,
  type WorktreeSummary,
  type Worktrees,
} from "./service";
import { WorktreeDiffPanel } from "./panel";
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

function summaryForLifecycle(
  lifecycle: WorktreeSummary["lifecycle"],
): WorktreeSummary {
  const { status: _status, ...rest } = summary;
  return { ...rest, lifecycle };
}

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
    reopen: async () => {
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

  for (const [name, hint] of [
    [/View 3 changed files/, "View local changes"],
    [/2 local commits/, "Local commit details"],
    ["Copy worktree path", "Copy worktree path"],
    ["Refresh local worktree status", "Refresh local worktree status"],
  ] as const) {
    const button = screen.getByRole("button", { name });
    await user.hover(button);
    expect(await screen.findByRole("tooltip", { name: hint })).toBeVisible();
    await user.unhover(button);
  }

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

it("removes the exact previewed HEAD, updates Canvas, and invalidates an open diff", async () => {
  const user = userEvent.setup();
  let removed = false;
  const remove = vi.fn(async () => {
    removed = true;
    return { state: "removed" as const } as never;
  });
  const trees = service(
    async () => (removed ? summaryForLifecycle("removed") : summary),
    true,
    {
      remove,
      diff: async () => {
        if (removed) throw new Error("This chat has no ready local worktree");
        return {
          content: "",
          path: summary.path,
          branch: summary.branch,
          status: { ...readyStatus, dirty: false, fileCount: 0 },
        };
      },
    },
  );
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
    <>
      <WorktreeStatusBar
        channelId="channel"
        worktrees={trees}
        openDiff={() => {}}
        agentWorking={false}
        session={session}
        canvas={canvasFixture}
      />
      <WorktreeDiffPanel
        channelContext={{
          scope: "scope",
          channelId: "channel",
          channelName: "channel",
          viewer: "viewer",
          relayUrl: "https://relay.example",
        }}
        worktrees={trees}
      />
    </>,
  );
  expect(await screen.findAllByText("buzz/example-task")).toHaveLength(2);
  expect(
    await screen.findByText("The local worktree has no changes."),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Finish" }));
  await user.click(
    await screen.findByRole("button", { name: "Remove worktree" }),
  );

  await waitFor(() =>
    expect(remove).toHaveBeenCalledWith("channel", head, expect.any(Function)),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "This chat has no ready local worktree",
  );
  expect(
    screen.queryByText("The local worktree has no changes."),
  ).not.toBeInTheDocument();
  expect(
    (canvasFixture as { save: ReturnType<typeof vi.fn> }).save,
  ).toHaveBeenCalledWith(
    "channel",
    expect.not.stringContaining(summary.path),
    "canvas-head",
    { preserveApproval: true },
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

it("refreshes the status and an open diff when agent work ends", async () => {
  const load = vi.fn(async () => summary);
  let diffCount = 1;
  const diff = vi.fn(async () => ({
    content: "",
    path: summary.path,
    branch: summary.branch,
    status: { ...readyStatus, fileCount: diffCount },
  }));
  const trees = service(load, true, { diff });
  const content = (agentWorking: boolean) => (
    <>
      <WorktreeStatusBar
        channelId="channel"
        worktrees={trees}
        openDiff={() => {}}
        agentWorking={agentWorking}
        session={session}
        canvas={canvas}
      />
      <WorktreeDiffPanel
        channelContext={{
          scope: "scope",
          channelId: "channel",
          channelName: "channel",
          viewer: "viewer",
          relayUrl: "https://relay.example",
        }}
        worktrees={trees}
      />
    </>
  );
  const view = render(content(false));
  expect(await screen.findAllByText("buzz/example-task")).toHaveLength(2);
  expect(
    await screen.findByText(
      "No tracked diff. Git reports 1 changed or untracked file.",
    ),
  ).toBeVisible();
  const baselineDiffCalls = diff.mock.calls.length;

  diffCount = 2;
  view.rerender(content(true));
  view.rerender(content(false));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(diff.mock.calls.length).toBeGreaterThan(baselineDiffCalls),
  );
  expect(
    await screen.findByText(
      "No tracked diff. Git reports 2 changed or untracked files.",
    ),
  ).toBeVisible();
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

it("remounts chat-owned finish state when the channel changes", async () => {
  const user = userEvent.setup();
  const pending = deferred<WorkspaceFinishPreview>();
  const previewFinish = vi.fn<Worktrees["previewFinish"]>((channelId) =>
    channelId === "first"
      ? pending.promise
      : Promise.resolve({
          bindingId: "second-binding",
          path: "/trees/second",
          branch: "buzz/second",
          head,
          blockers: [],
        }),
  );
  const trees = service(
    async (channelId) => ({
      ...summary,
      path: `/trees/${channelId}`,
      branch: `buzz/${channelId}`,
    }),
    true,
    { previewFinish },
  );
  const props = {
    worktrees: trees,
    openDiff: () => {},
    agentWorking: false,
    session,
    canvas,
  };
  const view = render(
    <WorktreeStatusBar key="first" channelId="first" {...props} />,
  );
  await screen.findByText("buzz/first");
  await user.click(screen.getByRole("button", { name: "Finish" }));
  expect(previewFinish).toHaveBeenCalledWith("first", expect.any(Function));

  view.rerender(
    <WorktreeStatusBar key="second" channelId="second" {...props} />,
  );
  expect(await screen.findByText("buzz/second")).toBeVisible();
  act(() =>
    pending.resolve({
      bindingId: "first-binding",
      path: "/trees/first",
      branch: "buzz/first",
      head,
      blockers: [],
    }),
  );
  expect(
    screen.queryByRole("dialog", { name: "Remove local worktree?" }),
  ).not.toBeInTheDocument();
});

it("shows removing and reopens removed lifecycle states", async () => {
  const user = userEvent.setup();
  const reopenedBinding = {
    ...summaryForLifecycle("ready"),
    repoRoot: summary.repository,
    worktreeRoot: "/trees",
    gitCommonDir: "/repo/.git",
    bindingId: "binding",
    channelId: "removed",
    createdAt: 1,
    installId: "install",
    owned: true,
    state: "ready" as const,
  };
  const reopen = vi.fn(async () => reopenedBinding as never);
  const trees = service(
    async (channelId) =>
      summaryForLifecycle(channelId === "removing" ? "removing" : "removed"),
    true,
    {
      recover: vi.fn(async () => ({ state: "removed" }) as never),
      reopen,
    },
  );
  const prepared = preparedWorkspaceCanvas(
    { folders: [summary.repository], canvas: "Authored" },
    reopenedBinding,
  );
  const removed = removedWorkspaceCanvas(prepared, reopenedBinding);
  const save = vi.fn(async (_channelId: string, _content: string) => ({
    id: "saved",
  }));
  const props = {
    worktrees: trees,
    openDiff: () => {},
    agentWorking: false,
    session,
    canvas: {
      read: vi.fn(async () => ({ id: "canvas-head", content: removed })),
      save,
    } as never,
  };
  const view = render(<WorktreeStatusBar channelId="removing" {...props} />);
  expect(await screen.findByText("Removal needs checking")).toBeVisible();
  expect(screen.getByRole("button", { name: "Check again" })).toBeVisible();

  view.rerender(
    <WorktreeStatusBar key="removed" channelId="removed" {...props} />,
  );
  expect(
    await screen.findByText(/Worktree removed; branch .* remains/),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Finish" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Recreate worktree" }));
  expect(reopen).toHaveBeenCalledWith("removed");
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0]?.[1]).toContain("## Prepared worktree");
  expect(save.mock.calls[0]?.[1]).toContain("Authored");
  expect(save.mock.calls[0]?.[1]).not.toContain("## Worktree removed");
});

it("keeps a Canvas write failure visible and retries it", async () => {
  const user = userEvent.setup();
  const prepared = preparedWorkspaceCanvas(
    { folders: [summary.repository], canvas: "Authored" },
    {
      bindingId: "binding",
      channelId: "channel",
      repoRoot: summary.repository,
      worktreeRoot: "/trees",
      path: summary.path,
      branch: summary.branch,
      baseRef: summary.baseRef,
      baseSha: summary.baseSha,
      gitCommonDir: "/repo/.git",
      createdAt: 1,
      installId: "install",
      owned: true,
      state: "ready",
    },
  );
  const save = vi
    .fn()
    .mockRejectedValueOnce(new Error("relay rejected save"))
    .mockResolvedValueOnce({ id: "saved" });
  const canvasFixture = {
    read: vi.fn(async () => ({ id: "canvas-head", content: prepared })),
    save,
  } as never;
  render(
    <WorktreeStatusBar
      channelId="channel"
      worktrees={service(async () => summaryForLifecycle("removed"))}
      openDiff={() => {}}
      agentWorking={false}
      session={session}
      canvas={canvasFixture}
    />,
  );

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "relay rejected save",
  );
  await user.click(screen.getByRole("button", { name: "Retry Canvas update" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("reports a removal failure in the dialog and refreshes status", async () => {
  const user = userEvent.setup();
  const load = vi.fn(async () => summary);
  const remove = vi.fn(async () => {
    throw new Error("Git denied worktree removal");
  });
  render(
    <WorktreeStatusBar
      channelId="channel"
      worktrees={service(load, true, { remove })}
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

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Removal failed: Git denied worktree removal",
  );
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
});

it("exposes status and Canvas errors in the shared reason popover", async () => {
  const user = userEvent.setup();
  render(
    <WorktreeStatusBar
      channelId="channel"
      worktrees={service(async () => {
        throw new Error("Repository identity changed");
      })}
      openDiff={() => {}}
      agentWorking={false}
      session={session}
      canvas={canvas}
    />,
  );
  await user.click(
    await screen.findByRole("button", {
      name: "Local worktree needs attention; show reason",
    }),
  );
  expect(screen.getAllByText("Repository identity changed")).toHaveLength(2);
});

it("updates a removed Canvas once per chat opening, not every refresh", async () => {
  const read = vi.fn(async () => undefined);
  const load = vi.fn(async () => summaryForLifecycle("removed"));
  render(
    <WorktreeStatusBar
      channelId="channel"
      worktrees={service(load)}
      openDiff={() => {}}
      agentWorking={false}
      session={session}
      canvas={{ read, save: vi.fn() } as never}
    />,
  );
  await waitFor(() => expect(read).toHaveBeenCalledOnce());
  act(() => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  expect(read).toHaveBeenCalledOnce();
});
