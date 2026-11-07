import type { ComponentType } from "react";
import type { AutomationVerb } from "./automation-policy";

/** One signed-in Builderlab lifetime; never passed to website JavaScript.
 * `federated` is the public NIP-FI session revision; native holds its token. */
export type BuilderlabViewerSession = Readonly<
  ({ federated: string } | { broker: { origin: string; revision: string } }) & {
    storage: string;
    signal: AbortSignal;
  }
>;

export type BrowserViewProps = Readonly<{
  url: string;
  /** Bootstrap only the configured Builderlab tenant's app using its native viewer exchange. */
  builderlab?: BuilderlabViewerSession;
  /** Which polled destinations may reopen after guest eviction. Native auth still validates the destination. */
  canResumeUrl?: ((url: string) => boolean) | undefined;
  /** Keeps the website's cookies and storage under this name between opens
   * and restarts (1-64 of a-z, 0-9, `-`, `_`, `.`), where the platform can hold
   * them apart from Buzz's own. Without it each open is a private session. */
  storage?: string;
  /** Names the view's tab until the website has a title, and while a hidden
   * tab has not opened it yet. */
  label?: string | undefined;
}>;

/** A live website guest, as host automation sees it. */
export type BrowserGuest = Readonly<{
  id: string;
  url: string;
  title: string;
  loading: boolean;
}>;

/** How a plugin classifies an evaluation for the automation policy gate
 * (block/buzz-app#2984). Reading covers listing and snapshots; acting covers
 * clicks, input and free-form script. Undeclared calls count as acting. */
export type EvaluateOptions = Readonly<{ kind?: AutomationVerb }>;

export interface Browser {
  readonly available: boolean;
  readonly View: ComponentType<BrowserViewProps>;
  /** The live guests, most recently shown first; one that closes
   * mid-listing is left out. A plugin sees a guest's full details only with
   * a grant on its origin; without one it gets the id, the origin and the
   * loading state, so it can ask for access but not read content. */
  guests(): Promise<readonly BrowserGuest[]>;
  /** Runs `script` in a guest's page scope and resolves with its
   * JSON-serializable return value; page exceptions reject. Only the host
   * and plugins can evaluate — website JavaScript never reaches this.
   * Plugin calls pass the automation policy gate (master switch, per-origin
   * grant, rate limit) and are audited by plugin, origin and script hash. */
  evaluate(
    sessionId: string,
    script: string,
    options?: EvaluateOptions,
  ): Promise<unknown>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    browser: Browser;
  }
}
