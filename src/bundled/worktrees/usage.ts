import type { RelaySession } from "../../features/relay/session";
import { workingAgents } from "../channels/working-agents";

/** Fresh channel-wide agent evidence for a destructive workspace check. */
export function workspaceAgents(
  session: Pick<RelaySession, "agentActivity" | "typing" | "agentChoices">,
  channelId: string,
): string[] {
  const observed = workingAgents(session.agentActivity.snapshot(), channelId);
  const choices = new Set(
    session.agentChoices.snapshot().identities.map(({ pubkey }) => pubkey),
  );
  const typing = session.typing
    .snapshot()
    .filter(
      ({ channelId: typedChannel, pubkey }) =>
        typedChannel === channelId && choices.has(pubkey),
    )
    .map(({ pubkey }) => pubkey);
  return [...new Set([...observed, ...typing])].sort();
}
