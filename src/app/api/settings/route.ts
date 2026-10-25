import { z } from "zod";
import { errorResponse } from "@/server/http";
import { getSettingsView } from "@/server/queries";
import { contextFor } from "@/server/runtime";
import { ACTOR } from "@/server/security/actors";
import { setExecutionMode } from "@/server/settings";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return Response.json(getSettingsView(contextFor(request)));
}

const body = z.object({ mode: z.enum(["llm", "deterministic"]) });

export async function POST(request: Request) {
  try {
    const { mode } = body.parse(await request.json());
    setExecutionMode(contextFor(request), ACTOR.controller, mode);
    return Response.json(getSettingsView(contextFor(request)));
  } catch (error) {
    return errorResponse(error);
  }
}
