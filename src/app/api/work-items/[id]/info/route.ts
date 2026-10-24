import { z } from "zod";
import { errorResponse } from "@/server/http";
import { getContext } from "@/server/runtime";
import { ACTOR } from "@/server/security/actors";
import { provideInformation } from "@/server/workflow/info";

const body = z.object({ answer: z.string().min(3).max(2000) });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { answer } = body.parse(await request.json());
    return Response.json(provideInformation(getContext(), { workItemId: id, actorId: ACTOR.controller, answer }));
  } catch (error) {
    return errorResponse(error);
  }
}
