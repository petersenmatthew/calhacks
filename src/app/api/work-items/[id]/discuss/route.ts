import { z } from "zod";
import { discussDecision } from "@/server/assistant";
import { errorResponse } from "@/server/http";
import { getContext } from "@/server/runtime";

export const dynamic = "force-dynamic";

const body = z.object({
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(4000) })).max(40),
});

/** Talk a pending decision through with the employee who asked. Read-only: the controller confirms separately. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { messages } = body.parse(await request.json());
    return Response.json(await discussDecision(getContext(), messages, id));
  } catch (error) {
    return errorResponse(error);
  }
}
