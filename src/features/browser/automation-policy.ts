import { useSyncExternalStore } from "react";

/** Policy gate for plugin browser automation (PoC for the guest-access
 * contract, block/buzz-app#2984). Every plugin call into a website guest —
 * listing included — passes `authorize`; host-side callers (the panel's own
 * automation console) never do. The plugin's identity comes from the cordis
 * DI scope (`ctx.pluginOwner`), never from call parameters.
 *
 * Layers, per RESEARCH/QBC_BROWSER_SECURITY_MODEL.md: a master switch
 * (default off), per-plugin × per-origin grants split into read/act verb
 * classes, a per-plugin act rate limit, and an append-only audit log the
 * plugin cannot write. Grants and the log live in memory for the PoC;
 * persistence and relay-synced policy are open direction questions. */

export type AutomationVerb = "read" | "act";
export type GrantLevel = "read" | "act";

export type AuditStatus =
  | "allowed"
  | "denied"
  | "rate-limited"
  | "grant-requested"
  | "grant-granted"
  | "grant-denied"
  | "grant-timed-out"
  | "revoked";

export type AuditEntry = Readonly<{
  at: number;
  pluginId: string;
  sessionId: string;
  origin: string;
  verb: AutomationVerb | "grant" | "revoke";
  status: AuditStatus;
  detail?: string | undefined;
}>;

export type GrantRequest = Readonly<{
  id: number;
  pluginId: string;
  sessionId: string;
  origin: string;
  verb: AutomationVerb;
}>;

const AUDIT_CAP = 200;
const GRANT_TIMEOUT_MS = 120_000;
const ACT_LIMIT = 30;
const ACT_WINDOW_MS = 60_000;

const preferenceKey = "buzz-browser-automation.v1";
const changedEvent = "buzz-browser-automation-changed";
let unsavedPreference: boolean | undefined;

/** Device-local master switch for agent browser access. Deliberately not a
 * device setting: agents must never flip the gate that constrains them. */
export function browserAutomationAllowed(): boolean {
  if (unsavedPreference !== undefined) return unsavedPreference;
  try {
    return localStorage.getItem(preferenceKey) === "on";
  } catch {
    return false;
  }
}
export function setBrowserAutomationAllowed(enabled: boolean): void {
  unsavedPreference = enabled;
  try {
    localStorage.setItem(preferenceKey, enabled ? "on" : "off");
    unsavedPreference = undefined;
  } catch {
    // Keep the active choice readable until a save succeeds.
  }
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event(changedEvent));
}
export function useBrowserAutomationAllowed(): boolean {
  return useSyncExternalStore(
    (listener) => {
      window.addEventListener(changedEvent, listener);
      return () => window.removeEventListener(changedEvent, listener);
    },
    browserAutomationAllowed,
  );
}

/** An act grant covers reading; a read grant does not cover acting. */
function covers(
  level: GrantLevel | undefined,
  verb: AutomationVerb,
): boolean {
  return level !== undefined && (level === "act" || verb === "read");
}

/** djb2, so the audit references a script without keeping its body. */
function scriptHash(script: string): string {
  let hash = 5381;
  for (let i = 0; i < script.length; i++)
    hash = ((hash << 5) + hash + script.charCodeAt(i)) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

export class AutomationPolicy {
  private readonly grants = new Map<string, Map<string, GrantLevel>>();
  private readonly queues = new Map<string, GrantRequest[]>();
  private readonly open = new Map<
    number,
    { request: GrantRequest; answer: (level: GrantLevel | null) => void }
  >();
  private readonly acts = new Map<string, number[]>();
  private entries: AuditEntry[] = [];
  private readonly listeners = new Set<() => void>();
  private nextRequestId = 1;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish() {
    for (const listener of this.listeners) listener();
  }

  private audit(entry: AuditEntry) {
    this.entries = [...this.entries, entry].slice(-AUDIT_CAP);
  }

  auditEntries(): readonly AuditEntry[] {
    return this.entries;
  }

  grantFor(pluginId: string, origin: string): GrantLevel | undefined {
    return this.grants.get(pluginId)?.get(origin);
  }

  /** Every plugin holding a grant on this origin — the panel badge's data. */
  grantsForOrigin(
    origin: string,
  ): readonly { pluginId: string; level: GrantLevel }[] {
    const found: { pluginId: string; level: GrantLevel }[] = [];
    for (const [pluginId, origins] of this.grants) {
      const level = origins.get(origin);
      if (level) found.push({ pluginId, level });
    }
    return found;
  }

  /** The request the panel should ask about first, if any. */
  pendingFor(sessionId: string): GrantRequest | undefined {
    return this.queues.get(sessionId)?.[0];
  }

  /** The gate: resolves once the call may proceed, rejects with the reason
   * a denied plugin should see. Master switch, grant, and rate limit each
   * leave their audit trail here. */
  async authorize(
    pluginId: string,
    sessionId: string,
    origin: string,
    verb: AutomationVerb,
    script?: string,
  ): Promise<void> {
    const detail = script === undefined ? undefined : scriptHash(script);
    if (!browserAutomationAllowed()) {
      this.audit({
        at: Date.now(),
        pluginId,
        sessionId,
        origin,
        verb,
        status: "denied",
        detail,
      });
      this.publish();
      throw new Error(
        "Agent browser access is off. The user can enable it in Settings → Security.",
      );
    }
    if (!covers(this.grantFor(pluginId, origin), verb)) {
      const level = await this.requestGrant({
        pluginId,
        sessionId,
        origin,
        verb,
      });
      if (!covers(level ?? undefined, verb)) {
        throw new Error(
          level
            ? `${pluginId} got read access to ${origin}, which does not cover acting.`
            : `The user did not grant ${pluginId} access to ${origin}.`,
        );
      }
    }
    if (verb === "act") {
      const now = Date.now();
      const recent = (this.acts.get(pluginId) ?? []).filter(
        (at) => now - at < ACT_WINDOW_MS,
      );
      if (recent.length >= ACT_LIMIT) {
        this.audit({
          at: now,
          pluginId,
          sessionId,
          origin,
          verb,
          status: "rate-limited",
          detail,
        });
        this.publish();
        throw new Error(
          `${pluginId} hit the agent browser action limit (${ACT_LIMIT}/min). Wait a moment, then retry.`,
        );
      }
      recent.push(now);
      this.acts.set(pluginId, recent);
    }
    this.audit({
      at: Date.now(),
      pluginId,
      sessionId,
      origin,
      verb,
      status: "allowed",
      detail,
    });
    this.publish();
  }

  private requestGrant(request: {
    pluginId: string;
    sessionId: string;
    origin: string;
    verb: AutomationVerb;
  }): Promise<GrantLevel | null> {
    const entry: GrantRequest = { id: this.nextRequestId++, ...request };
    const queue = this.queues.get(request.sessionId) ?? [];
    this.queues.set(request.sessionId, [...queue, entry]);
    this.audit({
      at: Date.now(),
      pluginId: request.pluginId,
      sessionId: request.sessionId,
      origin: request.origin,
      verb: "grant",
      status: "grant-requested",
      detail: request.verb,
    });
    this.publish();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.settle(entry.id, "grant-timed-out");
        resolve(null);
      }, GRANT_TIMEOUT_MS);
      this.open.set(entry.id, {
        request: entry,
        answer: (level) => {
          clearTimeout(timer);
          this.settle(
            entry.id,
            level ? "grant-granted" : "grant-denied",
            level ?? undefined,
          );
          resolve(level);
        },
      });
    });
  }

  private settle(id: number, status: AuditStatus, level?: GrantLevel) {
    const pending = this.open.get(id);
    if (!pending) return;
    this.open.delete(id);
    const { request } = pending;
    const queue = (this.queues.get(request.sessionId) ?? []).filter(
      (entry) => entry.id !== id,
    );
    if (queue.length) this.queues.set(request.sessionId, queue);
    else this.queues.delete(request.sessionId);
    if (level) {
      const origins =
        this.grants.get(request.pluginId) ?? new Map<string, GrantLevel>();
      origins.set(request.origin, level);
      this.grants.set(request.pluginId, origins);
    }
    this.audit({
      at: Date.now(),
      pluginId: request.pluginId,
      sessionId: request.sessionId,
      origin: request.origin,
      verb: "grant",
      status,
      detail: level,
    });
    this.publish();
  }

  /** The panel's dialog answers here: a level grants, null denies. */
  resolveGrant(requestId: number, level: GrantLevel | null): void {
    this.open.get(requestId)?.answer(level);
  }

  revoke(pluginId: string, origin: string, sessionId: string): void {
    const origins = this.grants.get(pluginId);
    if (!origins?.delete(origin)) return;
    if (!origins.size) this.grants.delete(pluginId);
    this.audit({
      at: Date.now(),
      pluginId,
      sessionId,
      origin,
      verb: "revoke",
      status: "revoked",
    });
    this.publish();
  }
}
