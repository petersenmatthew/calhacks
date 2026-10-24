"use client";

import { createContext, useContext } from "react";
import type { WorkspaceData } from "@/server/queries";

export interface WorkspaceCtx {
  data: WorkspaceData;
  openEvidence: (id: string) => void;
  refresh: () => void;
}

export const WorkspaceContext = createContext<WorkspaceCtx | null>(null);

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace outside provider");
  return ctx;
}

export const PROJECT_COLORS: Record<string, { bar: string; dot: string; text: string }> = {
  "PRJ-FLM": { bar: "bg-indigo-500", dot: "bg-indigo-500", text: "text-indigo-700" },
  "PRJ-MMP": { bar: "bg-amber-500", dot: "bg-amber-500", text: "text-amber-700" },
  "PRJ-RLA": { bar: "bg-emerald-500", dot: "bg-emerald-500", text: "text-emerald-700" },
  "PRJ-INF": { bar: "bg-sky-500", dot: "bg-sky-500", text: "text-sky-700" },
};

export const SIMULATED_SOURCES = new Set([
  "invoice_line",
  "lifecycle",
  "job_log",
  "provider_usage",
  "experiment",
  "contract",
  "reservation",
  "usage",
  "budget",
]);

export const ACCOUNT_NAMES: Record<string, string> = {
  "2000": "Accounts payable",
  "6100": "GPU compute expense",
  "6990": "Compute clearing",
};
