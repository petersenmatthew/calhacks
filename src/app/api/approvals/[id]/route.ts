import { z } from "zod";
import { errorResponse } from "@/server/http";
import { getContext } from "@/server/runtime";
import { ACTOR } from "@/server/security/actors";
import { decideApproval } from "@/server/workflow/approvals";

const body = z.object({
  decision: z.enum(["APPROVED", "REJECTED", "CHANGES_REQUESTED"]),
  reason: z.string().max(2000).optional().nullable(),
  directive: z.enum(["usage_proportional", "owner_pays_idle", "owner_pays_all"]).optional().nullable(),
});

/** Human decisions. The demo has a single signed-in user: the controller. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const input = body.parse(await request.json());
    return Response.json(
      decideApproval(getContext(), {
        approvalId: id,
        actorId: ACTOR.controller,
        decision: input.decision,
        reason: input.reason ?? null,
        directive: input.directive ?? null,
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
