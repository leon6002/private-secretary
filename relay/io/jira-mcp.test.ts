import { beforeEach, describe, expect, it, vi } from "vitest";

const callMcpTool = vi.fn();

vi.mock("./mcp-tool.js", () => ({
  callMcpTool: (...args: unknown[]) => callMcpTool(...args),
  callResultText: (res: unknown) => (res as { content: [{ text: string }] }).content[0].text,
  extractRef: (text: string, toolName: string) => `${toolName}: ${text.split("\n")[0]}`,
}));

const { createJiraToolRunner } = await import("./jira-mcp.js");

const textResult = (payload: unknown) => ({ content: [{ text: JSON.stringify(payload) }] });

const ONE_SITE = [{ id: "cloud-1", name: "jiraoxyz" }];

describe("createJiraToolRunner", () => {
  beforeEach(() => {
    callMcpTool.mockReset();
  });

  it("maps project→projectKey, defaults issueTypeName, calls createJiraIssue with cloudId", async () => {
    callMcpTool.mockImplementation(async (_url: string, _auth: string, tool: string) => {
      if (tool === "getAccessibleAtlassianResources") return textResult(ONE_SITE);
      if (tool === "createJiraIssue") return textResult({ key: "PST-1" });
      throw new Error(`unexpected tool ${tool}`);
    });

    const runner = createJiraToolRunner({ url: "https://mcp.atlassian.com/v1/mcp/authv2", authService: "svc" });
    const result = await runner.run({ project: "PST", summary: "Fix the widget", description: "details" });

    expect(result.ref).toContain("createJiraIssue");
    const createCall = callMcpTool.mock.calls.find((c) => c[2] === "createJiraIssue");
    expect(createCall?.[3]).toEqual({
      cloudId: "cloud-1",
      projectKey: "PST",
      issueTypeName: "Task",
      summary: "Fix the widget",
      description: "details",
    });
  });

  it("resolves an unambiguous human assignee to assignee_account_id", async () => {
    callMcpTool.mockImplementation(async (_url: string, _auth: string, tool: string) => {
      if (tool === "getAccessibleAtlassianResources") return textResult(ONE_SITE);
      if (tool === "lookupJiraAccountId") {
        return textResult({
          data: {
            users: {
              users: [
                { accountId: "acc-1", displayName: "Alice Chen", accountType: "atlassian" },
                { accountId: "bot-1", displayName: "Automation for Jira", accountType: "app" },
              ],
            },
          },
        });
      }
      if (tool === "createJiraIssue") return textResult({ key: "PST-2" });
      throw new Error(`unexpected tool ${tool}`);
    });

    const runner = createJiraToolRunner({ url: "https://mcp.atlassian.com/v1/mcp/authv2-2", authService: "svc" });
    await runner.run({ project: "PST", summary: "Ship it", assignee: "Alice Chen" });

    const createCall = callMcpTool.mock.calls.find((c) => c[2] === "createJiraIssue");
    expect(createCall?.[3]).toMatchObject({ assignee_account_id: "acc-1" });
  });

  it("throws instead of guessing when the assignee query is ambiguous", async () => {
    callMcpTool.mockImplementation(async (_url: string, _auth: string, tool: string) => {
      if (tool === "getAccessibleAtlassianResources") return textResult(ONE_SITE);
      if (tool === "lookupJiraAccountId") {
        return textResult({
          data: {
            users: {
              users: [
                { accountId: "acc-1", displayName: "Alice Chen", accountType: "atlassian" },
                { accountId: "acc-2", displayName: "Alice Chen", accountType: "atlassian" },
              ],
            },
          },
        });
      }
      throw new Error(`unexpected tool ${tool}`);
    });

    const runner = createJiraToolRunner({ url: "https://mcp.atlassian.com/v1/mcp/authv2-3", authService: "svc" });
    await expect(runner.run({ project: "PST", summary: "Ship it", assignee: "Alice Chen" })).rejects.toThrow(
      /more than one/,
    );
  });

  it("throws when the connected account has more than one accessible Atlassian site", async () => {
    callMcpTool.mockImplementation(async (_url: string, _auth: string, tool: string) => {
      if (tool === "getAccessibleAtlassianResources") {
        return textResult([
          { id: "cloud-a", name: "site-a" },
          { id: "cloud-b", name: "site-b" },
        ]);
      }
      throw new Error(`unexpected tool ${tool}`);
    });

    const runner = createJiraToolRunner({ url: "https://mcp.atlassian.com/v1/mcp/authv2-4", authService: "svc" });
    await expect(runner.run({ project: "PST", summary: "Ship it" })).rejects.toThrow(/ambiguous/);
  });
});
