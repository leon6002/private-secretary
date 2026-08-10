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
import { loadIdentity } from "../io/identity.js";
import {
  parseStoredToken,
  resolveSlackCredential,
  SLACK_OAUTH_TOKEN_SERVICE,
  SLACK_REFRESH_TTL_MS,
  SLACK_TOKEN_SERVICE,
  type SlackTokenBundle,
} from "../io/slack-oauth.js";

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

export interface SlackCredentialState {
  present: boolean;
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
}

export interface SlackWorkspace {
  /** Keychain key. "team:T…" for workspaces added through the one-click flow;
   *  older entries keep whatever key identity.json already had. */
  account: string;
  /** Source label. Keys cursors and sourceErrors — never regenerate it. */
  label: string;
  /** Which credential the runtime actually uses for THIS workspace. Legacy
   *  wins — it is the unthrottled one, and preferring ours would cut
   *  throughput ~50x. */
  active: "legacy" | "oauth" | "none";
  /** The user's own Slack app token: unthrottled, and unrecoverable from here
   *  once removed, because our flow can only ever issue OUR app's token. */
  legacy: SlackCredentialState;
  /** Ours: one click to obtain, rate-limited until the app is on the
   *  Marketplace. */
  oauth: SlackCredentialState;
}

export interface SlackConnectionStatus {
  workspaces: SlackWorkspace[];
}

const ABSENT: SlackCredentialState = { present: false, expiresAt: 0, reconnectBy: 0 };

function bundleState(b: SlackTokenBundle): SlackCredentialState {
  return {
    present: true,
    team: b.team_name || b.team_id || undefined,
    expiresAt: b.expires_at,
    // Pre-refreshed_at bundles fall back to the original consent time.
    reconnectBy: (b.refreshed_at ?? b.granted_at) + SLACK_REFRESH_TTL_MS,
  };
}

async function workspaceStatus(account: string, label: string): Promise<SlackWorkspace> {
  const cred = await resolveSlackCredential(account);
  const legacy: SlackCredentialState =
    cred?.kind === "legacy" ? { present: true, expiresAt: 0, reconnectBy: 0 } : ABSENT;

  // The OAuth bundle may resolve from either slot (pre-split installs kept
  // theirs in the original one), and it is only reachable through resolve when
  // no legacy token outranks it — so read the OAuth slot directly as well.
  let oauth: SlackCredentialState = ABSENT;
  if (cred?.kind === "pkce" && cred.bundle) oauth = bundleState(cred.bundle);
  else {
    try {
      const raw = parseStoredToken(await getSecret(SLACK_OAUTH_TOKEN_SERVICE, account));
      if (typeof raw !== "string") oauth = bundleState(raw);
    } catch {
      /* absent */
    }
  }

  return {
    account,
    label,
    active: cred ? (cred.kind === "legacy" ? "legacy" : "oauth") : "none",
    legacy,
    oauth,
  };
}

// Reads identity FRESH rather than the module-load snapshot: adding a
// workspace rewrites identity.json mid-process, and a cached list would leave
// the new one invisible until the cockpit restarted.
export async function slackConnectionStatus(): Promise<SlackConnectionStatus> {
  const accounts = loadIdentity().slackAccounts;
  return {
    workspaces: await Promise.all(accounts.map((a) => workspaceStatus(a.account, a.label))),
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
  which: "legacy" | "oauth" = "oauth",
): Promise<SlackDisconnect> {
  // Only ever our own slot by default. Removing the legacy token is a
  // different, unrecoverable act and has to be asked for explicitly.
  const service = which === "legacy" ? SLACK_TOKEN_SERVICE : SLACK_OAUTH_TOKEN_SERVICE;
  let token: string | undefined;
  try {
    const stored = parseStoredToken(await getSecret(service, account));
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

  await deleteSecret(service, account).catch(() => {});

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
  mode: "reauth" | "add" = "reauth",
): SlackConnectStart {
  const trimmed = account.trim();
  // "add" needs no account: the key is derived from whichever workspace the
  // user picks on Slack's page, which we only learn afterwards.
  if (mode === "reauth" && !trimmed) {
    return { started: false, account, detail: "account required" };
  }
  spawnFn(mode === "add" ? ["tsx", CONSENT_SCRIPT, "add"] : ["tsx", CONSENT_SCRIPT, "consent", trimmed]);
  return {
    started: true,
    account: trimmed,
    detail: "Opening the browser — approve access in Slack, then this card turns green.",
  };
}
