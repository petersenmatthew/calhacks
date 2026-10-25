import { rateLimited } from "@/server/rate-limit";
import { errorResponse } from "@/server/http";
import { contextFor, resetEnvironment } from "@/server/runtime";
import { ACTOR } from "@/server/security/actors";

export async function POST(request: Request) {
  try {
    const limited = rateLimited(contextFor(request), request, "reset");
    if (limited) return limited;
    await resetEnvironment(ACTOR.controller, request);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
