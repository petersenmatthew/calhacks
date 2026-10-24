"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useState } from "react";
import useSWR from "swr";
import { CircleHelp, Network, ShieldCheck, SquareKanban } from "lucide-react";
import { fetcher } from "@/lib/api";
import { periodLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { DashboardData } from "@/server/queries";
import { dashboardKey, Metrics } from "./dashboard/dashboard";
import { ClockControl } from "./dashboard/clock-control";
import { ResetButton } from "./dashboard/reset-button";
import { SimulateDialog } from "./dashboard/simulate-dialog";
import { hasSeenOnboarding, Onboarding } from "./onboarding";

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
  const { data, mutate } = useSWR<DashboardData>(dashboardKey(period), fetcher, { keepPreviousData: true });
  // First visit: a one-screen intro with a button that starts the sample case.
  const [intro, setIntro] = useState(false);
  useEffect(() => {
    // Read after mount (storage is browser-only), then open on the next frame.
    if (hasSeenOnboarding()) return;
    const raf = requestAnimationFrame(() => setIntro(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // Remember which work view was open last (adjusted during render, no effect needed).
  const here: View | null = pathname === "/board" ? "board" : pathname === "/canvas" ? "canvas" : null;
  if (here && here !== lastView) setLastView(here);

  const onTask = pathname.startsWith("/investigations");
  const active = pathname.startsWith("/audit")
    ? "audit"
    : pathname === "/board" || (onTask && lastView === "board")
        ? "board"
        : "canvas";

  // The landing page stands on its own: no app header, no intro dialog.
  if (pathname === "/welcome") return <>{children}</>;

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
          {data && data.periods.length > 1 ? (
            <select
              value={data.period}
              onChange={(e) => setPeriod(e.target.value)}
              className="h-7 rounded-md bg-transparent px-1 text-[12px] text-muted-foreground outline-none hover:bg-zinc-100"
            >
              {data.periods.map((p) => (
                <option key={p} value={p}>
                  {periodLabel(p, true)}
                </option>
              ))}
            </select>
          ) : data ? (
            <span className="text-[12px] text-muted-foreground">{periodLabel(data.period, true)}</span>
          ) : null}
          <div className="ml-auto flex items-center gap-4">
            {data ? <Metrics data={data} /> : null}
            <div className="flex items-center gap-1.5">
              {data ? <ClockControl now={data.clock.now} offsetMs={data.clock.offsetMs} onDone={() => mutate()} /> : null}
              <button
                type="button"
                onClick={() => setIntro(true)}
                aria-label="How MOA works"
                title="How MOA works"
                className="grid size-7 place-items-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
              >
                <CircleHelp className="size-4" />
              </button>
              <ResetButton onDone={() => mutate()} />
              <SimulateDialog onDone={() => mutate()} />
            </div>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
        <Onboarding open={intro} publicDemo={Boolean(data?.settings.publicDemo)} onClose={() => setIntro(false)} onStarted={() => mutate()} />
      </div>
    </ShellContext.Provider>
  );
}
