import type { Host, HostProcessOptions } from "../../features/host/service";
import { describe, expect, it, vi } from "vitest";
import { BindingStore, type WorkspaceBinding } from "./binding";
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
  } = {},
) {
  const calls: string[][] = [];
  let added = options.existing ?? false;
  let branchExists = options.existingBranch ?? added;
  const spawn: NonNullable<Host["spawn"]> = vi.fn(
    async (_id: string, processOptions: HostProcessOptions = {}) => {
      const args = [...(processOptions.args ?? [])];
      const gitArgs = args.slice(3);
      calls.push(gitArgs);
      let stdout = "";
      let stderr = "";
      let code = 0;
      if (gitArgs[0] === "rev-parse" && gitArgs.at(-1)?.endsWith("^{commit}"))
        stdout = `${"a".repeat(40)}\n`;
      else if (gitArgs[0] === "rev-parse") stdout = "/repo/.git\n";
      else if (gitArgs[0] === "worktree" && gitArgs[1] === "list")
        stdout = `worktree /repo\0HEAD ${"a".repeat(40)}\0branch refs/heads/main\0\0${
          added
            ? `worktree /trees/task\0HEAD ${"a".repeat(40)}\0branch refs/heads/buzz/task\0\0`
            : ""
        }`;
      else if (gitArgs[0] === "worktree" && gitArgs[1] === "add") {
        if (options.addFails) {
          stderr = "add failed";
          code = 1;
        } else {
          added = true;
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
    if (path === "/repo-link") return "/repo";
    if (path === "/trees-link") return "/trees";
    return path;
  });
  return { host: { spawn, resolveDirectory }, calls };
}

const options = {
  newId: () => "binding-1",
  now: () => 10,
};

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
