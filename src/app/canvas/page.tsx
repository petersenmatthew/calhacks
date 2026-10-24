import { Dashboard } from "@/components/dashboard/dashboard";

export default async function Page({ searchParams }: { searchParams: Promise<{ task?: string | string[] }> }) {
  const { task } = await searchParams;
  return <Dashboard view="canvas" task={typeof task === "string" ? task : null} />;
}
