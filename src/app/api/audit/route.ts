import { getAuditView } from "@/server/queries";
import { contextFor } from "@/server/runtime";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return Response.json(getAuditView(contextFor(request)));
}
