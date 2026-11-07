import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AutomationPolicy,
  browserAutomationAllowed,
  setBrowserAutomationAllowed,
} from "./automation-policy";

const ORIGIN = "https://de.wikipedia.org";

describe("AutomationPolicy", () => {
  let policy: AutomationPolicy;

  beforeEach(() => {
    setBrowserAutomationAllowed(true);
    policy = new AutomationPolicy();
  });

  async function grant(pluginId: string, level: "read" | "act") {
    const attempt = policy.authorize(pluginId, "s1", ORIGIN, "read");
    const request = policy.pendingFor("s1");
    expect(request?.pluginId).toBe(pluginId);
    policy.resolveGrant(request!.id, level);
    await attempt;
  }

  it("denies every verb while the master switch is off", async () => {
    setBrowserAutomationAllowed(false);
    await expect(
      policy.authorize("qbc.browser", "s1", ORIGIN, "read"),
    ).rejects.toThrow("Agent browser access is off");
    const entry = policy.auditEntries().at(-1);
    expect(entry?.status).toBe("denied");
    expect(entry?.pluginId).toBe("qbc.browser");
  });

  it("holds the first call for a grant request and honors the answer", async () => {
    const attempt = policy.authorize("qbc.browser", "s1", ORIGIN, "read");
    const request = policy.pendingFor("s1");
    expect(request?.origin).toBe(ORIGIN);
    policy.resolveGrant(request!.id, "read");
    await expect(attempt).resolves.toBeUndefined();
    expect(policy.grantFor("qbc.browser", ORIGIN)).toBe("read");
    expect(policy.pendingFor("s1")).toBeUndefined();
    expect(
      policy.auditEntries().map((entry) => entry.status),
    ).toEqual(["grant-requested", "grant-granted", "allowed"]);
  });

  it("rejects the call when the user declines", async () => {
    const attempt = policy.authorize("qbc.browser", "s1", ORIGIN, "read");
    policy.resolveGrant(policy.pendingFor("s1")!.id, null);
    await expect(attempt).rejects.toThrow("did not grant qbc.browser");
    expect(policy.grantFor("qbc.browser", ORIGIN)).toBeUndefined();
    expect(policy.auditEntries().at(-1)?.status).toBe("grant-denied");
  });

  it("covers read under an act grant but upgrades a read grant for acting", async () => {
    await grant("qbc.browser", "read");
    await expect(
      policy.authorize("qbc.browser", "s1", ORIGIN, "read"),
    ).resolves.toBeUndefined();
    const acting = policy.authorize("qbc.browser", "s1", ORIGIN, "act");
    const upgrade = policy.pendingFor("s1");
    expect(upgrade?.verb).toBe("act");
    policy.resolveGrant(upgrade!.id, "act");
    await acting;
    expect(policy.grantFor("qbc.browser", ORIGIN)).toBe("act");
  });

  it("rejects acting when the upgrade answer stays read", async () => {
    await grant("qbc.browser", "read");
    const acting = policy.authorize("qbc.browser", "s1", ORIGIN, "act");
    policy.resolveGrant(policy.pendingFor("s1")!.id, "read");
    await expect(acting).rejects.toThrow("does not cover acting");
  });

  it("scopes grants per plugin and per origin", async () => {
    await grant("qbc.browser", "act");
    expect(policy.grantFor("qbc.browser", ORIGIN)).toBe("act");
    expect(policy.grantFor("other.plugin", ORIGIN)).toBeUndefined();
    expect(policy.grantFor("qbc.browser", "https://example.com")).toBeUndefined();
    expect(policy.grantsForOrigin(ORIGIN)).toEqual([
      { pluginId: "qbc.browser", level: "act" },
    ]);
  });

  it("rate-limits acting after 30 calls inside a minute", async () => {
    await grant("qbc.browser", "act");
    for (let i = 0; i < 30; i++)
      await policy.authorize("qbc.browser", "s1", ORIGIN, "act");
    await expect(
      policy.authorize("qbc.browser", "s1", ORIGIN, "act"),
    ).rejects.toThrow("action limit");
    expect(policy.auditEntries().at(-1)?.status).toBe("rate-limited");
    // Reading is not rate-limited.
    await expect(
      policy.authorize("qbc.browser", "s1", ORIGIN, "read"),
    ).resolves.toBeUndefined();
  });

  it("times out an unanswered grant request", async () => {
    vi.useFakeTimers();
    try {
      const attempt = policy.authorize("qbc.browser", "s1", ORIGIN, "read");
      const assertion = expect(attempt).rejects.toThrow("did not grant");
      await vi.advanceTimersByTimeAsync(120_000);
      await assertion;
      expect(policy.pendingFor("s1")).toBeUndefined();
      expect(policy.auditEntries().at(-1)?.status).toBe("grant-timed-out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("revokes a grant so the next call asks again", async () => {
    await grant("qbc.browser", "act");
    policy.revoke("qbc.browser", ORIGIN, "s1");
    expect(policy.grantFor("qbc.browser", ORIGIN)).toBeUndefined();
    expect(policy.auditEntries().at(-1)?.status).toBe("revoked");
    const attempt = policy.authorize("qbc.browser", "s1", ORIGIN, "read");
    expect(policy.pendingFor("s1")).toBeDefined();
    policy.resolveGrant(policy.pendingFor("s1")!.id, "act");
    await attempt;
  });

  it("keeps the audit append-only and capped at 200 entries", async () => {
    await grant("qbc.browser", "act");
    for (let i = 0; i < 250; i++)
      await policy.authorize("qbc.browser", "s1", ORIGIN, "read");
    expect(policy.auditEntries().length).toBe(200);
    expect(policy.auditEntries().at(0)?.status).toBe("allowed");
  });

  it("hashes scripts into the audit instead of keeping them", async () => {
    await grant("qbc.browser", "act");
    await policy.authorize("qbc.browser", "s1", ORIGIN, "act", "document.title");
    const entry = policy.auditEntries().at(-1);
    expect(entry?.detail).toMatch(/^[0-9a-f]{8}$/);
    expect(entry?.detail).not.toContain("document.title");
  });

  it("notifies subscribers on every state change", async () => {
    let notifications = 0;
    const unsubscribe = policy.subscribe(() => notifications++);
    const attempt = policy.authorize("qbc.browser", "s1", ORIGIN, "read");
    expect(notifications).toBeGreaterThan(0);
    policy.resolveGrant(policy.pendingFor("s1")!.id, "read");
    await attempt;
    const seen = notifications;
    unsubscribe();
    await policy.authorize("qbc.browser", "s1", ORIGIN, "read");
    expect(notifications).toBe(seen);
  });
});

describe("browserAutomationAllowed", () => {
  it("defaults to off", () => {
    setBrowserAutomationAllowed(false);
    expect(browserAutomationAllowed()).toBe(false);
    setBrowserAutomationAllowed(true);
    expect(browserAutomationAllowed()).toBe(true);
    setBrowserAutomationAllowed(false);
  });
});
