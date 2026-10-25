import { eq } from "drizzle-orm";
import { contracts, providers } from "@/server/db/schema";
import { contextFor } from "@/server/runtime";

export const dynamic = "force-dynamic";

/** One provider contract, with the provider it is with. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = contextFor(request);
  const contract = ctx.db.select().from(contracts).where(eq(contracts.id, id)).get();
  if (!contract) return Response.json({ error: "Contract not found" }, { status: 404 });
  const provider = ctx.db.select().from(providers).where(eq(providers.id, contract.providerId)).get() ?? null;
  return Response.json({ contract, provider });
}
