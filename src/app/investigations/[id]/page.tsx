import { ReviewPage } from "@/components/review/review-page";

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ v?: string | string[] }> }) {
  const [{ id }, { v }] = await Promise.all([params, searchParams]);
  return <ReviewPage id={id} variant={v === "proof" ? "proof" : "focus"} />;
}

