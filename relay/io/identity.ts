// WHO this instance belongs to. Everything that used to be hard-coded to one
// person's accounts (Slack workspace tokens, Gmail mailboxes, the calendar to
// book on) reads from here, so a second person can run the engine against their
// own accounts by dropping in a config file.
//
// Resolution order, first hit wins:
//   1. $SECRETARY_IDENTITY            — path to a JSON file
//   2. config/identity.json           — the normal case (gitignored)
//   3. environment variables          — SECRETARY_EMAIL / SECRETARY_MAILBOXES /
//                                       SECRETARY_SLACK_ACCOUNTS / SECRETARY_CALENDAR
//   4. the UNCONFIGURED fallback      — empty account lists, so a fresh clone
//                                       does nothing surprising instead of
//                                       reaching for someone else's Keychain.
//
// The fallback is deliberately inert rather than a guess: reading the WRONG
// person's mailbox is worse than reading none. `describeIdentity()` renders a
// one-line status the daemon prints at startup so a mis-set config is obvious.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SlackAccountConfig {
  account: string; // Keychain account name for this workspace's user token
  label: string; // stable source label, e.g. "slack:work"
}

export interface Identity {
  // The owner's primary work email. Doubles as the default Keychain account for
  // the primary Slack workspace.
  primaryEmail: string;
  // Every Slack workspace to poll. The FIRST entry is the primary (its cursor
  // slice keeps the legacy key so existing state survives).
  slackAccounts: SlackAccountConfig[];
  // Every Gmail mailbox to poll.
  mailboxes: string[];
  // Which calendar new events are booked on.
  calendarMailbox: string;
  // True when nothing was configured — call sites can warn instead of silently
  // doing nothing.
  configured: boolean;
  source: string; // where the config came from (for the startup line)
}

const UNCONFIGURED: Identity = {
  primaryEmail: "",
  slackAccounts: [],
  mailboxes: [],
  calendarMailbox: "",
  configured: false,
  source: "unconfigured",
};

function fromEnv(): Identity | null {
  const email = process.env.SECRETARY_EMAIL?.trim();
  if (!email) return null;
  const list = (v: string | undefined): string[] =>
    (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const mailboxes = list(process.env.SECRETARY_MAILBOXES);
  const slackRaw = list(process.env.SECRETARY_SLACK_ACCOUNTS);
  return {
    primaryEmail: email,
    slackAccounts: (slackRaw.length ? slackRaw : [email]).map((account, i) => ({
      account,
      label: i === 0 ? "slack:direct" : `slack:${account.split("@")[0]}`,
    })),
    mailboxes: mailboxes.length ? mailboxes : [email],
    calendarMailbox: process.env.SECRETARY_CALENDAR?.trim() || email,
    configured: true,
    source: "env",
  };
}

function fromFile(path: string): Identity | null {
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`identity config ${path} is not valid JSON: ${(e as Error).message}`);
  }
  const o = raw as Partial<Identity> & { slackAccounts?: unknown };
  const email = typeof o.primaryEmail === "string" ? o.primaryEmail.trim() : "";
  if (!email) throw new Error(`identity config ${path} is missing "primaryEmail"`);

  const slackAccounts: SlackAccountConfig[] = Array.isArray(o.slackAccounts)
    ? (o.slackAccounts as SlackAccountConfig[])
        .filter((a) => a && typeof a.account === "string" && a.account.trim() !== "")
        .map((a, i) => ({
          account: a.account.trim(),
          label: typeof a.label === "string" && a.label.trim() ? a.label.trim() : i === 0 ? "slack:direct" : `slack:${a.account.split("@")[0]}`,
        }))
    : [{ account: email, label: "slack:direct" }];

  const mailboxes = Array.isArray(o.mailboxes)
    ? o.mailboxes.filter((m): m is string => typeof m === "string" && m.trim() !== "").map((m) => m.trim())
    : [email];

  return {
    primaryEmail: email,
    slackAccounts,
    mailboxes: mailboxes.length ? mailboxes : [email],
    calendarMailbox:
      typeof o.calendarMailbox === "string" && o.calendarMailbox.trim() ? o.calendarMailbox.trim() : email,
    configured: true,
    source: path,
  };
}

let cached: Identity | null = null;

export function loadIdentity(): Identity {
  if (cached) return cached;
  const explicit = process.env.SECRETARY_IDENTITY?.trim();
  cached =
    (explicit ? fromFile(explicit) : null) ??
    fromFile(join(process.cwd(), "config", "identity.json")) ??
    fromEnv() ??
    UNCONFIGURED;
  return cached;
}

// Test seam / for a process that rewrites config at runtime.
export function _resetIdentity(): void {
  cached = null;
}

// Test seam: pin the identity so a test never depends on whether the machine
// running it happens to have a config file. Without this, any test touching
// identity passes on a configured machine and fails on a fresh clone (or vice
// versa) — which is exactly the bug this seam was added to kill.
export function _setIdentityForTest(partial: Partial<Identity>): void {
  cached = { ...UNCONFIGURED, configured: true, source: "test", ...partial };
}

export function describeIdentity(id: Identity = loadIdentity()): string {
  if (!id.configured) {
    return "identity: UNCONFIGURED — copy config/identity.example.json → config/identity.json (see SETUP.md). No Slack/Gmail will be polled.";
  }
  return (
    `identity: ${id.primaryEmail} (from ${id.source}) — ` +
    `slack=${id.slackAccounts.map((a) => a.label).join(",") || "none"} ` +
    `mailboxes=${id.mailboxes.length} calendar=${id.calendarMailbox}`
  );
}
