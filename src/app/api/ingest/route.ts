import { rateLimited } from "@/server/rate-limit";
import { errorResponse } from "@/server/http";
import { getContext } from "@/server/runtime";
import { ingestBillingEvent } from "@/server/workflow/ingestion";

/** Provider billing feed webhook. Source records must already exist in the sandbox. */
export async function POST(request: Request) {
  try {
    const limited = rateLimited(getContext(), request, "simulate");
    if (limited) return limited;
    return Response.json(ingestBillingEvent(getContext(), await request.json()));
  } catch (error) {
    return errorResponse(error);
  }
}
