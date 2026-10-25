"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useState } from "react";
import useSWR from "swr";
import { CircleHelp, Network, ShieldCheck, SquareKanban } from "lucide-react";
import { fetcher } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { DashboardData } from "@/server/queries";
import { dashboardKey } from "./dashboard/dashboard";
import { ResetButton } from "./dashboard/reset-button";
import { SimulateDialog } from "./dashboard/simulate-dialog";
import { FLOWER_COLORS, Flower } from "./landing/meadow";
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
    // Read in the browser (storage is browser-only), then open on the next frame. Checked on every
    // page change, since the shell stays mounted when the landing page's Start moves to the canvas.
    // Coming from that Start: always show it. Otherwise only the first time.
    if (pathname === "/welcome") return;
    const fromLanding = new URLSearchParams(window.location.search).get("intro") === "1";
    if (fromLanding) window.history.replaceState(null, "", window.location.pathname);
    if (!fromLanding && hasSeenOnboarding()) return;
    const raf = requestAnimationFrame(() => setIntro(true));
    return () => cancelAnimationFrame(raf);
  }, [pathname]);

  // The intro hands off to the billing-event picker; nothing starts until one is chosen.
  const router = useRouter();
  const [simulating, setSimulating] = useState(false);
  const pickEvent = () => {
    setIntro(false);
    if (pathname !== "/canvas") router.push("/canvas");
    setSimulating(true);
  };

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
        <header className="flex h-14 shrink-0 items-center gap-4 border-b border-zinc-200/80 px-4">
          <Link href="/welcome" className="flex items-center gap-1.5 pr-1 text-[17px] font-semibold tracking-[-0.03em] text-zinc-950">
            <Flower petal={FLOWER_COLORS[2].petal} eye={FLOWER_COLORS[2].eye} size={14} />
            moa
          </Link>
          <nav className="flex gap-0.5">
            {TABS.map((t) => (
              <Link
                key={t.key}
                href={t.href}
                className={cn(
                  "flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors",
                  active === t.key ? "bg-zinc-100 text-zinc-900" : "text-zinc-500 hover:bg-zinc-50 hover:text-zinc-800",
                )}
              >
                <t.icon className="size-4" />
                {t.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-4">
            <div className="flex items-center gap-1.5">
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
              <SimulateDialog onDone={() => mutate()} open={simulating} onOpenChange={setSimulating} />
            </div>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
        <Onboarding open={intro} publicDemo={Boolean(data?.settings.publicDemo)} onClose={() => setIntro(false)} onStart={pickEvent} />
      </div>
    </ShellContext.Provider>
  );
}
