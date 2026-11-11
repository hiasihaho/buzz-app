import { describe, expect, it, vi } from "vitest";
import type { Host } from "../../features/host/service";
import { BindingStore, type WorkspaceBinding } from "./binding";
import { createWorktrees, preparedWorkspaceCanvas } from "./service";
import type { Workspace } from "../../features/solo/workspace";

const workspace: Workspace = {
  folders: ["/repo"],
  worktree: { location: "/trees", baseBranch: "main" },
  canvas: "",
};

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  } as unknown as Storage;
}

describe("worktree chat service", () => {
  it("hands the prepared path and branch to the agent as facts", () => {
    const binding: WorkspaceBinding = {
      bindingId: "binding",
      channelId: "channel",
      repoRoot: "/repo",
      worktreeRoot: "/trees",
      path: "/trees/task-abcd",
      branch: "buzz/task-abcd",
      baseRef: "main",
      baseSha: "a".repeat(40),
      gitCommonDir: "/repo/.git",
      createdAt: 1,
      installId: "install",
      owned: true,
      state: "ready",
    };
    const canvas = preparedWorkspaceCanvas(
      { ...workspace, canvas: "Keep this instruction." },
      binding,
    );
    expect(canvas).toContain(
      "Work in `/trees/task-abcd` on branch `buzz/task-abcd`",
    );
    expect(canvas).toContain("already exists from `main`");
    expect(canvas).toContain("do not create another worktree");
    expect(canvas).not.toContain("Before starting new work");
    expect(canvas).toContain("Keep this instruction.");
  });
  it("exposes one configured repository only when desktop Git is available", () => {
    expect(createWorktrees({}, storage()).workspace(workspace)).toBeUndefined();
    expect(
      createWorktrees(
        {
          spawn: vi.fn() as NonNullable<Host["spawn"]>,
          resolveDirectory: vi.fn(),
        },
        storage(),
      ).workspace(workspace),
    ).toEqual({ repository: "/repo", location: "/trees", baseBranch: "main" });
  });

  it("reuses an owned binding when retry text changes", async () => {
    const saved = storage();
    saved.setItem("buzz.worktrees.install.v1", "install");
    const binding: WorkspaceBinding = {
      bindingId: "binding",
      channelId: "abcd0000-0000-0000-0000-000000000000",
      repoRoot: "/repo",
      worktreeRoot: "/trees",
      path: "/trees/original-abcd",
      branch: "buzz/original-abcd",
      baseRef: "main",
      baseSha: "a".repeat(40),
      gitCommonDir: "/repo/.git",
      createdAt: 1,
      installId: "install",
      owned: true,
      state: "ready",
    };
    new BindingStore(saved).set(binding);
    const spawn: NonNullable<Host["spawn"]> = vi.fn(
      async (_id, options = {}) => {
        const args = options.args ?? [];
        let stdout = "";
        if (args.includes("--version")) stdout = "git version 2.43.0\n";
        else if (args.includes("worktree"))
          stdout = `worktree /repo\0HEAD ${"b".repeat(40)}\0branch refs/heads/main\0\0worktree /trees/original-abcd\0HEAD ${"a".repeat(40)}\0branch refs/heads/buzz/original-abcd\0\0`;
        else if (args.at(-1) === "--git-common-dir") stdout = "/repo/.git\n";
        else if (!args.includes("check-ref-format"))
          throw new Error(`Unexpected git call: ${args.join(" ")}`);
        options.onStdout?.(stdout);
        return {
          write: async () => {},
          end: async () => {},
          kill: async () => {},
          exited: Promise.resolve(0),
        };
      },
    );
    const service = createWorktrees(
      { spawn, resolveDirectory: async (path) => path },
      saved,
    );
    await expect(
      service.prepare(binding.channelId, workspace, "Completely changed task"),
    ).resolves.toMatchObject({
      path: binding.path,
      branch: binding.branch,
      state: "ready",
    });
    await expect(
      service.prepare(
        binding.channelId,
        {
          ...workspace,
          worktree: { location: "/trees", baseBranch: "develop" },
        },
        "Changed workspace",
      ),
    ).rejects.toThrow(
      "Switch back to its original workspace to retry, or close and reopen New chat",
    );
  });

  it("replaces an unregistered failed binding with the corrected workspace", async () => {
    const saved = storage();
    saved.setItem("buzz.worktrees.install.v1", "install");
    new BindingStore(saved).set({
      bindingId: "binding",
      channelId: "abcd0000-0000-0000-0000-000000000000",
      repoRoot: "/repo",
      worktreeRoot: "/broken-trees",
      path: "/broken-trees/original-abcd",
      branch: "buzz/original-abcd",
      baseRef: "main",
      baseSha: "a".repeat(40),
      gitCommonDir: "/repo/.git",
      createdAt: 1,
      installId: "install",
      owned: true,
      state: "failed",
    });
    let added = false;
    const spawn: NonNullable<Host["spawn"]> = vi.fn(
      async (_id, options = {}) => {
        const args = options.args ?? [];
        let stdout = "";
        if (args.includes("--version")) stdout = "git version 2.43.0\n";
        else if (args.includes("worktree") && args.includes("list"))
          stdout = `worktree /repo\0HEAD ${"a".repeat(40)}\0branch refs/heads/main\0\0${
            added
              ? `worktree /fixed-trees/fixed-workspace-abcd\0HEAD ${"a".repeat(40)}\0branch refs/heads/buzz/fixed-workspace-abcd\0\0`
              : ""
          }`;
        else if (args.includes("worktree") && args.includes("add"))
          added = true;
        else if (args.at(-1) === "--git-common-dir") stdout = "/repo/.git\n";
        else if (args.at(-1)?.endsWith("^{commit}"))
          stdout = `${"a".repeat(40)}\n`;
        options.onStdout?.(stdout);
        return {
          write: async () => {},
          end: async () => {},
          kill: async () => {},
          exited: Promise.resolve(0),
        };
      },
    );
    const service = createWorktrees(
      { spawn, resolveDirectory: async (path) => path },
      saved,
    );
    await expect(
      service.prepare(
        "abcd0000-0000-0000-0000-000000000000",
        {
          folders: ["/repo"],
          worktree: { location: "/fixed-trees", baseBranch: "develop" },
          canvas: "",
        },
        "Fixed workspace",
      ),
    ).resolves.toMatchObject({
      path: "/fixed-trees/fixed-workspace-abcd",
      branch: "buzz/fixed-workspace-abcd",
      baseRef: "develop",
      state: "ready",
    });
  });

  it("does not claim a multi-folder workspace can be prepared", () => {
    const service = createWorktrees(
      {
        spawn: vi.fn() as NonNullable<Host["spawn"]>,
        resolveDirectory: vi.fn(),
      },
      storage(),
    );
    expect(
      service.workspace({ ...workspace, folders: ["/one", "/two"] }),
    ).toBeUndefined();
  });
});
