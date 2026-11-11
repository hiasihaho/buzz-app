import { expect, it } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import { workspaceAgents } from "./usage";

type Session = Pick<RelaySession, "agentActivity" | "typing" | "agentChoices">;

it("includes an app-managed agent whose only live evidence is typing", () => {
  const typer = "a".repeat(64);
  const session = {
    agentActivity: {
      snapshot: () => ({
        status: "listening",
        records: [],
        turns: [],
        typing: [],
        trimmed: 0,
      }),
    },
    typing: {
      snapshot: () => [
        { channelId: "chat", pubkey: typer, threadRootId: "thread" },
        { channelId: "other", pubkey: "b".repeat(64) },
      ],
    },
    agentChoices: {
      snapshot: () => ({
        status: "ready",
        identities: [{ pubkey: typer, name: "Builder" }],
      }),
    },
  } as unknown as Session;

  expect(workspaceAgents(session, "chat")).toEqual([typer]);
});

it("fails closed when typing exists before agent choices are ready", () => {
  const typer = "a".repeat(64);
  const session = {
    agentActivity: {
      snapshot: () => ({
        status: "listening",
        records: [],
        turns: [],
        typing: [],
        trimmed: 0,
      }),
    },
    typing: {
      snapshot: () => [{ channelId: "chat", pubkey: typer }],
    },
    agentChoices: {
      snapshot: () => ({ status: "loading", identities: [] }),
    },
  } as unknown as Session;

  expect(() => workspaceAgents(session, "chat")).toThrow(
    "Available agents have not finished loading",
  );
});
