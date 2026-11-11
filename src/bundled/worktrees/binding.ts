import { assertPathWithinRoot } from "./git";

const STORAGE_KEY = "buzz.worktrees.bindings.v1";

export type WorkspaceBinding = Readonly<{
  bindingId: string;
  channelId: string;
  repoRoot: string;
  worktreeRoot: string;
  path: string;
  branch: string;
  baseRef: string;
  baseSha: string;
  gitCommonDir: string;
  createdAt: number;
  installId: string;
  owned: boolean;
  state: "preparing" | "ready" | "missing" | "removing" | "removed" | "failed";
}>;

type SavedBindings = Readonly<{
  version: 1;
  bindings: readonly WorkspaceBinding[];
}>;

/** Device-local workspace bindings. Invalid records are ignored fail-closed. */
export class BindingStore {
  constructor(private readonly storage: Pick<Storage, "getItem" | "setItem">) {}

  all(): readonly WorkspaceBinding[] {
    try {
      const parsed: unknown = JSON.parse(
        this.storage.getItem(STORAGE_KEY) ?? "null",
      );
      if (!savedBindings(parsed)) return [];
      return parsed.bindings.filter(validBinding);
    } catch {
      return [];
    }
  }

  get(bindingId: string): WorkspaceBinding | undefined {
    return this.all().find((binding) => binding.bindingId === bindingId);
  }

  forChannel(channelId: string): WorkspaceBinding | undefined {
    return this.all().find((binding) => binding.channelId === channelId);
  }

  set(binding: WorkspaceBinding): void {
    if (!validBinding(binding)) throw new Error("Invalid workspace binding");
    const bindings = this.all().filter(
      (saved) =>
        saved.bindingId !== binding.bindingId &&
        saved.channelId !== binding.channelId,
    );
    this.storage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 1, bindings: [...bindings, binding] }),
    );
  }
}

function savedBindings(value: unknown): value is SavedBindings {
  return object(value) && value.version === 1 && Array.isArray(value.bindings);
}

function validBinding(value: unknown): value is WorkspaceBinding {
  if (!object(value)) return false;
  const strings = [
    "bindingId",
    "channelId",
    "repoRoot",
    "worktreeRoot",
    "path",
    "branch",
    "baseRef",
    "baseSha",
    "gitCommonDir",
    "installId",
  ] as const;
  if (
    strings.some(
      (key) => typeof value[key] !== "string" || value[key].length === 0,
    ) ||
    typeof value.createdAt !== "number" ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt < 0 ||
    typeof value.owned !== "boolean" ||
    ![
      "preparing",
      "ready",
      "missing",
      "removing",
      "removed",
      "failed",
    ].includes(String(value.state)) ||
    !/^[0-9a-f]{40,64}$/i.test(String(value.baseSha)) ||
    !validRef(String(value.branch)) ||
    !validRef(String(value.baseRef))
  )
    return false;
  try {
    assertPathWithinRoot(String(value.worktreeRoot), String(value.path));
    absoluteCanonical(String(value.repoRoot));
    absoluteCanonical(String(value.gitCommonDir));
    return true;
  } catch {
    return false;
  }
}

function absoluteCanonical(path: string): void {
  const windows = /^[A-Za-z]:[\\/]/.test(path);
  if ((!windows && !path.startsWith("/")) || path.includes("\0"))
    throw new Error("Path must be absolute");
  if (
    path
      .split(windows ? /[\\/]+/ : /\/+/)
      .some((part) => part === "." || part === "..")
  )
    throw new Error("Path must be canonical");
}

function validRef(value: string): boolean {
  return (
    !value.startsWith("-") &&
    !value.includes("..") &&
    !/[\s~^:?*[\\]/.test(value) &&
    !value.endsWith(".") &&
    !value.endsWith(".lock")
  );
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
