import type { Metadata } from "next";
import { Landing } from "@/components/landing/landing";

export const metadata: Metadata = {
  title: "MOA: Mixture of Accountants",
  description: "Six AI employees catch GPU overbilling, dispute it with the vendor, and book the result.",
};

export default function Page() {
  return <Landing />;
}
