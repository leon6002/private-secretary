// Pure decision: which Jira account (if any) a free-text assignee query
// resolves to. Mirrors recipient-resolver.ts's ASK-not-GUESS rule — resolve
// ONLY on an exact, unambiguous match against real (human) accounts;
// anything else is unresolved and the caller must not guess.

export interface JiraAccountCandidate {
  accountId: string;
  displayName: string;
  accountType: string; // "atlassian" = human; "app" = bot/integration
}

export type JiraAssigneeResolution =
  | { status: "resolved"; accountId: string }
  | { status: "unresolved"; reason: "no-match" | "ambiguous" };

function norm(s: string): string {
  return s.trim().toLowerCase();
}

export function resolveJiraAssignee(
  query: string,
  candidates: JiraAccountCandidate[],
): JiraAssigneeResolution {
  const q = norm(query);
  const humans = candidates.filter((c) => c.accountType === "atlassian");
  const matched = humans.filter((c) => norm(c.displayName) === q);
  if (matched.length === 1) return { status: "resolved", accountId: matched[0]!.accountId };
  return { status: "unresolved", reason: matched.length === 0 ? "no-match" : "ambiguous" };
}
