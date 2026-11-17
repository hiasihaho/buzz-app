import { spawn as spawnProcess, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Host, HostProcessOptions } from "../../features/host/service";
import { describe, expect, it, vi } from "vitest";
import { BindingStore, type WorkspaceBinding } from "./binding";
import { GitError } from "./git";
import { prepareWorkspace } from "./prepare";

function memory() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

const input = {
  channelId: "channel-1",
  repoRoot: "/repo-link",
  worktreeRoot: "/trees-link",
  worktreeName: "task",
  branch: "buzz/task",
  baseRef: "origin/main",
  installId: "install-1",
};

function fixture(
  options: {
    addFails?: boolean;
    existing?: boolean;
    existingBranch?: boolean;
    branchSha?: string;
    baseSha?: string;
    locked?: boolean;
    prunable?: boolean;
    resolvedWorktreePath?: string;
    invalidRepo?: boolean;
    repositoryError?: string;
    missingBase?: boolean;
  } = {},
) {
  const calls: string[][] = [];
  let added = options.existing ?? false;
  let branchExists = options.existingBranch ?? added;
  let prunable = options.prunable ?? false;
  const spawn: NonNullable<Host["spawn"]> = vi.fn(
    async (_id: string, processOptions: HostProcessOptions = {}) => {
      const args = [...(processOptions.args ?? [])];
      const gitArgs = args.slice(3);
      calls.push(gitArgs);
      let stdout = "";
      let stderr = "";
      let code = 0;
      if (gitArgs[0] === "rev-parse" && gitArgs.includes("--git-dir")) {
        if (options.invalidRepo) {
          stderr = "fatal: not a git repository";
          code = 128;
        } else if (options.repositoryError) {
          stderr = options.repositoryError;
          code = 128;
        } else stdout = "/repo/.git\n";
      } else if (
        gitArgs[0] === "rev-parse" &&
        gitArgs.at(-1) === "origin/main^{commit}" &&
        options.missingBase
      ) {
        stderr = "fatal: Needed a single revision";
        code = 128;
      } else if (
        gitArgs[0] === "rev-parse" &&
        gitArgs.includes("refs/heads/buzz/task^{commit}")
      )
        stdout = `${options.branchSha ?? "a".repeat(40)}\n`;
      else if (
        gitArgs[0] === "rev-parse" &&
        gitArgs.at(-1)?.endsWith("^{commit}")
      )
        stdout = `${options.baseSha ?? "a".repeat(40)}\n`;
      else if (gitArgs[0] === "rev-parse") stdout = "/repo/.git\n";
      else if (gitArgs[0] === "worktree" && gitArgs[1] === "list")
        stdout = `worktree /repo\0HEAD ${"a".repeat(40)}\0branch refs/heads/main\0\0${
          added
            ? `worktree /trees/task\0HEAD ${"a".repeat(40)}\0branch refs/heads/buzz/task\0${
                options.locked ? "locked interrupted add\0" : ""
              }${prunable ? "prunable missing gitdir\0" : ""}\0`
            : ""
        }`;
      else if (gitArgs[0] === "worktree" && gitArgs[1] === "remove") {
        added = false;
        prunable = false;
      } else if (gitArgs[0] === "worktree" && gitArgs[1] === "add") {
        if (options.addFails) {
          stderr = "add failed";
          code = 1;
        } else {
          added = true;
          prunable = false;
          branchExists = true;
        }
      } else if (
        gitArgs[0] === "check-ref-format" ||
        (gitArgs[0] === "rev-parse" &&
          gitArgs.includes("refs/heads/buzz/task^{commit}"))
      ) {
        // valid branch, or an absent branch below
      }
      if (
        gitArgs[0] === "rev-parse" &&
        gitArgs.includes("refs/heads/buzz/task^{commit}") &&
        !branchExists
      ) {
        stderr = "unknown revision";
        code = 128;
      }
      processOptions.onStdout?.(stdout);
      processOptions.onStderr?.(stderr);
      return {
        write: async () => undefined,
        end: async () => undefined,
        kill: async () => undefined,
        exited: Promise.resolve(code),
      };
    },
  );
  const resolveDirectory = vi.fn(async (path: string) => {
    if (path === "~") return "/home/test";
    if (path === "/repo-link") return "/repo";
    if (path === "/trees-link") return "/trees";
    if (path === "/trees/task" && options.resolvedWorktreePath)
      return options.resolvedWorktreePath;
    return path;
  });
  return { host: { spawn, resolveDirectory }, calls };
}

const options = {
  newId: () => "binding-1",
  now: () => 10,
};

function realHost(): Required<Pick<Host, "spawn" | "resolveDirectory">> {
  return {
    spawn: async (id, processOptions = {}) => {
      const child = spawnProcess(id, processOptions.args ?? [], {
        env: {
          ...process.env,
          ...Object.fromEntries(
            Object.entries(processOptions.env ?? {}).filter(
              (entry): entry is [string, string] => entry[1] !== null,
            ),
          ),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdout.on("data", (data) =>
        processOptions.onStdout?.(data.toString()),
      );
      child.stderr.on("data", (data) =>
        processOptions.onStderr?.(data.toString()),
      );
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
    },
    resolveDirectory: async (path) => {
      await mkdir(path, { recursive: true });
      return realpath(path);
    },
  };
}

describe("prepareWorkspace", () => {
  it("canonicalizes roots, creates a worktree, and transitions preparing to ready", async () => {
    const { host, calls } = fixture();
    const store = new BindingStore(memory());
    const states: string[] = [];
    const bindings = {
      forChannel: (channelId: string) => store.forChannel(channelId),
      set: (binding: WorkspaceBinding) => {
        states.push(binding.state);
        store.set(binding);
      },
    };

    await expect(
      prepareWorkspace(host, bindings, input, options),
    ).resolves.toMatchObject({
      repoRoot: "/repo",
      worktreeRoot: "/trees",
      path: "/trees/task",
      state: "ready",
      owned: true,
    });
    expect(states).toEqual(["preparing", "ready"]);
    expect(calls).toContainEqual([
      "worktree",
      "add",
      "-b",
      "buzz/task",
      "/trees/task",
      "a".repeat(40),
    ]);
  });

  it("replaces an owned failed intent only when no worktree was registered", async () => {
    const saved = memory();
    const store = new BindingStore(saved);
    const failed: WorkspaceBinding = {
      bindingId: "binding-1",
      channelId: input.channelId,
      repoRoot: "/repo",
      worktreeRoot: "/trees",
      path: "/trees/task",
      branch: input.branch,
      baseRef: input.baseRef,
      baseSha: "a".repeat(40),
      gitCommonDir: "/repo/.git",
      createdAt: 10,
      installId: input.installId,
      owned: true,
      state: "failed",
    };
    store.set(failed);
    const replacement = { ...input, baseRef: "origin/develop" };
    await expect(
      prepareWorkspace(
        fixture({ baseSha: "b".repeat(40) }).host,
        store,
        replacement,
        options,
      ),
    ).resolves.toMatchObject({
      bindingId: failed.bindingId,
      baseRef: "origin/develop",
      baseSha: "b".repeat(40),
      state: "ready",
    });

    store.set(failed);
    await expect(
      prepareWorkspace(
        fixture({ existing: true }).host,
        store,
        replacement,
        options,
      ),
    ).rejects.toThrow("different workspace binding");
    expect(store.forChannel(input.channelId)).toEqual(failed);
  });

  it("never replaces a ready binding even when its worktree is unregistered", async () => {
    const store = new BindingStore(memory());
    const ready: WorkspaceBinding = {
      bindingId: "binding-1",
      channelId: input.channelId,
      repoRoot: "/repo",
      worktreeRoot: "/trees",
      path: "/trees/task",
      branch: input.branch,
      baseRef: input.baseRef,
      baseSha: "a".repeat(40),
      gitCommonDir: "/repo/.git",
      createdAt: 10,
      installId: input.installId,
      owned: true,
      state: "ready",
    };
    store.set(ready);
    await expect(
      prepareWorkspace(
        fixture().host,
        store,
        { ...input, baseRef: "origin/develop" },
        options,
      ),
    ).rejects.toThrow("different workspace binding");
    expect(store.forChannel(input.channelId)).toEqual(ready);
  });

  it("is idempotent after creating the intended worktree", async () => {
    const { host, calls } = fixture();
    const store = new BindingStore(memory());
    const first = await prepareWorkspace(host, store, input, options);
    const second = await prepareWorkspace(host, store, input, options);
    expect(second).toEqual(first);
    expect(
      calls.filter((args) => args[0] === "worktree" && args[1] === "add"),
    ).toHaveLength(1);
  });

  it("rejects an existing worktree without an owned binding", async () => {
    const { host } = fixture({ existing: true });
    const store = new BindingStore(memory());
    await expect(prepareWorkspace(host, store, input, options)).rejects.toThrow(
      "already registered as a worktree",
    );
    expect(store.forChannel(input.channelId)).toBeUndefined();
  });

  it("checks out an existing branch by its short name", async () => {
    const { host, calls } = fixture({ existingBranch: true });
    await prepareWorkspace(host, new BindingStore(memory()), input, options);
    expect(calls).toContainEqual([
      "worktree",
      "add",
      "/trees/task",
      "buzz/task",
    ]);
  });

  it("rejects a symlink leaf that resolves outside the worktree root", async () => {
    const { host, calls } = fixture({ resolvedWorktreePath: "/outside" });
    const store = new BindingStore(memory());
    await expect(prepareWorkspace(host, store, input, options)).rejects.toThrow(
      "inside the configured root",
    );
    expect(
      calls.some((args) => args[0] === "worktree" && args[1] === "add"),
    ).toBe(false);
    expect(store.forChannel(input.channelId)).toBeUndefined();
  });

  it("rejects a mismatched existing branch without recording ownership", async () => {
    const { host } = fixture({
      existingBranch: true,
      branchSha: "b".repeat(40),
    });
    const store = new BindingStore(memory());
    await expect(prepareWorkspace(host, store, input, options)).rejects.toThrow(
      "branch already exists at a different commit",
    );
    expect(store.forChannel(input.channelId)).toBeUndefined();
  });

  it("reopens a removed binding at its saved branch tip", async () => {
    const { host, calls } = fixture({
      existingBranch: true,
      branchSha: "b".repeat(40),
    });
    const store = new BindingStore(memory());
    store.set({
      bindingId: "binding-1",
      channelId: input.channelId,
      repoRoot: "/repo",
      worktreeRoot: "/trees",
      path: "/trees/task",
      branch: input.branch,
      baseRef: input.baseRef,
      baseSha: "a".repeat(40),
      gitCommonDir: "/repo/.git",
      createdAt: 10,
      installId: input.installId,
      owned: true,
      state: "removed",
    });

    await expect(
      prepareWorkspace(host, store, input, options),
    ).resolves.toMatchObject({
      state: "ready",
      branch: input.branch,
    });
    expect(calls).toContainEqual([
      "worktree",
      "add",
      "/trees/task",
      "buzz/task",
    ]);
  });

  it("keeps a removed binding retryable when reopening fails", async () => {
    const { host } = fixture({ existingBranch: true, addFails: true });
    const store = new BindingStore(memory());
    const removed: WorkspaceBinding = {
      bindingId: "binding-1",
      channelId: input.channelId,
      repoRoot: "/repo",
      worktreeRoot: "/trees",
      path: "/trees/task",
      branch: input.branch,
      baseRef: input.baseRef,
      baseSha: "a".repeat(40),
      gitCommonDir: "/repo/.git",
      createdAt: 10,
      installId: input.installId,
      owned: true,
      state: "removed",
    };
    store.set(removed);

    await expect(prepareWorkspace(host, store, input, options)).rejects.toThrow(
      "add failed",
    );
    expect(store.forChannel(input.channelId)).toEqual(removed);
  });

  it("recreates an owned prunable registration in an existing empty leaf", async () => {
    const root = await mkdtemp(join(tmpdir(), "buzz-worktree-prepare-"));
    try {
      const repoRoot = join(root, "repo");
      const worktreeRoot = join(root, "trees");
      const worktreePath = join(worktreeRoot, "task");
      await mkdir(repoRoot);
      spawnSync("git", ["init", "-q", "-b", "main", repoRoot], {
        stdio: "inherit",
      });
      spawnSync(
        "git",
        [
          "-C",
          repoRoot,
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.org",
          "commit",
          "--allow-empty",
          "-qm",
          "base",
        ],
        { stdio: "inherit" },
      );
      const store = new BindingStore(memory());
      const realInput = {
        ...input,
        repoRoot,
        worktreeRoot,
        baseRef: "main",
      };
      const host = realHost();
      const first = await prepareWorkspace(host, store, realInput, options);
      const branchSha = spawnSync(
        "git",
        ["-C", repoRoot, "rev-parse", "refs/heads/buzz/task"],
        { encoding: "utf8" },
      ).stdout.trim();
      await rm(worktreePath, { recursive: true });

      await expect(
        prepareWorkspace(host, store, realInput, options),
      ).resolves.toMatchObject({ state: "ready", path: worktreePath });
      expect(first.baseSha).toBe(branchSha);
      expect(
        spawnSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], {
          encoding: "utf8",
        }).stdout.trim(),
      ).toBe(branchSha);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not mutate a locked owned worktree registration", async () => {
    const store = new BindingStore(memory());
    await prepareWorkspace(fixture().host, store, input, options);
    const locked = fixture({ existing: true, locked: true, prunable: true });
    await expect(
      prepareWorkspace(locked.host, store, input, options),
    ).rejects.toThrow("locked: interrupted add");
    expect(
      locked.calls.some(
        (args) => args[0] === "worktree" && args[1] === "remove",
      ),
    ).toBe(false);
  });

  it("explains an invalid repository without creating the worktree leaf", async () => {
    const { host } = fixture({ invalidRepo: true });
    const store = new BindingStore(memory());

    await expect(prepareWorkspace(host, store, input, options)).rejects.toThrow(
      'Workspace folder "/repo-link" is not a Git repository. Choose a Git repository in Workspace settings.',
    );
    expect(host.resolveDirectory).not.toHaveBeenCalledWith("/trees/task");
    expect(store.forChannel(input.channelId)).toBeUndefined();
  });

  it("creates a worktree from a bare repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "buzz-worktree-bare-"));
    try {
      const seed = join(root, "seed");
      const repoRoot = join(root, "repo.git");
      const worktreeRoot = join(root, "trees");
      spawnSync("git", ["init", "-q", "-b", "main", seed], {
        stdio: "inherit",
      });
      spawnSync(
        "git",
        [
          "-C",
          seed,
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.org",
          "commit",
          "--allow-empty",
          "-qm",
          "base",
        ],
        { stdio: "inherit" },
      );
      spawnSync("git", ["clone", "-q", "--bare", seed, repoRoot], {
        stdio: "inherit",
      });

      await expect(
        prepareWorkspace(
          realHost(),
          new BindingStore(memory()),
          { ...input, repoRoot, worktreeRoot, baseRef: "main" },
          options,
        ),
      ).resolves.toMatchObject({
        repoRoot,
        path: join(worktreeRoot, "task"),
        state: "ready",
      });
      await expect(access(join(worktreeRoot, "task", ".git"))).resolves.toBe(
        undefined,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("expands a tilde-prefixed repository before invoking Git", async () => {
    const { host } = fixture();

    await prepareWorkspace(
      host,
      new BindingStore(memory()),
      { ...input, repoRoot: "~/repo" },
      options,
    );

    expect(host.resolveDirectory).toHaveBeenCalledWith("~");
    expect(host.spawn).toHaveBeenCalledWith(
      "git",
      expect.objectContaining({
        args: [
          "--no-optional-locks",
          "-C",
          "/home/test/repo",
          "rev-parse",
          "--git-dir",
        ],
      }),
    );
  });

  it("preserves repository access errors from Git", async () => {
    const { host } = fixture({
      repositoryError:
        "fatal: detected dubious ownership in repository at '/repo-link'",
    });

    const error = await prepareWorkspace(
      host,
      new BindingStore(memory()),
      input,
      options,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GitError);
    expect(error).toHaveProperty(
      "message",
      "fatal: detected dubious ownership in repository at '/repo-link'",
    );
  });

  it("explains a missing base branch without creating the worktree leaf", async () => {
    const { host } = fixture({ missingBase: true });
    const store = new BindingStore(memory());

    await expect(prepareWorkspace(host, store, input, options)).rejects.toThrow(
      'Base branch "origin/main" was not found in workspace repository "/repo-link". Choose an existing base branch in Workspace settings.',
    );
    expect(host.resolveDirectory).not.toHaveBeenCalledWith("/trees/task");
    expect(store.forChannel(input.channelId)).toBeUndefined();
  });

  it("does not create a leaf for invalid real Git workspace settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "buzz-worktree-invalid-"));
    try {
      const repoRoot = join(root, "repo");
      const worktreeRoot = join(root, "trees");
      const worktreePath = join(worktreeRoot, "task");
      await mkdir(repoRoot);
      await mkdir(worktreeRoot);
      const host = realHost();
      const realInput = {
        ...input,
        repoRoot,
        worktreeRoot,
        baseRef: "main",
      };

      await expect(
        prepareWorkspace(host, new BindingStore(memory()), realInput, options),
      ).rejects.toThrow("is not a Git repository");
      await expect(access(worktreePath)).rejects.toThrow();

      spawnSync("git", ["init", "-q", "-b", "develop", repoRoot], {
        stdio: "inherit",
      });
      spawnSync(
        "git",
        [
          "-C",
          repoRoot,
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.org",
          "commit",
          "--allow-empty",
          "-qm",
          "base",
        ],
        { stdio: "inherit" },
      );
      await expect(
        prepareWorkspace(host, new BindingStore(memory()), realInput, options),
      ).rejects.toThrow('Base branch "main" was not found');
      await expect(access(worktreePath)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records failed and rethrows when creation fails", async () => {
    const { host } = fixture({ addFails: true });
    const store = new BindingStore(memory());
    await expect(prepareWorkspace(host, store, input, options)).rejects.toThrow(
      "add failed",
    );
    expect(store.forChannel(input.channelId)?.state).toBe("failed");
  });

  it("resumes against the saved SHA even when the base ref advances", async () => {
    const { host, calls } = fixture();
    const store = new BindingStore(memory());
    await prepareWorkspace(host, store, input, options);
    await prepareWorkspace(host, store, input, options);
    expect(
      calls.filter((args) => args.at(-1) === "origin/main^{commit}"),
    ).toHaveLength(1);
  });

  it("does not displace a different owned binding", async () => {
    const { host } = fixture();
    const store = new BindingStore(memory());
    await prepareWorkspace(host, store, input, options);
    await expect(
      prepareWorkspace(
        host,
        store,
        { ...input, worktreeName: "other" },
        options,
      ),
    ).rejects.toThrow("already owns a different workspace binding");
    expect(store.forChannel(input.channelId)?.path).toBe("/trees/task");
  });

  it.each([
    ["empty path segment", { branch: "buzz//task" }],
    ["ref expression", { baseRef: "main@{1}" }],
    ["option-like ref", { baseRef: "--help" }],
    ["nested leaf", { worktreeName: "repo/task" }],
    ["traversal leaf", { worktreeName: ".." }],
  ])("rejects %s before spawning", async (_name, patch) => {
    const { host } = fixture();
    await expect(
      prepareWorkspace(
        host,
        new BindingStore(memory()),
        { ...input, ...patch },
        options,
      ),
    ).rejects.toThrow();
    expect(host.spawn).not.toHaveBeenCalled();
  });
});
