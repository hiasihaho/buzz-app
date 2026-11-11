import { spawn as spawnProcess, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Host, HostProcessOptions } from "../../features/host/service";
import type { WorkspaceBinding } from "./binding";
import {
  previewWorkspaceFinish,
  recoverWorkspaceRemoval,
  removeWorkspace,
} from "./finish";

const sha = "a".repeat(40);
const binding: WorkspaceBinding = {
  bindingId: "binding-1",
  channelId: "channel-1",
  repoRoot: "/repo",
  worktreeRoot: "/trees",
  path: "/trees/task",
  branch: "buzz/task",
  baseRef: "origin/main",
  baseSha: "b".repeat(40),
  gitCommonDir: "/repo/.git",
  createdAt: 1,
  installId: "install-1",
  owned: true,
  state: "ready",
};

type GitResult = string | Readonly<{ code: number; stderr: string }>;

function git(outputs: readonly GitResult[]) {
  let call = 0;
  return vi.fn(async (_id: string, options: HostProcessOptions = {}) => {
    const result = outputs[call++] ?? "";
    if (typeof result === "string") options.onStdout?.(result);
    else options.onStderr?.(result.stderr);
    return {
      write: async () => {},
      end: async () => {},
      kill: async () => {},
      exited: Promise.resolve(typeof result === "string" ? 0 : result.code),
    };
  });
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

function listed(value: WorkspaceBinding = binding, fields = "") {
  return [
    `worktree ${value.repoRoot}`,
    `HEAD ${"c".repeat(40)}`,
    "branch refs/heads/main",
    "",
    `worktree ${value.path}`,
    `HEAD ${sha}`,
    `branch refs/heads/${value.branch}`,
    fields,
    "",
  ].join("\0");
}

function status(entries: readonly string[] = []) {
  return [
    `# branch.oid ${sha}`,
    "# branch.head buzz/task",
    ...entries,
    "",
  ].join("\0");
}

function store(value: WorkspaceBinding = binding) {
  let saved = value;
  return {
    get: vi.fn((id: string) => (id === saved.bindingId ? saved : undefined)),
    set: vi.fn((next: WorkspaceBinding) => {
      saved = next;
    }),
    current: () => saved,
  };
}

const available = async () => ({ agents: [], terminals: [] });
const options = { installId: binding.installId, inspectUse: available };

function safePreviewOutputs() {
  return [listed(), "/repo/.git\n", status(), "0\n"];
}

describe("safe worktree finish", () => {
  it("previews one owned clean worktree and uses strict ignored and unpublished checks", async () => {
    const spawn = git(safePreviewOutputs());
    await expect(
      previewWorkspaceFinish(spawn, store(), binding.bindingId, options),
    ).resolves.toEqual({
      bindingId: binding.bindingId,
      path: binding.path,
      branch: binding.branch,
      head: sha,
      unpublishedCommits: 0,
      blockers: [],
    });
    expect(spawn.mock.calls.map(([, value]) => value?.args)).toEqual([
      [
        "--no-optional-locks",
        "-C",
        binding.repoRoot,
        "worktree",
        "list",
        "--porcelain",
        "-z",
      ],
      [
        "--no-optional-locks",
        "-C",
        binding.path,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ],
      [
        "--no-optional-locks",
        "-C",
        binding.path,
        "status",
        "--porcelain=v2",
        "--branch",
        "--untracked-files=all",
        "--ignored=matching",
        "-z",
      ],
      [
        "--no-optional-locks",
        "-C",
        binding.path,
        "rev-list",
        "--count",
        "HEAD",
        "--not",
        "--remotes",
        "--",
      ],
    ]);
  });

  it("reports every destructive-work blocker without treating ignored files as clean", async () => {
    const dirty = [
      `1 .M N... 100644 100644 100644 ${sha} ${sha} tracked.txt`,
      "? new.txt",
      "! .env",
    ];
    const spawn = git([
      listed(binding, "locked busy"),
      "/other/.git\n",
      status(dirty),
      "2\n",
    ]);
    const result = await previewWorkspaceFinish(
      spawn,
      store({ ...binding, state: "failed" }),
      binding.bindingId,
      {
        ...options,
        inspectUse: async () => ({ agents: ["agent"], terminals: ["shell"] }),
      },
    );
    expect(result.blockers).toEqual([
      expect.objectContaining({ kind: "binding-state" }),
      expect.objectContaining({ kind: "locked" }),
      expect.objectContaining({ kind: "repository" }),
      expect.objectContaining({ kind: "dirty", count: 2 }),
      expect.objectContaining({ kind: "ignored", count: 1 }),
      expect.objectContaining({ kind: "unpublished", count: 2 }),
      expect.objectContaining({ kind: "usage", count: 2 }),
    ]);
  });

  it("blocks detached, missing, foreign and unverifiable-use worktrees", async () => {
    await expect(
      previewWorkspaceFinish(
        git([listed(binding, "detached"), "/repo/.git\n", status(), "0\n"]),
        store(),
        binding.bindingId,
        options,
      ),
    ).resolves.toMatchObject({
      blockers: [expect.objectContaining({ kind: "detached" })],
    });

    await expect(
      previewWorkspaceFinish(
        git([`worktree /repo\0HEAD ${sha}\0branch refs/heads/main\0\0`]),
        store(),
        binding.bindingId,
        options,
      ),
    ).resolves.toMatchObject({ blockers: [{ kind: "missing" }] });

    await expect(
      previewWorkspaceFinish(
        git([]),
        store({ ...binding, owned: false }),
        binding.bindingId,
        options,
      ),
    ).rejects.toThrow("not owned by this installation");

    const result = await previewWorkspaceFinish(
      git(safePreviewOutputs()),
      store(),
      binding.bindingId,
      {
        ...options,
        inspectUse: async () => Promise.reject(new Error("no probe")),
      },
    );
    expect(result.blockers).toContainEqual(
      expect.objectContaining({ kind: "usage-unknown" }),
    );
  });

  it("refuses a changed HEAD before writing lifecycle state or removing", async () => {
    const saved = store();
    const spawn = git([...safePreviewOutputs(), `${"d".repeat(40)}\n`]);
    await expect(
      removeWorkspace(spawn, saved, binding.bindingId, sha, options),
    ).rejects.toThrow("HEAD changed since finish preview");
    expect(saved.set).not.toHaveBeenCalled();
    expect(
      spawn.mock.calls.some(([, value]) => value?.args?.includes("remove")),
    ).toBe(false);
  });

  it("removes without force, verifies absence, and preserves the binding identity", async () => {
    const saved = store();
    const remaining = `worktree /repo\0HEAD ${"c".repeat(40)}\0branch refs/heads/main\0\0`;
    const spawn = git([...safePreviewOutputs(), `${sha}\n`, "", remaining]);
    await expect(
      removeWorkspace(spawn, saved, binding.bindingId, sha, options),
    ).resolves.toEqual({ ...binding, state: "removed" });
    expect(saved.set.mock.calls.map(([value]) => value.state)).toEqual([
      "removing",
      "removed",
    ]);
    expect(spawn.mock.calls.at(-2)?.[1]?.args).toEqual([
      "--no-optional-locks",
      "-C",
      binding.repoRoot,
      "worktree",
      "remove",
      "--",
      binding.path,
    ]);
    expect(spawn.mock.calls.at(-2)?.[1]?.args).not.toContain("--force");
  });

  it("restores ready after a rejected remove leaves the same worktree intact", async () => {
    const saved = store();
    const spawn = git([
      ...safePreviewOutputs(),
      `${sha}\n`,
      { code: 128, stderr: "fatal: worktree contains modified files\n" },
      listed(),
      "/repo/.git\n",
    ]);
    await expect(
      removeWorkspace(spawn, saved, binding.bindingId, sha, options),
    ).rejects.toThrow("worktree contains modified files");
    expect(saved.set.mock.calls.map(([value]) => value.state)).toEqual([
      "removing",
      "ready",
    ]);
  });

  it("restores ready when cancellation happens as remove starts", async () => {
    const controller = new AbortController();
    const saved = store();
    const delegate = git([
      ...safePreviewOutputs(),
      `${sha}\n`,
      "",
      listed(),
      "/repo/.git\n",
    ]);
    const spawn = vi.fn(async (id: string, value: HostProcessOptions = {}) => {
      const process = await delegate(id, value);
      if (value.args?.includes("remove")) controller.abort();
      return process;
    });
    await expect(
      removeWorkspace(spawn, saved, binding.bindingId, sha, {
        ...options,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/abort/i);
    expect(saved.current().state).toBe("ready");
  });

  it("recovers a persisted removing state after restart", async () => {
    const registered = store({ ...binding, state: "removing" });
    await expect(
      recoverWorkspaceRemoval(
        git([listed(), "/repo/.git\n"]),
        registered,
        binding.bindingId,
        binding.installId,
      ),
    ).resolves.toMatchObject({ state: "ready" });

    const absent = store({ ...binding, state: "removing" });
    await expect(
      recoverWorkspaceRemoval(
        git([`worktree /repo\0HEAD ${sha}\0branch refs/heads/main\0\0`]),
        absent,
        binding.bindingId,
        binding.installId,
      ),
    ).resolves.toMatchObject({ state: "removed" });
  });

  it("keeps failed when the post-error worktree state cannot be reconciled", async () => {
    const saved = store();
    const spawn = git([
      ...safePreviewOutputs(),
      `${sha}\n`,
      { code: 128, stderr: "fatal: unknown outcome\n" },
      { code: 128, stderr: "fatal: repository unavailable\n" },
    ]);
    await expect(
      removeWorkspace(spawn, saved, binding.bindingId, sha, options),
    ).rejects.toThrow("unknown outcome");
    expect(saved.current().state).toBe("failed");
  });

  it("propagates aborts from the required usage inspection", async () => {
    const controller = new AbortController();
    await expect(
      previewWorkspaceFinish(
        git(safePreviewOutputs()),
        store(),
        binding.bindingId,
        {
          ...options,
          signal: controller.signal,
          inspectUse: async () => {
            controller.abort();
            throw new Error("interrupted probe");
          },
        },
      ),
    ).rejects.toThrow(/abort/i);
  });

  it("blocks ignored data and safely removes a real Git worktree without deleting its branch", async () => {
    const created = await mkdtemp(join(tmpdir(), "buzz-worktree-finish-"));
    const root = await realpath(created);
    try {
      const repoRoot = join(root, "repo");
      const remote = join(root, "remote.git");
      const worktreeRoot = join(root, "trees");
      const path = join(worktreeRoot, "task");
      await mkdir(repoRoot);
      await mkdir(worktreeRoot);
      run(root, ["init", "-q", "--bare", remote]);
      run(root, ["init", "-q", "-b", "main", repoRoot]);
      await writeFile(join(repoRoot, ".gitignore"), ".env\n");
      run(repoRoot, ["add", ".gitignore"]);
      run(repoRoot, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.org",
        "commit",
        "-qm",
        "base",
      ]);
      run(repoRoot, ["remote", "add", "origin", remote]);
      run(repoRoot, ["push", "-qu", "origin", "main"]);
      run(repoRoot, ["worktree", "add", "-qb", "buzz/task", path, "main"]);
      const head = run(path, ["rev-parse", "HEAD"]);
      const actual: WorkspaceBinding = {
        ...binding,
        repoRoot,
        worktreeRoot,
        path,
        baseRef: "main",
        baseSha: head,
        gitCommonDir: await realpath(join(repoRoot, ".git")),
      };
      const saved = store(actual);
      await writeFile(join(path, ".env"), "secret\n");
      await expect(
        previewWorkspaceFinish(realSpawn(), saved, actual.bindingId, options),
      ).resolves.toMatchObject({
        head,
        blockers: [expect.objectContaining({ kind: "ignored", count: 1 })],
      });
      await rm(join(path, ".env"));
      const raced = join(path, "late.txt");
      await expect(
        removeWorkspace(realSpawn(), saved, actual.bindingId, head, {
          ...options,
          inspectUse: async () => {
            await writeFile(raced, "late\n");
            return { agents: [], terminals: [] };
          },
        }),
      ).rejects.toThrow(/modified or untracked files/);
      expect(saved.current().state).toBe("ready");
      await rm(raced);
      await expect(
        removeWorkspace(realSpawn(), saved, actual.bindingId, head, options),
      ).resolves.toMatchObject({ state: "removed" });
      expect(run(repoRoot, ["rev-parse", "refs/heads/buzz/task"])).toBe(head);
      expect(run(repoRoot, ["worktree", "list", "--porcelain"])).not.toContain(
        path,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
