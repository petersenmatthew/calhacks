import { describe, expect, it } from "vitest";
import { connectedPaths } from "../src/lib/flow-paths";

const edges = [
  { from: "source-a", to: "agent" },
  { from: "source-b", to: "agent" },
  { from: "agent", to: "artifact" },
  { from: "artifact", to: "accounts" },
  { from: "artifact", to: "engineering" },
];

describe("flow path highlighting", () => {
  it("traces a child's ancestors without highlighting its sibling", () => {
    expect([...connectedPaths(edges, "accounts")].sort()).toEqual([
      "agent:artifact", "artifact:accounts", "source-a:agent", "source-b:agent",
    ]);
  });
  it("traces a parent's descendants without crossing into another source", () => {
    expect([...connectedPaths(edges, "source-a")].sort()).toEqual([
      "agent:artifact", "artifact:accounts", "artifact:engineering", "source-a:agent",
    ]);
  });
  it("clears highlights on exit and terminates on cycles", () => {
    expect(connectedPaths(edges, null).size).toBe(0);
    expect(connectedPaths([{ from: "a", to: "b" }, { from: "b", to: "a" }], "a").size).toBe(2);
  });
});
