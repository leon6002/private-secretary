// Jira-specific mapping on top of the generic MCP transport (mcp-tool.ts):
// resolves the Atlassian cloudId once and caches it, maps our params.project
// to Jira's real projectKey, defaults issueTypeName, and resolves a free-text
// assignee to a real accountId via the same ASK-not-GUESS rule already used
// for reply/relay recipients (relay/core/recipient-resolver.ts) — see
// relay/core/jira-assignee.ts. Never silently assigns a guessed account.

import { callMcpTool, callResultText, extractRef } from "./mcp-tool.js";
import { resolveJiraAssignee, type JiraAccountCandidate } from "../core/jira-assignee.js";
import type { ToolRunner } from "../proc/execute.js";

const DEFAULT_ISSUE_TYPE = "Task";

const cloudIdCache = new Map<string, string>();

async function resolveCloudId(url: string, authService: string): Promise<string> {
  const cached = cloudIdCache.get(url);
  if (cached) return cached;
  const res = await callMcpTool(url, authService, "getAccessibleAtlassianResources", {});
  const resources = JSON.parse(callResultText(res)) as Array<{ id: string; name?: string }>;
  if (resources.length === 0) {
    throw new Error("no accessible Atlassian site for this Jira connection");
  }
  if (resources.length > 1) {
    throw new Error(
      `${resources.length} accessible Atlassian sites (${resources.map((r) => r.name).join(", ")}) — cloudId is ambiguous, connect a single-site account`,
    );
  }
  const cloudId = resources[0]!.id;
  cloudIdCache.set(url, cloudId);
  return cloudId;
}

async function resolveAssigneeAccountId(
  url: string,
  authService: string,
  cloudId: string,
  query: string,
): Promise<string> {
  const res = await callMcpTool(url, authService, "lookupJiraAccountId", { cloudId, searchString: query });
  const parsed = JSON.parse(callResultText(res)) as {
    data?: { users?: { users?: JiraAccountCandidate[] } };
  };
  const candidates = parsed.data?.users?.users ?? [];
  const resolution = resolveJiraAssignee(query, candidates);
  if (resolution.status !== "resolved") {
    throw new Error(
      `assignee "${query}" ${resolution.reason === "ambiguous" ? "matches more than one Jira user" : "does not match any Jira user"} — cannot assign without an exact match`,
    );
  }
  return resolution.accountId;
}

export interface JiraToolOptions {
  url: string;
  authService: string;
  defaultTool?: string;
}

// Build the Jira ToolRunner. Unlike the generic createMcpToolRunner, this maps
// our card's param names (project, summary, description, assignee) onto the
// real createJiraIssue field names (cloudId, projectKey, issueTypeName,
// assignee_account_id) instead of passing params straight through.
export function createJiraToolRunner(opts: JiraToolOptions): ToolRunner {
  return {
    run: async (params: Record<string, unknown>) => {
      const toolName =
        (typeof params.mcp_tool === "string" && params.mcp_tool) || opts.defaultTool || "createJiraIssue";
      const cloudId = await resolveCloudId(opts.url, opts.authService);

      const projectKey = typeof params.project === "string" ? params.project : "";
      if (!projectKey) throw new Error("jira tool card is missing params.project");
      const summary = typeof params.summary === "string" ? params.summary : "";
      const description = typeof params.description === "string" ? params.description : undefined;

      const args: Record<string, unknown> = {
        cloudId,
        projectKey,
        issueTypeName: DEFAULT_ISSUE_TYPE,
        summary,
        ...(description ? { description } : {}),
      };

      const assigneeQuery = typeof params.assignee === "string" ? params.assignee.trim() : "";
      if (assigneeQuery) {
        args.assignee_account_id = await resolveAssigneeAccountId(
          opts.url,
          opts.authService,
          cloudId,
          assigneeQuery,
        );
      }

      const res = await callMcpTool(opts.url, opts.authService, toolName, args);
      return { ref: extractRef(callResultText(res), toolName) };
    },
  };
}
