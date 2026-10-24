import { eq } from "drizzle-orm";
import { z } from "zod";
import { vendorDisputes } from "@/server/db/schema";
import { errorResponse } from "@/server/http";
import { getContext } from "@/server/runtime";
import { ControlError } from "@/server/security/errors";
import { receiveVendorEmail } from "@/server/workflow/vendor-replies";

const body = z.object({ text: z.string().min(3).max(4000), from: z.string().max(200).optional() });

/** Record a vendor reply by hand (pasted from email, or typed for a demo). The Vendor Liaison picks it up like an emailed one. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { text, from } = body.parse(await request.json());
    const ctx = getContext();
    const dispute = ctx.db.select().from(vendorDisputes).where(eq(vendorDisputes.workItemId, id)).get();
    if (!dispute) throw new ControlError("There is no vendor dispute on " + id + ".", "NOT_FOUND", "FAILED");
    const result = receiveVendorEmail(ctx, {
      from: from || dispute.sentTo,
      subject: "Re: " + (dispute.letterSubject ?? dispute.id),
      text,
    });
    return Response.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
