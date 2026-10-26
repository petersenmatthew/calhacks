import type { Metadata } from "next";
import { About } from "../../../src/components/landing/about";

export const metadata: Metadata = {
  title: "About · moa",
  description: "A small team of AI accountants that checks every GPU bill before it gets paid.",
};

export default function Page() {
  return <About />;
}
