// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { Panel, PanelProps } from "../../features/panels/service";
import type { ChatMenuProps } from "../../features/conversation/service";
import type { WorktreeDiff, Worktrees } from "./service";
import {
  refreshWorktreeDiff,
  registerWorktreeDiff,
  WorktreeDiffPanel,
  worktreeDiffTarget,
} from "./panel";

afterEach(cleanup);

const status = {
  state: "ready" as const,
  path: "/trees/task",
  branch: "buzz/task",
  detached: false,
  dirty: true,
  fileCount: 1,
};

function result(
  channelId = "alpha",
  comparison: WorktreeDiff["comparison"] = "uncommitted",
): WorktreeDiff {
  return {
    path: `/trees/${channelId}`,
    branch: `buzz/${channelId}`,
    status: { ...status, path: `/trees/${channelId}`, ahead: 2 },
    comparison,
    ...(comparison === "since-base" && {
      baseRef: "origin/main",
      unpublishedCommits: 1,
    }),
    content: [
      `diff --git a/${channelId}.txt b/${channelId}.txt`,
      "index 1111111..2222222 100644",
      `--- a/${channelId}.txt`,
      `+++ b/${channelId}.txt`,
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "",
    ].join("\n"),
  };
}

function service(diff: Worktrees["diff"]): Worktrees {
  return {
    has: () => true,
    canDiff: () => true,
    summary: async () => ({
      repository: "/repo",
      path: "/trees/task",
      branch: "buzz/task",
      baseRef: "main",
      baseSha: "b".repeat(40),
      lifecycle: "ready",
      status,
      unpublishedCommits: 0,
    }),
    diff,
    workspace: () => undefined,
    prepare: async () => undefined,
    previewFinish: async () => {
      throw new Error("not implemented");
    },
    remove: async () => {
      throw new Error("not implemented");
    },
    reopen: async () => {
      throw new Error("not implemented");
    },
    recover: async () => {
      throw new Error("not implemented");
    },
  };
}

function props(channelId: string): Pick<PanelProps, "channelContext"> {
  return {
    channelContext: {
      scope: "scope",
      channelId,
      channelName: channelId,
      viewer: "viewer",
      relayUrl: "https://relay.example",
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

it("renders the bound local diff and a truthful clean or untracked empty state", async () => {
  const worktrees = service(vi.fn(async () => result()));
  const mounted = render(
    <WorktreeDiffPanel {...props("alpha")} worktrees={worktrees} />,
  );
  expect(await screen.findByText("buzz/alpha")).toBeVisible();
  expect(screen.getByRole("region", { name: "alpha.txt" })).toBeVisible();

  mounted.rerender(
    <WorktreeDiffPanel
      {...props("clean")}
      worktrees={service(
        vi.fn(async () => ({
          ...result("clean"),
          content: "",
          status: { ...status, dirty: false, fileCount: 0 },
        })),
      )}
    />,
  );
  expect(
    await screen.findByText("The local worktree has no changes."),
  ).toBeVisible();

  mounted.rerender(
    <WorktreeDiffPanel
      {...props("untracked")}
      worktrees={service(
        vi.fn(async () => ({
          ...result("untracked"),
          content: "",
          status: { ...status, dirty: true, fileCount: 1 },
        })),
      )}
    />,
  );
  expect(
    await screen.findByText(
      "No tracked diff. Git reports 1 changed or untracked file.",
    ),
  ).toBeVisible();
});

it("switches comparisons without retaining the previous mode", async () => {
  const cumulative = deferred<WorktreeDiff>();
  const diff = vi.fn<Worktrees["diff"]>(
    async (channelId, _signal, comparison) =>
      comparison === "since-base"
        ? cumulative.promise
        : result(channelId, comparison),
  );
  const mounted = render(
    <WorktreeDiffPanel
      {...props("alpha")}
      target={worktreeDiffTarget("alpha")}
      worktrees={service(diff)}
    />,
  );
  expect(await screen.findByText("buzz/alpha")).toBeVisible();
  expect(
    screen.queryByText(/Changes since the merge base/),
  ).not.toBeInTheDocument();
  expect(diff).toHaveBeenLastCalledWith(
    "alpha",
    expect.any(AbortSignal),
    "uncommitted",
  );

  mounted.rerender(
    <WorktreeDiffPanel
      {...props("alpha")}
      target={worktreeDiffTarget("alpha", "since-base")}
      worktrees={service(diff)}
    />,
  );
  expect(mounted.container.querySelector('[aria-busy="true"]')).toBeVisible();
  expect(
    screen.queryByRole("region", { name: "alpha.txt" }),
  ).not.toBeInTheDocument();
  await act(async () => cumulative.resolve(result("alpha", "since-base")));
  expect(
    await screen.findByText("Changes since the merge base with origin/main"),
  ).toBeVisible();
  expect(screen.getByText(/2 commits ahead of origin\/main/)).toBeVisible();
  expect(
    screen.getByText(/1 commit not found on a local remote-tracking branch/),
  ).toBeVisible();
  expect(screen.getByText(/This evidence is informational/)).toBeVisible();
  expect(diff).toHaveBeenLastCalledWith(
    "alpha",
    expect.any(AbortSignal),
    "since-base",
  );
});

it("reports unavailable commit evidence in the cumulative panel", async () => {
  render(
    <WorktreeDiffPanel
      {...props("alpha")}
      target={worktreeDiffTarget("alpha", "since-base")}
      worktrees={service(
        vi.fn(async () => {
          const { unpublishedCommits: _unpublished, ...withoutUnpublished } =
            result("alpha", "since-base");
          return { ...withoutUnpublished, status };
        }),
      )}
    />,
  );
  expect(
    await screen.findByText(
      /Commits ahead of origin\/main could not be determined/,
    ),
  ).toBeVisible();
  expect(
    screen.getByText(/Remote-tracking evidence is unavailable/),
  ).toBeVisible();
});

it("refreshes in place while keeping the last diff visible", async () => {
  let resolveRefresh!: (value: WorktreeDiff) => void;
  const refresh = new Promise<WorktreeDiff>((resolve) => {
    resolveRefresh = resolve;
  });
  const diff = vi
    .fn<Worktrees["diff"]>()
    .mockResolvedValueOnce(result("alpha"))
    .mockReturnValueOnce(refresh);
  render(<WorktreeDiffPanel {...props("alpha")} worktrees={service(diff)} />);
  expect(await screen.findByText("buzz/alpha")).toBeVisible();

  act(() => refreshWorktreeDiff("alpha"));
  await waitFor(() => expect(diff).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("region", { name: "alpha.txt" })).toBeVisible();
  expect(screen.queryByText("Loading local changes…")).not.toBeInTheDocument();

  act(() => resolveRefresh(result("updated")));
  expect(await screen.findByText("buzz/updated")).toBeVisible();
});

it("aborts an older same-chat request and ignores its stale result", async () => {
  const firstRefresh = deferred<WorktreeDiff>();
  const secondRefresh = deferred<WorktreeDiff>();
  const diff = vi
    .fn<Worktrees["diff"]>()
    .mockResolvedValueOnce(result("initial"))
    .mockReturnValueOnce(firstRefresh.promise)
    .mockReturnValueOnce(secondRefresh.promise);
  render(<WorktreeDiffPanel {...props("alpha")} worktrees={service(diff)} />);
  expect(await screen.findByText("buzz/initial")).toBeVisible();

  act(() => refreshWorktreeDiff("alpha"));
  await waitFor(() => expect(diff).toHaveBeenCalledTimes(2));
  const firstSignal = diff.mock.calls[1]?.[1];
  expect(firstSignal?.aborted).toBe(false);

  act(() => refreshWorktreeDiff("alpha"));
  await waitFor(() => expect(diff).toHaveBeenCalledTimes(3));
  expect(firstSignal?.aborted).toBe(true);

  await act(async () => firstRefresh.resolve(result("stale")));
  expect(screen.queryByText("buzz/stale")).not.toBeInTheDocument();
  expect(screen.getByText("buzz/initial")).toBeVisible();

  await act(async () => secondRefresh.resolve(result("current")));
  expect(await screen.findByText("buzz/current")).toBeVisible();
});

it("invalidates a removed worktree instead of retaining a stale clean claim", async () => {
  const diff = vi
    .fn<Worktrees["diff"]>()
    .mockResolvedValueOnce({
      ...result("alpha", "since-base"),
      content: "",
      status: { ...status, dirty: false, fileCount: 0 },
    })
    .mockRejectedValueOnce(new Error("This chat has no ready local worktree"));
  render(
    <WorktreeDiffPanel
      {...props("alpha")}
      target={worktreeDiffTarget("alpha", "since-base")}
      worktrees={service(diff)}
    />,
  );
  expect(
    await screen.findByText(
      "No changes since the merge base with origin/main.",
    ),
  ).toBeVisible();

  act(() => refreshWorktreeDiff("alpha", true));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "This chat has no ready local worktree",
  );
  expect(
    screen.queryByText("No changes since the merge base with origin/main."),
  ).not.toBeInTheDocument();
});

it("reports reconciliation failures and never paints a stale channel response", async () => {
  let resolveAlpha!: (value: WorktreeDiff) => void;
  let resolveBeta!: (value: WorktreeDiff) => void;
  const alpha = new Promise<WorktreeDiff>((resolve) => {
    resolveAlpha = resolve;
  });
  const beta = new Promise<WorktreeDiff>((resolve) => {
    resolveBeta = resolve;
  });
  const worktrees = service(
    vi.fn((channelId) =>
      channelId === "alpha"
        ? alpha
        : channelId === "beta"
          ? beta
          : Promise.reject(new Error("Repository identity changed")),
    ),
  );
  const mounted = render(
    <WorktreeDiffPanel {...props("alpha")} worktrees={worktrees} />,
  );
  mounted.rerender(
    <WorktreeDiffPanel {...props("beta")} worktrees={worktrees} />,
  );
  await act(async () => resolveAlpha(result("alpha")));
  expect(screen.queryByText("buzz/alpha")).not.toBeInTheDocument();
  await act(async () => resolveBeta(result("beta")));
  expect(await screen.findByText("buzz/beta")).toBeVisible();

  mounted.rerender(
    <WorktreeDiffPanel {...props("broken")} worktrees={worktrees} />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Repository identity changed",
  );
  expect(screen.queryByText("buzz/beta")).not.toBeInTheDocument();
});

it("registers a side panel and refreshes an open panel from the chat menu", async () => {
  let panel!: Panel;
  let menu!: (props: ChatMenuProps) => ReactElement | null;
  const requestOpen = vi.fn(() => true);
  const available = new Set(["alpha"]);
  const diff = vi.fn(async () => result());
  const worktrees: Worktrees = {
    ...service(diff),
    has: (channelId) => available.has(channelId),
    canDiff: (channelId) => available.has(channelId),
  };
  registerWorktreeDiff(
    {
      panels: {
        register(value: Panel) {
          panel = value;
        },
        requestOpen,
      },
      conversation: {
        registerChatMenu(value: (props: ChatMenuProps) => ReactElement | null) {
          menu = value;
        },
      },
    } as never,
    worktrees,
  );
  expect(panel).toMatchObject({
    id: "worktree-diff",
    title: "Local changes",
    channelPlacement: "side",
  });
  expect(
    panel.channelMenu?.eligible({ id: "alpha" } as never, {} as never),
  ).toBe(true);
  render(<WorktreeDiffPanel {...props("alpha")} worktrees={worktrees} />);
  await screen.findByText("buzz/alpha");
  const item = menu({ channelId: "alpha" } as ChatMenuProps) as ReactElement<{
    onClick(): void;
  }>;
  act(() => item.props.onClick());
  await waitFor(() => expect(diff).toHaveBeenCalledTimes(2));
  expect(requestOpen).toHaveBeenCalledWith({
    channelId: "alpha",
    target: "buzz:worktree-diff:alpha",
  });
  expect(menu({ channelId: "missing" } as ChatMenuProps)).toBeNull();
});
