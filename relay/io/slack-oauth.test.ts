import { createHash, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  __setSlackOAuthFetch,
  buildAuthorizeUrl,
  codeChallengeOf,
  createCodeVerifier,
  exchangeCode,
  needsRefresh,
  parseStoredToken,
  readSlackToken,
  refreshBundle,
  SLACK_TOKEN_SERVICE,
  slackRedirectUri,
  type SlackTokenBundle,
} from "./slack-oauth.js";
import { __setRunner as __setKeychainRunner } from "./keychain.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest();

function fakeKeychainStore(seed: Record<string, string> = {}): Map<string, string> {
  const store = new Map<string, string>(Object.entries(seed));
  __setKeychainRunner(async (args) => {
    const cmd = args[0];
    const s = args[args.indexOf("-s") + 1];
    const a = args[args.indexOf("-a") + 1];
    if (cmd === "find-generic-password") {
      const v = store.get(`${s}|${a}`);
      if (v === undefined) {
        throw Object.assign(new Error("missing"), { code: 44, stderr: "could not be found" });
      }
      return { stdout: v + "\n", stderr: "" };
    }
    if (cmd === "add-generic-password") {
      store.set(`${s}|${a}`, args[args.indexOf("-w") + 1]!);
      return { stdout: "", stderr: "" };
    }
    throw new Error(`unhandled cmd: ${cmd}`);
  });
  return store;
}

function bundle(over: Partial<SlackTokenBundle> = {}): SlackTokenBundle {
  return {
    access_token: "xoxe.xoxp-old",
    refresh_token: "xoxe-1-refresh",
    expires_at: 0,
    scope: "im:history",
    team_id: "T1",
    team_name: "Taiv",
    user_id: "U1",
    granted_at: 1_000,
    client_id: "123.456",
    ...over,
  };
}

afterEach(() => {
  __setSlackOAuthFetch(null);
  __setKeychainRunner(null);
});

describe("PKCE", () => {
  it("derives the challenge per RFC 7636 S256 test vector", () => {
    // The verifier/challenge pair published in RFC 7636 appendix B — if our
    // base64url encoding is wrong (padding or +/ not swapped) this fails.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(codeChallengeOf(verifier, sha256)).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("generates a verifier in the RFC-legal length range and charset", () => {
    const v = createCodeVerifier(randomBytes);
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v.length).toBeLessThanOrEqual(128);
    expect(v).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });
});

describe("buildAuthorizeUrl", () => {
  it("requests user_scope, never bot scope — desktop redirects forbid bot scopes", () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: "123.456",
        redirectUri: slackRedirectUri(4318),
        codeChallenge: "chal",
        state: "st",
      }),
    );
    expect(url.searchParams.get("user_scope")).toContain("im:history");
    expect(url.searchParams.get("scope")).toBeNull();
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:4318/slack/callback");
  });
});

describe("exchangeCode", () => {
  it("sends the verifier and NO client_secret, and reads the nested user token", async () => {
    let sentBody = "";
    __setSlackOAuthFetch(async (_url, init) => {
      sentBody = String((init as RequestInit).body);
      return new Response(
        JSON.stringify({
          ok: true,
          authed_user: {
            id: "U9",
            scope: "im:history,chat:write",
            access_token: "xoxe.xoxp-new",
            refresh_token: "xoxe-1-r",
            expires_in: 43_200,
            token_type: "user",
          },
          team: { id: "T9", name: "Taiv" },
        }),
        { status: 200 },
      );
    });
    const out = await exchangeCode({
      clientId: "123.456",
      code: "c",
      codeVerifier: "v",
      redirectUri: slackRedirectUri(4318),
      now: 10_000,
    });
    expect(sentBody).toContain("code_verifier=v");
    expect(sentBody).not.toContain("client_secret");
    expect(out.access_token).toBe("xoxe.xoxp-new");
    expect(out.expires_at).toBe(10_000 + 43_200 * 1000);
    expect(out.team_name).toBe("Taiv");
  });

  it("throws on ok:false — Slack returns HTTP 200 for real failures", async () => {
    __setSlackOAuthFetch(async () =>
      new Response(JSON.stringify({ ok: false, error: "invalid_grant_type" }), { status: 200 }),
    );
    await expect(
      exchangeCode({ clientId: "c", code: "c", codeVerifier: "v", redirectUri: "r" }),
    ).rejects.toThrow(/invalid_grant_type/);
  });
});

describe("refreshBundle", () => {
  // VERIFIED against the live API on 2026-08-09, not inferred: a user-token
  // refresh answers TOP-LEVEL, unlike the initial exchange which nests under
  // authed_user. Real response keys were:
  //   ok, access_token, expires_in, refresh_token, token_type, app_id, scope,
  //   user_id, team, enterprise, is_enterprise_install
  // Slack documents only the nested shape, so betting on it would have broken
  // every install ~12h after connecting. Both shapes stay supported.
  it("reads a TOP-LEVEL token shape (the real refresh response)", async () => {
    __setSlackOAuthFetch(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          access_token: "xoxe.xoxp-flat",
          refresh_token: "xoxe-1-r2",
          expires_in: 43_200,
          token_type: "user",
        }),
        { status: 200 },
      ),
    );
    const out = await refreshBundle(bundle({ expires_at: 1 }), 5_000);
    expect(out.access_token).toBe("xoxe.xoxp-flat");
    expect(out.refresh_token).toBe("xoxe-1-r2");
  });

  it("keeps the previous refresh_token when the response omits one", async () => {
    __setSlackOAuthFetch(async () =>
      new Response(
        JSON.stringify({ ok: true, authed_user: { access_token: "xoxe.xoxp-2" } }),
        { status: 200 },
      ),
    );
    const out = await refreshBundle(bundle({ refresh_token: "keep-me" }), 5_000);
    expect(out.refresh_token).toBe("keep-me");
  });

  it("refuses to refresh without a refresh_token", async () => {
    await expect(refreshBundle(bundle({ refresh_token: "" }))).rejects.toThrow(/re-consent/);
  });
});

describe("stored credential shapes", () => {
  it("treats a bare xoxp- string as a legacy static token", () => {
    expect(parseStoredToken("  xoxp-123  ")).toBe("xoxp-123");
  });

  it("parses a bundle", () => {
    const parsed = parseStoredToken(JSON.stringify(bundle()));
    expect(typeof parsed).toBe("object");
  });

  it("never treats a non-rotating bundle as expiring", () => {
    expect(needsRefresh(bundle({ expires_at: 0 }), 9e15)).toBe(false);
  });
});

describe("readSlackToken", () => {
  // REGRESSION: users who set up before the PKCE flow hold a hand-pasted
  // xoxp- token. Adding OAuth must not break them, and must not try to
  // refresh a credential that has no refresh semantics.
  it("returns a legacy static token untouched and makes no network call", async () => {
    fakeKeychainStore({ [`${SLACK_TOKEN_SERVICE}|me@taiv.tv`]: "xoxp-legacy" });
    __setSlackOAuthFetch(async () => {
      throw new Error("must not hit the network for a legacy token");
    });
    expect(await readSlackToken("me@taiv.tv")).toBe("xoxp-legacy");
  });

  it("refreshes an expiring bundle and persists the new one", async () => {
    const store = fakeKeychainStore({
      [`${SLACK_TOKEN_SERVICE}|me@taiv.tv`]: JSON.stringify(bundle({ expires_at: 5_000 })),
    });
    __setSlackOAuthFetch(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          authed_user: { access_token: "xoxe.xoxp-fresh", refresh_token: "r2", expires_in: 43_200 },
        }),
        { status: 200 },
      ),
    );
    expect(await readSlackToken("me@taiv.tv", 4_000)).toBe("xoxe.xoxp-fresh");
    const persisted = JSON.parse(store.get(`${SLACK_TOKEN_SERVICE}|me@taiv.tv`)!);
    expect(persisted.access_token).toBe("xoxe.xoxp-fresh");
  });

  it("does not refresh a bundle that is still comfortably valid", async () => {
    fakeKeychainStore({
      [`${SLACK_TOKEN_SERVICE}|me@taiv.tv`]: JSON.stringify(bundle({ expires_at: 9_000_000 })),
    });
    __setSlackOAuthFetch(async () => {
      throw new Error("must not refresh a live token");
    });
    expect(await readSlackToken("me@taiv.tv", 1_000)).toBe("xoxe.xoxp-old");
  });
});
