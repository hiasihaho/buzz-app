import { Service, type Context } from "@deepseek-ai/cordis";
import { createElement, type ComponentType } from "react";
import type { Browser, BrowserViewProps, EvaluateOptions } from "./api";
import { AutomationPolicy } from "./automation-policy";
import { BrowserHostView } from "./BrowserHostView";
import { createBrowserPlatform, type BrowserPlatform } from "./platform";
import { BrowserSessions } from "./sessions";

/** A guest's origin is its grant boundary; pages without one (about:blank)
 * grant nothing. Guests only ever load http/https, so this never throws. */
function originOf(url: string): string | undefined {
  try {
    const { origin } = new URL(url);
    return origin === "null" ? undefined : origin;
  } catch {
    return undefined;
  }
}

export class BrowserService extends Service implements Browser {
  readonly View: ComponentType<BrowserViewProps>;
  private readonly sessions: BrowserSessions;
  private readonly policy = new AutomationPolicy();

  constructor(
    ctx: Context,
    private readonly platform: BrowserPlatform = createBrowserPlatform(),
  ) {
    super(ctx, "browser");
    this.sessions = new BrowserSessions(this.platform);
    this.View = (props) =>
      createElement(BrowserHostView, {
        ...props,
        platform: this.platform,
        sessions: this.sessions,
        policy: this.policy,
      });
  }
  get available() {
    return this.platform.available;
  }
  async guests() {
    const guests = await this.sessions.guests();
    // Host-side callers (the panel console) see everything. A plugin sees
    // full details only for origins it holds a grant on; the rest it can
    // perceive — so it can ask — but not read.
    const pluginId = this.ctx.pluginOwner?.id;
    if (!pluginId) return guests;
    return guests.map((guest) => {
      const origin = originOf(guest.url);
      if (origin && this.policy.grantFor(pluginId, origin)) return guest;
      return { ...guest, url: origin ?? "", title: "" };
    });
  }
  async evaluate(sessionId: string, script: string, options?: EvaluateOptions) {
    const pluginId = this.ctx.pluginOwner?.id;
    if (!pluginId) return this.platform.evaluate(sessionId, script);
    const { url } = await this.platform.status(sessionId);
    const origin = originOf(url);
    if (!origin)
      throw new Error("The guest has no origin to grant access to yet.");
    await this.policy.authorize(
      pluginId,
      sessionId,
      origin,
      options?.kind === "read" ? "read" : "act",
      script,
    );
    return this.platform.evaluate(sessionId, script);
  }
}
