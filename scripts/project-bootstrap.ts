#!/usr/bin/env -S npx tsx
// Project discovery (specs/project-discovery.md) — build a self-maintaining
// project set per company WITHOUT hand-enumeration. Container = project unit:
// enumerate Slack channels / WeChat groups / MPIMs, classify, summarize each
// from a RECENT+DEEP window via `claude -p` (zero API), merge across surfaces,
// write staged YAMLs + a review doc. Resumable via stage files.
//
//   npx tsx scripts/project-bootstrap.ts --company ous [--stage all]
//     --stage enumerate|classify|summarize|merge|write|all (default all)
//     --dormant-weeks 6   --limit N (cap containers, for a fast first pass)
//
// NOT part of the scan loop. Staged → review → promote (a later --promote moves
// projects/_staged/*.yaml live, same gate as persona-bootstrap).

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { createSlackClientFromKeychain } from "../relay/io/slack-api.js";
import { wechatRaw, wechatSessions, wechatHistory } from "../relay/io/wechat-cli.js";
import { createClaudeCliJsonCaller } from "../relay/proc/llm-claude-cli.js";

type Surface = "osyx-slack" | "taiv-slack" | "wechat" | "misc";
interface Container { surface: Surface; id: string; name: string; kind: "channel" | "mpim" | "group" | "dm"; }
interface ProjectSummary {
  container: Container;
  name?: string; goal?: string; current_state?: string; stage?: string; money?: string;
  status?: string; needs?: { need: string; status?: string }[]; blockers?: string[];
  people?: { name: string; role?: string }[]; cross_company?: string[];
  is_project?: boolean; // false = not a real company project (social/noise)
}

const OSYX_ACCOUNT = "huizhezheng@gmail.com";
const DISCOVERY_DIR = "projects/_staged/_discovery";
const STAGED_DIR = "projects/_staged";

function arg(flag: string, def: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
}
const company = arg("--company", "ous");
const stage = arg("--stage", "all");
const limit = Number(arg("--limit", "999"));
// Generous timeout: summarize calls are big + the machine is often under heavy
// concurrent `claude -p` load. A per-container failure is caught (not fatal).
const json = createClaudeCliJsonCaller({ model: "opus", timeoutMs: 300_000 });

function stagePath(name: string): string { return join(DISCOVERY_DIR, `${company}-${name}.json`); }
function readStage<T>(name: string): T | null {
  const p = stagePath(name);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null;
}
function writeStage(name: string, data: unknown): void {
  mkdirSync(DISCOVERY_DIR, { recursive: true });
  writeFileSync(stagePath(name), JSON.stringify(data, null, 2));
}

// ── ENUMERATE ────────────────────────────────────────────────────────
// OUS = the CN-commercial side: WeChat groups + the cross-company OSYX channels
// (OUS owns the commercial side of the OSYX-dev projects). OSYX = OSYX Slack only.
async function enumerateSlack(account: string | undefined, surface: Surface, out: Container[]): Promise<void> {
  const slack = account ? await createSlackClientFromKeychain({}, account) : await createSlackClientFromKeychain({});
  const all = await slack.listAllConversations();
  const DROP = /^(all-|social$|random$|.*-notifs$|.*-jira-notifs$)/i;
  // Named CHANNELS only. MPIMs (ad-hoc group DMs) are dropped: a big workspace
  // (Taiv) has hundreds of them and they're rarely a clean project. A project
  // that lives only in an MPIM is caught by the MISC-card detector / manual add.
  for (const c of all as Array<{ id: string; name?: string; is_channel?: boolean; is_archived?: boolean }>) {
    if (c.is_archived || !c.is_channel || !c.name || DROP.test(c.name)) continue;
    out.push({ surface, id: c.id, name: c.name, kind: "channel" });
  }
}

async function enumerate(): Promise<Container[]> {
  const out: Container[] = [];
  const wantWechat = company === "ous";

  // OSYX Slack (huizhezheng account): OSYX-own projects + the OUS-commercial overlap.
  if (company === "osyx" || company === "ous") await enumerateSlack(OSYX_ACCOUNT, "osyx-slack", out);
  // Taiv Slack (default leo@taiv.tv account).
  if (company === "taiv") await enumerateSlack(undefined, "taiv-slack", out);

  if (wantWechat) {
    const raw = String(await wechatRaw("get_contacts", { query: "", limit: 1000 }));
    // Groups (@chatroom).
    for (const m of raw.matchAll(/(\d+@chatroom)\s+(?:备注:\s*[^\n]*?)?昵称:\s*([^\n]+)/g)) {
      out.push({ surface: "wechat", id: m[1]!, name: m[2]!.trim(), kind: "group" });
    }
    // High-freq 1:1 DMs: take the RECENTLY-ACTIVE contacts (get_recent_sessions),
    // resolve each to a wxid via the contact dump. Customer/partner DMs (京瓷
    // battery / 孙陈 arm advisor / 陈古龙 delivery) are container-less project
    // signal that group enumeration misses.
    const nameToId = new Map<string, string>();
    for (const m of raw.matchAll(/^(\S+)\s+(?:备注:\s*(.+?)\s+)?昵称:\s*(.+)$/gm)) {
      const id = m[1]!;
      if (id.includes("@chatroom") || id.startsWith("gh_")) continue; // groups / official accts
      if (m[2]) nameToId.set(m[2].trim(), id);
      if (m[3]) nameToId.set(m[3].trim(), id);
    }
    const sessions = String(await wechatSessions({ limit: 40 }));
    const seen = new Set<string>();
    for (const line of sessions.split("\n")) {
      const mm = line.match(/^\[\d\d-\d\d \d\d:\d\d\]\s+(.+)$/);
      if (!mm) continue;
      if (/\[群\]/.test(mm[1]!)) continue; // group, already enumerated
      const name = mm[1]!.replace(/\s*\(\d+条未读\)\s*$/, "").trim();
      const id = nameToId.get(name);
      if (id && !seen.has(id)) { seen.add(id); out.push({ surface: "wechat", id, name, kind: "dm" }); }
    }
  }
  return out;
}

// ── CLASSIFY ─────────────────────────────────────────────────────────
// Cheap name-only LLM pass to drop social/industry/noise groups before the
// expensive per-container reads. Slack channels are already curated → keep all;
// only WeChat groups (noisy) get classified.
// Company-aware KEEP/EXCLUDE guidance for the name-triage.
const CLASSIFY_GUIDE: Record<string, string> = {
  ous: `Company 欧思克斯 (OUS) — China commercial arm: Bao-hypervisor automotive deals (xEV/瑞萨/采埃孚ZF/零跑/恒润/UAES/华勤/埃泰克/普华), RISC-V (SpaceMIT/进迭/Nuclei/Andes), military (Chu/导控所), robotics/小车/Jetson/机械臂, test-equipment (中汽研车辆测试), + supplier DMs (battery/电机/BMS, e.g. 京瓷锂电). KEEP those project groups + customer/partner/supplier/delivery DMs. EXCLUDE Taiv (Box/FCC/HDMI/REV4/Yunzuo), building-HVAC (港城广场/江森自控), exhibitions/event-logistics, social/family/alumni/animation/machining, broadcast/news, purely-personal DMs.`,
  osyx: `Company OSYX (Portugal) — Bao hypervisor dev + productization: chip-vendor SoC ports (Renesas/Infineon/SpaceMIT/Nuclei/Andes), toolchain (IAR/TASKING), functional-safety cert, demos (industrial-edge/reBot, Embedded World), customer scoping (ZF/PATAC/HiRain/Chu). KEEP eng/product/customer/demo channels. EXCLUDE social/random/announcements/notifs.`,
  taiv: `Company Taiv — the ad-supported TV box: hardware/firmware (the box, RK3399/RK3576, rev4.x, HDMI, FCC cert), detection/ML, TaivX/Viewer/Installer apps, ad-sales/campaigns, supply-chain/manufacturing (艾科/DS assembly), venues/install ops. KEEP product/eng/hardware/ad-sales/ops PROJECT channels. EXCLUDE social/random/watercooler/announcements/notifs/HR/generic-team-chatter and personal channels.`,
};
async function classify(containers: Container[]): Promise<Container[]> {
  if (containers.length === 0) return [];
  const SCHEMA = { type: "object", properties: { project_like_ids: { type: "array", items: { type: "string" } } }, required: ["project_like_ids"] };
  const kindTag = (c: Container) => c.surface === "wechat" ? (c.kind === "dm" ? "[微信DM]" : "[微信群]") : "[slack #]";
  const list = containers.map((c, i) => `${i}: ${kindTag(c)} ${c.name}`).join("\n");
  const res = (await json({
    system: `You triage channel / group / DM NAMES to find the ACTIVE PROJECTS of this company.
${CLASSIFY_GUIDE[company] ?? CLASSIFY_GUIDE.ous}
Return project_like_ids = indices to KEEP. For a customer/supplier/partner 1:1 DM whose name is ambiguous, KEEP it (the deep read decides). For channels/groups, be reasonably strict — drop chatter/social/ops/notifs. Better to drop a borderline channel than keep noise.`,
    userText: `CANDIDATES:\n${list}\n\nReturn project_like_ids (indices as strings) to keep.`,
    toolInputSchema: SCHEMA,
  })) as { project_like_ids?: string[] } | null;
  const keep = new Set((res?.project_like_ids ?? []).map((x) => Number(x)));
  return containers.filter((_, i) => keep.has(i));
}

// ── SUMMARIZE ────────────────────────────────────────────────────────
async function windowFor(c: Container): Promise<string> {
  if (c.surface === "wechat") {
    return await wechatHistory(c.id, { limit: 60, oldestFirst: true, start: weeksAgo(8) });
  }
  // Slack (osyx-slack via huizhezheng account, taiv-slack via default account).
  const slack = c.surface === "taiv-slack"
    ? await createSlackClientFromKeychain({})
    : await createSlackClientFromKeychain({}, OSYX_ACCOUNT);
  const r = await slack.conversationsHistory({ channel: c.id, limit: 40 });
  const msgs = (r.messages ?? []).filter((m) => m.text).reverse();
  return msgs.map((m) => `${m.user ?? "?"}: ${(m.text ?? "").replace(/\s+/g, " ")}`).join("\n");
}
function weeksAgo(n: number): string {
  return new Date(Date.now() - n * 7 * 86400_000).toISOString().slice(0, 10);
}
const PROJECT_FIELDS = {
  is_project: { type: "boolean", description: "false if not a real company project (social/industry/noise)" },
  name: { type: "string" }, goal: { type: "string" }, current_state: { type: "string" },
  stage: { type: "string", description: "exploring | SoW | signed | delivering | done | unknown" },
  money: { type: "string", description: "amount/terms if stated, else empty" },
  needs: { type: "array", items: { type: "object", properties: { need: { type: "string" }, status: { type: "string" } } } },
  blockers: { type: "array", items: { type: "string" } },
  people: { type: "array", items: { type: "object", properties: { name: { type: "string" }, role: { type: "string" } } } },
  cross_company: { type: "array", items: { type: "string" }, description: "other companies involved (OSYX/欧思克斯/Taiv)" },
};
// One container may host MORE THAN ONE distinct effort (e.g. #renesas-1 holds both
// an IAR webinar AND the xEV democar SoW). Return an array so they split cleanly.
const SUMMARY_SCHEMA = {
  type: "object",
  properties: { projects: { type: "array", items: { type: "object", properties: PROJECT_FIELDS, required: ["is_project", "name", "goal"] } } },
  required: ["projects"],
};
async function summarizeOne(c: Container): Promise<ProjectSummary[]> {
  let window = "";
  try { window = await windowFor(c); } catch (e) { return [{ container: c, is_project: false, current_state: `fetch failed: ${(e as Error).message}` }]; }
  if (!window.trim()) return [{ container: c, is_project: false }];
  const res = (await json({
    system: `You read ONE conversation (a ${c.kind} named "${c.name}") and extract the company PROJECT(S) it covers. Usually ONE; but if it clearly hosts MULTIPLE distinct efforts (e.g. a marketing webinar AND a paid engineering SoW), return one entry PER project. Rules: state ONLY what the messages show; "unknown" when not stated; NEVER promote "scheduled/planned" to "done". Capture money, stage, blockers, key people with roles. needs.status ∈ gap|partial|covered. If the conversation is social/industry/noise (no real project), return one entry with is_project=false.`,
    userText: `CONVERSATION (recent, newest last):\n${window.slice(0, 16000)}\n\nReturn projects[] (1 per distinct effort).`,
    toolInputSchema: SUMMARY_SCHEMA,
  })) as { projects?: Partial<ProjectSummary>[] } | null;
  const arr = res?.projects ?? [];
  if (arr.length === 0) return [{ container: c, is_project: false }];
  return arr.map((p) => ({ container: c, ...p }));
}

// ── MERGE ────────────────────────────────────────────────────────────
async function merge(summaries: ProjectSummary[]): Promise<Record<string, unknown>[]> {
  const projects = summaries.filter((s) => s.is_project && s.name);
  const rows = projects.map((p, i) =>
    `${i}: [${p.container.surface}#${p.container.name}] "${p.name}" — ${(p.goal ?? "").slice(0, 90)}` +
    ` | people: ${(p.people ?? []).map((x) => x.name).join(", ") || "-"}` +
    ` | state: ${(p.current_state ?? "").replace(/\s+/g, " ").slice(0, 110)}`,
  ).join("\n");
  const SCHEMA = { type: "object", properties: { groups: { type: "array", items: { type: "object", properties: { canonical_name: { type: "string" }, member_indices: { type: "array", items: { type: "string" } } }, required: ["canonical_name", "member_indices"] } } }, required: ["groups"] };
  const res = (await json({
    system: `Group the records that are the SAME real-world project, even across different containers/surfaces. MERGE when they share the same customer/end-client, the same people, or the same hardware/topic — e.g. several records all about RK3588 + RT-Thread/Linux + 导控所/Chu (technical "Rocket" work + the 20K optimization contract + the RT-Thread porting) are ONE Chu military project; an OSYX Slack channel + a WeChat group about the same customer are one project. Only return groups for records you are MERGING (2+ members); leave genuinely standalone records out (they're kept automatically). Be decisive about same-customer merges.`,
    userText: `RECORDS:\n${rows}\n\nReturn groups (each {canonical_name, member_indices}) ONLY for records that are the same project.`,
    toolInputSchema: SCHEMA,
  })) as { groups?: { canonical_name: string; member_indices: string[] }[] } | null;
  const groups = res?.groups ?? [];
  // The LLM only returns the groups it wants to MERGE; every project NOT covered
  // is a standalone project. Append a singleton group for each uncovered index so
  // nothing is dropped (the bug that collapsed 20 → 1).
  const covered = new Set(groups.flatMap((g) => g.member_indices.map((x) => Number(x))));
  for (let i = 0; i < projects.length; i++) {
    if (!covered.has(i)) groups.push({ canonical_name: projects[i]!.name!, member_indices: [String(i)] });
  }

  const merged: Record<string, unknown>[] = [];
  let n = 1;
  const used = new Set<number>();
  for (const g of groups) {
    const members = g.member_indices.map((x) => Number(x)).filter((i) => projects[i] && !used.has(i));
    if (members.length === 0) continue;
    members.forEach((i) => used.add(i));
    const ms = members.map((i) => projects[i]!);
    const pick = <T,>(f: (s: ProjectSummary) => T | undefined): T | undefined => ms.map(f).find((v) => v != null && v !== "");
    merged.push({
      id: `${company.toUpperCase()}-${String(n++).padStart(2, "0")}`,
      company: company === "ous" ? "oushikesi" : company,
      name: g.canonical_name,
      goal: pick((s) => s.goal) ?? "",
      stage: pick((s) => s.stage) ?? "unknown",
      money: pick((s) => s.money) ?? "",
      status: "active",
      current_state: ms.map((s) => s.current_state).filter(Boolean).join(" | "),
      needs: ms.flatMap((s) => s.needs ?? []),
      blockers: ms.flatMap((s) => s.blockers ?? []),
      people: dedupePeople(ms.flatMap((s) => s.people ?? [])),
      cross_company: [...new Set(ms.flatMap((s) => s.cross_company ?? []))],
      containers: ms.map((s) => ({ surface: s.container.surface, id: s.container.id, name: s.container.name })),
    });
  }
  return merged;
}
function dedupePeople(ps: { name: string; role?: string }[]): { name: string; role?: string }[] {
  const seen = new Map<string, { name: string; role?: string }>();
  for (const p of ps) if (p.name && !seen.has(p.name)) seen.set(p.name, p);
  return [...seen.values()];
}

// ── L3 MISC detector ─────────────────────────────────────────────────
// Container-less projects (e.g. chip-cascading) leave no channel/group, but the
// daemon's cards that map to no project pile up as project_id=MISC. A topic
// recurring across those cards = a real project not yet filed.
async function miscScan(known: ProjectSummary[]): Promise<ProjectSummary[]> {
  const sp = "state/loop-state.json";
  if (!existsSync(sp)) return [];
  const st = JSON.parse(readFileSync(sp, "utf8")) as { actions?: { status?: string; project_id?: string; headline?: string; reason?: string; summary?: string }[] };
  const misc = (st.actions ?? []).filter((a) => (a.status === "suggested" || a.status === "approved") && (!a.project_id || a.project_id === "MISC"));
  if (misc.length < 2) return [];
  const rows = misc.map((a, i) => `${i}: ${a.headline || a.reason || ""} — ${(a.summary || "").replace(/\s+/g, " ").slice(0, 100)}`).join("\n");
  const knownNames = known.filter((k) => k.is_project).map((k) => k.name).join("; ");
  const SCHEMA = { type: "object", properties: { emergent: { type: "array", items: { type: "object", properties: PROJECT_FIELDS, required: ["name", "goal"] } } }, required: ["emergent"] };
  const res = (await json({
    system: `These are triage cards the secretary could NOT map to any known project. KNOWN projects: ${knownNames || "(none)"}. Find RECURRING efforts here that are real ongoing projects NOT already in the known list (a topic across multiple cards = a container-less project, e.g. "produce a SoW for X"). Return emergent[] in the project schema; ignore one-off / personal / noise. Empty if none.`,
    userText: `UNMAPPED CARDS:\n${rows}\n\nReturn emergent projects.`,
    toolInputSchema: SCHEMA,
  })) as { emergent?: Partial<ProjectSummary>[] } | null;
  return (res?.emergent ?? []).map((p) => ({ container: { surface: "misc" as Surface, id: "misc", name: "MISC cards", kind: "group" as const }, is_project: true, ...p }));
}

// ── WRITE ────────────────────────────────────────────────────────────
function write(merged: Record<string, unknown>[]): void {
  mkdirSync(STAGED_DIR, { recursive: true });
  for (const p of merged) writeFileSync(join(STAGED_DIR, `${p.id}.yaml`), stringify(p), "utf8");
  const review = [`# Project discovery review — ${company} — ${new Date().toISOString().slice(0, 10)}`, "",
    `${merged.length} candidate projects (staged in projects/_staged/). Review, edit, then promote.`, "",
    ...merged.map((p) => `## ${p.id} — ${p.name}\n- stage: ${p.stage} | money: ${p.money || "—"} | cross: ${(p.cross_company as string[]).join(",") || "—"}\n- containers: ${(p.containers as { name: string }[]).map((c) => c.name).join(", ")}\n- goal: ${String(p.goal).slice(0, 200)}\n- state: ${String(p.current_state).slice(0, 300)}`)];
  writeFileSync(join(STAGED_DIR, `_DISCOVERY-REVIEW-${company}.md`), review.join("\n"), "utf8");
  console.log(`[bootstrap] wrote ${merged.length} staged projects + review doc`);
}

// ── DRIVER ───────────────────────────────────────────────────────────
async function main(): Promise<void> {
  // --stage names the FURTHEST stage to run; earlier stages always run if their
  // output is missing (prerequisite auto-run). "all" → through write.
  const ORDER = ["enumerate", "classify", "summarize", "misc", "merge", "write"];
  const upTo = ORDER.indexOf(stage === "all" ? "write" : stage);
  const run = (s: string) => ORDER.indexOf(s) <= (upTo < 0 ? ORDER.length - 1 : upTo);

  let containers = readStage<Container[]>("containers");
  if (run("enumerate") && !containers) {
    containers = await enumerate();
    writeStage("containers", containers);
    console.log(`[bootstrap] enumerated ${containers.length} containers`);
  }
  containers = containers ?? [];

  let classified = readStage<Container[]>("classified");
  if (run("classify") && !classified) {
    classified = await classify(containers);
    writeStage("classified", classified);
    console.log(`[bootstrap] classified → ${classified.length} project-like containers`);
  }
  classified = (classified ?? containers).slice(0, limit);

  let summaries = readStage<ProjectSummary[]>("summaries") ?? [];
  if (run("summarize")) {
    const done = new Set(summaries.map((s) => s.container.id));
    for (const c of classified) {
      if (done.has(c.id)) continue;
      console.log(`[bootstrap] summarizing ${c.surface}#${c.name} …`);
      try {
        summaries.push(...(await summarizeOne(c))); // 1 container → 1+ projects
        writeStage("summaries", summaries); // checkpoint each (resumable)
      } catch (e) {
        // One slow/failed claude -p must not abort the whole run; skip + the
        // container is retried on the next pass (not checkpointed as done).
        console.warn(`[bootstrap] skip ${c.name}: ${(e as Error).message}`);
      }
    }
    const proj = summaries.filter((s) => s.is_project).length;
    console.log(`[bootstrap] summarized ${summaries.length} (${proj} are projects)`);
  }

  // L3 MISC: emergent container-less projects from the daemon's unmapped cards.
  if (run("misc") && !summaries.some((s) => s.container.surface === "misc")) {
    const emergent = await miscScan(summaries);
    if (emergent.length) { summaries.push(...emergent); writeStage("summaries", summaries); }
    console.log(`[bootstrap] MISC scan → ${emergent.length} emergent candidates`);
  }

  let merged = readStage<Record<string, unknown>[]>("merged");
  if (run("merge") && !merged) {
    merged = await merge(summaries);
    writeStage("merged", merged);
    console.log(`[bootstrap] merged → ${merged.length} projects`);
  }
  if (run("write") && merged) write(merged);
}
main().catch((e) => { console.error("[bootstrap] crashed:", (e as Error).message); process.exit(1); });
