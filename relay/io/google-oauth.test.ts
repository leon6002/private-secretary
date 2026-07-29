import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __setOAuthFetch,
  clearTokenCache,
  getAccessToken,
  TOKEN_KEYCHAIN_SERVICE,
  type StoredTokenBundle,
} from "./google-oauth.js";
import { __setRunner as __setKeychainRunner } from "./keychain.js";

// In-memory Keychain runner for these tests so we don't touch real secrets.
function fakeKeychainStore(): { store: Map<string, string> } {
  const store = new Map<string, string>();
  __setKeychainRunner(async (args) => {
    const cmd = args[0];
    if (cmd === "find-generic-password") {
      const s = args[args.indexOf("-s") + 1];
      const a = args[args.indexOf("-a") + 1];
      const v = store.get(`${s}|${a}`);
      if (v === undefined) {
        const err = Object.assign(new Error("missing"), {
          code: 44,
          stderr: "could not be found",
        });
        throw err;
      }
      return { stdout: v + "\n", stderr: "" };
    }
    if (cmd === "add-generic-password") {
      const s = args[args.indexOf("-s") + 1];
      const a = args[args.indexOf("-a") + 1];
      const v = args[args.indexOf("-w") + 1];
      store.set(`${s}|${a}`, v!);
      return { stdout: "", stderr: "" };
    }
    throw new Error(`unhandled cmd: ${cmd}`);
  });
  return { store };
}

beforeEach(() => {
  clearTokenCache();
});

afterEach(() => {
  __setOAuthFetch(null);
  __setKeychainRunner(null);
});

function seedBundle(
  store: Map<string, string>,
  bundle: StoredTokenBundle,
): void {
  store.set(`${TOKEN_KEYCHAIN_SERVICE}|${bundle.email}`, JSON.stringify(bundle));
  // OAuth client JSON the bundle points to
  store.set(
    `${bundle.oauth_client_service}|${bundle.oauth_client_account}`,
    JSON.stringify({
      installed: {
        client_id: "test-client",
        client_secret: "test-secret",
        auth_uri: "https://x/auth",
        token_uri: "https://oauth2.googleapis.com/token",
        redirect_uris: ["http://localhost"],
      },
    }),
  );
}

describe("getAccessToken", () => {
  it("returns the cached bundle if access_token is still fresh", async () => {
    const { store } = fakeKeychainStore();
    seedBundle(store, {
      email: "leo@taiv.tv",
      refresh_token: "rt",
      access_token: "at-fresh",
      expires_at: Date.now() + 60 * 60 * 1000, // 1h out
      scope: "gmail.modify calendar.events",
      granted_at: Date.now(),
      oauth_client_service: "taiv-secretary-gcp-A",
      oauth_client_account: "leo@taiv.tv",
    });
    const fetchSpy = vi.fn(async () => {
      throw new Error("fetch should not be called for a fresh token");
    });
    __setOAuthFetch(fetchSpy as unknown as typeof fetch);
    const bundle = await getAccessToken("leo@taiv.tv");
    expect(bundle.access_token).toBe("at-fresh");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refreshes when the access_token is inside the 60s buffer", async () => {
    const { store } = fakeKeychainStore();
    seedBundle(store, {
      email: "leo@taiv.tv",
      refresh_token: "rt-old",
      access_token: "at-old",
      expires_at: Date.now() + 5_000, // 5s out, inside the 60s buffer
      scope: "s",
      granted_at: 0,
      oauth_client_service: "taiv-secretary-gcp-A",
      oauth_client_account: "leo@taiv.tv",
    });
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: "at-new",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "gmail.modify calendar.events",
      }),
    }));
    __setOAuthFetch(fetchSpy as unknown as typeof fetch);
    const bundle = await getAccessToken("leo@taiv.tv");
    expect(bundle.access_token).toBe("at-new");
    expect(bundle.refresh_token).toBe("rt-old"); // unchanged when server doesn't rotate
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("rotates refresh_token when the server returns a new one", async () => {
    const { store } = fakeKeychainStore();
    seedBundle(store, {
      email: "leo@taiv.tv",
      refresh_token: "rt-old",
      access_token: "at-old",
      expires_at: 0,
      scope: "s",
      granted_at: 0,
      oauth_client_service: "taiv-secretary-gcp-A",
      oauth_client_account: "leo@taiv.tv",
    });
    __setOAuthFetch((async () => ({
      ok: true,
      json: async () => ({
        access_token: "at-new",
        refresh_token: "rt-new",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    })) as unknown as typeof fetch);
    const bundle = await getAccessToken("leo@taiv.tv");
    expect(bundle.refresh_token).toBe("rt-new");
  });

  it("propagates upstream HTTP errors during refresh", async () => {
    const { store } = fakeKeychainStore();
    seedBundle(store, {
      email: "leo@taiv.tv",
      refresh_token: "rt",
      access_token: "at",
      expires_at: 0,
      scope: "",
      granted_at: 0,
      oauth_client_service: "taiv-secretary-gcp-A",
      oauth_client_account: "leo@taiv.tv",
    });
    __setOAuthFetch((async () => ({
      ok: false,
      status: 401,
      text: async () => '{"error":"invalid_grant"}',
    })) as unknown as typeof fetch);
    await expect(getAccessToken("leo@taiv.tv")).rejects.toThrow(/HTTP 401/);
  });

  it("evicts the cached bundle on refresh failure so a re-consent recovers without a restart", async () => {
    const { store } = fakeKeychainStore();
    seedBundle(store, {
      email: "leo@taiv.tv",
      refresh_token: "dead",
      access_token: "at",
      expires_at: 0, // forces a refresh
      scope: "",
      granted_at: 0,
      oauth_client_service: "taiv-secretary-gcp-A",
      oauth_client_account: "leo@taiv.tv",
    });
    // 1) refresh fails (token revoked) — must evict the cached (dead) bundle.
    __setOAuthFetch((async () => ({
      ok: false,
      status: 400,
      text: async () => '{"error":"invalid_grant"}',
    })) as unknown as typeof fetch);
    await expect(getAccessToken("leo@taiv.tv")).rejects.toThrow(/HTTP 400/);

    // 2) simulate a re-consent: a FRESH, non-expiring bundle lands in Keychain.
    store.set(
      `${TOKEN_KEYCHAIN_SERVICE}|leo@taiv.tv`,
      JSON.stringify({
        email: "leo@taiv.tv",
        refresh_token: "new",
        access_token: "at-fresh",
        expires_at: Date.now() + 60 * 60 * 1000,
        scope: "gmail.modify",
        granted_at: Date.now(),
        oauth_client_service: "taiv-secretary-gcp-A",
        oauth_client_account: "leo@taiv.tv",
      }),
    );
    // 3) next call re-reads Keychain (cache was evicted) → fresh token, no
    //    refresh needed. Without the eviction it would reuse the dead cached
    //    bundle and fail the (still-failing) refresh again.
    const bundle = await getAccessToken("leo@taiv.tv");
    expect(bundle.access_token).toBe("at-fresh");
  });

  it("persists the refreshed bundle back into Keychain for the next call", async () => {
    const { store } = fakeKeychainStore();
    seedBundle(store, {
      email: "leo@taiv.tv",
      refresh_token: "rt",
      access_token: "at-old",
      expires_at: 0,
      scope: "",
      granted_at: 0,
      oauth_client_service: "taiv-secretary-gcp-A",
      oauth_client_account: "leo@taiv.tv",
    });
    __setOAuthFetch((async () => ({
      ok: true,
      json: async () => ({
        access_token: "at-new",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    })) as unknown as typeof fetch);
    await getAccessToken("leo@taiv.tv");
    const stored = JSON.parse(
      store.get(`${TOKEN_KEYCHAIN_SERVICE}|leo@taiv.tv`)!,
    ) as StoredTokenBundle;
    expect(stored.access_token).toBe("at-new");
    expect(stored.expires_at).toBeGreaterThan(Date.now());
  });
});
