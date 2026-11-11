import { expect, it } from "vitest";
import { BindingStore, type WorkspaceBinding } from "./binding";

function memory() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    values,
  };
}

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

it("round trips one binding per channel and id", () => {
  const storage = memory();
  const store = new BindingStore(storage);
  store.set(binding);
  expect(store.get("binding-1")).toEqual(binding);
  expect(store.forChannel("channel-1")).toEqual(binding);

  const replacement = {
    ...binding,
    bindingId: "binding-2",
    branch: "buzz/new",
  };
  expect(() => store.set(replacement)).toThrow(
    "Owned workspace binding cannot be replaced",
  );
  expect(store.all()).toEqual([binding]);

  store.set({ ...binding, state: "preparing" });
  expect(store.all()).toEqual([{ ...binding, state: "preparing" }]);
});

it("ignores malformed, unsupported and unsafe saved records fail-closed", () => {
  const storage = memory();
  const store = new BindingStore(storage);
  storage.setItem("buzz.worktrees.bindings.v1", "not json");
  expect(store.all()).toEqual([]);
  storage.setItem(
    "buzz.worktrees.bindings.v1",
    JSON.stringify({ version: 2, bindings: [binding] }),
  );
  expect(store.all()).toEqual([]);
  storage.setItem(
    "buzz.worktrees.bindings.v1",
    JSON.stringify({
      version: 1,
      bindings: [
        binding,
        { ...binding, bindingId: "bad", path: "/trees/../private" },
      ],
    }),
  );
  expect(store.all()).toEqual([binding]);
});

it("refuses to persist an invalid binding", () => {
  const store = new BindingStore(memory());
  expect(() => store.set({ ...binding, path: "/outside" })).toThrow(
    "Invalid workspace binding",
  );
});

it("does not silently discard invalid stored records during a write", () => {
  const storage = memory();
  const store = new BindingStore(storage);
  storage.setItem(
    "buzz.worktrees.bindings.v1",
    JSON.stringify({
      version: 1,
      bindings: [binding, { ...binding, path: "/outside" }],
    }),
  );
  expect(() => store.set({ ...binding, state: "preparing" })).toThrow(
    "Workspace binding store is invalid",
  );
  expect(store.all()).toEqual([binding]);
});
