// MessageSource registry. A source ORIGINATES action items, so it is only ever a
// person-to-person messaging channel (Slack, Gmail, WeChat). Reference systems
// (Jira, Notion) are NOT sources — they are context the analyzer looks up and
// executor targets actions land on. New messaging source = add one entry here.

import type { MessageSource } from "./types.js";
import { slackChannelsSource } from "./slack-channels.js";

export const SOURCES: Record<string, MessageSource> = {
  [slackChannelsSource.key]: slackChannelsSource,
};

export function getSource(key: string): MessageSource | undefined {
  return SOURCES[key];
}

export * from "./types.js";
