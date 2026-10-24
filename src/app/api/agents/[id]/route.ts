import { z } from "zod";
import { errorResponse } from "@/server/http";
import { getAgentView } from "@/server/queries";
import { getContext } from "@/server/runtime";
import { ACTOR } from "@/server/security/actors";
import { setAgentSettings } from "@/server/settings";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const view = getAgentView(getContext(), id);
  if (!view) return Response.json({ error: "Agent not found" }, { status: 404 });
  return Response.json(view);
}

const body = z.object({ paused: z.boolean().optional(), guidance: z.string().max(2000).optional() });

/** Update an employee's settings. Every request acts as the controller (the demo has one user). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    setAgentSettings(getContext(), ACTOR.controller, id, body.parse(await request.json()));
    return Response.json(getAgentView(getContext(), id));
  } catch (error) {
    return errorResponse(error);
  }
}
