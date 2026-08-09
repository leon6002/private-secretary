import { describe, expect, it } from "vitest";
import { resolveJiraAssignee, type JiraAccountCandidate } from "./jira-assignee.js";

const human = (displayName: string, accountId: string): JiraAccountCandidate => ({
  accountId,
  displayName,
  accountType: "atlassian",
});
const bot = (displayName: string, accountId: string): JiraAccountCandidate => ({
  accountId,
  displayName,
  accountType: "app",
});

describe("resolveJiraAssignee (ASK-not-GUESS)", () => {
  it("resolves on an exact, unambiguous human match", () => {
    const candidates = [human("Alice Chen", "acc-1"), human("Bob Lee", "acc-2")];
    expect(resolveJiraAssignee("Alice Chen", candidates)).toEqual({
      status: "resolved",
      accountId: "acc-1",
    });
  });

  it("is case- and whitespace-insensitive", () => {
    const candidates = [human("Alice Chen", "acc-1")];
    expect(resolveJiraAssignee("  alice chen ", candidates)).toEqual({
      status: "resolved",
      accountId: "acc-1",
    });
  });

  it("no match → unresolved no-match, never guesses", () => {
    const candidates = [human("Bob Lee", "acc-2")];
    expect(resolveJiraAssignee("Alice Chen", candidates)).toEqual({
      status: "unresolved",
      reason: "no-match",
    });
  });

  it("two humans with the same display name → unresolved ambiguous", () => {
    const candidates = [human("Alice Chen", "acc-1"), human("Alice Chen", "acc-3")];
    expect(resolveJiraAssignee("Alice Chen", candidates)).toEqual({
      status: "unresolved",
      reason: "ambiguous",
    });
  });

  it("excludes bot/app accounts even on an exact name match", () => {
    const candidates = [bot("Automation for Jira", "bot-1")];
    expect(resolveJiraAssignee("Automation for Jira", candidates)).toEqual({
      status: "unresolved",
      reason: "no-match",
    });
  });

  it("a bot with the same name as a human does not create ambiguity", () => {
    const candidates = [human("Alice Chen", "acc-1"), bot("Alice Chen", "bot-1")];
    expect(resolveJiraAssignee("Alice Chen", candidates)).toEqual({
      status: "resolved",
      accountId: "acc-1",
    });
  });
});
