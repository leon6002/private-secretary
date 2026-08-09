// Write side of identity.ts — the file a fresh install has no way to create
// without a terminal.
//
// Until this existed, `curl | bash` produced an instance that could not work:
// config/identity.json is gitignored (correctly — it names a person's
// accounts), so a clone has only the .example. With no identity the daemon
// polls nothing and the cockpit's Connect button is inert, because the Keychain
// account key it would write to is the empty string. Hand-editing JSON was the
// only way out, which is exactly the step the one-click onboarding exists to
// remove.
//
// One field is enough. identity.ts already defaults slackAccounts, mailboxes
// and calendarMailbox to the primary email when they are absent, so the common
// single-account case needs nothing else; multi-account owners edit the file.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { _resetIdentity, type Identity } from "./identity.js";

export interface IdentityInput {
  primaryEmail: string;
  mailboxes?: string[];
  slackAccounts?: Array<{ account: string; label?: string }>;
  calendarMailbox?: string;
}

export class InvalidIdentity extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidIdentity";
  }
}

// Deliberately permissive: this guards against an empty box or an obvious
// typo, not against every RFC-legal oddity. Rejecting a valid address the
// owner actually uses would be the worse failure.
function normalizeEmail(raw: unknown, field: string): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) throw new InvalidIdentity(`${field} is required`);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) {
    throw new InvalidIdentity(`${field} does not look like an email address: ${s}`);
  }
  return s;
}

export function identityPathFor(cwd: string = process.cwd()): string {
  return join(cwd, "config", "identity.json");
}

// Build the on-disk shape. Pure — separated from the write so the exact JSON is
// assertable without touching a filesystem.
export function buildIdentityFile(input: IdentityInput): Record<string, unknown> {
  const primaryEmail = normalizeEmail(input.primaryEmail, "primaryEmail");
  const mailboxes = (input.mailboxes ?? [primaryEmail])
    .map((m, i) => normalizeEmail(m, `mailboxes[${i}]`));
  const slackAccounts = (input.slackAccounts ?? [{ account: primaryEmail }]).map((a, i) => ({
    account: normalizeEmail(a.account, `slackAccounts[${i}].account`),
    // The first workspace keeps the legacy label: it keys persisted cursors and
    // sourceErrors, so renaming it would orphan existing state.
    label: a.label?.trim() || (i === 0 ? "slack:direct" : `slack:${a.account.split("@")[0]}`),
  }));
  return {
    _comment:
      "Written by the cockpit's first-run setup. Safe to edit by hand — add mailboxes or Slack workspaces here. Gitignored; never commit.",
    primaryEmail,
    slackAccounts,
    mailboxes: mailboxes.length ? mailboxes : [primaryEmail],
    calendarMailbox: input.calendarMailbox?.trim()
      ? normalizeEmail(input.calendarMailbox, "calendarMailbox")
      : primaryEmail,
  };
}

export function writeIdentity(input: IdentityInput, cwd: string = process.cwd()): string {
  const path = identityPathFor(cwd);
  const body = buildIdentityFile(input);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
  // loadIdentity() memoises for the process lifetime, so without this the
  // cockpit would keep serving "unconfigured" until it restarted — the user
  // would save the form and see nothing change.
  _resetIdentity();
  return path;
}

export interface IdentityStatus {
  configured: boolean;
  primaryEmail: string;
  mailboxes: string[];
  slackAccounts: Array<{ account: string; label: string }>;
  calendarMailbox: string;
  source: string;
}

export function identityStatus(id: Identity): IdentityStatus {
  return {
    configured: id.configured,
    primaryEmail: id.primaryEmail,
    mailboxes: [...id.mailboxes],
    slackAccounts: id.slackAccounts.map((a) => ({ ...a })),
    calendarMailbox: id.calendarMailbox,
    source: id.source,
  };
}
