import { z } from "zod";
import { errorResponse } from "@/server/http";
import { getContext } from "@/server/runtime";
import { recordVendorResponse } from "@/server/workflow/decisions";

const body = z.object({ outcome: z.enum(["accept", "deny"]) });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { outcome } = body.parse(await request.json());
    return Response.json(recordVendorResponse(getContext(), { workItemId: id, outcome }));
  } catch (error) {
    return errorResponse(error);
  }
}
