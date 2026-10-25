import pdfs from "./contract-pdfs.json";

/** Where a contract (and optionally one clause in it) lives in the app. */
export function contractHref(id: string, ref?: string | null) {
  return "/contracts/" + encodeURIComponent(id) + (ref ? "#" + ref : "");
}

/** Contract ids look like HC-2025-114. */
export const CONTRACT_ID = /[A-Z]{2}-\d{4}-\d{3}/;

export type ContractPdf = { pdf: string; pages: number; clausePages: Record<string, number> };

/** The signed PDF for a contract, built by scripts/contracts/build_contract_pdfs.py. */
export function contractPdf(id: string): ContractPdf | null {
  return (pdfs as Record<string, ContractPdf>)[id] ?? null;
}

/** A small image of one page of the contract PDF. */
export function contractThumb(id: string, page: number) {
  return "/contracts/" + encodeURIComponent(id) + "-p" + page + ".png";
}
