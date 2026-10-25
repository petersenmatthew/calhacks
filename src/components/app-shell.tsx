"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import { createContext, useContext, useEffect, useState } from "react";
import useSWR from "swr";
import { CircleHelp, LoaderCircle, Network, ShieldCheck, SquareKanban } from "lucide-react";
import { fetcher, postJson } from "@/lib/api";
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

/** Seconds between leaving the intro and the sample invoice arriving. */
const START_PAUSE_S = 3;

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

  // After the intro, give people a moment to take in the canvas before the team starts moving.
  const router = useRouter();
  const [countdown, setCountdown] = useState<number | null>(null);
  const startSample = async () => {
    setIntro(false);
    if (pathname !== "/canvas") router.push("/canvas");
    for (let n = START_PAUSE_S; n > 0; n--) {
      setCountdown(n);
      await new Promise((r) => setTimeout(r, 1000));
    }
    try {
      const r = await postJson<{ status: string; workItemId?: string | null }>("/api/demo/simulate", { scenario: "overbilling" });
      router.push(r.workItemId ? "/canvas?task=" + r.workItemId : "/canvas");
      mutate();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setCountdown(null);
    }
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
        <Onboarding open={intro} publicDemo={Boolean(data?.settings.publicDemo)} onClose={() => setIntro(false)} onStart={startSample} />
        {countdown !== null ? (
          <div
            role="status"
            className="animate-enter fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full bg-zinc-900 px-4 py-2 text-[13px] font-medium text-white shadow-lg"
          >
            <LoaderCircle className="size-4 animate-spin" />
            A Lambda invoice arrives in {countdown}&hellip;
          </div>
        ) : null}
      </div>
    </ShellContext.Provider>
  );
}
