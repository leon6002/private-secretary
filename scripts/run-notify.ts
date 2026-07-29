#!/usr/bin/env -S npx tsx
// Notification daemon — the reactive engine. Each source runs on its OWN
// cadence (decoupled), all feeding the same draft → queue → cockpit pipeline:
//   WeChat : local-DB poll (recent-sessions unread + chat-history), fast — near-real-time
//   Gmail  : delta poll per mailbox (historyId), medium
//   Slack  : conversations.history poll, slow (Slack has no DM push + rate limits)
// An in-process mutex serializes ticks so they never contend on the state lock.
// Cursors must already be seeded to "now" (scripts/seed-cursors-now.ts) so the
// daemon only surfaces messages that arrive from here on.
//
//   npx tsx scripts/run-notify.ts [--state p] [--personas p]
//     [--wechat-ms 10000] [--gmail-ms 180000] [--slack-ms 600000] [--max-draft N]

import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describeIdentity } from "../relay/io/identity.js";
import { dirname, resolve } from "node:path";
import { runScanTick, type ScanLoopResult } from "../relay/proc/scan-loop.js";
import { notify } from "../relay/proc/notify.js";
import { loadPersonas } from "../relay/io/personas.js";
import { buildPersonaResolver, type DraftDeps } from "../relay/proc/draft.js";
import { loadProjects, loadLeoProfile } from "../relay/io/projects.js";
import { renderProjectCatalog } from "../relay/core/project.js";
import { createAnthropicLlmCaller, createAnthropicJsonCaller } from "../relay/proc/llm-anthropic.js";
import { createClaudeCliLlmCaller, createClaudeCliJsonCaller } from "../relay/proc/llm-claude-cli.js";
import type { ConsolidateDeps } from "../relay/proc/consolidate.js";
import type { RefreshDeps } from "../relay/proc/refresh.js";
import type { PlanDeps } from "../relay/proc/plan.js";
import type { PersonaUpdateDeps } from "../relay/proc/persona-update.js";
import { wechatDecodeImage, wechatHistory } from "../relay/io/wechat-cli.js";
import { createSlackClientFromKeychain, SLACK_ACCOUNTS, type SlackClient } from "../relay/io/slack-api.js";
import { GmailClient, getHeader } from "../relay/io/gmail-api.js";
import { extractText } from "../relay/sources/gmail-direct.js";
import { KNOWN_MAILBOXES } from "../relay/io/google-oauth.js";
import type { InboundMessage, Persona } from "../relay/core/types.js";
import type { ActionItem } from "../relay/core/action-item.js";

// Decode a message's image attachments to local file paths the LLM can read.
// WeChat: decode_image (the V2 AES image key must be in the decrypt config).
// A decode that throws/times out is skipped — the draft proceeds text-only.
// Slack/Gmail vision is not wired yet (their byte-fetch differs).
async function resolveImages(m: InboundMessage): Promise<string[]> {
  if (m.platform !== "wechat") return [];
  const imgs = (m.attachments ?? []).filter((a) => a.kind === "image");
  const paths: string[] = [];
  for (const a of imgs) {
    try {
      const out = await wechatDecodeImage(m.senderHandle, Number(a.id));
      const match = out.match(/\/[^\s"']+\.(?:jpg|jpeg|png|gif|webp)/i);
      if (match && existsSync(match[0])) paths.push(match[0]);
    } catch {
      /* skip this image — draft text-only */
    }
  }
  return paths;
}

type Source = "wechat" | "gmail" | "slack";

function num(flag: string, def: number): number {
  const i = process.argv.indexOf(flag);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : def;
}
function str(flag: string, def: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
}

const statePath = resolve(str("--state", resolve(process.cwd(), "state/loop-state.json")));
const personaDir = resolve(str("--personas", resolve(process.cwd(), "personas")));
// 3-layer RAG sources (local-only, gitignored). projects = the project layer;
// leoProfile = how Leo decides + his own durable facts/assets (house, logistics).
const projectsDir = resolve(str("--projects", resolve(process.cwd(), "projects/_staged")));
const leoProfilePath = resolve(process.cwd(), "projects/LEO-DECISION-PROFILE.md");
const leoFactsPath = resolve(process.cwd(), "projects/LEO-FACTS.md");
const intervals: Record<Source, number> = {
  wechat: num("--wechat-ms", 10_000),
  gmail: num("--gmail-ms", 180_000),
  slack: num("--slack-ms", 600_000),
};
const maxDraft = num("--max-draft", 20);
// Drafting backend: "cli" (Claude Code subscription via `claude -p`, no API
// spend — the current default, temporarily standing in for the API) or "api"
// (the Anthropic API path). Override with --llm api.
const llmMode = str("--llm", "cli");
const draftModel = str("--draft-model", "opus");
const visionEnabled = process.argv.includes("--vision");
// Task consolidation (specs/task-consolidation.md, Stage 1): group open cards
// that are the same real-world task. ON by default; --no-consolidate opts out.
const consolidateEnabled = !process.argv.includes("--no-consolidate");
// Task refresh (specs/task-consolidation.md, Stage 2): re-read the full thread
// for conversations with an open card + emit calendar actions on agreed meetings.
// ON by default; --no-refresh opts out. --refresh-ttl-min overrides the cooldown.
const refreshEnabled = !process.argv.includes("--no-refresh");
const refreshTtlMin = num("--refresh-ttl-min", 10);
// How many open conversations to re-read per scan. The default cap of 3 meant a
// full inbox of ~7 open cards took ~3 scans (~90 min) to all catch up. Cover the
// whole open set each scan so every card tracks its latest reply within one cycle.
const refreshMaxPerTick = num("--refresh-max", 12);
const heartbeatPath = `${dirname(statePath)}/notify-heartbeat.json`;
const daemonLockPath = `${dirname(statePath)}/run-notify.pid`;

// Single-instance guard. Parallel Claude sessions kept launching duplicate daemons
// that raced the shared state file (cost real work on 2026-06-28). Refuse to start
// if another run-notify is alive; reclaim a stale lock (PID dead). Returns false →
// caller exits 0 (clean, so launchd KeepAlive=SuccessfulExit doesn't hammer-respawn).
function acquireDaemonLock(): boolean {
  try {
    if (existsSync(daemonLockPath)) {
      const pid = Number(readFileSync(daemonLockPath, "utf8").trim());
      if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) {
        try {
          process.kill(pid, 0); // signal 0 = liveness probe; throws if gone
          // Liveness alone is NOT enough: after a kill -9 the lockfile survives, and
          // the OS eventually REUSES that pid for some unrelated process — then this
          // guard would refuse to start forever ("daemon keeps not running"). Confirm
          // the pid is really a run-notify before yielding to it.
          const cmd = execFileSync("/bin/ps", ["-o", "command=", "-p", String(pid)], {
            encoding: "utf8",
          });
          if (cmd.includes("run-notify")) return false; // genuinely another instance
          /* pid reused by something else — stale lock, reclaim below */
        } catch {
          /* no such process — stale lock, reclaim below */
        }
      }
    }
    writeFileSync(daemonLockPath, String(process.pid));
    return true;
  } catch {
    return true; // a lockfile fs hiccup shouldn't hard-block the daemon
  }
}
function releaseDaemonLock(): void {
  try {
    if (existsSync(daemonLockPath) && readFileSync(daemonLockPath, "utf8").trim() === String(process.pid))
      unlinkSync(daemonLockPath);
  } catch {
    /* best-effort */
  }
}

async function buildDraft(): Promise<DraftDeps | undefined> {
  try {
    const llm =
      llmMode === "api"
        ? await createAnthropicLlmCaller()
        : createClaudeCliLlmCaller({ model: draftModel });
    const personas = loadPersonas(personaDir);
    const { resolve: resolvePersona, keys } = buildPersonaResolver(personas);
    // 3-layer RAG: project layer + Leo's decision profile, with his own durable
    // facts/assets appended so a message about his house/logistics has grounding.
    const projects = loadProjects(projectsDir);
    const decisionProfile = loadLeoProfile(leoProfilePath);
    const facts = loadLeoProfile(leoFactsPath).trim();
    const leoProfile = facts
      ? `${decisionProfile}\n\n## LEO'S OWN FACTS / ASSETS (durable; use when a message concerns Leo's house, assets, or family logistics):\n${facts}`
      : decisionProfile;
    console.log(
      `[notify] drafting enabled via ${llmMode}${llmMode === "cli" ? ` (model=${draftModel})` : ""} (${keys.length} personas, ${projects.length} projects, leo-profile ${decisionProfile.trim() ? "on" : "off"})`,
    );
    // Vision is OPT-IN (--vision) and cli-only (claude -p reads the staged image
    // via Read; the API caller has no image blocks yet). Off by default because
    // decode_image can HANG to its full timeout, and that stalls the whole tick
    // (and holds the state lock) — only enable once decode is reliable.
    const vision = visionEnabled && llmMode === "cli" ? { resolveImages } : {};
    if (visionEnabled && llmMode === "cli") console.log("[notify] image vision ENABLED (cli)");
    return { llm, resolvePersona, knownPersonaKeys: keys, projects, leoProfile: leoProfile.trim() || undefined, personas, fetchRelatedThread, ...vision };
  } catch (e) {
    console.log(`[notify] drafting DISABLED — ${(e as Error).message.split("\n")[0]}`);
    return undefined;
  }
}

// ── Stage-2 thread re-read (specs/task-consolidation.md). Per-platform readers,
// lazily built. fetchThread returns the recent thread text (both sides, newest
// last) for a card's conversation, or null when unavailable → that conversation
// is skipped this tick.
// Slack clients + self-ids cached per workspace account (Taiv, OSYX, …).
const slackClients = new Map<string, Promise<SlackClient>>();
const slackSelves = new Map<string, Promise<string>>();
function slackClientForAccount(account: string): Promise<SlackClient> {
  let p = slackClients.get(account);
  if (!p) { p = createSlackClientFromKeychain({}, account); slackClients.set(account, p); }
  return p;
}
function slackSelfForAccount(account: string): Promise<string> {
  let p = slackSelves.get(account);
  if (!p) {
    p = slackClientForAccount(account).then((c) => c.authTest()).then((a) => a.user_id);
    slackSelves.set(account, p);
  }
  return p;
}
const gmailClients = new Map<string, GmailClient>();
function gmailClientFor(email: string): GmailClient {
  let c = gmailClients.get(email);
  if (!c) { c = new GmailClient({ email }); gmailClients.set(email, c); }
  return c;
}

async function fetchThread(card: ActionItem): Promise<string | null> {
  const prefix = card.source_message_id.split(":")[0];
  try {
    if (prefix === "wechat") {
      const name = card.context?.sender_handle;
      if (!name) return null;
      // Refresh asks "did the conversation move on since this card?" — so it MUST
      // see the latest messages. The default order (no oldest_first, no start) is
      // newest-anchored: the server returns the most-recent `limit` messages, sorted
      // chronologically within that window. Two earlier bugs this avoids:
      //   • `oldest_first:true` with no start re-anchored on the chat's very first
      //     messages (the 古龙换汇 bug);
      //   • `oldest_first:true` + a start floor returns the OLDEST N from the floor,
      //     which TRUNCATES the newest messages in a busy conversation — so 詹毅's
      //     07-06 Damon update was cut off and the card stayed stale.
      // Newest-anchored always includes the latest reply, whatever the volume.
      return await wechatHistory(name, { limit: 60 });
    }
    if (prefix === "slack") {
      const channel = card.source_message_id.split(":")[1];
      if (!channel) return null;
      // The card doesn't record WHICH workspace it came from (the message id is
      // just slack:<channel>:<ts>), so probe each configured account — the
      // workspace that owns this channel returns history, the others throw
      // channel_not_found. First hit wins. So OSYX cards refresh too, not just Taiv.
      for (const { account } of SLACK_ACCOUNTS) {
        try {
          const client = await slackClientForAccount(account);
          const self = await slackSelfForAccount(account);
          const r = await client.conversationsHistory({ channel, limit: 40 });
          if (!r.messages || r.messages.length === 0) continue;
          const ordered = [...r.messages].reverse(); // oldest-first for reading
          const lines: string[] = [];
          for (const m of ordered) {
            lines.push(`${m.user === self ? "me" : (m.user ?? "?")}: ${m.text ?? ""}`);
            // Pull thread REPLIES too — conversations.history returns only top-level
            // messages, so a decision made in a thread (e.g. a meeting time confirmed
            // in a reply: "That works for me") is otherwise invisible to the refresh.
            const rc = (m as { reply_count?: number }).reply_count ?? 0;
            if (rc > 0 && m.ts) {
              try {
                const rep = await client.conversationsReplies({ channel, ts: m.ts, limit: 30 });
                for (const t of (rep.messages ?? []).slice(1)) // slice(1): skip the parent (already added)
                  lines.push(`  ↳ ${t.user === self ? "me" : (t.user ?? "?")}: ${t.text ?? ""}`);
              } catch {
                /* replies unavailable for this parent → skip */
              }
            }
          }
          return lines.join("\n");
        } catch {
          /* not this workspace (channel_not_found) → try the next account */
        }
      }
      return null;
    }
    if (prefix === "gmail") {
      const threadId = card.context?.thread_ref;
      if (!threadId) return null; // legacy card without the thread locator
      const mailbox = typeof card.params?.mailbox === "string" ? card.params.mailbox : KNOWN_MAILBOXES[0]!;
      const t = await gmailClientFor(mailbox).getThread({ id: threadId, format: "full" });
      return (t.messages ?? [])
        .map((m) => `From ${getHeader(m.payload, "From") ?? "?"}:\n${extractText(m)}`)
        .join("\n---\n");
    }
  } catch {
    return null; // reader unavailable / fetch failed → skip this conversation
  }
  return null;
}

// P10 multi-party: a mentioned third party's recent conversation, by persona handle
// — so a decision with one person can inform + act on another. Recency-windowed,
// best-effort (null when unavailable). WeChat (by chat name), Slack (DM via the IM
// map, probing each workspace), Gmail (newest thread with that email). The slack IM
// map (user id → DM channel) is cached per account so it's listed once.
const slackImMaps = new Map<string, Promise<Map<string, string>>>();
function slackImMap(account: string): Promise<Map<string, string>> {
  let p = slackImMaps.get(account);
  if (!p) {
    p = slackClientForAccount(account)
      .then((c) => c.listAllConversations({ types: "im" }))
      .then((ims) => {
        const m = new Map<string, string>();
        for (const im of ims) {
          const u = (im as { user?: string }).user;
          if (u && im.id) m.set(u, im.id);
        }
        return m;
      })
      .catch(() => new Map<string, string>());
    slackImMaps.set(account, p);
  }
  return p;
}

async function fetchRelatedThread(p: Persona): Promise<string | null> {
  try {
    if (p.handles?.wechat) {
      const start = new Date(Date.now() - 14 * 24 * 3600_000).toISOString().slice(0, 10);
      return await wechatHistory(p.displayName, { limit: 30, oldestFirst: true, start });
    }
    if (p.handles?.slack) {
      const userId = p.handles.slack;
      for (const { account } of SLACK_ACCOUNTS) {
        const channel = (await slackImMap(account)).get(userId);
        if (!channel) continue;
        const self = await slackSelfForAccount(account);
        const r = await (await slackClientForAccount(account)).conversationsHistory({ channel, limit: 25 });
        if (!r.messages || r.messages.length === 0) continue;
        return [...r.messages]
          .reverse()
          .map((m) => `${m.user === self ? "me" : "them"}: ${m.text ?? ""}`)
          .join("\n");
      }
      return null;
    }
    if (p.handles?.gmail) {
      const mailbox = KNOWN_MAILBOXES[0]!;
      const list = await gmailClientFor(mailbox).messagesList({
        q: `from:${p.handles.gmail} OR to:${p.handles.gmail}`,
        maxResults: 1,
      });
      const tid = list.messages?.[0]?.threadId;
      if (!tid) return null;
      const t = await gmailClientFor(mailbox).getThread({ id: tid, format: "full" });
      return (t.messages ?? [])
        .map((m) => `From ${getHeader(m.payload, "From") ?? "?"}:\n${extractText(m)}`)
        .join("\n---\n");
    }
  } catch {
    /* reader unavailable → skip this third party */
  }
  return null;
}

async function buildRefresh(): Promise<RefreshDeps | undefined> {
  if (!refreshEnabled) return undefined;
  try {
    const llm =
      llmMode === "api" ? await createAnthropicLlmCaller() : createClaudeCliLlmCaller({ model: draftModel });
    const { resolve: resolvePersona } = buildPersonaResolver(loadPersonas(personaDir));
    const projectCatalog = renderProjectCatalog(loadProjects(projectsDir));
    console.log(`[notify] task refresh enabled via ${llmMode} (TTL ${refreshTtlMin}min)`);
    return { llm, resolvePersona, fetchThread, projectCatalog, ttlMs: refreshTtlMin * 60_000, maxPerTick: refreshMaxPerTick };
  } catch (e) {
    console.log(`[notify] refresh DISABLED — ${(e as Error).message.split("\n")[0]}`);
    return undefined;
  }
}

async function buildConsolidate(): Promise<ConsolidateDeps | undefined> {
  if (!consolidateEnabled) return undefined;
  try {
    const json =
      llmMode === "api" ? await createAnthropicJsonCaller() : createClaudeCliJsonCaller({ model: draftModel });
    console.log(`[notify] task consolidation enabled via ${llmMode}`);
    return { json };
  } catch (e) {
    console.log(`[notify] consolidation DISABLED — ${(e as Error).message.split("\n")[0]}`);
    return undefined;
  }
}

async function buildPlan(): Promise<PlanDeps | undefined> {
  if (process.argv.includes("--no-plan")) return undefined;
  try {
    const json =
      llmMode === "api" ? await createAnthropicJsonCaller() : createClaudeCliJsonCaller({ model: draftModel });
    console.log(`[notify] daily plan (ranking) enabled via ${llmMode}`);
    return { json };
  } catch (e) {
    console.log(`[notify] plan DISABLED — ${(e as Error).message.split("\n")[0]}`);
    return undefined;
  }
}

async function buildPersonaUpdate(): Promise<PersonaUpdateDeps | undefined> {
  if (process.argv.includes("--no-persona-update")) return undefined;
  try {
    const json =
      llmMode === "api" ? await createAnthropicJsonCaller() : createClaudeCliJsonCaller({ model: draftModel });
    const { resolve: resolvePersona } = buildPersonaResolver(loadPersonas(personaDir));
    console.log(`[notify] persona commitments update enabled via ${llmMode}`);
    return { json, resolvePersona, fetchThread, personaDir };
  } catch (e) {
    console.log(`[notify] persona update DISABLED — ${(e as Error).message.split("\n")[0]}`);
    return undefined;
  }
}

// In-process mutex: only one tick runs at a time (so ticks never collide on
// the state file lock, regardless of which timer fires).
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(() => undefined, () => undefined);
  return run as Promise<T>;
}

async function main(): Promise<void> {
  mkdirSync(dirname(statePath), { recursive: true });
  if (!acquireDaemonLock()) {
    console.log(`[notify] another run-notify instance is already running (see ${daemonLockPath}); exiting cleanly.`);
    process.exit(0);
  }
  console.log(`[notify] state=${statePath}`);
  console.log(`[notify] ${describeIdentity()}`);
  console.log(`[notify] cadence: wechat=${intervals.wechat / 1000}s gmail=${intervals.gmail / 1000}s slack=${intervals.slack / 1000}s`);
  const draft = await buildDraft();
  const consolidate = await buildConsolidate();
  const refresh = await buildRefresh();
  const plan = await buildPlan();
  const personaUpdate = await buildPersonaUpdate();

  let consecutiveErrors = 0;

  const tick = (source: Source): Promise<void> =>
    serialize(async () => {
      try {
        const r: ScanLoopResult = await runScanTick({
          statePath,
          sources: [source],
          draft,
          consolidate,
          refresh,
          plan,
          personaUpdate,
          maxDraftCandidates: maxDraft,
        });
        if (r.totalInbound > 0 || r.drafted > 0) {
          console.log(
            `[notify:${source}] inbound=${r.totalInbound} triggered=${r.totalTriggered} drafted=${r.drafted} (${r.durationMs}ms)`,
          );
        }
        writeFileSync(
          heartbeatPath,
          JSON.stringify({ source, atMs: r.startedAtMs, drafted: r.drafted, durationMs: r.durationMs }),
        );
        consecutiveErrors = 0;
      } catch (e) {
        console.error(`[notify:${source}] ERROR: ${(e as Error).message}`);
        if (++consecutiveErrors === 5) {
          void notify({ title: "Secretary notify failing", body: (e as Error).message.slice(0, 200) });
        }
      }
    });

  // Stagger the initial ticks so they don't queue up at once; then interval.
  const sources: Source[] = ["wechat", "gmail", "slack"];
  sources.forEach((s, i) => {
    setTimeout(() => void tick(s), i * 2000);
    setInterval(() => void tick(s), intervals[s]);
  });

  const shutdown = (sig: string): void => {
    console.log(`[notify] ${sig} — shutting down`);
    releaseDaemonLock();
    process.exit(0);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("exit", releaseDaemonLock);
  setInterval(() => {}, 1 << 30).unref();
}

main().catch((e) => {
  console.error("[notify] crashed:", (e as Error).message);
  process.exit(1);
});
