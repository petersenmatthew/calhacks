import { rateLimited } from "@/server/rate-limit";
import { z } from "zod";
import { askAboutFrame, askAssistant } from "@/server/assistant";
import { errorResponse } from "@/server/http";
import { getContext } from "@/server/runtime";

export const dynamic = "force-dynamic";

const body = z.object({
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(4000) })).min(1).max(40),
  taskId: z.string().max(40).nullable().optional(),
  /** Untagged frame id ("act-123", "intake-rules"). Talks to the employee who made that frame. */
  frameId: z.string().max(80).nullable().optional(),
});

/** Read-only questions about the books. The assistant has no write tools. */
export async function POST(request: Request) {
  try {
    const limited = rateLimited(getContext(), request, "chat");
    if (limited) return limited;
    const input = body.parse(await request.json());
    const reply =
      input.frameId && input.taskId
        ? await askAboutFrame(getContext(), input.messages, input.taskId, input.frameId)
        : await askAssistant(getContext(), input.messages, input.taskId ?? null);
    return Response.json({ reply });
  } catch (error) {
    return errorResponse(error);
  }
}

