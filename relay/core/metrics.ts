// Validation-gate metrics. Makes the "are drafts good enough?" question computable,
// not vibes. Recorded per draft in loop-state.json.
//
// Gate to graduate to Phase 2 (the cockpit):
//   - of the last 20 surfaced drafts, >= 16 approved clean (no edit or trivial edit)
//   - across >= 3 distinct contacts
//   - zero wrong-recipient incidents
//
// 2026-06-11 (user decision): the EN<->ZH both-directions requirement is SUSPENDED
// until WeChat lands — real Phase 1 traffic is en->en because the Chinese-side
// sources aren't connected yet (chicken-and-egg). Direction coverage is still
// computed and reported; set REQUIRE_CROSS_LANG = true to re-arm it with WeChat.

export type Decision = "approve-clean" | "approve-trivial" | "edit" | "skip";
// Same-language directions (en->en, zh->zh) are valid relays (e.g. forwarding an
// English Slack thread to an English teammate) but do NOT prove cross-language
// ability. The gate's "both directions" check looks specifically for the two
// cross-language directions.
export type Direction = "en->zh" | "zh->en" | "en->en" | "zh->zh";
const CROSS_LANG: ReadonlySet<Direction> = new Set(["en->zh", "zh->en"]);

export interface DraftOutcome {
  relayId: string;
  contactKey: string; // recipient persona key (or "unknown")
  direction: Direction;
  decision: Decision;
  wrongRecipient: boolean; // user flagged the proposed recipient was wrong
}

export interface GateResult {
  pass: boolean;
  cleanApprovals: number;
  surfaced: number;
  distinctContacts: number;
  directionsCovered: number; // 0, 1, or 2
  wrongRecipientCount: number;
  reasons: string[]; // why it failed, empty if pass
}

const WINDOW = 20;
const CLEAN_TARGET = 16;
const MIN_CONTACTS = 3;
// Re-arm when WeChat (the Chinese-side source) is connected.
export const REQUIRE_CROSS_LANG = false;

export function computeGate(outcomes: DraftOutcome[]): GateResult {
  // "Surfaced" = drafts the user judged. Skips count as surfaced (they were shown), but
  // a skip is not a clean approval.
  const window = outcomes.slice(-WINDOW);
  const cleanApprovals = window.filter(
    (o) => o.decision === "approve-clean" || o.decision === "approve-trivial",
  ).length;
  const distinctContacts = new Set(window.map((o) => o.contactKey)).size;
  const crossLang = new Set(
    window.map((o) => o.direction).filter((d) => CROSS_LANG.has(d)),
  );
  const wrongRecipientCount = window.filter((o) => o.wrongRecipient).length;

  const reasons: string[] = [];
  if (window.length < WINDOW)
    reasons.push(`only ${window.length}/${WINDOW} drafts surfaced`);
  if (cleanApprovals < CLEAN_TARGET)
    reasons.push(`${cleanApprovals}/${CLEAN_TARGET} clean approvals`);
  if (distinctContacts < MIN_CONTACTS)
    reasons.push(`${distinctContacts}/${MIN_CONTACTS} distinct contacts`);
  if (REQUIRE_CROSS_LANG && crossLang.size < 2)
    reasons.push("both cross-language directions (en->zh, zh->en) not covered");
  if (wrongRecipientCount > 0)
    reasons.push(`${wrongRecipientCount} wrong-recipient incident(s)`);

  return {
    pass: reasons.length === 0,
    cleanApprovals,
    surfaced: window.length,
    distinctContacts,
    directionsCovered: crossLang.size,
    wrongRecipientCount,
    reasons,
  };
}
