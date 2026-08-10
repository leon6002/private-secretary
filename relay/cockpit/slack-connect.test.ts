import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setRunner as __setKeychainRunner } from "../io/keychain.js";
import { SLACK_REFRESH_TTL_MS, SLACK_TOKEN_SERVICE } from "../io/slack-oauth.js";
import {
  addLegacyWorkspace,
  disconnectSlack,
  slackConnectionStatus,
  startSlackConnect,
} from "./slack-connect.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setIdentityForTest, _resetIdentity } from "../io/identity.js";

const ACCOUNT = "me@example.com";

function keychain(value?: string) {
  __setKeychainRunner(async (args) => {
    if (args[0] !== "find-generic-password") throw new Error(`unhandled: ${args[0]}`);
    if (value === undefined) {
      throw Object.assign(new Error("missing"), { code: 44, stderr: "could not be found" });
    }
    return { stdout: value + "\n", stderr: "" };
  });
}

function bundle(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    access_token: "xoxe.xoxp-1",
    refresh_token: "xoxe-1-r",
    expires_at: 1_800_000,
    scope: "im:history",
    team_id: "T1",
    team_name: "leotest",
    user_id: "U1",
    granted_at: 1_000,
    client_id: "123.456",
    ...over,
  });
}

// The status list comes from identity.json; pin it so these tests do not
// depend on whether the machine running them happens to have one.
beforeEach(() => {
  _setIdentityForTest({ slackAccounts: [{ account: ACCOUNT, label: "slack:direct" }] });
});

afterEach(() => {
  __setKeychainRunner(null);
  _resetIdentity();
});

describe("slackConnectionStatus", () => {
  it("reports nothing present when Keychain is empty", async () => {
    keychain(undefined);
    const s = (await slackConnectionStatus()).workspaces[0]!;
    expect(s.active).toBe("none");
    expect(s.legacy.present).toBe(false);
    expect(s.oauth.present).toBe(false);
  });

  it("recognises a legacy hand-pasted token as the active credential", async () => {
    keychain("xoxp-legacy");
    const s = (await slackConnectionStatus()).workspaces[0]!;
    expect(s.active).toBe("legacy");
    expect(s.legacy.present).toBe(true);
    expect(s.oauth.present).toBe(false);
  });

  it("surfaces team and expiry from a PKCE bundle", async () => {
    keychain(bundle());
    const s = (await slackConnectionStatus()).workspaces[0]!;
    expect(s.active).toBe("oauth");
    expect(s.oauth.team).toBe("leotest");
    expect(s.oauth.expiresAt).toBe(1_800_000);
  });

  // The re-consent deadline rides on the LAST refresh, not the first consent —
  // a daemon that keeps refreshing pushes it forward forever.
  it("derives reconnectBy from refreshed_at, not granted_at", async () => {
    keychain(bundle({ granted_at: 1_000, refreshed_at: 500_000 }));
    const s = (await slackConnectionStatus()).workspaces[0]!;
    expect(s.oauth.reconnectBy).toBe(500_000 + SLACK_REFRESH_TTL_MS);
  });

  // Bundles written before refreshed_at existed must still produce a deadline.
  it("falls back to granted_at when refreshed_at is absent", async () => {
    keychain(bundle({ granted_at: 7_000, refreshed_at: undefined }));
    const s = (await slackConnectionStatus()).workspaces[0]!;
    expect(s.oauth.reconnectBy).toBe(7_000 + SLACK_REFRESH_TTL_MS);
  });

  // The status read must never surface the credential itself — this object is
  // serialised straight to the browser.
  // BOTH credentials visible at once is the point: the legacy one is the only
  // unthrottled path until the app is on the Marketplace, so connecting ours
  // must not hide or replace it.
  it("shows both, with legacy active, when both exist", async () => {
    const store = new Map<string, string>([
      [`${SLACK_TOKEN_SERVICE}|${ACCOUNT}`, "xoxp-own-app"],
      [`taiv-secretary-slack-oauth|${ACCOUNT}`, bundle()],
    ]);
    __setKeychainRunner(async (args) => {
      const v = store.get(`${args[args.indexOf("-s") + 1]}|${args[args.indexOf("-a") + 1]}`);
      if (v === undefined) {
        throw Object.assign(new Error("missing"), { code: 44, stderr: "could not be found" });
      }
      return { stdout: v + "\n", stderr: "" };
    });
    const s = (await slackConnectionStatus()).workspaces[0]!;
    expect(s.active).toBe("legacy");
    expect(s.legacy.present).toBe(true);
    expect(s.oauth.present).toBe(true);
    expect(s.oauth.team).toBe("leotest");
  });

  it("never leaks token material", async () => {
    keychain(bundle());
    const s = (await slackConnectionStatus()).workspaces[0]!;
    const dumped = JSON.stringify(s);
    expect(dumped).not.toContain("xoxe");
    expect(dumped).not.toContain("xoxp");
  });
});

describe("startSlackConnect", () => {
  it("spawns the consent script for the given account", () => {
    const calls: string[][] = [];
    const r = startSlackConnect(ACCOUNT, (argv) => calls.push(argv));
    expect(r.started).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe("tsx");
    expect(calls[0]!.at(-2)).toBe("consent");
    expect(calls[0]!.at(-1)).toBe(ACCOUNT);
    expect(calls[0]![1]).toMatch(/scripts\/auth\/slack-oauth\.ts$/);
  });

  it("refuses a blank account instead of spawning with a missing argument", () => {
    const calls: string[][] = [];
    const r = startSlackConnect("   ", (argv) => calls.push(argv));
    expect(r.started).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("disconnectSlack", () => {
  function keychainStore(seed?: string, service: string = SLACK_TOKEN_SERVICE) {
    const store = new Map<string, string>();
    if (seed) store.set(`${service}|${ACCOUNT}`, seed);
    const order: string[] = [];
    __setKeychainRunner(async (args) => {
      const k = `${args[args.indexOf("-s") + 1]}|${args[args.indexOf("-a") + 1]}`;
      if (args[0] === "find-generic-password") {
        const v = store.get(k);
        if (v === undefined) {
          throw Object.assign(new Error("missing"), { code: 44, stderr: "could not be found" });
        }
        return { stdout: v + "\n", stderr: "" };
      }
      if (args[0] === "delete-generic-password") {
        order.push("delete");
        store.delete(k);
        return { stdout: "", stderr: "" };
      }
      throw new Error(`unhandled: ${args[0]}`);
    });
    return { store, order };
  }

  // Revoke FIRST, then forget: revoking needs the token, so deleting first
  // would leave a live grant that nothing here could withdraw.
  it("revokes at Slack before deleting the local copy", async () => {
    const { store, order } = keychainStore(bundle(), "taiv-secretary-slack-oauth");
    const r = await disconnectSlack(ACCOUNT, async () => {
      order.push("revoke");
      return true;
    });
    expect(order).toEqual(["revoke", "delete"]);
    expect(r.revoked).toBe(true);
    expect(store.size).toBe(0);
  });

  // A dead or unreachable token must not strand the row: forget it locally
  // anyway, and say plainly that Slack did not confirm.
  it("still forgets the token when the revoke call fails", async () => {
    const { store } = keychainStore(bundle(), "taiv-secretary-slack-oauth");
    const r = await disconnectSlack(ACCOUNT, async () => {
      throw new Error("token_revoked");
    });
    expect(r.ok).toBe(true);
    expect(r.revoked).toBe(false);
    expect(r.detail).toMatch(/slack\.com\/apps/);
    expect(store.size).toBe(0);
  });

  it("is a no-op when nothing is stored", async () => {
    keychainStore();
    const r = await disconnectSlack(ACCOUNT, async () => true);
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/Already disconnected/);
  });

  // Default target is OUR slot. Removing the user's own app token is a
  // different, unrecoverable act that has to be named explicitly.
  it("leaves the legacy token alone unless it is asked for by name", async () => {
    const { store } = keychainStore("xoxp-own-app", SLACK_TOKEN_SERVICE);
    const r = await disconnectSlack(ACCOUNT, async () => true);
    expect(r.detail).toMatch(/Already disconnected/);
    expect(store.get(`${SLACK_TOKEN_SERVICE}|${ACCOUNT}`)).toBe("xoxp-own-app");

    await disconnectSlack(ACCOUNT, async () => true, "legacy");
    expect(store.size).toBe(0);
  });
});

describe("multiple workspaces", () => {
  it("returns one entry per identity workspace, each resolved independently", async () => {
    _setIdentityForTest({
      slackAccounts: [
        { account: "me@example.com", label: "slack:direct" },
        { account: "team:T9", label: "slack:leo-test" },
      ],
    });
    const store = new Map<string, string>([
      [`${SLACK_TOKEN_SERVICE}|me@example.com`, "xoxp-own-app"],
      [`taiv-secretary-slack-oauth|team:T9`, bundle()],
    ]);
    __setKeychainRunner(async (args) => {
      const v = store.get(`${args[args.indexOf("-s") + 1]}|${args[args.indexOf("-a") + 1]}`);
      if (v === undefined) {
        throw Object.assign(new Error("missing"), { code: 44, stderr: "could not be found" });
      }
      return { stdout: v + "\n", stderr: "" };
    });

    const { workspaces } = await slackConnectionStatus();
    expect(workspaces).toHaveLength(2);
    expect(workspaces[0]).toMatchObject({ label: "slack:direct", active: "legacy" });
    expect(workspaces[1]).toMatchObject({ label: "slack:leo-test", active: "oauth" });
    expect(workspaces[1]!.oauth.team).toBe("leotest");
  });

  // "add" cannot name an account up front: the key is derived from whichever
  // workspace the user picks on Slack's page, which we only learn afterwards.
  it("spawns the add subcommand with no account argument", () => {
    const calls: string[][] = [];
    const r = startSlackConnect("", (argv) => calls.push(argv), "add");
    expect(r.started).toBe(true);
    expect(calls[0]!.at(-1)).toBe("add");
  });

  it("still requires an account when re-authorizing a known workspace", () => {
    const calls: string[][] = [];
    expect(startSlackConnect("  ", (argv) => calls.push(argv)).started).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("disconnect finds the credential wherever it lives", () => {
  function store(seed: Record<string, string>) {
    const m = new Map(Object.entries(seed));
    __setKeychainRunner(async (args) => {
      const k = `${args[args.indexOf("-s") + 1]}|${args[args.indexOf("-a") + 1]}`;
      if (args[0] === "delete-generic-password") {
        m.delete(k);
        return { stdout: "", stderr: "" };
      }
      const v = m.get(k);
      if (v === undefined) {
        throw Object.assign(new Error("missing"), { code: 44, stderr: "could not be found" });
      }
      return { stdout: v + "\n", stderr: "" };
    });
    return m;
  }

  // REGRESSION: a pre-split install keeps its OAuth bundle in the ORIGINAL
  // slot. Targeting the oauth slot by name found nothing, said "Already
  // disconnected" and deleted nothing — while the status row, which checks
  // both slots, kept showing connected.
  it("disconnects a bundle sitting in the pre-split slot", async () => {
    const m = store({ [`${SLACK_TOKEN_SERVICE}|${ACCOUNT}`]: bundle() });
    const r = await disconnectSlack(ACCOUNT, async () => true, "oauth");
    expect(r.revoked).toBe(true);
    expect(m.size).toBe(0);
  });

  // The hand-pasted token can occupy that same slot, and it is unrecoverable
  // from the cockpit — an "oauth" disconnect must never take it.
  it("refuses to delete a legacy token during an oauth disconnect", async () => {
    const m = store({ [`${SLACK_TOKEN_SERVICE}|${ACCOUNT}`]: "xoxp-own-app" });
    const r = await disconnectSlack(ACCOUNT, async () => true, "oauth");
    expect(r.detail).toMatch(/Already disconnected/);
    expect(m.get(`${SLACK_TOKEN_SERVICE}|${ACCOUNT}`)).toBe("xoxp-own-app");
  });

  it("prefers the oauth slot when both slots hold something", async () => {
    const m = store({
      [`${SLACK_TOKEN_SERVICE}|${ACCOUNT}`]: "xoxp-own-app",
      [`taiv-secretary-slack-oauth|${ACCOUNT}`]: bundle(),
    });
    await disconnectSlack(ACCOUNT, async () => true, "oauth");
    expect(m.has(`taiv-secretary-slack-oauth|${ACCOUNT}`)).toBe(false);
    expect(m.get(`${SLACK_TOKEN_SERVICE}|${ACCOUNT}`)).toBe("xoxp-own-app");
  });
});

describe("addLegacyWorkspace", () => {
  const WHO = async () => ({ team: "Taiv", team_id: "T77", user: "leo" });

  function tmpIdentity() {
    const dir = mkdtempSync(join(tmpdir(), "idw-"));
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(
      join(dir, "config", "identity.json"),
      JSON.stringify({ primaryEmail: "me@example.com", slackAccounts: [] }),
    );
    return dir;
  }

  it("refuses a bot token before it reaches Slack or Keychain", async () => {
    let called = false;
    await expect(
      addLegacyWorkspace("xoxb-bot", async () => {
        called = true;
        return { team: "X", team_id: "T", user: "u" };
      }),
    ).rejects.toThrow(/xoxp-/);
    expect(called).toBe(false);
  });

  // The token identifies its own workspace, and auth.test doubles as
  // verification: a token that cannot answer it would otherwise sit in
  // Keychain looking configured and fail at scan time.
  it("verifies the token, then registers the workspace it names", async () => {
    const dir = tmpIdentity();
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const store = new Map<string, string>();
      __setKeychainRunner(async (args) => {
        if (args[0] === "add-generic-password") {
          store.set(`${args[args.indexOf("-s") + 1]}|${args[args.indexOf("-a") + 1]}`, args[args.indexOf("-w") + 1]!);
          return { stdout: "", stderr: "" };
        }
        throw Object.assign(new Error("missing"), { code: 44, stderr: "could not be found" });
      });

      const r = await addLegacyWorkspace("xoxp-abc", WHO, async () => ({ restarted: true }));
      expect(r).toMatchObject({ team: "Taiv", user: "leo", added: true, account: "team:T77" });
      expect(store.get(`${SLACK_TOKEN_SERVICE}|team:T77`)).toBe("xoxp-abc");
      // A newly polled workspace is invisible to a daemon that read its list
      // at startup.
      expect(r.daemonRestarted).toBe(true);
    } finally {
      process.chdir(cwd);
      _resetIdentity();
    }
  });
});
