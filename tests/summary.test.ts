import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { vendorDisputes } from "@/server/db/schema";
import { taskSummary } from "@/lib/summary";
import { getWorkspace } from "@/server/queries";
import { ACTOR } from "@/server/security/actors";
import { runScenario } from "@/server/sim/scenarios";
import { decideApproval } from "@/server/workflow/approvals";
import { receiveVendorEmail } from "@/server/workflow/vendor-replies";
import { pendingApprovals, setup } from "./helpers";

describe("task summary", () => {
  it("sums up a credited dispute: the money, who did what, and the controller's one decision", async () => {
    const { ctx, orchestrator } = setup();
    await orchestrator.drain();
    const r = runScenario(ctx, "overbilling");
    const id = r.status === "work_item_created" ? r.workItemId : "";
    await orchestrator.drain();
    decideApproval(ctx, { approvalId: pendingApprovals(ctx, id)[0].id, actorId: ACTOR.controller, decision: "APPROVED" });
    await orchestrator.drain();
    const d = ctx.db.select().from(vendorDisputes).where(eq(vendorDisputes.workItemId, id)).get()!;
    receiveVendorEmail(ctx, { from: "billing@lambda.test", subject: "Re: " + d.letterSubject, text: "We have issued credit memo CM-10422 for $1,200.00.", receivedAt: new Date(Date.now() + 1000).toISOString() });
    await orchestrator.drain();

    const w = getWorkspace(ctx, id)!;
    expect(w.item.state).toBe("RESOLVED");
    const s = taskSummary(w);
    expect(s.figures).toEqual([
      { label: "Billed", value: "$3,600" },
      { label: "Recovered", value: "$1,200", tone: "good" },
      { label: "Charged to team", value: "$2,400" },
    ]);
    expect(s.you).toBe(1);
    expect(s.steps.some((x) => x.actorId === ACTOR.controller && x.text.startsWith("Approved"))).toBe(true);
    expect(s.steps.some((x) => x.text.includes("CM-10422"))).toBe(true);
    expect(s.steps.at(-1)?.actorId).toBe("system.ledger_gateway");
  });
});
