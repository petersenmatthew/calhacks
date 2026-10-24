import { z } from "zod";
import { errorResponse } from "@/server/http";
import { getSettingsView } from "@/server/queries";
import { getContext } from "@/server/runtime";
import { ACTOR } from "@/server/security/actors";
import { setExecutionMode, setRunMode } from "@/server/settings";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(getSettingsView(getContext()));
}

const body = z.object({ mode: z.enum(["llm", "deterministic"]).optional(), runMode: z.enum(["one", "all"]).optional() });

export async function POST(request: Request) {
  try {
    const { mode, runMode } = body.parse(await request.json());
    if (mode) setExecutionMode(getContext(), ACTOR.controller, mode);
    if (runMode) setRunMode(getContext(), ACTOR.controller, runMode);
    return Response.json(getSettingsView(getContext()));
  } catch (error) {
    return errorResponse(error);
  }
}
