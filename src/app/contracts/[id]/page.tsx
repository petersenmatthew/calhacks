import { ContractView } from "@/components/contract/contract-view";

/** A provider contract as a document: parties, rates, terms, and every clause. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ContractView id={id} />;
}
