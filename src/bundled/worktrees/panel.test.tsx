// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { expect, it, vi } from "vitest";
import type { Panel, PanelProps } from "../../features/panels/service";
import type { ChatMenuProps } from "../../features/conversation/service";
import type { WorktreeDiff, Worktrees } from "./service";
import { registerWorktreeDiff, WorktreeDiffPanel } from "./panel";

const status = {
  state: "ready" as const,
  path: "/trees/task",
  branch: "buzz/task",
  detached: false,
  dirty: true,
  fileCount: 1,
};

function result(channelId = "alpha"): WorktreeDiff {
  return {
    path: `/trees/${channelId}`,
    branch: `buzz/${channelId}`,
    status: { ...status, path: `/trees/${channelId}` },
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
    diff,
    workspace: () => undefined,
    prepare: async () => undefined,
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

it("registers a side panel and opens it from the chat menu only for a local binding", () => {
  let panel!: Panel;
  let menu!: (props: ChatMenuProps) => ReactElement | null;
  const requestOpen = vi.fn(() => true);
  const available = new Set(["alpha"]);
  const worktrees: Worktrees = {
    ...service(vi.fn(async () => result())),
    has: (channelId) => available.has(channelId),
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
  const item = menu({ channelId: "alpha" } as ChatMenuProps) as ReactElement<{
    onClick(): void;
  }>;
  item.props.onClick();
  expect(requestOpen).toHaveBeenCalledWith({
    channelId: "alpha",
    target: "buzz:worktree-diff:alpha",
  });
  expect(menu({ channelId: "missing" } as ChatMenuProps)).toBeNull();
});
