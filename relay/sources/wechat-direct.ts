// WeChat detection source for the notification loop.
//
// DETECTION MODEL (the get_new_messages digest was RETIRED — it was lossy and
// direction-blind, which produced four separate bugs; see specs / git history):
//   1. get_recent_sessions gives every session WITH ITS UNREAD COUNT. unread>0
//      means the contact sent messages Leo hasn't read = awaiting Leo. Leo's OWN
//      sends never raise unread, so they never trigger (fixes "drafted a reply to
//      my own message"). Already-read messages don't trigger either — that's the
//      intent: unread IS the open ask.
//   2. For each unread 1:1, get_chat_history pulls the ACTUAL recent messages,
//      which are DIRECTION-MARKED (the sender label is the contact for incoming,
//      Leo for outgoing) and give full multi-message context (not just the latest
//      one-line preview), plus image refs. We keep only the incoming unread
//      messages and combine them into one InboundMessage.
//
// Groups ([群] / @placeholder_foldgroup) and family (乐乐 / 郑建明) are dropped —
// the queue is person-to-person work only.
//
// Message content is UNTRUSTED DATA (prompt-injection guard) — never instructions.
//
// IMAGES: surfaced as refs (attachments: local_id=N) so the draft prompt flags
// "the point may be in here". Actually feeding the pixels to the model needs
// vision support in anthropic-api.ts (not wired for ANY source yet) — separate
// follow-up; decoding without a vision path would be wasted work.

import type { Attachment, InboundMessage } from "../core/types.js";

// Family contacts to exclude (personal, not for the work queue).
export const WECHAT_FAMILY = ["乐乐", "郑建明"];

// ─── get_recent_sessions parsing ─────────────────────────────────────
// Format (mcp_server.get_recent_sessions):
//   最近 N 个会话:
//
//   [MM-DD HH:MM] <name>[ [群]][ (U条未读)]
//     <type>: [<group-sender>: ]<summary>
// We read ONLY the head line (the indented "  type: content" detail line and the
// "最近 N" header don't match and are skipped).
export interface RecentSession {
  name: string;
  isGroup: boolean;
  unread: number;
  tsMs: number; // latest-message time (minute precision)
}

const SESSION_HEAD_RE =
  /^\[(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})\]\s+(.+?)(\s\[群\])?(?:\s\((\d+)条未读\))?$/;

export function parseRecentSessions(text: string, nowMs: number): RecentSession[] {
  if (!text) return [];
  const out: RecentSession[] = [];
  const now = new Date(nowMs);
  for (const raw of text.split("\n")) {
    const m = SESSION_HEAD_RE.exec(raw.trim());
    if (!m) continue;
    const [, mo, dd, hh, mm, rawName, groupTag, unreadStr] = m;
    const name = rawName!.trim();
    // [MM-DD HH:MM] carries no year; assume the current one, roll back a year if
    // that lands in the future.
    const d = new Date(now.getFullYear(), Number(mo) - 1, Number(dd), Number(hh), Number(mm), 0, 0);
    if (d.getTime() > nowMs) d.setFullYear(d.getFullYear() - 1);
    out.push({
      name,
      isGroup: !!groupTag || name === "@placeholder_foldgroup",
      unread: unreadStr ? Number(unreadStr) : 0,
      tsMs: d.getTime(),
    });
  }
  return out;
}

// ─── get_chat_history parsing ────────────────────────────────────────
// Each line: "[YYYY-MM-DD HH:MM] <sender>: <text>" (sender omitted when unknown).
// In a 1:1 the sender label is the CONTACT's display name for incoming and Leo's
// for outgoing, so incoming === (label === contactName). Images render as
// "[图片] (local_id=N, ts=T)".
export interface HistoryMsg {
  tsMs: number;
  isIncoming: boolean;
  text: string;
  imageLocalIds: number[];
}

const HIST_RE = /^\[(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})\]\s+(.*)$/;

export function parseChatHistory(text: string, contactName: string): HistoryMsg[] {
  if (!text) return [];
  const out: HistoryMsg[] = [];
  for (const raw of text.split("\n")) {
    const m = HIST_RE.exec(raw.trim());
    if (!m) continue;
    const [, y, mo, dd, hh, mm, rest] = m;
    let isIncoming = false;
    let body = rest!;
    const sep = rest!.indexOf(": ");
    if (sep > 0) {
      // The first ": " splits the sender label from the text; a 1:1 name never
      // contains ": ", so this is unambiguous.
      isIncoming = rest!.slice(0, sep) === contactName;
      body = rest!.slice(sep + 2);
    }
    const imageLocalIds: number[] = [];
    const img = /\[图片\].*?local_id=(\d+)/.exec(body);
    if (img) imageLocalIds.push(Number(img[1]));
    out.push({
      tsMs: new Date(Number(y), Number(mo) - 1, Number(dd), Number(hh), Number(mm), 0, 0).getTime(),
      isIncoming,
      text: body.trim(),
      imageLocalIds,
    });
  }
  return out;
}

// ─── official-account (公众号/服务号) detection ───────────────────────
// get_recent_sessions only gives display names, but get_contacts lists the
// wxid — and official/marketing accounts (公众号) have a `gh_` wxid prefix
// (mcp_server.py). Parse get_contacts into the set of display names (备注 +
// 昵称) belonging to gh_ accounts, so the scan can drop their broadcasts
// (recruiting links, promos) that aren't person-to-person work.
//
// get_contacts line: "<wxid>[  备注: <remark>][  昵称: <nick>]"
export function parseOfficialAccountNames(contactsText: string): Set<string> {
  const names = new Set<string>();
  for (const raw of contactsText.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("gh_")) continue;
    for (const part of line.split(/\s{2,}/)) {
      const m = /^(?:备注|昵称):\s*(.+)$/.exec(part);
      if (m) names.add(m[1]!.trim());
    }
  }
  return names;
}

// ─── the scan ────────────────────────────────────────────────────────
// How many extra prior messages (beyond the unread) to pull for thread context.
const CONTEXT_LOOKBACK = 6;

export interface WechatInboxOptions {
  // get_recent_sessions text (injectable for tests; prod passes wechatSessions).
  fetchSessions: () => Promise<string>;
  // get_chat_history text for one contact (injectable; prod passes wechatHistory).
  fetchHistory: (name: string, limit: number) => Promise<string>;
  nowMs: number;
  excludeNames?: string[];
  // Display names of 公众号/服务号 (gh_ accounts) to drop — built via
  // parseOfficialAccountNames(get_contacts). Their broadcasts aren't 1:1 work.
  officialNames?: Set<string>;
  historyCap?: number; // max messages to pull per session (default 20)
}

// One InboundMessage per unread 1:1 session, carrying the combined incoming
// unread messages. Cross-tick/restart dedup is the scan loop's job (it keeps
// only ids that are new vs the persisted marks).
export async function scanWechatInbox(
  opts: WechatInboxOptions,
): Promise<{ inbound: InboundMessage[]; sessions: RecentSession[] }> {
  const sessions = parseRecentSessions(await opts.fetchSessions(), opts.nowMs);
  const exclude = opts.excludeNames ?? WECHAT_FAMILY;
  const cap = opts.historyCap ?? 20;
  const candidates = sessions.filter(
    (s) =>
      !s.isGroup &&
      s.unread > 0 &&
      !exclude.some((f) => s.name.includes(f)) &&
      !opts.officialNames?.has(s.name),
  );
  const inbound: InboundMessage[] = [];
  for (const s of candidates) {
    // Pull the unread PLUS a few prior messages for conversation context (so the
    // draft isn't a reply to a lone line ripped out of its thread).
    const limit = Math.min(cap, Math.max(s.unread + CONTEXT_LOOKBACK, 6));
    const history = parseChatHistory(await opts.fetchHistory(s.name, limit), s.name);
    const incoming = history.filter((m) => m.isIncoming);
    if (incoming.length === 0) continue; // latest run was Leo's own → nothing to do
    const unread = incoming.slice(-s.unread);
    const combined = unread.map((m) => m.text).filter(Boolean).join("\n");
    if (!combined) continue; // image/voice-only with no text → nothing to draft from yet
    const latest = unread[unread.length - 1]!;
    // Background context: the recent thread, both sides, labelled (我 = Leo).
    const threadContext = history
      .map((m) => `${m.isIncoming ? s.name : "我"}: ${m.text}`)
      .join("\n");
    const attachments: Attachment[] = unread
      .flatMap((m) => m.imageLocalIds)
      .map((id) => ({ id: String(id), kind: "image", name: `wechat-image local_id=${id}` }));
    inbound.push({
      id: `wechat:${s.name}:${latest.tsMs}`,
      platform: "wechat",
      senderHandle: s.name,
      timestampMs: latest.tsMs,
      text: combined,
      source: `wechat:${s.name}`,
      isDirectMessage: true,
      mentionsUser: false,
      isReplyInUserThread: false,
      recipientsIncludeUser: true,
      threadAnsweredByUserAfter: false,
      userIsLastSenderInChannel: false,
      threadContext,
      ...(attachments.length ? { attachments } : {}),
    });
  }
  return { inbound, sessions };
}
