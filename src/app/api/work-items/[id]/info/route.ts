import { rateLimited } from "@/server/rate-limit";
import { z } from "zod";
import { errorResponse } from "@/server/http";
import { contextFor } from "@/server/runtime";
import { ACTOR } from "@/server/security/actors";
import { provideInformation } from "@/server/workflow/info";

const body = z.object({ answer: z.string().min(3).max(2000) });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const limited = rateLimited(contextFor(request), request, "decide");
    if (limited) return limited;
    const { id } = await params;
    const { answer } = body.parse(await request.json());
    return Response.json(provideInformation(contextFor(request), { workItemId: id, actorId: ACTOR.controller, answer }));
  } catch (error) {
    return errorResponse(error);
  }
}
