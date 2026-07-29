// Read the OSYX Slack workspace (a SEPARATE workspace, NOT the Taiv MCP) via the
// Keychain direct token (account huizhezheng@gmail.com). Used by the project/
// persona bootstrap for OSYX, since the MCP only covers Taiv.
//
//   npx tsx scripts/osyx-slack.mts list                 # list channels
//   npx tsx scripts/osyx-slack.mts <#channel|id> [N]    # last N msgs (default 60)
//
// Output: "[YYYY-MM-DD] <name>: <text>" oldest→newest. "me" = Leo (huizhezheng).
import { createSlackClientFromKeychain } from "../relay/io/slack-api.js";

const OSYX_ACCOUNT = "huizhezheng@gmail.com";
const [, , target, limitArg] = process.argv;
const limit = Number(limitArg) || 60;

const c = await createSlackClientFromKeychain(undefined as never, OSYX_ACCOUNT);
const convs = await c.listAllConversations();

if (!target || target === "list") {
  for (const ch of convs) {
    const kind = ch.is_im ? "DM" : ch.is_mpim ? "GDM" : "#";
    console.log(`${ch.id}\t${kind}\t${(ch as Record<string, unknown>).name ?? (ch as Record<string, unknown>).user ?? ""}`);
  }
  process.exit(0);
}

const name = target.replace(/^#/, "");
const ch = convs.find((x) => (x as Record<string, unknown>).name === name || x.id === target);
if (!ch) {
  console.error(`channel not found: ${target} (try: npx tsx scripts/osyx-slack.mts list)`);
  process.exit(1);
}

// Resolve user ids → display names (best-effort, cached).
const nameCache = new Map<string, string>();
async function who(uid: string | undefined): Promise<string> {
  if (!uid) return "?";
  if (uid === "me") return "me";
  if (nameCache.has(uid)) return nameCache.get(uid)!;
  try {
    const p = await c.usersInfo(uid);
    const n = p?.real_name ?? p?.name ?? uid;
    nameCache.set(uid, n);
    return n;
  } catch {
    return uid;
  }
}

const resp = await c.conversationsHistory({ channel: ch.id, limit });
const ordered = [...(resp.messages ?? [])].reverse(); // newest-first → oldest-first
for (const m of ordered) {
  const d = new Date(Number(m.ts) * 1000).toISOString().slice(0, 10);
  const author = await who(m.user);
  const text = (m.text ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
  if (text) console.log(`[${d}] ${author}: ${text}`);
}
process.exit(0);
