import { describe, expect, it, vi } from "vitest";
import type { Host } from "../../features/host/service";
import { createWorktrees } from "./service";
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
