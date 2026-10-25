import { z } from "zod";
import { advanceClock } from "@/server/clock";
import { errorResponse } from "@/server/http";
import { runtimeFor } from "@/server/runtime";
import { ACTOR } from "@/server/security/actors";

const body = z.object({ hours: z.number().positive().max(24 * 90) });

/** Demo control: move the business clock forward, then run the scheduler right away. */
export async function POST(request: Request) {
  try {
    const { hours } = body.parse(await request.json());
    const { ctx, orchestrator } = runtimeFor(request);
    const result = advanceClock(ctx, ACTOR.controller, hours);
    await orchestrator.runSchedule();
    return Response.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
