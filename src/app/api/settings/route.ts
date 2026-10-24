import { z } from "zod";
import { errorResponse } from "@/server/http";
import { getSettingsView } from "@/server/queries";
import { getContext } from "@/server/runtime";
import { ACTOR } from "@/server/security/actors";
import { setExecutionMode } from "@/server/settings";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(getSettingsView(getContext()));
}

const body = z.object({ mode: z.enum(["llm", "deterministic"]) });

export async function POST(request: Request) {
  try {
    const { mode } = body.parse(await request.json());
    setExecutionMode(getContext(), ACTOR.controller, mode);
    return Response.json(getSettingsView(getContext()));
  } catch (error) {
    return errorResponse(error);
  }
}
