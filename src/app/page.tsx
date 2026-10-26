import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Landing } from "@/components/landing/landing";

export const metadata: Metadata = {
  title: "moa: a mixture of accountants",
  description: "An autonomous AP and cost team for AI lab compute spend.",
};

/**
 * The bare domain. A public demo (PUBLIC_DEMO=1) shows the landing page here; a local or
 * team setup goes straight to the canvas.
 */
export default async function Page() {
  // Read the environment at request time, not when the page is prerendered at build.
  await connection();
  const publicDemo = process.env.PUBLIC_DEMO === "1" || process.env.PUBLIC_DEMO === "true";
  if (!publicDemo) redirect("/canvas");
  return <Landing />;
}
