"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useState } from "react";
import useSWR from "swr";
import { Network, ShieldCheck, SquareKanban } from "lucide-react";
import { fetcher } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { DashboardData } from "@/server/queries";
import { dashboardKey } from "./dashboard/dashboard";
import { ResetButton } from "./dashboard/reset-button";
import { SimulateDialog } from "./dashboard/simulate-dialog";

type View = "board" | "canvas";

type Shell = {
  period: string | null;
  setPeriod: (p: string) => void;
  /** The work view the person last looked at, so the task page can go back to it. */
  lastView: View;
};

const ShellContext = createContext<Shell>({ period: null, setPeriod: () => {}, lastView: "canvas" });
export const useShell = () => useContext(ShellContext);
export const viewHref = (v: View) => (v === "board" ? "/board" : "/canvas");

const TABS = [
  { key: "canvas", href: "/canvas", label: "Canvas", icon: Network },
  { key: "board", href: "/board", label: "Board", icon: SquareKanban },
  { key: "audit", href: "/audit", label: "Audit trail", icon: ShieldCheck },
] as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [period, setPeriod] = useState<string | null>(null);
  const [lastView, setLastView] = useState<View>("canvas");
  const { mutate } = useSWR<DashboardData>(dashboardKey(period), fetcher, { keepPreviousData: true });

  // Remember which work view was open last (adjusted during render, no effect needed).
  const here: View | null = pathname === "/board" ? "board" : pathname === "/canvas" ? "canvas" : null;
  if (here && here !== lastView) setLastView(here);

  const onTask = pathname.startsWith("/investigations");
  const active = pathname.startsWith("/audit")
    ? "audit"
    : pathname === "/board" || (onTask && lastView === "board")
        ? "board"
        : "canvas";

  return (
    <ShellContext.Provider value={{ period, setPeriod, lastView }}>
      <div className="flex h-dvh flex-col overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
          <nav className="flex rounded-md bg-zinc-100 p-0.5">
            {TABS.map((t) => (
              <Link
                key={t.key}
                href={t.href}
                className={cn(
                  "flex items-center gap-1.5 rounded px-2 py-0.5 text-[12px] font-medium",
                  active === t.key ? "bg-white text-zinc-900 shadow-xs" : "text-zinc-500 hover:text-zinc-800",
                )}
              >
                <t.icon className="size-3.5" />
                {t.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-4">
            <div className="flex items-center gap-1.5">
              <ResetButton onDone={() => mutate()} />
              <SimulateDialog onDone={() => mutate()} />
            </div>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
      </div>
    </ShellContext.Provider>
  );
}
