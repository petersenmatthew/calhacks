"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { ArrowLeft, Download, FileText } from "lucide-react";
import { fetcher } from "@/lib/api";
import { contractPdf } from "@/lib/contracts";
import { money } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ContractClause } from "@/server/db/schema";
import { Skeleton } from "../ui/skeleton";
import { PdfPages } from "./pdf-pages";

type Data = {
  contract: {
    id: string;
    name: string;
    effectiveFrom: string;
    rateCard: Record<string, number>;
    billingIncrementHours: number;
    minimumHours: number;
    idleBillable: boolean;
    reservationsBilledInFull: boolean;
    clauses: ContractClause[];
  };
  provider: { name: string; shortName: string } | null;
};

const longDate = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/**
 * The signed contract PDF, as filed in Ironclad, with the terms the agents use beside it.
 * A #4.1 hash opens the PDF on that clause's page and highlights it in the list.
 */
export function ContractView({ id }: { id: string }) {
  const router = useRouter();
  const { data, error } = useSWR<Data>("/api/contracts/" + encodeURIComponent(id), fetcher);
  const [hash, setHash] = useState<string | null>(null);
  useEffect(() => {
    const read = () => setHash(decodeURIComponent(window.location.hash.slice(1)) || null);
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  const pdf = contractPdf(id);
  const c = data?.contract;
  useEffect(() => {
    if (c && hash) document.getElementById("clause-item-" + hash)?.scrollIntoView({ block: "nearest" });
  }, [c, hash]);

  return (
    <div className="bg-canvas flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-zinc-200/80 px-4">
          <button type="button" onClick={() => router.back()} className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900">
            <ArrowLeft className="size-4" /> Back
          </button>
          <span className="flex min-w-0 items-center gap-1.5 text-[13px] text-zinc-700">
            <FileText className="size-4 shrink-0 text-zinc-400" />
            <span className="truncate">{id}.pdf</span>
            {pdf ? <span className="text-zinc-400">· {pdf.pages} pages</span> : null}
          </span>
          {pdf ? (
            <a href={pdf.pdf} download className="ml-auto flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900">
              <Download className="size-4" /> Download
            </a>
          ) : null}
        </div>
        {pdf ? (
          <div className="min-h-0 flex-1 overflow-y-auto bg-zinc-100">
            <PdfPages src={pdf.pdf} highlight={hash} />
          </div>
        ) : (
          <div className="grid flex-1 place-items-center text-[13px] text-zinc-500">No signed PDF on file for {id}.</div>
        )}
      </div>

      <aside className="flex w-[340px] shrink-0 flex-col overflow-y-auto border-l border-zinc-200/80 bg-white">
        {error ? <p className="p-5 text-[13px] text-destructive">Could not load contract {id}.</p> : null}
        {!c ? (
          error ? null : (
            <div className="p-5">
              <Skeleton className="h-40 rounded-xl" />
            </div>
          )
        ) : (
          <div className="px-5 pt-5 pb-6">
            <div className="flex items-center gap-1.5 text-[12px] text-zinc-500">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logos/ironclad.png" alt="" className="size-4 rounded-full object-cover" />
              Signed copy from Ironclad
            </div>
            <h1 className="mt-2 text-[19px] leading-tight font-semibold tracking-[-0.015em] text-zinc-950">{c.name}</h1>
            <p className="mt-1 text-[13px] text-zinc-500">
              {data.provider?.name ?? ""} · Effective {longDate(c.effectiveFrom)}
            </p>

            <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl bg-zinc-50 px-4 py-3.5 text-[12.5px]">
              {Object.entries(c.rateCard).map(([type, cents]) => (
                <div key={type}>
                  <dt className="text-zinc-500">{type}</dt>
                  <dd className="font-medium text-zinc-900 tnum">{money(cents)}/h</dd>
                </div>
              ))}
              <div>
                <dt className="text-zinc-500">Billed in</dt>
                <dd className="font-medium text-zinc-900">{c.billingIncrementHours} h increments</dd>
              </div>
              <div>
                <dt className="text-zinc-500">Minimum</dt>
                <dd className="font-medium text-zinc-900">{c.minimumHours} h</dd>
              </div>
              <div>
                <dt className="text-zinc-500">Idle time</dt>
                <dd className="font-medium text-zinc-900">{c.idleBillable ? "Billable" : "Not billable"}</dd>
              </div>
            </dl>

            <div className="mt-6 text-[13px] font-medium text-zinc-500">Clauses the team uses</div>
            <ul className="mt-2 space-y-1">
              {c.clauses.map((cl) => (
                <li key={cl.ref} id={"clause-item-" + cl.ref}>
                  <a
                    href={"#" + cl.ref}
                    className={cn("block rounded-xl px-3 py-2.5 transition-colors hover:bg-zinc-50", hash === cl.ref && "bg-accent ring-1 ring-primary/30 hover:bg-accent")}
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono text-[11.5px] text-zinc-400">§{cl.ref}</span>
                      <span className="text-[13px] font-medium text-zinc-900">{cl.title}</span>
                      {pdf?.clausePages[cl.ref] ? <span className="ml-auto shrink-0 text-[11.5px] text-zinc-400">p. {pdf.clausePages[cl.ref]}</span> : null}
                    </div>
                    <p className="mt-0.5 text-[12.5px] leading-snug text-zinc-600">{cl.text}</p>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </aside>
    </div>
  );
}
