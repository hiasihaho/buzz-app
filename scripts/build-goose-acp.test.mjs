import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

// target/ is often a symlink onto another disk, and rename cannot cross a
// filesystem boundary. Make every rename between target/ and the rest of the
// tree fail with EXDEV, as the kernel would, so staging must copy across it.
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal();
  const underTarget = (path) => path.split(sep).includes("target");
  return {
    ...fs,
    renameSync(from, to) {
      if (underTarget(from) !== underTarget(to)) {
        const error = new Error(
          `EXDEV: cross-device link not permitted, rename '${from}' -> '${to}'`,
        );
        error.code = "EXDEV";
        throw error;
      }
      return fs.renameSync(from, to);
    },
  };
});
const fs = await import("node:fs");
const { stageGoose } = await import("./build-goose-acp.mjs");

const triple = "x86_64-unknown-linux-gnu";
const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "buzz-goose-stage-"));
  directories.push(root);
  const executable = "#!/bin/sh\necho goose-acp\n";
  const source = join(root, "release");
  fs.mkdirSync(source);
  fs.writeFileSync(join(source, "goose-acp"), executable, { mode: 0o755 });
  const archive = join(root, "goose-acp.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", source, "goose-acp"]);
  const bytes = fs.readFileSync(archive);
  const pin = {
    version: "test",
    assets: {
      [triple]: {
        url: "https://example.invalid/goose-acp.tar.gz",
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    },
  };
  const download = vi.fn(async () => ({
    ok: true,
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  }));
  return { root, executable, pin, download };
}

it("stages goose-acp when target/ lies on another filesystem", async () => {
  const { root, executable, pin, download } = fixture();
  await stageGoose(root, pin, triple, download);
  const binary = join(root, "src-tauri/resources/bin/goose-acp");
  expect(fs.readFileSync(binary, "utf8")).toBe(executable);
  expect(fs.statSync(binary).mode & 0o111).toBe(0o111);
  // Nothing half-staged is left behind the destination or in the cache.
  expect(fs.readdirSync(join(root, "src-tauri/resources/bin"))).toEqual([
    "goose-acp",
  ]);
  expect(
    fs
      .readdirSync(join(root, "target/goose-acp-download"))
      .filter((name) => name.startsWith("stage-")),
  ).toEqual([]);
  // The verified archive is cached, so staging again downloads nothing.
  await stageGoose(root, pin, triple, download);
  expect(download).toHaveBeenCalledTimes(1);
});
