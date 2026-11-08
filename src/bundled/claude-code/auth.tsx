// How Buzz's Claude authenticates in this build: with the Claude account
// sign-in that `claude auth login` keeps in `~/.claude`, shared with the
// `claude` in the terminal, as Buzz did before #2553 moved OSS builds to an
// Anthropic API key. Nothing is pasted or stored by Buzz: `claude` itself
// holds the credentials.
//
// This file is the plugin's one authentication seam (see the upstream
// `auth.tsx`): the rest of the plugin reaches authentication only through its
// exports, so their names and shapes are kept.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import inlineStyles from "../../shared/InlineReference.module.css";
import { ENV, type Spawn } from "./claude";
import type { ClaudeSetup } from "./setup";

const NOT_SIGNED_IN =
  "Claude is not signed in. Sign in under Settings → Agent setup → Harness defaults → Claude → Edit configuration.";
const REJECTED_SIGN_IN =
  "Claude rejected the sign-in. It may have expired or been revoked, or the account has no Claude subscription. Sign in again under Settings → Agent setup → Harness defaults → Claude → Edit configuration.";
const BROWSER_HINT =
  "Continue in your browser. If it shows a code to paste, enter it here.";
const SIGN_IN_ONCE =
  "Claude runs with your Claude account. Sign in once; Buzz then uses the same sign-in as the claude in your terminal.";

/** Runs one process as a setup step, its output shown; throws unless it
 * succeeds. */
export type Step = (
  id: string,
  args: readonly string[],
  label: string,
) => Promise<void>;
type Env = Readonly<Record<string, string | null>>;

/** Runs a `claude.sh` step to its end: its exit code and what it printed. */
async function collect(spawn: Spawn, id: string, args: readonly string[]) {
  let stdout = "";
  let stderr = "";
  const process = await spawn(id, {
    args,
    env: ENV,
    onStdout: (text) => {
      stdout += text;
    },
    onStderr: (text) => {
      stderr += text;
    },
  });
  await process.end();
  const code = await process.exited;
  return { code, stdout, stderr };
}

/** Whether Claude leads the Harness list and is new agents' default
 * (`src/bundled/index.ts`). Kept as upstream orders it. */
export const leadsHarnesses = false;

/** Claude's credentials on this computer: the account `claude auth login`
 * signed in. */
export class ClaudeAuth {
  /** Which way this build authenticates. */
  readonly id = "buzz-claude-auth:login";
  /** What the agent type's row asks for while Claude cannot run. */
  readonly attentionLabel = "Log in to Claude Code";
  /** Ends "Claude 2.1.0 …" while Claude cannot run. */
  readonly needs = "is not signed in";
  private readonly listeners = new Set<() => void>();

  constructor(private readonly spawn: Spawn | undefined) {}

  /** The interactive sign-in, run as a setup step: `claude auth login`
   * opens the browser and may ask for a code, which `ClaudeSetup.answer`
   * passes on. Running sessions start again once it succeeds. */
  readonly signIn: ((step: Step) => Promise<void>) | undefined = async (
    step,
  ) => {
    await step("claude", ["auth", "login"], "Sign-in");
    for (const listener of this.listeners) listener();
  };

  /** Told when the credentials change, so running sessions start again. */
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Whether Claude can run turns: the signed-in account to show, or
   * undefined. Asked of `claude` itself each time. */
  async check(): Promise<Readonly<{ account?: string }> | undefined> {
    const spawn = this.spawn;
    if (!spawn) return undefined;
    const { code, stdout } = await collect(spawn, "claude", [
      "auth",
      "status",
      "--json",
    ]);
    if (code !== 0) return undefined;
    const status = JSON.parse(stdout) as {
      loggedIn?: boolean;
      email?: string;
      orgName?: string;
    };
    if (!status.loggedIn) return undefined;
    const account = [status.email, status.orgName].filter(Boolean).join(" · ");
    return account ? { account } : {};
  }

  /** Nothing to save: `claude auth login` keeps the sign-in itself. */
  async save(_key: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    throw new Error(
      "This build signs in with your Claude account; there is no key to save.",
    );
  }

  /** `spawn` as it is: every `claude` reads the sign-in from `~/.claude`.
   * A turn without one fails with Claude's own error, which `explainTurn`
   * says how to fix. */
  authorize(spawn: Spawn, _required = false): Spawn {
    return spawn;
  }

  /** Security reviews run Claude apart from `~/.claude`, so they need
   * credentials of their own, which this build has none of. */
  async review(): Promise<Readonly<{ home: string; env: Env }>> {
    throw new Error(
      "Claude security reviews need an API key build; this build signs in with a Claude account.",
    );
  }

  /** A failed review's error, as the person can act on it. */
  explain(error: string) {
    return rejected(error) ? REJECTED_SIGN_IN : error;
  }

  /** A failed turn's error as its report in the conversation says it, in
   * Markdown: a missing or rejected sign-in links to `settings`. */
  explainTurn(error: string, settings: string) {
    if (signedOut(error) || rejected(error))
      return `Claude is not signed in. Head to [Settings](${settings}) and choose Sign in.`;
    return error;
  }
}

/** Whether Claude's error says it has no sign-in at all. */
const signedOut = (error: string) =>
  /not logged in|not signed in|please run \/login|run claude auth login/i.test(
    error,
  ) || error.includes(NOT_SIGNED_IN);

/** Whether Claude's error says Anthropic refused the sign-in. */
const rejected = (error: string) =>
  /authentication_error|OAuth token .*(expired|revoked)|invalid authentication/i.test(
    error,
  );

/** Setup's ask while Claude cannot run: the interactive sign-in, with the
 * browser's code once it runs. In the compact variant, as a row or a model
 * field, it offers the Sign in button itself; the full variant sits in a
 * dialog that has its own. `onSaved` follows a finished sign-in, so a surface
 * can close. */
export function SignIn({
  setup,
  disabled = false,
  variant = "full",
  onSaved,
}: {
  setup: ClaudeSetup;
  disabled?: boolean;
  variant?: "full" | "compact";
  onSaved?: (() => void) | undefined;
}) {
  const state = useSyncExternalStore(setup.subscribe, setup.snapshot);
  const running = state.running === "sign-in";
  const [code, setCode] = useState("");
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running && state.status?.state === "ready")
      onSaved?.();
    wasRunning.current = running;
  }, [running, state.status, onSaved]);
  const answer = () => {
    if (!code.trim() || disabled) return;
    void setup.answer(code.trim());
    setCode("");
  };
  if (!running)
    return (
      <div className="grid gap-3">
        <p className="m-0 text-body-sm text-secondary">{SIGN_IN_ONCE}</p>
        {variant === "compact" && (
          <div>
            <Button
              type="button"
              size="sm"
              variant="prominent"
              disabled={disabled || !!state.running}
              onClick={() => void setup.run("sign-in")}
            >
              Sign in
            </Button>
          </div>
        )}
      </div>
    );
  return (
    // Not a form: it sits inside agent creation's and Settings' own.
    <div className="grid gap-2">
      <Field label="Sign-in code" description={BROWSER_HINT}>
        <Input
          autoComplete="off"
          value={code}
          aria-disabled={disabled ? true : undefined}
          onValueChange={setCode}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            answer();
          }}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size={variant === "compact" ? "sm" : "md"}
          disabled={disabled || !code.trim()}
          focusableWhenDisabled
          onClick={answer}
        >
          Continue
        </Button>
      </div>
    </div>
  );
}

/** Claude's settings once it can run: the account, and signing in again. */
export function SignedIn({
  setup,
}: {
  setup: ClaudeSetup;
  onSaved?: (() => void) | undefined;
}) {
  const state = useSyncExternalStore(setup.subscribe, setup.snapshot);
  const account =
    state.status?.state === "ready" ? state.status.account : undefined;
  return (
    <div className="grid gap-2">
      <p className="m-0 text-body-sm text-subtle">
        {account
          ? `Claude runs as ${account}, signed in with claude auth login.`
          : "Claude runs with your Claude account sign-in."}
      </p>
      <div>
        <Button
          type="button"
          size="sm"
          disabled={!!state.running}
          onClick={() => void setup.run("sign-in")}
        >
          Switch account
        </Button>
      </div>
    </div>
  );
}

/** Where an agent's own surface, such as its library card, says Claude
 * cannot run: signing in is one step in Settings, not one per agent. */
export function Missing({
  openSettings,
}: {
  openSettings?: (() => void) | undefined;
}) {
  return (
    <p className="m-0 text-body-sm text-secondary">
      Claude is not signed in.{" "}
      {openSettings ? (
        <>
          Head to{" "}
          <button
            type="button"
            className={inlineStyles.link}
            onClick={openSettings}
          >
            Settings
          </button>{" "}
          to sign in.
        </>
      ) : (
        "Sign in under Settings → Agent setup."
      )}
    </p>
  );
}
