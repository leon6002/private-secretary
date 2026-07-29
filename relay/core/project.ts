// Project layer (the goal/needs/gaps RAG). Pure logic — no I/O. A Project is
// the durable map of a goal + what it needs + who's on it; selectProjects picks
// the ones relevant to an inbound message so the drafter can ground an Action
// Item in "what's actually going on" (not just who the sender is).

export interface ProjectNeed {
  need: string;
  status?: string; // covered | partial | gap | ...
  provided_by?: string[];
}

export interface ProjectPerson {
  key?: string;
  name?: string;
  role?: string;
}

export interface Project {
  id: string;
  company?: string;
  name?: string;
  goal?: string;
  status?: string;
  current_state?: string;
  needs?: ProjectNeed[];
  blockers?: string[];
  people?: ProjectPerson[];
}

// Lowercased token set for keyword matching: the project's name + id + each
// person's name (so a message naming the project, the id, or a teammate hits).
function matchTerms(p: Project): string[] {
  const terms = [p.id, p.name].filter((s): s is string => !!s);
  for (const person of p.people ?? []) {
    if (person.name) terms.push(person.name);
  }
  return terms
    .join(" ")
    .toLowerCase()
    .split(/[^a-z0-9一-鿿]+/)
    .filter((t) => t.length >= 3); // drop tiny tokens / punctuation
}

export interface ProjectMatch {
  project: Project;
  why: "sender" | "keyword";
}

// Pick the projects relevant to this message. STRONG signal: the sender is a
// listed person on the project (they own/touch it). WEAKER: project name/id/
// teammate names appear in the message text. Sender-matches rank first; cap at
// `limit` so the prompt stays focused. Returns [] when nothing matches — the
// drafter then works from persona alone (no fabricated project link).
export function selectProjects(
  projects: Project[],
  opts: { senderKey?: string | null; text?: string; limit?: number },
): ProjectMatch[] {
  const text = (opts.text ?? "").toLowerCase();
  const senderHits: ProjectMatch[] = [];
  const keywordHits: ProjectMatch[] = [];

  for (const p of projects) {
    const bySender =
      !!opts.senderKey &&
      (p.people ?? []).some((person) => person.key === opts.senderKey);
    if (bySender) {
      senderHits.push({ project: p, why: "sender" });
      continue; // don't double-count
    }
    if (text) {
      const hit = matchTerms(p).some((term) => text.includes(term));
      if (hit) keywordHits.push({ project: p, why: "keyword" });
    }
  }
  return [...senderHits, ...keywordHits].slice(0, opts.limit ?? 3);
}

// A compact catalog of ALL projects (id + company + name + trimmed goal) so the
// drafter can assign project_id by MEANING — keyword matching (selectProjects)
// misses a message that's clearly about a project but never names it (a BMS/motor
// message belongs to the automotive/small-car project though it says neither id
// nor a teammate). The focused needs/gaps detail still comes from selectProjects.
export function renderProjectCatalog(projects: Project[]): string {
  if (projects.length === 0) return "";
  const line = (p: Project): string => {
    const goal = (p.goal ?? "").replace(/\s+/g, " ").trim();
    const goalSnip = goal.length > 180 ? goal.slice(0, 180) + "…" : goal;
    return `- ${p.id} (${p.company ?? "?"}): ${p.name ?? ""}${goalSnip ? ` — ${goalSnip}` : ""}`;
  };
  return projects.map(line).join("\n");
}

// Render a matched project as a compact context block for the draft prompt —
// goal + current state + the OPEN needs/gaps (covered needs are omitted; the
// drafter cares about what's unresolved). Facts only; no invention.
export function renderProjectContext(p: Project): string {
  const lines = [`PROJECT ${p.id}${p.name ? ` — ${p.name}` : ""} (${p.company ?? "?"})`];
  if (p.goal) lines.push(`  goal: ${p.goal.replace(/\s+/g, " ").trim()}`);
  if (p.current_state) lines.push(`  state: ${p.current_state.replace(/\s+/g, " ").trim()}`);
  const open = (p.needs ?? []).filter((n) => n.status === "gap" || n.status === "partial");
  if (open.length > 0) {
    lines.push(`  open needs/gaps:`);
    for (const n of open) lines.push(`    - [${n.status}] ${n.need}`);
  }
  if (p.blockers && p.blockers.length > 0) {
    lines.push(`  blockers: ${p.blockers.join("; ")}`);
  }
  return lines.join("\n");
}
