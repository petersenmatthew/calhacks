import { z } from "zod";
import { askAssistant } from "@/server/assistant";
import { errorResponse } from "@/server/http";
import { getContext } from "@/server/runtime";

export const dynamic = "force-dynamic";

const body = z.object({
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(4000) })).min(1).max(40),
  taskId: z.string().max(40).nullable().optional(),
});

/** Read-only questions about the books. The assistant has no write tools. */
export async function POST(request: Request) {
  try {
    const input = body.parse(await request.json());
    const reply = await askAssistant(getContext(), input.messages, input.taskId ?? null);
    return Response.json({ reply });
  } catch (error) {
    return errorResponse(error);
  }
}

