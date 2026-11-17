import { spawn as spawnProcess, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Host } from "../../features/host/service";
import { BindingStore, type WorkspaceBinding } from "./binding";
import {
  createWorktrees,
  preparedWorkspaceCanvas,
  removedWorkspaceCanvas,
  reopenedWorkspaceCanvas,
} from "./service";
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

function realSpawn(): NonNullable<Host["spawn"]> {
  return async (id, options = {}) => {
    const child = spawnProcess(id, options.args ?? [], {
      env: {
        ...process.env,
        ...Object.fromEntries(
          Object.entries(options.env ?? {}).filter(
            (entry): entry is [string, string] => entry[1] !== null,
          ),
        ),
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.on("data", (data) => options.onStdout?.(data.toString()));
    child.stderr.on("data", (data) => options.onStderr?.(data.toString()));
    return {
      write: async (data: string) => {
        child.stdin.write(data);
      },
      end: async (data?: string) => {
        child.stdin.end(data);
      },
      kill: async () => {
        child.kill();
      },
      exited: new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      }),
    };
  };
}

function run(repo: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  if (result.status !== 0)
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
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

  it("removes the managed worktree path while preserving authored Canvas text", () => {
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
      state: "removed",
    };
    const authored = "# Goal\n\nKeep this instruction exactly.\n";
    const prepared = preparedWorkspaceCanvas(
      { ...workspace, canvas: authored },
      { ...binding, state: "ready" },
    );
    const removed = removedWorkspaceCanvas(prepared, binding);
    expect(removed).not.toContain(binding.path);
    expect(removed).toContain(
      `Branch \`${binding.branch}\` and its commits remain`,
    );
    expect(removed).toContain(
      "Do not create another worktree yourself. If more work is needed, ask the user to choose Recreate worktree.",
    );
    expect(removed.endsWith(authored)).toBe(true);

    const reopened = reopenedWorkspaceCanvas(removed, {
      ...binding,
      state: "ready",
    });
    expect(reopened).toContain(binding.path);
    expect(reopened).not.toContain("## Worktree removed");
    expect(reopened.endsWith(authored)).toBe(true);
  });

  it.each([
    [
      "the original one-line notice",
      "## Worktree removed\n\nThe local worktree was removed. Branch `buzz/task-abcd` and its commits remain in the repository.\n\nAuthored",
    ],
    [
      "the earlier new-chat notice",
      "## Worktree removed\n\nThe local worktree was removed. Branch `buzz/task-abcd` and its commits remain in the repository.\nDo not create another worktree in this chat. If more work is needed, tell the user to start a new chat.\n\nAuthored",
    ],
  ])("reopens Canvas after %s", (_label, content) => {
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
    const reopened = reopenedWorkspaceCanvas(content, binding);
    expect(reopened).toContain(binding.path);
    expect(reopened).not.toContain("## Worktree removed");
    expect(reopened).not.toContain("start a new chat");
    expect(reopened.endsWith("Authored")).toBe(true);
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

  it("recovers interrupted removals when the desktop service starts", async () => {
    const saved = storage();
    saved.setItem("buzz.worktrees.install.v1", "install");
    const binding: WorkspaceBinding = {
      bindingId: "binding",
      channelId: "channel",
      repoRoot: "/repo",
      worktreeRoot: "/trees",
      path: "/trees/task",
      branch: "buzz/task",
      baseRef: "main",
      baseSha: "a".repeat(40),
      gitCommonDir: "/repo/.git",
      createdAt: 1,
      installId: "install",
      owned: true,
      state: "removing",
    };
    new BindingStore(saved).set(binding);
    const spawn: NonNullable<Host["spawn"]> = vi.fn(
      async (_id, options = {}) => {
        const args = options.args ?? [];
        const stdout = args.includes("--git-common-dir")
          ? "/repo/.git\n"
          : args.includes("rev-parse")
            ? `${"a".repeat(40)}\n`
            : `worktree /repo\0HEAD ${"b".repeat(40)}\0branch refs/heads/main\0\0`;
        options.onStdout?.(stdout);
        return {
          write: async () => {},
          end: async () => {},
          kill: async () => {},
          exited: Promise.resolve(0),
        };
      },
    );
    createWorktrees({ spawn, resolveDirectory: async (path) => path }, saved);
    await vi.waitFor(() =>
      expect(new BindingStore(saved).get(binding.bindingId)?.state).toBe(
        "removed",
      ),
    );
  });

  it("reads a combined staged and unstaged diff only after reconciling the chat binding", async () => {
    const saved = storage();
    const binding: WorkspaceBinding = {
      bindingId: "binding",
      channelId: "channel",
      repoRoot: "/repo",
      worktreeRoot: "/trees",
      path: "/trees/task",
      branch: "buzz/task",
      baseRef: "main",
      baseSha: "a".repeat(40),
      gitCommonDir: "/repo/.git",
      createdAt: 1,
      installId: "install",
      owned: true,
      state: "ready",
    };
    new BindingStore(saved).set(binding);
    const patch = [
      "diff --git a/file.txt b/file.txt",
      `index ${"1".repeat(40)}..${"2".repeat(40)} 100644`,
      "--- a/file.txt",
      "+++ b/file.txt",
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "",
    ].join("\n");
    const spawn: NonNullable<Host["spawn"]> = vi.fn(
      async (_id, options = {}) => {
        const args = options.args ?? [];
        let stdout = "";
        if (args.at(-1) === "version") stdout = "git version 2.43.0\n";
        else if (args.includes("worktree"))
          stdout = `worktree /repo\0HEAD ${"b".repeat(40)}\0branch refs/heads/main\0\0worktree /trees/task\0HEAD ${"a".repeat(40)}\0branch refs/heads/buzz/task\0\0`;
        else if (args.at(-1) === "--git-common-dir") stdout = "/repo/.git\n";
        else if (args.includes("--porcelain=v2"))
          stdout = [
            `# branch.oid ${"a".repeat(40)}`,
            "# branch.head buzz/task",
            `1 .M N... 100644 100644 100644 ${"1".repeat(40)} ${"2".repeat(40)} file.txt`,
            "",
          ].join("\0");
        else if (args.includes("rev-list"))
          stdout = args.includes("--left-right") ? "0 0\n" : "3\n";
        else if (args.includes("diff")) stdout = patch;
        else throw new Error(`Unexpected git call: ${args.join(" ")}`);
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
    expect(service.has(binding.channelId)).toBe(true);
    await expect(service.summary(binding.channelId)).resolves.toMatchObject({
      repository: binding.repoRoot,
      path: binding.path,
      branch: binding.branch,
      baseRef: binding.baseRef,
      unpublishedCommits: 3,
      status: { state: "ready", dirty: true, fileCount: 1 },
    });
    await expect(service.diff(binding.channelId)).resolves.toMatchObject({
      content: patch,
      path: binding.path,
      branch: binding.branch,
      status: { state: "ready", dirty: true, fileCount: 1 },
    });
    expect(spawn).toHaveBeenLastCalledWith(
      "git",
      expect.objectContaining({
        args: [
          "--no-optional-locks",
          "-C",
          binding.path,
          "diff",
          "--no-ext-diff",
          "--no-color",
          "--src-prefix=a/",
          "--dst-prefix=b/",
          "--full-index",
          "HEAD",
          "--",
        ],
      }),
    );
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
        else if (args.includes("--git-dir")) stdout = "/repo/.git\n";
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
    new BindingStore(saved).set({ ...binding, state: "failed" });
    await expect(
      service.prepare(binding.channelId, workspace, "Changed retry text"),
    ).resolves.toMatchObject({
      path: binding.path,
      branch: binding.branch,
      state: "ready",
    });
    new BindingStore(saved).set(binding);
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
        else if (args.includes("--git-dir")) stdout = "/repo/.git\n";
        else if (args.includes("worktree") && args.includes("list"))
          stdout = `worktree /repo\0HEAD ${"a".repeat(40)}\0branch refs/heads/main\0\0${
            added
              ? `worktree /fixed-trees/original-abcd\0HEAD ${"a".repeat(40)}\0branch refs/heads/buzz/original-abcd\0\0`
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
      path: "/fixed-trees/original-abcd",
      branch: "buzz/original-abcd",
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

  it("treats an absent or unrelated managed Canvas block as already retired", () => {
    const binding: WorkspaceBinding = {
      bindingId: "binding",
      channelId: "channel",
      repoRoot: "/repo",
      worktreeRoot: "/trees",
      path: "/trees/task",
      branch: "buzz/task",
      baseRef: "main",
      baseSha: "a".repeat(40),
      gitCommonDir: "/repo/.git",
      createdAt: 1,
      installId: "install",
      owned: true,
      state: "removed",
    };
    expect(removedWorkspaceCanvas("Authored only", binding)).toBe(
      "Authored only",
    );
    const unrelated = preparedWorkspaceCanvas(
      { ...workspace, canvas: "Keep" },
      { ...binding, path: "/trees/other", state: "ready" },
    );
    expect(removedWorkspaceCanvas(unrelated, binding)).toBe(unrelated);
  });

  it("removes a matching block while preserving edited text around it", () => {
    const binding: WorkspaceBinding = {
      bindingId: "binding",
      channelId: "channel",
      repoRoot: "/repo",
      worktreeRoot: "/trees",
      path: "/trees/task",
      branch: "buzz/task",
      baseRef: "main",
      baseSha: "a".repeat(40),
      gitCommonDir: "/repo/.git",
      createdAt: 1,
      installId: "install",
      owned: true,
      state: "removed",
    };
    const prepared = preparedWorkspaceCanvas(
      { ...workspace, canvas: "Authored text" },
      { ...binding, state: "ready" },
    );
    const edited = `Text before the block.\n\n${prepared.replace(
      "## Prepared worktree",
      "## Manually edited worktree",
    )}`;
    const removed = removedWorkspaceCanvas(edited, binding);
    expect(removed).toMatch(/^## Worktree removed/);
    expect(removed).not.toContain("buzz-session-workspace");
    expect(removed).toContain("Text before the block.");
    expect(removed).toContain("## Manually edited worktree");
    expect(removed).toContain("Authored text");
  });

  it.each(["removing", "removed"] as const)(
    "summarizes a %s binding without probing removed worktree status",
    async (state) => {
      const saved = storage();
      saved.setItem("buzz.worktrees.install.v1", "different-install");
      const binding: WorkspaceBinding = {
        bindingId: "binding",
        channelId: "channel",
        repoRoot: "/repo",
        worktreeRoot: "/trees",
        path: "/trees/task",
        branch: "buzz/task",
        baseRef: "main",
        baseSha: "a".repeat(40),
        gitCommonDir: "/repo/.git",
        createdAt: 1,
        installId: "install",
        owned: true,
        state,
      };
      new BindingStore(saved).set(binding);
      const spawn = vi.fn() as NonNullable<Host["spawn"]>;
      const service = createWorktrees(
        { spawn, resolveDirectory: async (value) => value },
        saved,
      );
      await expect(service.summary(binding.channelId)).resolves.toMatchObject({
        lifecycle: state,
        branch: binding.branch,
      });
      expect(service.canDiff(binding.channelId)).toBe(false);
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it("exercises finish, removal, recovery, summary, and diff eligibility through the service", async () => {
    const created = await mkdtemp(join(tmpdir(), "buzz-worktree-service-"));
    const root = await realpath(created);
    try {
      const repoRoot = join(root, "repo");
      const worktreeRoot = join(root, "trees");
      const path = join(worktreeRoot, "task");
      await mkdir(repoRoot);
      await mkdir(worktreeRoot);
      run(root, ["init", "-q", "-b", "main", repoRoot]);
      await writeFile(join(repoRoot, "README.md"), "base\n");
      run(repoRoot, ["add", "README.md"]);
      run(repoRoot, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.org",
        "commit",
        "-qm",
        "base",
      ]);
      const baseSha = run(repoRoot, ["rev-parse", "HEAD"]);
      run(repoRoot, ["worktree", "add", "-qb", "buzz/task", path, "main"]);
      await writeFile(join(path, "README.md"), "base\ncontinued\n");
      run(path, ["add", "README.md"]);
      run(path, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.org",
        "commit",
        "-qm",
        "continue task",
      ]);
      const head = run(path, ["rev-parse", "HEAD"]);
      const saved = storage();
      saved.setItem("buzz.worktrees.install.v1", "install");
      const binding: WorkspaceBinding = {
        bindingId: "binding",
        channelId: "channel",
        repoRoot,
        worktreeRoot,
        path,
        branch: "buzz/task",
        baseRef: "main",
        baseSha,
        gitCommonDir: await realpath(join(repoRoot, ".git")),
        createdAt: 1,
        installId: "install",
        owned: true,
        state: "ready",
      };
      new BindingStore(saved).set(binding);
      const service = createWorktrees(
        { spawn: realSpawn(), resolveDirectory: async (value) => value },
        saved,
      );
      await expect(
        service.previewFinish(binding.channelId, () => []),
      ).resolves.toMatchObject({ head, blockers: [] });
      await expect(
        service.remove(binding.channelId, head, () => []),
      ).resolves.toMatchObject({ state: "removed" });
      await expect(service.summary(binding.channelId)).resolves.toMatchObject({
        lifecycle: "removed",
        branch: binding.branch,
      });
      expect(service.canDiff(binding.channelId)).toBe(false);
      await expect(service.recover(binding.channelId)).resolves.toMatchObject({
        state: "removed",
      });
      expect(run(repoRoot, ["rev-parse", `refs/heads/${binding.branch}`])).toBe(
        head,
      );
      run(repoRoot, ["branch", "-D", binding.branch]);
      await expect(service.reopen(binding.channelId)).rejects.toThrow(
        "saved workspace branch no longer exists",
      );
      expect(new BindingStore(saved).forChannel(binding.channelId)?.state).toBe(
        "removed",
      );
      run(repoRoot, ["branch", binding.branch, head]);
      new BindingStore(saved).set({ ...binding, state: "preparing" });
      await expect(service.reopen(binding.channelId)).resolves.toMatchObject({
        state: "ready",
        path,
      });
      expect(run(path, ["rev-parse", "HEAD"])).toBe(head);
      expect(service.canDiff(binding.channelId)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
