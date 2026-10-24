"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowRight, BookCheck, LoaderCircle, ShieldCheck, UserCheck } from "lucide-react";
import { postJson } from "@/lib/api";
import { cn } from "@/lib/utils";
import { PixelAgent, spriteTint, type SpriteMood } from "../pixel-agent";

/** The cast, left to right on the stage. "you" is the controller, in the middle. */
const CAST = [
  { id: "agent.capacity", name: "Capacity Planner", dept: "Procurement", job: "Works out who used the reserved GPUs." },
  { id: "agent.compute", name: "Compute Investigator", dept: "FinOps", job: "Checks every billed hour against what actually ran." },
  { id: "agent.finance", name: "Cost Accountant", dept: "Accounting", job: "Proposes the booking or the dispute, with the math." },
  { id: "you", name: "You", dept: "Controller", job: "Approve money and judgment calls. Nothing else." },
  { id: "agent.vendor", name: "Vendor Liaison", dept: "Payables", job: "Emails the vendor, answers back, books the credit." },
  { id: "agent.budget", name: "Budget Analyst", dept: "FP&A", job: "Warns a team lead before they blow their budget." },
  { id: "agent.policy", name: "Policy Analyst", dept: "Controls", job: "Turns your corrections into rules for next time." },
] as const;

/** One overbilled invoice, start to finish, as the team plays it. */
const STORY: { who: (typeof CAST)[number]["id"]; say: string; mood?: SpriteMood }[] = [
  { who: "agent.compute", say: "Lambda billed 36 h. It ran 24.", mood: "tilt" },
  { who: "agent.finance", say: "Dispute $1,200. Pay the other $2,400." },
  { who: "you", say: "Approved.", mood: "nod" },
  { who: "agent.vendor", say: "Emailed Lambda the evidence and clause 4.2." },
  { who: "agent.vendor", say: "Lambda says: credit memo CM-1042.", mood: "hop" },
  { who: "agent.budget", say: "Frontier team is back under budget." },
  { who: "agent.policy", say: "Noted. Small variances can auto-book now." },
  { who: "you", say: "That’s $1,200 back. Next!", mood: "party" },
];

const BEAT_MS = 2400;

function Bubble({ text }: { text: string }) {
  return (
    <div className="animate-enter absolute bottom-full left-1/2 z-10 mb-3 hidden w-max max-w-[220px] -translate-x-1/2 sm:block rounded-xl bg-white px-3 py-2 text-center text-[13px] leading-snug font-medium text-zinc-800 shadow-[0_2px_12px_rgb(0_0_0/0.10)] ring-1 ring-zinc-200">
      {text}
      <span className="absolute top-full left-1/2 -mt-[5px] size-2.5 -translate-x-1/2 rotate-45 bg-white ring-1 ring-zinc-200 [clip-path:polygon(100%_0,100%_100%,0_100%)]" />
    </div>
  );
}

/** The team on a little stage, acting out one dispute on a loop. */
function Stage() {
  const [beat, setBeat] = useState(0);
  useEffect(() => {
    const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const t = window.setInterval(() => setBeat((b) => (b + 1) % STORY.length), reduced ? BEAT_MS * 1.6 : BEAT_MS);
    return () => window.clearInterval(t);
  }, []);
  const now = STORY[beat];
  return (
    <div className="relative overflow-hidden rounded-3xl bg-white/70 px-4 pt-8 pb-6 ring-1 ring-zinc-200 sm:px-8 sm:pt-28">
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-accent/70 to-transparent" />
      <div className="relative flex items-end justify-between gap-1 sm:gap-3">
        {CAST.map((c) => {
          const on = now.who === c.id;
          const you = c.id === "you";
          return (
            <div key={c.id} className="relative flex min-w-0 flex-1 flex-col items-center">
              {on ? <Bubble key={beat} text={now.say} /> : null}
              <div
                className={cn("grid place-items-center rounded-xl transition-all duration-300 sm:rounded-2xl", you ? "size-[48px] sm:size-[104px]" : "size-[40px] sm:size-[76px]", on ? "ring-2 ring-primary" : "ring-1 ring-black/5", !on && "opacity-80")}
                style={{ background: spriteTint(c.id) }}
              >
                <PixelAgent
                  key={on ? "on-" + beat : c.id}
                  actorId={c.id}
                  size={you ? 64 : 46}
                  working={on}
                  mood={on ? now.mood : undefined}
                  className={you ? "h-auto w-[34px] sm:w-[64px]" : "h-auto w-[28px] sm:w-[46px]"}
                />
              </div>
              <div className={cn("mt-2 hidden max-w-full truncate text-center text-[12px] font-medium sm:block", on ? "text-zinc-900" : "text-zinc-500")}>{c.name}</div>
              <div className="hidden font-mono text-[10px] tracking-wider text-zinc-400 uppercase sm:block">{c.dept}</div>
            </div>
          );
        })}
      </div>
      {/* Phones: the line as a caption under the row, since bubbles would run off the edge. */}
      <p key={"cap-" + beat} className="animate-enter relative mt-4 text-center text-[14px] font-medium text-zinc-800 sm:hidden">
        <span className="text-zinc-500">{CAST.find((c) => c.id === now.who)?.name}: </span>
        {now.say}
      </p>
      <div className="relative mt-5 flex justify-center gap-1.5" aria-hidden>
        {STORY.map((_, i) => (
          <span key={i} className={cn("h-1 rounded-full transition-all", i === beat ? "w-5 bg-zinc-900" : "w-1.5 bg-zinc-300")} />
        ))}
      </div>
    </div>
  );
}

function StartButton({ big = false, onDark = false }: { big?: boolean; onDark?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      const r = await postJson<{ status: string; workItemId?: string | null }>("/api/demo/simulate", { scenario: "overbilling" });
      try {
        window.localStorage.setItem("moa-onboarded-v1", "1");
      } catch {
        /* fine */
      }
      router.push(r.workItemId ? "/canvas?task=" + r.workItemId : "/canvas");
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={start}
      disabled={busy}
      className={cn(
        "inline-flex items-center gap-2 rounded-xl font-medium shadow-sm disabled:opacity-60",
        onDark ? "bg-primary text-primary-foreground hover:brightness-95" : "bg-zinc-900 text-white hover:bg-zinc-800",
        big ? "h-12 px-5 text-[15px]" : "h-10 px-4 text-[14px]",
      )}
    >
      {busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
      Watch them work a real case
      {!busy ? <ArrowRight className="size-4" /> : null}
    </button>
  );
}

const IMPACT = [
  { value: "$610K", label: "a year back", tone: "brand" },
  { value: "5,184 → 48 h", label: "of reconciliation a year" },
  { value: "24,000 → 950", label: "lines checked by hand → decisions you make" },
];

const TRUST = [
  { icon: ShieldCheck, title: "Agents decide, code does the math", body: "Every write goes through a gateway that checks approvals and evidence. Amounts are computed, never guessed." },
  { icon: UserCheck, title: "You approve the money", body: "Disputes, bookings over your limit and any offer from a vendor wait for your call, in the app or in Slack." },
  { icon: BookCheck, title: "Every step on the record", body: "A hash-chained audit trail: who did what, with which evidence, months later." },
];

/** The public front door: what MOA is, the pixel team at work, the impact, and one button to try it. */
export function Landing() {
  // Someone who read this page doesn't need the in-app intro as well.
  useEffect(() => {
    try {
      window.localStorage.setItem("moa-onboarded-v1", "1");
    } catch {
      /* fine */
    }
  }, []);
  return (
    <div className="bg-dots min-h-dvh overflow-y-auto text-zinc-900">
      <header className="mx-auto flex max-w-[1120px] items-center gap-3 px-5 pt-5 sm:px-8">
        <span className="rounded-full bg-primary px-2.5 py-0.5 font-mono text-[12px] font-semibold tracking-wider text-primary-foreground">MOA</span>
        <span className="hidden font-mono text-[11px] tracking-wider text-zinc-500 uppercase sm:inline">Mixture of Accountants</span>
        <Link href="/canvas" className="ml-auto rounded-lg px-3 py-1.5 text-[13px] font-medium text-zinc-600 hover:bg-white hover:text-zinc-900">
          Open the app
        </Link>
      </header>

      <main className="mx-auto max-w-[1120px] px-5 sm:px-8">
        <section className="pt-14 pb-10 text-center sm:pt-20">
          <h1 className="mx-auto max-w-[820px] text-[40px] leading-[1.05] font-semibold tracking-[-0.035em] text-balance sm:text-[60px]">
            A tiny finance team that catches your GPU overbilling
          </h1>
          <p className="mx-auto mt-5 max-w-[620px] text-[16px] leading-relaxed text-pretty text-zinc-600 sm:text-[18px]">
            Six AI employees check every cloud GPU invoice line against what actually ran, dispute overcharges with the vendor over real email, and book the result. You only make the calls.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-2">
            <StartButton big />
            <Link href="/canvas" className="inline-flex h-12 items-center rounded-xl px-4 text-[15px] font-medium text-zinc-700 hover:bg-white">
              Look around first
            </Link>
          </div>
        </section>

        <Stage />

        <section className="mt-14 grid gap-3 sm:grid-cols-3">
          {IMPACT.map((m) => (
            <div key={m.value} className="rounded-2xl bg-white/80 p-5 ring-1 ring-zinc-200">
              <div className={cn("text-[30px] font-semibold tracking-[-0.02em] tnum", m.tone === "brand" ? "text-brand-ink" : "text-zinc-900")}>{m.value}</div>
              <div className="mt-1 text-[14px] text-zinc-500">{m.label}</div>
            </div>
          ))}
        </section>
        <p className="mt-3 text-[12px] leading-snug text-zinc-500">
          Base case for an assumed lab spending $60M a year on GPUs: 24,000 invoice lines, $60 an hour, 0.5% of spend recovered (our estimate; recovery audits get about 0.1%, apexanalytix 2026). Exception rate 19.9% from Ardent Partners, AP Metrics that Matter 2026.
        </p>

        <section className="mt-16">
          <h2 className="text-[26px] font-semibold tracking-[-0.02em]">Meet the team</h2>
          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {CAST.filter((c) => c.id !== "you").map((c) => (
              <div key={c.id} className="flex items-start gap-3 rounded-2xl bg-white/80 p-4 ring-1 ring-zinc-200">
                <span className="grid size-14 shrink-0 place-items-center rounded-xl" style={{ background: spriteTint(c.id) }}>
                  <PixelAgent actorId={c.id} size={40} />
                </span>
                <div className="min-w-0">
                  <div className="text-[15px] font-semibold">{c.name}</div>
                  <div className="font-mono text-[10.5px] tracking-wider text-zinc-400 uppercase">{c.dept}</div>
                  <div className="mt-1 text-[13.5px] leading-snug text-zinc-600">{c.job}</div>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-16 grid gap-6 sm:grid-cols-3">
          {TRUST.map((t) => (
            <div key={t.title}>
              <t.icon className="size-5 text-brand-ink" />
              <div className="mt-2 text-[15px] font-semibold">{t.title}</div>
              <div className="mt-1 text-[13.5px] leading-snug text-zinc-600">{t.body}</div>
            </div>
          ))}
        </section>

        <section className="my-20 flex flex-col items-center gap-4 rounded-3xl bg-zinc-900 px-6 py-12 text-center text-white">
          <div className="flex gap-1">
            {CAST.map((c) => (
              <PixelAgent key={c.id} actorId={c.id} size={30} />
            ))}
          </div>
          <h2 className="max-w-[560px] text-[28px] leading-tight font-semibold tracking-[-0.02em]">Hand them an overbilled invoice and watch</h2>
          <StartButton onDark />
        </section>
      </main>

      <footer className="mx-auto max-w-[1120px] px-5 pb-10 text-[12px] text-zinc-500 sm:px-8">Built at Cal Hacks 13.0 for the Hyphenate track. Atlas Research and its data are fictional.</footer>
    </div>
  );
}
