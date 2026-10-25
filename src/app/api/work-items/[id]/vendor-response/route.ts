import { rateLimited } from "@/server/rate-limit";
import { z } from "zod";
import { errorResponse } from "@/server/http";
import { contextFor } from "@/server/runtime";
import { recordVendorResponse } from "@/server/workflow/decisions";

const body = z.object({ outcome: z.enum(["accept", "deny"]) });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const limited = rateLimited(contextFor(request), request, "vendor");
    if (limited) return limited;
    const { id } = await params;
    const { outcome } = body.parse(await request.json());
    return Response.json(recordVendorResponse(contextFor(request), { workItemId: id, outcome }));
  } catch (error) {
    return errorResponse(error);
  }
}
