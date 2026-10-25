"use client";

import Link from "next/link";
import { contractHref } from "@/lib/contracts";

const link = "underline decoration-zinc-300 decoration-1 underline-offset-[3px] hover:decoration-zinc-700";

/*
 * Turns contract references in a sentence into links: contract ids (HC-2025-114),
 * clause numbers ("clauses 4.1 and 4.2", "§4.2"), and the word "contract" when we
 * know which contract the sentence is about.
 */
const PATTERN = /([A-Z]{2}-\d{4}-\d{3})|((?:[Cc]lauses?|§)\s*\d+\.\d+(?:(?:,\s*|,?\s+and\s+|\s*)\d+\.\d+)*)|\b([Cc]ontract)(?![-\w])/g;

export function ContractLinked({ text, contractId }: { text: string; contractId?: string | null }) {
  const out: React.ReactNode[] = [];
  let last = 0;
  let wordLinked = false;
  for (const m of text.matchAll(PATTERN)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const [whole, id, clauses, word] = m;
    if (id) {
      out.push(
        <Link key={at} href={contractHref(id)} className={link} onClick={(e) => e.stopPropagation()}>
          {id}
        </Link>,
      );
    } else if (clauses && contractId) {
      // Link each clause number to its place in the contract.
      let i = 0;
      for (const p of clauses.split(/(\d+\.\d+)/)) {
        if (/^\d+\.\d+$/.test(p)) {
          out.push(
            <Link key={at + "-" + i++} href={contractHref(contractId, p)} className={link} onClick={(e) => e.stopPropagation()}>
              {p}
            </Link>,
          );
        } else if (p) out.push(p);
      }
    } else if (word && contractId && !wordLinked) {
      wordLinked = true;
      out.push(
        <Link key={at} href={contractHref(contractId)} className={link} onClick={(e) => e.stopPropagation()}>
          {word}
        </Link>,
      );
    } else {
      out.push(whole);
    }
    last = at + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}
