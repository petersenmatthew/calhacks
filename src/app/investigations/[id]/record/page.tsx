import { Workspace } from "@/components/workspace/workspace";

/** The full record of a task: every agent step, the evidence, and the log. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Workspace id={id} />;
}

