import { describe, expect, it } from "vitest";
import { buildFrames } from "@/lib/frames";
import { getWorkspace } from "@/server/queries";
import { runScenario } from "@/server/sim/scenarios";
import { setup } from "./helpers";

describe("blocked tool calls on the canvas", () => {
  it("shows a blocked call the agent then redid as a correction, and a lone one as a failure", async () => {
    const { ctx, orchestrator } = setup();
    await orchestrator.drain();
    const r = runScenario(ctx, "shared_allocation");
    const id = r.status === "work_item_created" ? r.workItemId : "";
    await orchestrator.drain();
    const w = getWorkspace(ctx, id)!;
    const at = w.activity.findIndex((a) => a.toolName === "propose_adjustment" && a.status !== "error");
    expect(at).toBeGreaterThan(0);
    const ok = w.activity[at];
    const blocked = {
      ...ok,
      id: ok.id - 0.5,
      toolName: null,
      status: "error",
      title: "Cost Allocator failed: tool:propose_adjustment",
      summary: "Unknown evidence ids for " + id + ": F-5005 [EVIDENCE_REQUIRED]",
    };

    const fixed = buildFrames({ ...w, activity: [...w.activity.slice(0, at), blocked, ...w.activity.slice(at)] }).find((f) => f.id === "act-" + blocked.id)!;
    expect(fixed.label).toBe("Corrected");
    expect(fixed.tone).toBe("warn");
    expect(fixed.spec.checks?.map((c) => c.ok)).toEqual([false, true]);

    const lone = buildFrames({ ...w, activity: [...w.activity, { ...blocked, id: 1e9 }] }).find((f) => f.id === "act-" + 1e9)!;
    expect(lone.label).toBe("Failed");
    expect(lone.tone).toBe("denied");
  });
});
