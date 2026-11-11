import { expect, it, vi } from "vitest";
import type { HostProcessOptions } from "../../features/host/service";
import { BindingStore, type WorkspaceBinding } from "./binding";
import { getWorkspaceStatus, reconcileWorkspaceStatus } from "./status";

const binding: WorkspaceBinding = {
  bindingId: "binding-1",
  channelId: "channel-1",
  repoRoot: "/repo",
  worktreeRoot: "/trees",
  path: "/trees/repo/task",
  branch: "buzz/task",
  baseRef: "origin/main",
  baseSha: "a".repeat(40),
  gitCommonDir: "/repo/.git",
  createdAt: 1,
  installId: "install-1",
  owned: true,
  state: "ready",
};

function git(outputs: readonly string[]) {
  let call = 0;
  return vi.fn(async (_id: string, options?: HostProcessOptions) => {
    const output = outputs[call++] ?? "";
    return {
      write: async () => {},
      end: async () => options?.onStdout?.(output),
      kill: async () => {},
      exited: Promise.resolve(0),
    };
  });
}

it("resolves a binding id and rejects an unknown one", async () => {
  const values = new Map<string, string>();
  const store = new BindingStore({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  });
  store.set(binding);
  await expect(
    getWorkspaceStatus(git(["git version 2.35.9\n"]), store, "binding-1"),
  ).rejects.toThrow("Git 2.36 or newer is required");
  await expect(getWorkspaceStatus(git([]), store, "unknown")).rejects.toThrow(
    "Workspace binding not found",
  );
});

it("reconciles a dirty attached worktree and base divergence", async () => {
  const spawn = git([
    "git version 2.45.1\n",
    [
      "worktree /repo",
      `HEAD ${"a".repeat(40)}`,
      "branch refs/heads/main",
      "",
      `worktree ${binding.path}`,
      `HEAD ${"b".repeat(40)}`,
      "branch refs/heads/buzz/task",
      "",
      "",
    ].join("\0"),
    "/repo/.git\n",
    [
      `# branch.oid ${"b".repeat(40)}`,
      "# branch.head buzz/task",
      "? new file.txt",
      "1 .M N... 100644 100644 100644 abc abc changed.ts",
      "",
    ].join("\0"),
    "3\t2\n",
  ]);
  await expect(reconcileWorkspaceStatus(spawn, binding)).resolves.toEqual({
    state: "ready",
    path: binding.path,
    head: "b".repeat(40),
    branch: "buzz/task",
    detached: false,
    dirty: true,
    fileCount: 2,
    ahead: 2,
    behind: 3,
  });
  expect(
    spawn.mock.calls.every(([, options]) => options?.env?.LC_ALL === "C"),
  ).toBe(true);
  expect(
    spawn.mock.calls.every(
      ([, options]) => options?.args?.[0] === "--no-optional-locks",
    ),
  ).toBe(true);
});

it("reports a missing binding without probing its absent path", async () => {
  const spawn = git([
    "git version 2.36.0\n",
    `worktree /repo\0HEAD ${"a".repeat(40)}\0branch refs/heads/main\0\0`,
  ]);
  await expect(reconcileWorkspaceStatus(spawn, binding)).resolves.toMatchObject(
    {
      state: "missing",
      path: binding.path,
    },
  );
  expect(spawn).toHaveBeenCalledTimes(2);
});

it("reports repository and branch identity mismatches", async () => {
  const listed = `worktree ${binding.path}\0HEAD ${"b".repeat(40)}\0branch refs/heads/buzz/task\0\0`;
  await expect(
    reconcileWorkspaceStatus(
      git(["git version 2.36.0\n", listed, "/other/.git\n"]),
      binding,
    ),
  ).resolves.toMatchObject({
    state: "mismatched",
    reason: "Repository identity changed",
  });

  const wrongBranch = `worktree ${binding.path}\0HEAD ${"b".repeat(40)}\0branch refs/heads/other\0\0`;
  await expect(
    reconcileWorkspaceStatus(
      git(["git version 2.36.0\n", wrongBranch, "/repo/.git\n"]),
      binding,
    ),
  ).resolves.toMatchObject({
    state: "mismatched",
    reason: "Worktree branch changed",
  });
});

it("returns an explicit detached status and enforces Git 2.36", async () => {
  const listed = `worktree ${binding.path}\0HEAD ${"b".repeat(40)}\0detached\0\0`;
  await expect(
    reconcileWorkspaceStatus(
      git([
        "git version 2.36.0\n",
        listed,
        "/repo/.git\n",
        `# branch.oid ${"b".repeat(40)}\0# branch.head (detached)\0`,
        "0 0\n",
      ]),
      binding,
    ),
  ).resolves.toMatchObject({ state: "ready", detached: true, dirty: false });
  await expect(
    reconcileWorkspaceStatus(git(["git version 2.35.9\n"]), binding),
  ).rejects.toThrow("Git 2.36 or newer is required");
});
