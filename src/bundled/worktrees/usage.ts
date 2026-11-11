import type { RelaySession } from "../../features/relay/session";
import { workingAgents } from "../channels/working-agents";

/** Fresh channel-wide agent evidence for a destructive workspace check. */
export function workspaceAgents(
  session: Pick<RelaySession, "agentActivity" | "typing" | "agentChoices">,
  channelId: string,
): string[] {
  const observed = workingAgents(session.agentActivity.snapshot(), channelId);
  const typingInChannel = session.typing
    .snapshot()
    .filter(({ channelId: typedChannel }) => typedChannel === channelId);
  const choiceSnapshot = session.agentChoices.snapshot();
  if (typingInChannel.length > 0 && choiceSnapshot.status !== "ready")
    throw new Error("Available agents have not finished loading");
  const choices = new Set(
    choiceSnapshot.identities.map(({ pubkey }) => pubkey),
  );
  const typing = typingInChannel
    .filter(({ pubkey }) => choices.has(pubkey))
    .map(({ pubkey }) => pubkey);
  return [...new Set([...observed, ...typing])].sort();
}
