import { expect, it, vi } from "vitest";
import type { HostProcessOptions } from "../../features/host/service";
import { ClaudeAuth } from "./auth";
import { ENV, type Spawn } from "./claude";

/** A host whose `claude auth status --json` answers `status`; every start is
 * recorded. */
function host(status: string | undefined = '{"loggedIn":true}', code = 0) {
  const started: { id: string; options: HostProcessOptions | undefined }[] = [];
  const spawn: Spawn = async (id, options) => {
    started.push({ id, options });
    if (status !== undefined && options?.args?.[0] === "auth")
      queueMicrotask(() => options?.onStdout?.(status));
    return {
      write: async () => undefined,
      end: async () => undefined,
      kill: async () => undefined,
      exited: Promise.resolve(code),
    };
  };
  return { spawn, started };
}

it("starts every claude as it is: the sign-in lives in ~/.claude", async () => {
  const { spawn, started } = host();
  const auth = new ClaudeAuth(spawn);
  const authorized = auth.authorize(spawn, true);
  await authorized("claude", { args: ["--verbose"], env: { ...ENV, A: "1" } });
  await authorized("platform", { env: { ...ENV } });
  expect(started).toEqual([
    { id: "claude", options: { args: ["--verbose"], env: { ...ENV, A: "1" } } },
    { id: "platform", options: { env: { ...ENV } } },
  ]);
});

it("asks claude whether it is signed in, and as whom", async () => {
  const signedIn = host(
    '{"loggedIn":true,"email":"me@example.com","orgName":"Org"}',
  );
  await expect(new ClaudeAuth(signedIn.spawn).check()).resolves.toEqual({
    account: "me@example.com · Org",
  });
  expect(signedIn.started).toEqual([
    {
      id: "claude",
      options: expect.objectContaining({
        args: ["auth", "status", "--json"],
        env: ENV,
      }),
    },
  ]);
  await expect(
    new ClaudeAuth(host('{"loggedIn":true}').spawn).check(),
  ).resolves.toEqual({});
  await expect(
    new ClaudeAuth(host('{"loggedIn":false}').spawn).check(),
  ).resolves.toBeUndefined();
  await expect(
    new ClaudeAuth(host("", 1).spawn).check(),
  ).resolves.toBeUndefined();
  await expect(new ClaudeAuth(undefined).check()).resolves.toBeUndefined();
});

it("signs in interactively as a setup step and then tells listeners", async () => {
  const auth = new ClaudeAuth(host().spawn);
  const told = vi.fn();
  auth.subscribe(told);
  const steps: unknown[] = [];
  await auth.signIn?.(async (id, args, label) => {
    steps.push([id, args, label]);
  });
  expect(steps).toEqual([["claude", ["auth", "login"], "Sign-in"]]);
  expect(told).toHaveBeenCalledTimes(1);
  // A failed sign-in changes nothing.
  await expect(
    auth.signIn?.(async () => {
      throw new Error("Sign-in ended (1).");
    }),
  ).rejects.toThrow("Sign-in ended (1).");
  expect(told).toHaveBeenCalledTimes(1);
});

it("has no key to save and no credentials for reviews", async () => {
  const auth = new ClaudeAuth(host().spawn);
  await expect(auth.save("sk-ant-anything")).rejects.toThrow("no key to save");
  await expect(auth.review()).rejects.toThrow("API key build");
});

it("links a turn that failed for want of a sign-in to Settings", () => {
  const auth = new ClaudeAuth(undefined);
  const settings = "buzz://settings?section=agents";
  const linked = `Claude is not signed in. Head to [Settings](${settings}) and choose Sign in.`;
  expect(auth.explainTurn("Not logged in · Please run /login", settings)).toBe(
    linked,
  );
  expect(
    auth.explainTurn("authentication_error: OAuth token has expired", settings),
  ).toBe(linked);
  expect(auth.explainTurn("Error: overloaded", settings)).toBe(
    "Error: overloaded",
  );
  expect(auth.explain("OAuth token revoked")).toContain("Sign in again");
  expect(auth.explain("Error: overloaded")).toBe("Error: overloaded");
});
