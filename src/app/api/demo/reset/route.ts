import { rateLimited } from "@/server/rate-limit";
import { errorResponse } from "@/server/http";
import { getContext, resetEnvironment } from "@/server/runtime";
import { ACTOR } from "@/server/security/actors";

export async function POST(request: Request) {
  try {
    const limited = rateLimited(getContext(), request, "reset");
    if (limited) return limited;
    await resetEnvironment(ACTOR.controller);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
