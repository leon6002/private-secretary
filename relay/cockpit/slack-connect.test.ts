import { afterEach, describe, expect, it } from "vitest";
import { __setRunner as __setKeychainRunner } from "../io/keychain.js";
import { SLACK_REFRESH_TTL_MS, SLACK_TOKEN_SERVICE } from "../io/slack-oauth.js";
import { slackConnectionStatus, startSlackConnect } from "./slack-connect.js";

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

afterEach(() => {
  __setKeychainRunner(null);
});

describe("slackConnectionStatus", () => {
  it("reports not-connected when Keychain has no entry", async () => {
    keychain(undefined);
    const s = await slackConnectionStatus(ACCOUNT);
    expect(s.kind).toBe("none");
    expect(s.connected).toBe(false);
  });

  it("recognises a legacy hand-pasted token as connected and non-expiring", async () => {
    keychain("xoxp-legacy");
    const s = await slackConnectionStatus(ACCOUNT);
    expect(s.kind).toBe("legacy");
    expect(s.connected).toBe(true);
    expect(s.expiresAt).toBe(0);
  });

  it("surfaces team and expiry from a PKCE bundle", async () => {
    keychain(bundle());
    const s = await slackConnectionStatus(ACCOUNT);
    expect(s.kind).toBe("pkce");
    expect(s.team).toBe("leotest");
    expect(s.expiresAt).toBe(1_800_000);
    expect(s.detail).toContain("leotest");
  });

  // The re-consent deadline rides on the LAST refresh, not the first consent —
  // a daemon that keeps refreshing pushes it forward forever.
  it("derives reconnectBy from refreshed_at, not granted_at", async () => {
    keychain(bundle({ granted_at: 1_000, refreshed_at: 500_000 }));
    const s = await slackConnectionStatus(ACCOUNT);
    expect(s.reconnectBy).toBe(500_000 + SLACK_REFRESH_TTL_MS);
  });

  // Bundles written before refreshed_at existed must still produce a deadline.
  it("falls back to granted_at when refreshed_at is absent", async () => {
    keychain(bundle({ granted_at: 7_000, refreshed_at: undefined }));
    const s = await slackConnectionStatus(ACCOUNT);
    expect(s.reconnectBy).toBe(7_000 + SLACK_REFRESH_TTL_MS);
  });

  // The status read must never surface the credential itself — this object is
  // serialised straight to the browser.
  it("never leaks token material", async () => {
    keychain(bundle());
    const s = await slackConnectionStatus(ACCOUNT);
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
