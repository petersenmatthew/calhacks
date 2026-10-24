import { getDashboard } from "@/server/queries";
import { getContext } from "@/server/runtime";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const period = new URL(request.url).searchParams.get("period");
  return Response.json(getDashboard(getContext(), period));
}
