import { redirect } from "next/navigation";

/** Tasks are reviewed in the canvas sidebar. Old task links land there. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect("/canvas?task=" + id);
}

