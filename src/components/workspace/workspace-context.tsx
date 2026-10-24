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
  "PRJ-FLM": { bar: "bg-primary", dot: "bg-primary", text: "text-foreground" },
  "PRJ-MMP": { bar: "bg-zinc-700", dot: "bg-zinc-700", text: "text-foreground" },
  "PRJ-RLA": { bar: "bg-zinc-400", dot: "bg-zinc-400", text: "text-foreground" },
  "PRJ-INF": { bar: "bg-zinc-200", dot: "bg-zinc-200", text: "text-foreground" },
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
