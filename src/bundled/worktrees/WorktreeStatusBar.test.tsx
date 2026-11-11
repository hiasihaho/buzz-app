// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
  expect(screen.getByText(/does not block safe finish/)).toBeVisible();

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
