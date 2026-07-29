// Re-run the Google OAuth consent flow for a mailbox whose refresh_token died,
// driven from the cockpit's Connections screen (the "Reconnect" button) instead
// of the terminal. Self-describing: it reads the mailbox's (stale) stored token
// bundle to learn WHICH OAuth client it used (oauth_client_service/account), so
// the UI doesn't need the gcp-A/B/C mapping. Then it spawns
// scripts/auth/google-oauth.ts, which opens the browser, captures the redirect,
// and writes a fresh bundle to Keychain. The daemon self-heals on its next tick
// (getAccessToken evicts the dead bundle from its cache on the failed refresh),
// so no daemon restart is needed.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getJSON } from "../io/keychain.js";
import { TOKEN_KEYCHAIN_SERVICE, type StoredTokenBundle } from "../io/google-oauth.js";
import type { SourceError } from "../io/state.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONSENT_SCRIPT = join(REPO_ROOT, "scripts", "auth", "google-oauth.ts");

// Parse the failing Gmail mailboxes out of the gmail:direct sourceError message
// (shape: "mailbox=<email>: <err>; mailbox=<email>: <err>"). Returns the unique
// emails so the UI can offer a Reconnect button per dead mailbox. Exported for
// testing + reuse by the frontend's matching logic.
export function failingGmailMailboxes(
  sourceErrors: Record<string, SourceError> | undefined,
): string[] {
  const msg = sourceErrors?.["gmail:direct"]?.message ?? "";
  const out = new Set<string>();
  for (const m of msg.matchAll(/mailbox=([^\s:]+@[^\s:]+)/g)) out.add(m[1]!);
  return [...out];
}

export interface ReauthStart {
  started: boolean;
  mailbox: string;
  detail: string;
}

// Kick off a re-consent for one mailbox. Reads the stored bundle for its OAuth
// client refs, then spawns the consent flow (which opens the browser). Returns
// as soon as it's spawned — the user completes sign-in in the browser, and the
// daemon picks up the fresh token on its next tick. The browser flow can take a
// minute, so we do NOT hold the HTTP request open for it.
export async function startGmailReauth(mailbox: string): Promise<ReauthStart> {
  let bundle: StoredTokenBundle;
  try {
    bundle = await getJSON<StoredTokenBundle>(TOKEN_KEYCHAIN_SERVICE, mailbox);
  } catch {
    return {
      started: false,
      mailbox,
      detail: `no stored token for ${mailbox} — run the consent CLI once first`,
    };
  }
  const service = bundle.oauth_client_service;
  const account = bundle.oauth_client_account;
  if (!service || !account) {
    return { started: false, mailbox, detail: `stored token for ${mailbox} has no OAuth client refs` };
  }
  const child = spawn(
    "npx",
    ["tsx", CONSENT_SCRIPT, "consent", service, account, mailbox],
    { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"], detached: false },
  );
  // Surface the consent script's output on the cockpit's stderr for debugging,
  // but don't block the response on completion.
  child.stdout?.on("data", (d) => process.stderr.write(`[reauth:${mailbox}] ${d}`));
  child.stderr?.on("data", (d) => process.stderr.write(`[reauth:${mailbox}] ${d}`));
  child.unref();
  return {
    started: true,
    mailbox,
    detail: `Opening the browser — sign in as ${mailbox}. The banner clears once the daemon re-checks.`,
  };
}
