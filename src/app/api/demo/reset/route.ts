import { errorResponse } from "@/server/http";
import { resetEnvironment } from "@/server/runtime";
import { ACTOR } from "@/server/security/actors";

export async function POST() {
  try {
    await resetEnvironment(ACTOR.controller);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
