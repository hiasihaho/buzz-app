import { expect, it, vi } from "vitest";
import type { Host, HostProcessOptions } from "../../features/host/service";
import {
  assertPathWithinRoot,
  GitError,
  GitUnavailable,
  parseStatus,
  parseWorktreeList,
  runGit,
} from "./git";

function fakeSpawn(stdout: string, code = 0, stderr = "", endError?: Error) {
  const kill = vi.fn(async () => {});
  const spawn = vi.fn(async (_id: string, options?: HostProcessOptions) => {
    let exit!: (code: number | null) => void;
    const exited = new Promise<number | null>((resolve) => {
      exit = resolve;
    });
    kill.mockImplementation(async () => exit(null));
    return {
      write: async () => {},
      end: async () => {
        options?.onStdout?.(stdout);
        options?.onStderr?.(stderr);
        exit(code);
        if (endError) throw endError;
      },
      kill,
      exited,
    };
  });
  return { spawn, kill };
}

it("always runs git with -C and never uses cwd", async () => {
  const { spawn } = fakeSpawn("answer\n");
  await expect(
    runGit(spawn, "/repos/project", ["status", "--porcelain=v2", "-z"]),
  ).resolves.toBe("answer\n");
  expect(spawn).toHaveBeenCalledWith("git", {
    args: [
      "--no-optional-locks",
      "-C",
      "/repos/project",
      "status",
      "--porcelain=v2",
      "-z",
    ],
    env: { LC_ALL: "C" },
    onStdout: expect.any(Function),
    onStderr: expect.any(Function),
  });
  expect(spawn.mock.calls[0]?.[1]).not.toHaveProperty("cwd");
});

it("uses the exit code when Git exits before stdin is closed", async () => {
  const { spawn } = fakeSpawn("answer\n", 0, "", new Error("No such process"));
  await expect(runGit(spawn, "/repo", ["status"])).resolves.toBe("answer\n");
});

it("reports spawn and git failures distinctly", async () => {
  await expect(
    runGit(
      vi.fn(async () => {
        throw new Error("not installed");
      }),
      "/repo",
      ["status"],
    ),
  ).rejects.toThrow(new GitUnavailable("not installed"));
  const { spawn } = fakeSpawn("", 128, "fatal: not a git repository\n");
  await expect(runGit(spawn, "/repo", ["status"])).rejects.toEqual(
    new GitError(
      "fatal: not a git repository",
      128,
      "fatal: not a git repository\n",
    ),
  );
  await expect(runGit(spawn, "relative/repo", ["status"])).rejects.toThrow(
    "Git path must be absolute",
  );
});

it("rejects an already-aborted call before spawning", async () => {
  const spawn = vi.fn();
  const controller = new AbortController();
  controller.abort();
  await expect(
    runGit(spawn, "/repo", ["status"], controller.signal),
  ).rejects.toThrow();
  expect(spawn).not.toHaveBeenCalled();
});

it("rejects Windows paths on POSIX", async () => {
  const { spawn } = fakeSpawn("");
  await expect(runGit(spawn, "C:/repo", ["status"])).rejects.toThrow(
    "Git path must be absolute on this platform",
  );
  expect(spawn).not.toHaveBeenCalled();
});

it("stops git at its deadline", async () => {
  let exit!: (code: number | null) => void;
  const kill = vi.fn(async () => exit(null));
  const spawn: NonNullable<Host["spawn"]> = vi.fn(async () => ({
    write: async () => {},
    end: async () => {},
    kill,
    exited: new Promise<number | null>((resolve) => {
      exit = resolve;
    }),
  }));
  await expect(
    runGit(spawn, "/repo", ["status"], undefined, 1),
  ).rejects.toThrow();
  expect(kill).toHaveBeenCalledOnce();
});

it("stops git when the caller aborts", async () => {
  let exit!: (code: number | null) => void;
  const kill = vi.fn(async () => exit(null));
  const spawn: NonNullable<Host["spawn"]> = vi.fn(async () => ({
    write: async () => {},
    end: async () => {},
    kill,
    exited: new Promise<number | null>((resolve) => {
      exit = resolve;
    }),
  }));
  const controller = new AbortController();
  const result = runGit(spawn, "/repo", ["status"], controller.signal);
  await Promise.resolve();
  await Promise.resolve();
  controller.abort();
  await expect(result).rejects.toThrow();
  expect(kill).toHaveBeenCalledOnce();
});

it("parses porcelain worktree records and optional states", () => {
  const output = [
    "worktree /repo",
    "HEAD 0123456789abcdef",
    "branch refs/heads/main",
    "",
    "worktree /repo/feature path",
    "HEAD fedcba9876543210",
    "detached",
    "locked active operation",
    "prunable gitdir file points to non-existent location",
    "",
    "worktree /repo/locked",
    "HEAD 1111111111111111",
    "locked",
    "",
    "worktree /repo.git",
    "bare",
    "",
    "",
  ].join("\0");
  expect(parseWorktreeList(output)).toEqual([
    {
      path: "/repo",
      head: "0123456789abcdef",
      branch: "refs/heads/main",
      detached: false,
      bare: false,
      locked: false,
      prunable: false,
    },
    {
      path: "/repo/feature path",
      head: "fedcba9876543210",
      detached: true,
      bare: false,
      locked: true,
      lockReason: "active operation",
      prunable: true,
      prunableReason: "gitdir file points to non-existent location",
    },
    {
      path: "/repo/locked",
      head: "1111111111111111",
      detached: false,
      bare: false,
      locked: true,
      prunable: false,
    },
    {
      path: "/repo.git",
      detached: false,
      bare: true,
      locked: false,
      prunable: false,
    },
  ]);
  expect(() => parseWorktreeList("worktree /repo\0\0")).toThrow(
    "Invalid git worktree output",
  );
});

it("parses branch metadata and every porcelain v2 entry kind", () => {
  const output = [
    "# branch.oid abc123",
    "# branch.head feature/worktrees",
    "# branch.upstream origin/feature/worktrees",
    "# branch.ab +2 -3",
    "1 .M N... 100644 100644 100644 abc abc file with spaces.ts",
    "2 R. N... 100644 100644 100644 abc abc R100 renamed file.ts",
    "old file.ts",
    "u UU N... 100644 100644 100644 100644 abc def 012 conflict.ts",
    "? untracked file.ts",
    "! ignored file.ts",
    "",
  ].join("\0");
  expect(parseStatus(output)).toEqual({
    oid: "abc123",
    head: "feature/worktrees",
    upstream: "origin/feature/worktrees",
    ahead: 2,
    behind: 3,
    entries: [
      {
        kind: "ordinary",
        path: "file with spaces.ts",
        index: ".",
        worktree: "M",
      },
      {
        kind: "renamed",
        path: "renamed file.ts",
        originalPath: "old file.ts",
        index: "R",
        worktree: ".",
      },
      {
        kind: "unmerged",
        path: "conflict.ts",
        index: "U",
        worktree: "U",
      },
      {
        kind: "untracked",
        path: "untracked file.ts",
        index: "?",
        worktree: "?",
      },
      {
        kind: "ignored",
        path: "ignored file.ts",
        index: "?",
        worktree: "?",
      },
    ],
  });
});

it("ignores unknown headers and omits unavailable branch metadata", () => {
  const output = [
    "# branch.oid (initial)",
    "# branch.head (detached)",
    "# branch.upstream origin/main",
    "# stash 1",
    "",
  ].join("\0");
  expect(parseStatus(output)).toEqual({
    upstream: "origin/main",
    entries: [],
  });
});

it("rejects malformed status records", () => {
  expect(() => parseStatus("# branch.ab +x -1\0")).toThrow(
    "Invalid git status branch counts",
  );
  expect(() =>
    parseStatus("2 R. N... 100644 100644 100644 abc abc R100 new\0"),
  ).toThrow("Invalid git rename status");
  expect(() => parseStatus("unexpected\0")).toThrow(
    "Invalid git status output",
  );
});

it("accepts only canonical descendants of the configured worktree root", () => {
  expect(() =>
    assertPathWithinRoot("/home/me/worktrees", "/home/me/worktrees/repo/task"),
  ).not.toThrow();
  expect(() =>
    assertPathWithinRoot("C:\\Worktrees", "c:\\worktrees\\repo\\task"),
  ).not.toThrow();
  for (const candidate of [
    "/home/me/worktrees",
    "/home/me/worktrees-other/task",
    "/home/me/worktrees/../private/task",
    "relative/task",
  ]) {
    expect(() =>
      assertPathWithinRoot("/home/me/worktrees", candidate),
    ).toThrow();
  }
});
