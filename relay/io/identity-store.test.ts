import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildIdentityFile,
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
