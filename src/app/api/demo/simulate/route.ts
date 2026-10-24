import { z } from "zod";
import { errorResponse } from "@/server/http";
import { getContext } from "@/server/runtime";
import { runScenario } from "@/server/sim/scenarios";
import { setFocusWorkItem } from "@/server/settings";

const body = z.object({
  scenario: z.enum(["overbilling", "shared_allocation", "next_month_shared", "early_job_end", "custom", "duplicate"]),
  params: z
    .object({
      providerId: z.enum(["PRV-HELIOS", "PRV-MERIDIAN"]),
      projectId: z.string(),
      provisionedHours: z.number().positive().max(240),
      jobHours: z.number().positive().max(240),
      billedHours: z.number().positive().max(480),
      rateCents: z.number().int().positive().max(1_000_000).nullable().optional(),
    })
    .optional(),
});

export async function POST(request: Request) {
  try {
    const input = body.parse(await request.json());
    const result = runScenario(getContext(), input.scenario, input.params);
    // A new invoice goes to the front of the line, so the team picks it up next.
    if (result.status === "work_item_created") setFocusWorkItem(getContext(), result.workItemId);
    return Response.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
