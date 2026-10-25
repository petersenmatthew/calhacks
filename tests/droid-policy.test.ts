import { describe, expect, it } from "vitest";
import { isAllowed, requestedCalls } from "@/server/agents/droid";

// Shape of a real Droid permission request: tool calls arrive batched inside a Script.
const script = (...calls: object[]) => [{ toolUse: { name: "Script" }, confirmationType: "script", details: { type: "script", impactLevel: "high", calls } }];
const mcp = (server: string, tool: string) => ({ toolName: server + "___" + tool, confirmation: { type: "mcp_tool", serverName: server, actualToolName: tool } });
const allowed = new Set(["get_work_item", "submit_compute_findings"]);

describe("Droid permission policy", () => {
  it("approves calls to the employee's own gateway tools", () => {
    expect(isAllowed(requestedCalls(script(mcp("moa", "get_work_item"), mcp("moa", "submit_compute_findings"))), allowed)).toBe(true);
  });

  it("rejects a batch that includes another employee's tool, another server, or a Droid built-in", () => {
    expect(isAllowed(requestedCalls(script(mcp("moa", "get_work_item"), mcp("moa", "approve_payment"))), allowed)).toBe(false);
    expect(isAllowed(requestedCalls(script(mcp("other", "get_work_item"))), allowed)).toBe(false);
    expect(isAllowed(requestedCalls(script(mcp("moa", "get_work_item"), { toolName: "Execute" })), allowed)).toBe(false);
    expect(isAllowed(requestedCalls([{ toolUse: { name: "Execute" }, details: { type: "execute" } }]), allowed)).toBe(false);
    expect(isAllowed(requestedCalls([]), allowed)).toBe(false);
  });
});
