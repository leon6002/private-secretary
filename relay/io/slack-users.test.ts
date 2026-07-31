import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickSlackUserName, resolveSlackUserNames } from "./slack-users.js";
import type { SlackClient, SlackUser } from "./slack-api.js";

let dir: string;
let cachePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "slack-users-"));
  cachePath = join(dir, "slack-users.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function clientWith(users: Record<string, SlackUser | Error>): SlackClient {
  return {
    usersInfo: vi.fn(async (id: string) => {
      const u = users[id];
      if (u instanceof Error) throw u;
      if (!u) throw new Error("users_not_found");
      return u;
    }),
  } as unknown as SlackClient;
}

describe("pickSlackUserName", () => {
  it("prefers profile.display_name → profile.real_name → real_name → name", () => {
    expect(
      pickSlackUserName({
        id: "U1",
        name: "zackh",
        real_name: "Zack Huang",
        profile: { display_name: "Zack", real_name: "Zack Huang" },
      }),
    ).toBe("Zack");
    expect(
      pickSlackUserName({ id: "U1", name: "zackh", real_name: "Zack Huang", profile: { real_name: "Zack Huang" } }),
    ).toBe("Zack Huang");
    expect(pickSlackUserName({ id: "U1", name: "zackh", real_name: "Zack Huang" })).toBe("Zack Huang");
    expect(pickSlackUserName({ id: "U1", name: "zackh" })).toBe("zackh");
    expect(pickSlackUserName({ id: "U1" })).toBe("");
  });
});

describe("resolveSlackUserNames", () => {
  it("fetches uncached ids and persists them to the cache file", async () => {
    const client = clientWith({ U1: { id: "U1", profile: { display_name: "Zack" } } });
    const names = await resolveSlackUserNames(client, ["U1"], cachePath);
    expect(names.get("U1")).toBe("Zack");
    const onDisk = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, { name: string }>;
    expect(onDisk["U1"]?.name).toBe("Zack");
  });

  it("serves fresh entries from cache without calling users.info", async () => {
    writeFileSync(
      cachePath,
      JSON.stringify({ U1: { name: "Zack", at: Date.now() } }),
      "utf8",
    );
    const client = clientWith({});
    const names = await resolveSlackUserNames(client, ["U1"], cachePath);
    expect(names.get("U1")).toBe("Zack");
    expect(client.usersInfo).not.toHaveBeenCalled();
  });

  it("re-fetches after the 24h TTL", async () => {
    const now = Date.now();
    writeFileSync(
      cachePath,
      JSON.stringify({ U1: { name: "Old Name", at: now - 25 * 60 * 60 * 1000 } }),
      "utf8",
    );
    const client = clientWith({ U1: { id: "U1", profile: { display_name: "New Name" } } });
    const names = await resolveSlackUserNames(client, ["U1"], cachePath);
    expect(names.get("U1")).toBe("New Name");
    expect(client.usersInfo).toHaveBeenCalledTimes(1);
  });

  it("tolerates a missing or corrupt cache file", async () => {
    writeFileSync(cachePath, "{not json", "utf8");
    const client = clientWith({ U1: { id: "U1", name: "zackh" } });
    const names = await resolveSlackUserNames(client, ["U1"], cachePath);
    expect(names.get("U1")).toBe("zackh");
    // corrupt file replaced with a valid one
    expect(() => JSON.parse(readFileSync(cachePath, "utf8"))).not.toThrow();
  });

  it("treats an empty name as a miss: not returned, cached briefly (1h), then retried", async () => {
    const now = Date.now();
    const client = clientWith({ U1: { id: "U1" } }); // no name fields at all
    const first = await resolveSlackUserNames(client, ["U1"], cachePath);
    expect(first.size).toBe(0);
    expect(client.usersInfo).toHaveBeenCalledTimes(1);

    // within the miss TTL → cached miss, no new API call
    const second = await resolveSlackUserNames(client, ["U1"], cachePath);
    expect(second.size).toBe(0);
    expect(client.usersInfo).toHaveBeenCalledTimes(1);

    // past the miss TTL (but well inside the 24h name TTL) → re-fetch
    writeFileSync(
      cachePath,
      JSON.stringify({ U1: { name: "", at: now - 2 * 60 * 60 * 1000 } }),
      "utf8",
    );
    const third = await resolveSlackUserNames(client, ["U1"], cachePath);
    expect(third.size).toBe(0);
    expect(client.usersInfo).toHaveBeenCalledTimes(2);
  });

  it("a per-id fetch error is swallowed and not cached (retried next tick)", async () => {
    const client = clientWith({
      U1: new Error("ratelimited"),
      U2: { id: "U2", name: "kevin" },
    });
    const names = await resolveSlackUserNames(client, ["U1", "U2"], cachePath);
    expect(names.has("U1")).toBe(false);
    expect(names.get("U2")).toBe("kevin");
    const onDisk = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, unknown>;
    expect(onDisk["U1"]).toBeUndefined();
  });

  it("dedupes ids and resolves nothing for an empty list", async () => {
    const client = clientWith({ U1: { id: "U1", name: "zackh" } });
    await resolveSlackUserNames(client, ["U1", "U1", "U1"], cachePath);
    expect(client.usersInfo).toHaveBeenCalledTimes(1);
    const names = await resolveSlackUserNames(client, [], cachePath);
    expect(names.size).toBe(0);
  });
});
