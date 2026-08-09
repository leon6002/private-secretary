// Slack connect / reconnect, driven from the cockpit's Connections screen.
// The Slack twin of reauth.ts, with one difference that matters: Gmail's
// Reconnect only appears after a refresh_token dies, while Slack needs a
// first-time Connect too, because a fresh install has no token at all.
//
// Why a status read exists here: a PKCE token rotates (~12h access token,
// 30-day refresh token — verified against the live API, and it rotates even
// with Slack's token-rotation setting left off). A machine that sits closed
// past the refresh window comes back needing full re-consent, and the cockpit
// has to say so rather than let the daemon fail mid-scan. Reading the stored
// bundle is what lets the card show that before the next scan discovers it.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deleteSecret, getSecret } from "../io/keychain.js";
import { SlackClient, SLACK_TOKEN_ACCOUNT } from "../io/slack-api.js";
import { parseStoredToken, SLACK_REFRESH_TTL_MS, SLACK_TOKEN_SERVICE } from "../io/slack-oauth.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONSENT_SCRIPT = join(REPO_ROOT, "scripts", "auth", "slack-oauth.ts");

// Injectable so tests assert the exact argv instead of spawning a browser.
export type SlackConsentSpawn = (argv: string[]) => void;

const defaultSlackConsentSpawn: SlackConsentSpawn = (argv) => {
  const child = spawn("npx", argv, {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  const account = argv.at(-1);
  child.stdout?.on("data", (d) => process.stderr.write(`[slack-consent:${account}] ${d}`));
  child.stderr?.on("data", (d) => process.stderr.write(`[slack-consent:${account}] ${d}`));
  child.unref();
};

export type SlackCredentialKind =
  | "none" // nothing stored — first-time Connect
  | "legacy" // hand-pasted xoxp-, never expires
  | "pkce"; // rotating bundle from the Connect flow

export interface SlackConnectionStatus {
  account: string;
  kind: SlackCredentialKind;
  connected: boolean;
  team?: string;
  // ms epoch of ACCESS token expiry; 0 when the credential does not expire.
  // Machinery, not a user-facing deadline — it is ~12h out by design and the
  // runtime refreshes it silently. Surfacing it as a warning would mean the
  // row is red permanently.
  expiresAt: number;
  // ms epoch when re-consent becomes necessary: the refresh_token's 30-day
  // window, restarted by every refresh. THIS is the one worth showing, and it
  // only closes on a machine that stopped running.
  reconnectBy: number;
  detail: string;
}

export async function slackConnectionStatus(
  account: string = SLACK_TOKEN_ACCOUNT,
): Promise<SlackConnectionStatus> {
  let raw: string;
  try {
    raw = await getSecret(SLACK_TOKEN_SERVICE, account);
  } catch {
    return {
      account,
      kind: "none",
      connected: false,
      expiresAt: 0,
      reconnectBy: 0,
      detail: "not connected",
    };
  }
  const stored = parseStoredToken(raw);
  if (typeof stored === "string") {
    return {
      account,
      kind: "legacy",
      connected: true,
      expiresAt: 0,
      reconnectBy: 0,
      detail: "connected · legacy token (no expiry)",
    };
  }
  return {
    account,
    kind: "pkce",
    connected: true,
    team: stored.team_name || stored.team_id || undefined,
    expiresAt: stored.expires_at,
    // Pre-refreshed_at bundles fall back to the original consent time.
    reconnectBy: (stored.refreshed_at ?? stored.granted_at) + SLACK_REFRESH_TTL_MS,
    detail: stored.team_name ? `connected · ${stored.team_name}` : "connected",
  };
}

export interface SlackDisconnect {
  ok: boolean;
  /** True when Slack itself confirmed the grant was withdrawn. */
  revoked: boolean;
  detail: string;
}

// Disconnect = revoke at Slack, THEN forget locally. Order matters: revoking
// needs the token, so deleting first would leave a live grant nobody can
// withdraw from here. If the revoke call fails (network, already-dead token)
// the local copy is still removed — leaving an unusable credential behind
// would strand the row in a state the user cannot clear.
// Injectable so tests can assert revoke-before-delete without a live token.
export type SlackRevoke = (token: string) => Promise<boolean>;
const defaultSlackRevoke: SlackRevoke = async (token) =>
  (await new SlackClient({ token }).authRevoke()).revoked;

export async function disconnectSlack(
  account: string = SLACK_TOKEN_ACCOUNT,
  revoke: SlackRevoke = defaultSlackRevoke,
): Promise<SlackDisconnect> {
  let token: string | undefined;
  try {
    const stored = parseStoredToken(await getSecret(SLACK_TOKEN_SERVICE, account));
    token = typeof stored === "string" ? stored : stored.access_token;
  } catch {
    return { ok: true, revoked: false, detail: "Already disconnected." };
  }

  let revoked = false;
  let revokeError = "";
  try {
    revoked = await revoke(token);
  } catch (e) {
    revokeError = e instanceof Error ? e.message : String(e);
  }

  await deleteSecret(SLACK_TOKEN_SERVICE, account).catch(() => {});

  return {
    ok: true,
    revoked,
    detail: revoked
      ? "Disconnected. Access was revoked at Slack and the token is gone from this Mac."
      : `Removed from this Mac, but Slack did not confirm the revoke${
          revokeError ? ` (${revokeError})` : ""
        } — remove it at slack.com/apps to be sure.`,
  };
}

export interface SlackConnectStart {
  started: boolean;
  account: string;
  detail: string;
}

// Kick off consent and return immediately. The browser dance takes as long as
// the user takes, so the HTTP request never waits on it — same contract as
// startGmailReauth.
export function startSlackConnect(
  account: string = SLACK_TOKEN_ACCOUNT,
  spawnFn: SlackConsentSpawn = defaultSlackConsentSpawn,
): SlackConnectStart {
  const trimmed = account.trim();
  if (!trimmed) {
    return { started: false, account, detail: "account required" };
  }
  spawnFn(["tsx", CONSENT_SCRIPT, "consent", trimmed]);
  return {
    started: true,
    account: trimmed,
    detail: "Opening the browser — approve access in Slack, then this card turns green.",
  };
}
