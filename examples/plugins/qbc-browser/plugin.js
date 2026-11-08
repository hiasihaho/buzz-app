// QBC browser automation (PoC) — agent tools over the host browser contract
// (ctx.browser.guests / ctx.browser.evaluate, buzz-app branch browser/qbc-poc).
// Everything runs in the guest's page scope; guests stay bridge-free.
export const inject = ["agents", "browser"];

const DEFAULT_MAX = 200;

const SESSION_ID = {
  type: "string",
  description:
    "Guest id from qbc_guests. Omit to use the most recently shown guest.",
};

async function target(ctx, sessionId) {
  if (!ctx.browser.available)
    throw new Error(
      "The embedded browser is not available in this Buzz build.",
    );
  if (sessionId) return sessionId;
  const guests = await ctx.browser.guests();
  if (!guests.length)
    throw new Error(
      "No website guest is open. Open a website panel first, then retry.",
    );
  return guests[0].id;
}

function snapshotScript(max) {
  return `(function () {
  var sel = 'a[href],button,input,textarea,select,summary,[role="button"],[role="link"],[role="checkbox"],[role="tab"],[role="menuitem"],[role="textbox"],[contenteditable=""],[contenteditable="true"],[tabindex]';
  var found = document.querySelectorAll(sel);
  var old = document.querySelectorAll("[data-qbc-ref]");
  for (var k = 0; k < old.length; k++) old[k].removeAttribute("data-qbc-ref");
  var refs = [];
  var elements = [];
  for (var i = 0; i < found.length && elements.length < ${max}; i++) {
    var el = found[i];
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    var style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") continue;
    refs.push(el);
    el.setAttribute("data-qbc-ref", "e" + refs.length);
    var text = (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").replace(/\\s+/g, " ").trim().slice(0, 80);
    elements.push({
      ref: "e" + refs.length,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role"),
      text: text,
      href: el.tagName === "A" ? el.getAttribute("href") : null,
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      inView: r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth
    });
  }
  window.__qbcRefs = { url: location.href, refs: refs };
  return { url: location.href, title: document.title, ready: document.readyState, count: elements.length, elements: elements };
})()`;
}

function clickScript(index, ref) {
  return `(function () {
  var store = window.__qbcRefs;
  if (!store || store.url !== location.href)
    throw new Error("Refs are stale (navigation or no snapshot yet) — run qbc_snapshot again.");
  var el = store.refs[${index}];
  if (!el) throw new Error("Unknown ref ${ref} — run qbc_snapshot for current refs.");
  if (!el.isConnected)
    throw new Error("Element ${ref} left the page — run qbc_snapshot again.");
  el.scrollIntoView({ block: "center", inline: "center" });
  el.click();
  var text = (el.innerText || el.value || "").replace(/\\s+/g, " ").trim().slice(0, 80);
  return { clicked: "${ref}", tag: el.tagName.toLowerCase(), text: text, url: location.href };
})()`;
}

function typeScript(index, ref, text) {
  return `(function () {
  var store = window.__qbcRefs;
  if (!store || store.url !== location.href)
    throw new Error("Refs are stale (navigation or no snapshot yet) — run qbc_snapshot again.");
  var el = store.refs[${index}];
  if (!el) throw new Error("Unknown ref ${ref} — run qbc_snapshot for current refs.");
  if (!el.isConnected)
    throw new Error("Element ${ref} left the page — run qbc_snapshot again.");
  var tag = el.tagName;
  var isField = tag === "INPUT" || tag === "TEXTAREA";
  if (!isField && !el.isContentEditable)
    throw new Error("Element ${ref} is a " + tag.toLowerCase() + ", not a text field — qbc_type works on input, textarea and contenteditable elements.");
  el.scrollIntoView({ block: "center", inline: "center" });
  el.focus();
  if (isField) {
    var proto = tag === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(text)});
  } else {
    el.innerText = ${JSON.stringify(text)};
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  var value = isField ? el.value : el.innerText;
  return { typed: "${ref}", tag: tag.toLowerCase(), value: String(value).slice(0, 200), url: location.href };
})()`;
}

function navigateScript(url) {
  return `(function () {
  var from = location.href;
  location.href = ${JSON.stringify(url)};
  return { navigating: ${JSON.stringify(url)}, from: from };
})()`;
}

function waitProbeScript(selector) {
  return `(function () {
  var el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { found: false };
  var r = el.getBoundingClientRect();
  return { found: true, visible: !!(r.width && r.height), url: location.href, ready: document.readyState };
})()`;
}

function scrollScript(direction, index, ref) {
  if (index !== null)
    return `(function () {
  var store = window.__qbcRefs;
  if (!store || store.url !== location.href)
    throw new Error("Refs are stale (navigation or no snapshot yet) — run qbc_snapshot again.");
  var el = store.refs[${index}];
  if (!el) throw new Error("Unknown ref ${ref} — run qbc_snapshot for current refs.");
  if (!el.isConnected)
    throw new Error("Element ${ref} left the page — run qbc_snapshot again.");
  el.scrollIntoView({ block: "center", inline: "center" });
  return { scrolledTo: "${ref}", x: Math.round(scrollX), y: Math.round(scrollY) };
})()`;
  const delta =
    direction === "up" ? "-innerHeight * 0.85" : "innerHeight * 0.85";
  return `(function () {
  var before = Math.round(scrollY);
  ${
    direction === "top"
      ? "scrollTo({ top: 0 });"
      : direction === "bottom"
        ? "scrollTo({ top: document.documentElement.scrollHeight });"
        : `scrollBy({ top: ${delta} });`
  }
  return { direction: ${JSON.stringify(direction)}, before: before, after: Math.round(scrollY) };
})()`;
}

function consoleInstallScript() {
  return `(function () {
  if (window.__qbcConsole) return { installed: false, buffered: window.__qbcConsole.length };
  var buf = [];
  window.__qbcConsole = buf;
  function push(level, args) {
    try {
      buf.push({
        level: level,
        text: Array.from(args).map(function (a) {
          if (typeof a === "string") return a;
          try { return JSON.stringify(a); } catch (e) { return String(a); }
        }).join(" ").slice(0, 500),
        at: Date.now()
      });
      if (buf.length > 200) buf.splice(0, buf.length - 200);
    } catch (e) {}
  }
  ["log", "info", "warn", "error"].forEach(function (level) {
    var original = console[level] && console[level].bind(console);
    console[level] = function () {
      push(level, arguments);
      if (original) return original.apply(null, arguments);
    };
  });
  window.addEventListener("error", function (e) {
    push("exception", [e.message + " @" + (e.filename || "") + ":" + (e.lineno || "")]);
  });
  window.addEventListener("unhandledrejection", function (e) {
    push("unhandledrejection", [String(e.reason)]);
  });
  return { installed: true };
})()`;
}

function consoleCollectScript(clear) {
  return `(function () {
  var buf = window.__qbcConsole || [];
  var out = buf.slice();
  if (${clear}) buf.length = 0;
  return { count: out.length, entries: out, since: "Captures start when qbc_console first runs on a page, not at page load." };
})()`;
}

export function apply(ctx) {
  ctx.agents.addTool({
    name: "qbc_guests",
    description:
      "List the website guests open in Buzz's embedded browser (id, url, title, loading), most recently shown first. Pass an id as sessionId to the other qbc_ tools.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async call() {
      if (!ctx.browser.available)
        throw new Error(
          "The embedded browser is not available in this Buzz build.",
        );
      return JSON.stringify(await ctx.browser.guests());
    },
  });

  ctx.agents.addTool({
    name: "qbc_snapshot",
    description:
      'Snapshot a website guest\'s interactive elements (links, buttons, inputs, roles, tabindex): stores refs e1…eN in the page, marks each element with a matching data-qbc-ref attribute (qbc_eval scripts can find them via [data-qbc-ref="e3"]) and returns them with tag, role, text, center coordinates and viewport visibility. Refs stay valid until the page navigates; qbc_click and qbc_type act on them.',
    inputSchema: {
      type: "object",
      properties: {
        sessionId: SESSION_ID,
        max: {
          type: "number",
          description: `Most elements to return (default ${DEFAULT_MAX}, at most 1000).`,
        },
      },
      additionalProperties: false,
    },
    async call(_client, _context, args) {
      const max = Math.min(
        Math.max(Math.trunc(args.max ?? DEFAULT_MAX), 1),
        1000,
      );
      const result = await ctx.browser.evaluate(
        await target(ctx, args.sessionId),
        snapshotScript(max),
        { kind: "read" },
      );
      return JSON.stringify(result);
    },
  });

  ctx.agents.addTool({
    name: "qbc_click",
    description:
      "Click an element from the latest qbc_snapshot by its ref (for example e3), scrolling it into view first. Fails with a stale-refs error after navigation — run qbc_snapshot again then.",
    inputSchema: {
      type: "object",
      properties: {
        ref: {
          type: "string",
          description: "Element ref from qbc_snapshot, like e3.",
        },
        sessionId: SESSION_ID,
      },
      required: ["ref"],
      additionalProperties: false,
    },
    async call(_client, _context, args) {
      const match = /^e([1-9]\d*)$/.exec(String(args.ref));
      if (!match) throw new Error("ref must look like e3 — see qbc_snapshot.");
      const result = await ctx.browser.evaluate(
        await target(ctx, args.sessionId),
        clickScript(Number(match[1]) - 1, `e${match[1]}`),
        { kind: "act" },
      );
      return JSON.stringify(result);
    },
  });

  ctx.agents.addTool({
    name: "qbc_type",
    description:
      "Type text into a text field from the latest qbc_snapshot by its ref (for example e12), replacing any existing value. Works on input, textarea and contenteditable elements: focuses the field, sets the value through the page's own setter and dispatches input/change events so page scripts react. Fails with a stale-refs error after navigation — run qbc_snapshot again then.",
    inputSchema: {
      type: "object",
      properties: {
        ref: {
          type: "string",
          description: "Text-field ref from qbc_snapshot, like e12.",
        },
        text: {
          type: "string",
          description: "Text to type into the field.",
        },
        sessionId: SESSION_ID,
      },
      required: ["ref", "text"],
      additionalProperties: false,
    },
    async call(_client, _context, args) {
      const match = /^e([1-9]\d*)$/.exec(String(args.ref));
      if (!match) throw new Error("ref must look like e12 — see qbc_snapshot.");
      if (typeof args.text !== "string")
        throw new Error("text must be a string.");
      const result = await ctx.browser.evaluate(
        await target(ctx, args.sessionId),
        typeScript(Number(match[1]) - 1, `e${match[1]}`, args.text),
        { kind: "act" },
      );
      return JSON.stringify(result);
    },
  });

  ctx.agents.addTool({
    name: "qbc_eval",
    description:
      "Evaluate a JavaScript expression in a website guest's page scope and return its JSON-serialized value (wrap statements in an IIFE). Page exceptions come back as errors. Prefer qbc_snapshot/qbc_click for page interaction; this is the escape hatch.",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", description: "JavaScript to evaluate." },
        sessionId: SESSION_ID,
      },
      required: ["script"],
      additionalProperties: false,
    },
    async call(_client, _context, args) {
      const result = await ctx.browser.evaluate(
        await target(ctx, args.sessionId),
        String(args.script),
        { kind: "act" },
      );
      return JSON.stringify(result);
    },
  });

  ctx.agents.addTool({
    name: "qbc_navigate",
    description:
      "Navigate a website guest to an http(s) URL. Returns right away; poll with qbc_wait or qbc_snapshot until the new page is ready. Refs from earlier snapshots go stale on navigation.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Destination URL (http/https)." },
        sessionId: SESSION_ID,
      },
      required: ["url"],
      additionalProperties: false,
    },
    async call(_client, _context, args) {
      let parsed;
      try {
        parsed = new URL(String(args.url));
      } catch {
        throw new Error("url must be a valid URL.");
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        throw new Error("Only http and https URLs are supported.");
      const result = await ctx.browser.evaluate(
        await target(ctx, args.sessionId),
        navigateScript(parsed.toString()),
        { kind: "act" },
      );
      return JSON.stringify(result);
    },
  });

  ctx.agents.addTool({
    name: "qbc_wait",
    description:
      "Wait until a CSS selector matches in a website guest (default at most 5s, at most 25s). Polls with short probes; use after qbc_navigate or qbc_click to await page changes.",
    inputSchema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector to wait for, like h1 or .results li.",
        },
        timeoutMs: {
          type: "number",
          description: "Most time to wait in ms (default 5000, at most 25000).",
        },
        sessionId: SESSION_ID,
      },
      required: ["selector"],
      additionalProperties: false,
    },
    async call(_client, _context, args) {
      const selector = String(args.selector ?? "");
      if (!selector) throw new Error("selector is required.");
      const timeoutMs = Math.min(
        Math.max(Math.trunc(args.timeoutMs ?? 5000), 100),
        25000,
      );
      const sessionId = await target(ctx, args.sessionId);
      const deadline = Date.now() + timeoutMs;
      let probe = { found: false };
      while (Date.now() < deadline) {
        probe = await ctx.browser.evaluate(
          sessionId,
          waitProbeScript(selector),
          {
            kind: "read",
          },
        );
        if (probe.found) break;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      return JSON.stringify({ ...probe, selector, waited: !probe.found });
    },
  });

  ctx.agents.addTool({
    name: "qbc_scroll",
    description:
      "Scroll a website guest: a page up/down, to top/bottom, or an element from the latest qbc_snapshot by its ref into view.",
    inputSchema: {
      type: "object",
      properties: {
        direction: {
          type: "string",
          enum: ["up", "down", "top", "bottom"],
          description: "Scroll a page up/down or jump to top/bottom.",
        },
        ref: {
          type: "string",
          description:
            "Element ref from qbc_snapshot, like e3 — scrolls it into view instead.",
        },
        sessionId: SESSION_ID,
      },
      additionalProperties: false,
    },
    async call(_client, _context, args) {
      let index = null;
      let ref = null;
      if (args.ref !== undefined) {
        const match = /^e([1-9]\d*)$/.exec(String(args.ref));
        if (!match)
          throw new Error("ref must look like e3 — see qbc_snapshot.");
        index = Number(match[1]) - 1;
        ref = `e${match[1]}`;
      }
      const direction = String(args.direction ?? "down");
      if (!ref && !["up", "down", "top", "bottom"].includes(direction))
        throw new Error("direction must be up, down, top or bottom.");
      const result = await ctx.browser.evaluate(
        await target(ctx, args.sessionId),
        scrollScript(direction, index, ref),
        { kind: "act" },
      );
      return JSON.stringify(result);
    },
  });

  ctx.agents.addTool({
    name: "qbc_console",
    description:
      "Read a website guest's console: log/info/warn/error calls, page exceptions and unhandled rejections. Capture starts when this tool first runs on a page (navigation resets it); pass clear to drain the buffer.",
    inputSchema: {
      type: "object",
      properties: {
        clear: {
          type: "boolean",
          description: "Clear the buffer after reading (default false).",
        },
        sessionId: SESSION_ID,
      },
      additionalProperties: false,
    },
    async call(_client, _context, args) {
      const sessionId = await target(ctx, args.sessionId);
      await ctx.browser.evaluate(sessionId, consoleInstallScript(), {
        kind: "act",
      });
      const result = await ctx.browser.evaluate(
        sessionId,
        consoleCollectScript(args.clear === true),
        { kind: "read" },
      );
      return JSON.stringify(result);
    },
  });
}
