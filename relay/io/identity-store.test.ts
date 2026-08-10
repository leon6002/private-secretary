import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendSlackAccount,
  buildIdentityFile,
  slackAccountKeyFor,
  slackLabelFor,
  identityPathFor,
  InvalidIdentity,
  writeIdentity,
} from "./identity-store.js";

describe("buildIdentityFile", () => {
  // One field is the whole point: a fresh install should not have to know what
  // a mailbox list or a Slack account key is.
  it("derives every account from the primary email alone", () => {
    const f = buildIdentityFile({ primaryEmail: " me@example.com " }) as Record<string, never>;
    expect(f.primaryEmail).toBe("me@example.com");
    expect(f.mailboxes).toEqual(["me@example.com"]);
    expect(f.calendarMailbox).toBe("me@example.com");
    expect(f.slackAccounts).toEqual([{ account: "me@example.com", label: "slack:direct" }]);
  });

  // The first label keys persisted cursors and sourceErrors; renaming it would
  // orphan the existing state rather than reuse it.
  it("always labels the first Slack workspace slack:direct", () => {
    const f = buildIdentityFile({
      primaryEmail: "me@example.com",
      slackAccounts: [{ account: "me@example.com" }, { account: "other@corp.com" }],
    }) as Record<string, never>;
    expect(f.slackAccounts).toEqual([
      { account: "me@example.com", label: "slack:direct" },
      { account: "other@corp.com", label: "slack:other" },
    ]);
  });

  it("keeps an explicitly supplied label", () => {
    const f = buildIdentityFile({
      primaryEmail: "me@example.com",
      slackAccounts: [{ account: "me@example.com", label: "slack:work" }],
    }) as Record<string, never>;
    expect((f.slackAccounts as unknown as Array<{ label: string }>)[0]!.label).toBe("slack:work");
  });

  it.each([
    ["", "empty"],
    ["   ", "blank"],
    ["not-an-email", "no @"],
    ["a@b", "no dot"],
    ["a b@c.com", "space"],
  ])("rejects %s (%s)", (email) => {
    expect(() => buildIdentityFile({ primaryEmail: email })).toThrow(InvalidIdentity);
  });

  it("names the offending field so the form can point at it", () => {
    expect(() =>
      buildIdentityFile({ primaryEmail: "me@example.com", mailboxes: ["ok@example.com", "bad"] }),
    ).toThrow(/mailboxes\[1\]/);
  });
});

describe("writeIdentity", () => {
  it("writes parseable JSON where loadIdentity looks for it", () => {
    const dir = mkdtempSync(join(tmpdir(), "identity-"));
    const path = writeIdentity({ primaryEmail: "me@example.com" }, dir);

    expect(path).toBe(identityPathFor(dir));
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.primaryEmail).toBe("me@example.com");
    expect(parsed.slackAccounts[0].label).toBe("slack:direct");
  });

  // It names the owner's accounts, so it should not be world-readable.
  it("writes the file 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "identity-"));
    const path = writeIdentity({ primaryEmail: "me@example.com" }, dir);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mode = require("node:fs").statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("creates config/ when it does not exist yet", () => {
    const dir = mkdtempSync(join(tmpdir(), "identity-"));
    expect(() => writeIdentity({ primaryEmail: "me@example.com" }, dir)).not.toThrow();
  });

  it("writes nothing when validation fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "identity-"));
    expect(() => writeIdentity({ primaryEmail: "nope" }, dir)).toThrow(InvalidIdentity);
    expect(() => readFileSync(identityPathFor(dir), "utf8")).toThrow();
  });
});

describe("multi-workspace registration", () => {
  function seeded(dir: string, accounts: Array<{ account: string; label: string }>) {
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(
      identityPathFor(dir),
      JSON.stringify({ primaryEmail: "me@example.com", slackAccounts: accounts }),
    );
  }

  // Keyed on team_id, not the name: workspaces get renamed, and a renamed key
  // would orphan the stored credential.
  it("keys the Keychain entry on team_id", () => {
    expect(slackAccountKeyFor(" T0123ABCD ")).toBe("team:T0123ABCD");
    expect(() => slackAccountKeyFor("")).toThrow(InvalidIdentity);
  });

  it("slugs the team name into a label", () => {
    expect(slackLabelFor("Leo Test", [])).toBe("slack:leo-test");
    expect(slackLabelFor("Taiv!! ", [])).toBe("slack:taiv");
    expect(slackLabelFor("", [])).toBe("slack:workspace");
  });

  it("never reuses a taken label — labels key cursors", () => {
    expect(slackLabelFor("Taiv", ["slack:taiv"])).toBe("slack:taiv-2");
    expect(slackLabelFor("Taiv", ["slack:taiv", "slack:taiv-2"])).toBe("slack:taiv-3");
  });

  // The first entry keys every cursor already on disk as "slack:direct".
  // Rewriting it would orphan that history and re-surface everything as new.
  it("appends without touching the existing primary entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "identity-"));
    seeded(dir, [{ account: "me@example.com", label: "slack:direct" }]);

    const r = appendSlackAccount({ teamId: "T9", teamName: "Leo Test" }, dir);
    expect(r.added).toBe(true);
    expect(r.account).toBe("team:T9");
    expect(r.label).toBe("slack:leo-test");

    const parsed = JSON.parse(readFileSync(identityPathFor(dir), "utf8"));
    expect(parsed.slackAccounts).toEqual([
      { account: "me@example.com", label: "slack:direct" },
      { account: "team:T9", label: "slack:leo-test" },
    ]);
  });

  // Re-authorizing a workspace already registered must not add a duplicate,
  // and must not mint a second label for the same cursors.
  it("is idempotent for a workspace already registered", () => {
    const dir = mkdtempSync(join(tmpdir(), "identity-"));
    seeded(dir, [{ account: "team:T9", label: "slack:leo-test" }]);

    const r = appendSlackAccount({ teamId: "T9", teamName: "Renamed Since" }, dir);
    expect(r.added).toBe(false);
    expect(r.label).toBe("slack:leo-test");
    expect(JSON.parse(readFileSync(identityPathFor(dir), "utf8")).slackAccounts).toHaveLength(1);
  });

  it("refuses to register a workspace before identity exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "identity-"));
    expect(() => appendSlackAccount({ teamId: "T9", teamName: "X" }, dir)).toThrow(InvalidIdentity);
  });
});
