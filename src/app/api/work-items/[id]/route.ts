import { getWorkspace } from "@/server/queries";
import { getContext } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = getWorkspace(getContext(), id);
  if (!data) return Response.json({ error: "Work item not found" }, { status: 404 });
  return Response.json(data);
}
