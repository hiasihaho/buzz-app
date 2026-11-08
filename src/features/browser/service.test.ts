import { Context } from "@deepseek-ai/cordis";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserService } from "./service";
import { setBrowserAutomationAllowed } from "./automation-policy";
import type { BrowserPlatform } from "./platform";
import type { BrowserSessions } from "./sessions";

const contexts: Context[] = [];
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.fiber.dispose();
});
beforeEach(() => {
  setBrowserAutomationAllowed(true);
});

function platform(available: boolean): BrowserPlatform {
  return {
    available,
    attach: vi.fn(),
    setBounds: vi.fn(),
    setMediaSuspended: vi.fn(),
    navigate: vi.fn(),
    action: vi.fn(),
    status: vi.fn(),
    evaluate: vi.fn(),
    detach: vi.fn(),
    openExternal: vi.fn(),
  };
}

it("exposes availability and a host View", () => {
  const context = new Context();
  contexts.push(context);
  new BrowserService(context, platform(true));
  expect(context.browser.available).toBe(true);
  expect(typeof context.browser.View).toBe("function");
});

it("delegates guests and evaluate for host automation", async () => {
  const context = new Context();
  contexts.push(context);
  const browserPlatform = platform(true);
  vi.mocked(browserPlatform.evaluate).mockResolvedValue(2);
  new BrowserService(context, browserPlatform);
  await expect(context.browser.guests()).resolves.toEqual([]);
  await expect(context.browser.evaluate("session-1", "1 + 1")).resolves.toBe(2);
  expect(browserPlatform.evaluate).toHaveBeenCalledWith("session-1", "1 + 1");
});

/** A plugin's own view of the browser service, with its cordis identity. */
function pluginBrowser(context: Context, id = "qbc.browser") {
  const scope = context.extend({
    pluginOwner: { id, revision: "test", agentHooks: [], agentExecution: [] },
  });
  contexts.push(scope);
  return scope.browser;
}

async function withGuest(browserPlatform: BrowserPlatform, context: Context) {
  vi.mocked(browserPlatform.attach).mockResolvedValue("session-1");
  vi.mocked(browserPlatform.status).mockResolvedValue({
    url: "https://de.wikipedia.org/wiki/Nostr",
    title: "Nostr – Wikipedia",
    loading: false,
    error: null,
  });
  const sessions = (context.browser as unknown as { sessions: BrowserSessions })
    .sessions;
  await sessions.attach(
    "https://de.wikipedia.org/wiki/Nostr",
    { x: 0, y: 0, width: 800, height: 600 },
    () => true,
  );
}

it("gates plugin guests behind grants; the host is not gated", async () => {
  const context = new Context();
  contexts.push(context);
  const browserPlatform = platform(true);
  new BrowserService(context, browserPlatform);
  await withGuest(browserPlatform, context);

  const plugin = pluginBrowser(context);
  const gated = await plugin.guests();
  expect(gated).toEqual([
    {
      id: "session-1",
      url: "https://de.wikipedia.org",
      title: "",
      loading: false,
    },
  ]);
  // The host console keeps full details.
  const hostGuests = await context.browser.guests();
  expect(hostGuests[0]?.title).toBe("Nostr – Wikipedia");
});

it("runs a plugin evaluation only after the user grants its origin", async () => {
  const context = new Context();
  contexts.push(context);
  const browserPlatform = platform(true);
  vi.mocked(browserPlatform.status).mockResolvedValue({
    url: "https://de.wikipedia.org/wiki/Nostr",
    title: "Nostr – Wikipedia",
    loading: false,
    error: null,
  });
  vi.mocked(browserPlatform.evaluate).mockResolvedValue("Nostr – Wikipedia");
  const service = new BrowserService(context, browserPlatform);
  const plugin = pluginBrowser(context);

  const attempt = plugin.evaluate("session-1", "document.title", {
    kind: "read",
  });
  // Pending until the panel's dialog answers.
  expect(browserPlatform.evaluate).not.toHaveBeenCalled();
  const policy = (
    service as unknown as {
      policy: import("./automation-policy").AutomationPolicy;
    }
  ).policy;
  await vi.waitFor(() => {
    expect(policy.pendingFor("session-1")).toMatchObject({
      pluginId: "qbc.browser",
      origin: "https://de.wikipedia.org",
      verb: "read",
    });
  });
  const request = policy.pendingFor("session-1");
  expect(request).toBeDefined();
  if (!request) throw new Error("expected a pending grant request");
  policy.resolveGrant(request.id, "read");
  await expect(attempt).resolves.toBe("Nostr – Wikipedia");
  expect(browserPlatform.evaluate).toHaveBeenCalledWith(
    "session-1",
    "document.title",
  );
});

it("denies plugin evaluation while the master switch is off", async () => {
  setBrowserAutomationAllowed(false);
  const context = new Context();
  contexts.push(context);
  const browserPlatform = platform(true);
  vi.mocked(browserPlatform.status).mockResolvedValue({
    url: "https://de.wikipedia.org/wiki/Nostr",
    title: "",
    loading: false,
    error: null,
  });
  new BrowserService(context, browserPlatform);
  await expect(
    pluginBrowser(context).evaluate("session-1", "1"),
  ).rejects.toThrow("Agent browser access is off");
  expect(browserPlatform.evaluate).not.toHaveBeenCalled();
  // The host console still works.
  vi.mocked(browserPlatform.evaluate).mockResolvedValue(1);
  await expect(context.browser.evaluate("session-1", "1")).resolves.toBe(1);
});
