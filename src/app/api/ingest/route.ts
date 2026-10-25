import { rateLimited } from "@/server/rate-limit";
import { errorResponse } from "@/server/http";
import { contextFor } from "@/server/runtime";
import { ingestBillingEvent } from "@/server/workflow/ingestion";

/** Provider billing feed webhook. Source records must already exist in the sandbox. */
export async function POST(request: Request) {
  try {
    const limited = rateLimited(contextFor(request), request, "simulate");
    if (limited) return limited;
    return Response.json(ingestBillingEvent(contextFor(request), await request.json()));
  } catch (error) {
    return errorResponse(error);
  }
}
