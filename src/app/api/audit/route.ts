import { getAuditView } from "@/server/queries";
import { getContext } from "@/server/runtime";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(getAuditView(getContext()));
}
