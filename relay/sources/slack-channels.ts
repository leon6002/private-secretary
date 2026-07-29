// Slack channels source: messages in support/work channels where the user is
// involved (e.g. ticket threads like #support-tech #3039). Distinct from the DM
// source — here "addressed to user" means an @mention or a reply in a thread the
// user participates in, not a 1:1 DM.

import type { Attachment, InboundMessage } from "../core/types.js";
import { slackTsToMs, type MessageSource, type SourceContext } from "./types.js";

interface SlackFileRaw {
  id: string;
  name?: string;
  mimetype?: string;
}

interface SlackChannelRaw {
  channel_id: string;
  messages: Array<{
    ts: string;
    user: string;
    text: string;
    thread_ts?: string;
    reply_user_ids?: string[]; // participants in the thread (skill-supplied)
    user_answered_after?: boolean; // user already replied after this msg in-thread
    // A3 — user is the most recent sender in the conversation bucket (DM/channel).
    // Distinct from user_answered_after, which is thread-scoped. Skill/connector
    // supplies it from a peek at the latest message in the channel.
    user_is_last_sender_in_channel?: boolean;
    files?: SlackFileRaw[]; // attachments — the point is often in here
  }>;
}

function mapAttachments(files?: SlackFileRaw[]): Attachment[] | undefined {
  if (!files || files.length === 0) return undefined;
  return files.map((f) => ({
    id: f.id,
    kind: (f.mimetype ?? "").startsWith("image/") ? "image" : "file",
    name: f.name ?? f.id,
  }));
}

function normalize(raw: unknown, ctx: SourceContext): InboundMessage[] {
  const r = raw as SlackChannelRaw;
  if (!r || !Array.isArray(r.messages)) return [];
  const self = ctx.selfSlackId;
  return r.messages.map((m) => {
    const mentionsUser = !!self && m.text.includes(`<@${self}>`);
    const isReplyInUserThread =
      !!m.thread_ts && !!self && (m.reply_user_ids ?? []).includes(self);
    const attachments = mapAttachments(m.files);
    return {
      id: `slack:${r.channel_id}:${m.ts}`,
      platform: "slack",
      senderHandle: m.user,
      timestampMs: slackTsToMs(m.ts),
      text: m.text,
      source: `slack:${r.channel_id}`,
      isDirectMessage: false,
      mentionsUser,
      isReplyInUserThread,
      recipientsIncludeUser: false,
      threadAnsweredByUserAfter: m.user_answered_after ?? false,
      userIsLastSenderInChannel: m.user_is_last_sender_in_channel ?? false,
      ...(attachments ? { attachments } : {}),
    };
  });
}

export const slackChannelsSource: MessageSource = {
  key: "slack-channels",
  platform: "slack",
  normalize,
};
