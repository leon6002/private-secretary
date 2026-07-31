// Slack display-name cache. Slack messages carry only user IDs (U0BLSL2NZ54)
// and the pipeline used the raw ID as the sender name everywhere; this module
// resolves IDs → display names via users.info and persists them on disk so the
// daemon pays at most one API call per user per TTL window.
//
// Names are COSMETIC (cockpit card headers, provenance lines) — every failure
// mode here is silent: a missing/corrupt cache file, a users.info error, or a
// user with no name all degrade to "no name", and the caller falls back to the
// raw ID.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SlackClient, SlackUser } from "./slack-api.js";

// Resolved names are stable for practical purposes — a day is fresh enough.
const NAME_TTL_MS = 24 * 60 * 60 * 1000;
// A user with NO usable name would otherwise be re-fetched on every tick
// forever. Cache the miss too, but briefly, so a profile update shows up
// within the hour instead of a day.
const MISS_TTL_MS = 60 * 60 * 1000;

interface CacheEntry {
  name: string; // "" = known miss (user has no display/real/username)
  at: number; // epoch ms when this entry was fetched
}

// The display-name pick. Matches Slack's own fallback chain: the user's chosen
// display name, then their real name, then the legacy username.
export function pickSlackUserName(u: SlackUser): string {
  return u.profile?.display_name || u.profile?.real_name || u.real_name || u.name || "";
}

function loadCache(cachePath: string): Record<string, CacheEntry> {
  try {
    if (!existsSync(cachePath)) return {};
    const raw = JSON.parse(readFileSync(cachePath, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    return raw as Record<string, CacheEntry>;
  } catch {
    return {}; // corrupt file → start over; entries re-fetch on next tick
  }
}

// Atomic-ish write mirroring io/state.ts: tmp + rename so a concurrent reader
// (or a crash mid-write) sees old-or-new bytes, never a torn file.
function saveCache(cachePath: string, cache: Record<string, CacheEntry>): void {
  mkdirSync(dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf8");
  renameSync(tmp, cachePath);
}

// Resolve display names for the given Slack user IDs. Returns a Map of only
// the ids that resolved to a non-empty name. Cache hits (fresh per TTL) skip
// the API entirely; misses are fetched one users.info call per uncached id,
// with per-id errors swallowed.
export async function resolveSlackUserNames(
  client: SlackClient,
  ids: string[],
  cachePath: string,
  now: () => number = Date.now,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return out;

  const cache = loadCache(cachePath);
  let dirty = false;
  for (const id of unique) {
    const hit = cache[id];
    if (hit) {
      const ttl = hit.name ? NAME_TTL_MS : MISS_TTL_MS;
      if (now() - hit.at < ttl) {
        if (hit.name) out.set(id, hit.name);
        continue;
      }
    }
    try {
      const name = pickSlackUserName(await client.usersInfo(id));
      cache[id] = { name, at: now() };
      dirty = true;
      if (name) out.set(id, name);
    } catch {
      // Cosmetic only — leave uncached so a transient API error retries next tick.
    }
  }
  if (dirty) saveCache(cachePath, cache);
  return out;
}
