"use client";

import Link from "next/link";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import useSWR from "swr";
import { Hash, Inbox, Mail, Paperclip } from "lucide-react";
import { fetcher } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { CommsData } from "@/server/queries";
import { useLiveRefresh } from "../live-events";

type Message = CommsData["messages"][number];
type View = { kind: "channel"; name: string } | { kind: "dm"; handle: string } | { kind: "mail" };

const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const day = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" });

/** Render Slack markup: <@handle> mentions, <url|label> links, *bold*, _italic_. */
function Rich({ text, data }: { text: string; data: CommsData }) {
  const parts = text.split(/(<@[a-z]+>|<[^>|]+\|[^>]+>|\*[^*\n]+\*|_[^_\n]+_)/g);
  return (
    <>
      {parts.map((p, i) => {
        const m = p.match(/^<@([a-z]+)>$/);
        if (m) {
          const person = data.people.find((x) => x.handle === m[1]);
          return (
            <span key={i} className="rounded bg-[#e8f5fa] px-0.5 font-medium text-[#1264a3]">
              @{person?.name ?? m[1]}
            </span>
          );
        }
        const link = p.match(/^<([^>|]+)\|([^>]+)>$/);
        if (link) {
          const href = link[1].replace(/^https?:\/\/[^/]+/, "");
          return (
            <Link key={i} href={href || "/"} className="text-[#1264a3] hover:underline">
              {link[2]}
            </Link>
          );
        }
        if (/^\*[^*]+\*$/.test(p)) return <strong key={i}>{p.slice(1, -1)}</strong>;
        if (/^_[^_]+_$/.test(p)) return <em key={i}>{p.slice(1, -1)}</em>;
        return <Fragment key={i}>{p}</Fragment>;
      })}
    </>
  );
}

function DeliveryTag({ m }: { m: Message }) {
  if (m.status === "failed") return <span className="text-[11px] text-red-600">not delivered</span>;
  if (m.status === "sent") return <span className="text-[11px] text-zinc-400">delivered to Slack</span>;
  if (m.status === "pending" || m.status === "sending") return <span className="text-[11px] text-zinc-400">sending…</span>;
  return null;
}

function Messages({ messages, data, empty }: { messages: Message[]; data: CommsData; empty: ReactNode }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);
  if (!messages.length) return <div className="px-5 py-10 text-[14px] text-zinc-500">{empty}</div>;
  const days = messages.map((m) => day.format(new Date(m.createdAt)));
  return (
    <div className="px-5 py-4">
      {messages.map((m, i) => {
        const d = days[i];
        const divider = i === 0 || d !== days[i - 1];
        return (
          <Fragment key={m.id}>
            {divider ? (
              <div className="my-3 flex items-center gap-3">
                <div className="h-px flex-1 bg-zinc-200" />
                <span className="rounded-full px-3 py-0.5 text-[12px] font-semibold text-zinc-700 ring-1 ring-zinc-200">{d}</span>
                <div className="h-px flex-1 bg-zinc-200" />
              </div>
            ) : null}
            <div className="group flex gap-2.5 rounded-md px-2 py-1.5 hover:bg-zinc-50">
              <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-md bg-[#c6d600] text-[13px] font-bold text-zinc-900">L</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-[15px] font-bold text-zinc-900">{data.bot.name}</span>
                  <span className="rounded bg-zinc-100 px-1 text-[10px] font-semibold text-zinc-500">APP</span>
                  <span className="text-[12px] text-zinc-500">{time.format(new Date(m.createdAt))}</span>
                  <span className="ml-auto opacity-0 group-hover:opacity-100">
                    <DeliveryTag m={m} />
                  </span>
                </div>
                <div className="text-[15px] leading-[1.46] whitespace-pre-wrap text-zinc-800">
                  <Rich text={m.body} data={data} />
                </div>
              </div>
            </div>
          </Fragment>
        );
      })}
      <div ref={end} />
    </div>
  );
}

function MailList({ data }: { data: CommsData }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!data.emails.length) return <div className="px-5 py-10 text-[14px] text-zinc-500">No email sent yet. Disputes and vendor follow-ups appear here.</div>;
  return (
    <div className="divide-y">
      {[...data.emails].reverse().map((e) => (
        <div key={e.id} className="px-5 py-3">
          <button type="button" onClick={() => setOpen(open === e.id ? null : e.id)} className="flex w-full items-baseline gap-3 text-left">
            <span className="w-56 shrink-0 truncate text-[13px] text-zinc-600">To {e.destination}</span>
            <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-zinc-900">{e.subject}</span>
            <span
              className={cn(
                "shrink-0 rounded px-1.5 text-[11px] font-medium",
                e.status === "sent" ? "bg-emerald-50 text-emerald-700" : e.status === "failed" ? "bg-red-50 text-red-700" : "bg-zinc-100 text-zinc-600",
              )}
            >
              {e.status === "simulated" ? "recorded" : e.status}
            </span>
          </button>
          {open === e.id ? (
            <div className="mt-3 space-y-2">
              <pre className="rounded-lg bg-zinc-50 p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-zinc-800 ring-1 ring-zinc-200">{e.body}</pre>
              {e.attachments.map((a) => (
                <div key={a.filename} className="flex items-center gap-1.5 text-[12px] text-zinc-500">
                  <Paperclip className="size-3.5" /> {a.filename}
                </div>
              ))}
              {e.lastError ? <div className="text-[12px] text-red-600">{e.lastError}</div> : null}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** A Slack-style view of the Atlas Research workspace the bot posts to. */
export function SlackView() {
  const { data, mutate } = useSWR<CommsData>("/api/comms", fetcher, { keepPreviousData: true, refreshInterval: 5000 });
  useLiveRefresh(() => mutate(), undefined, 400);
  const [view, setView] = useState<View>({ kind: "channel", name: "finance-approvals" });
  if (!data) return <div className="h-full bg-[#3f0e40]" />;
  const messages =
    view.kind === "channel"
      ? data.messages.filter((m) => m.destination === "#" + view.name)
      : view.kind === "dm"
        ? data.messages.filter((m) => m.destination === "@" + view.handle)
        : [];
  const channel = view.kind === "channel" ? data.channels.find((c) => c.name === view.name) : null;
  const person = view.kind === "dm" ? data.people.find((p) => p.handle === view.handle) : null;
  const item = "flex h-7 w-full items-center gap-2 rounded-md px-2.5 text-left text-[15px]";
  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-[260px] shrink-0 flex-col bg-[#3f0e40] text-[#cfc3cf]">
        <div className="border-b border-white/10 px-4 py-3">
          <div className="text-[18px] font-bold text-white">{data.workspace}</div>
          <div className="mt-0.5 text-[12px] text-white/60">
            {data.delivery.slack ? "Also posting to your real Slack" : "Simulated workspace"}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
          <div className="px-2.5 pb-1 text-[13px] font-semibold text-white/70">Channels</div>
          {data.channels.map((c) => {
            const active = view.kind === "channel" && view.name === c.name;
            return (
              <button key={c.name} type="button" onClick={() => setView({ kind: "channel", name: c.name })} className={cn(item, active ? "bg-[#1164a3] text-white" : "hover:bg-white/10")}>
                <Hash className="size-4 shrink-0 opacity-70" />
                <span className={cn("flex-1 truncate", c.count && !active && "font-semibold text-white")}>{c.name}</span>
                {c.count ? <span className="text-[12px] opacity-70">{c.count}</span> : null}
              </button>
            );
          })}
          <div className="mt-4 px-2.5 pb-1 text-[13px] font-semibold text-white/70">Direct messages</div>
          {data.people.map((p) => {
            const active = view.kind === "dm" && view.handle === p.handle;
            return (
              <button key={p.handle} type="button" onClick={() => setView({ kind: "dm", handle: p.handle })} className={cn(item, active ? "bg-[#1164a3] text-white" : "hover:bg-white/10")}>
                <span className="grid size-5 shrink-0 place-items-center rounded bg-white/20 text-[10px] font-bold text-white">{p.name.replace("Dr. ", "")[0]}</span>
                <span className={cn("flex-1 truncate", p.count && !active && "font-semibold text-white")}>{p.name}</span>
                {p.count ? <span className="grid h-5 min-w-5 place-items-center rounded-full bg-[#cd2553] px-1.5 text-[11px] font-bold text-white">{p.count}</span> : null}
              </button>
            );
          })}
          <div className="mt-4 px-2.5 pb-1 text-[13px] font-semibold text-white/70">Outside Slack</div>
          <button type="button" onClick={() => setView({ kind: "mail" })} className={cn(item, view.kind === "mail" ? "bg-[#1164a3] text-white" : "hover:bg-white/10")}>
            <Mail className="size-4 shrink-0 opacity-70" />
            <span className="flex-1 truncate">Vendor email</span>
            {data.emails.length ? <span className="text-[12px] opacity-70">{data.emails.length}</span> : null}
          </button>
        </div>
      </aside>
      <section className="flex min-w-0 flex-1 flex-col bg-white">
        <header className="flex h-[49px] shrink-0 items-center gap-2 border-b px-5">
          {view.kind === "channel" ? (
            <>
              <Hash className="size-[18px] text-zinc-700" />
              <span className="text-[18px] font-bold text-zinc-900">{view.name}</span>
              <span className="ml-2 truncate text-[13px] text-zinc-500">{channel?.purpose}</span>
            </>
          ) : view.kind === "dm" ? (
            <>
              <span className="text-[18px] font-bold text-zinc-900">{person?.name}</span>
              <span className="ml-2 truncate text-[13px] text-zinc-500">{person?.title}</span>
            </>
          ) : (
            <>
              <Inbox className="size-[18px] text-zinc-700" />
              <span className="text-[18px] font-bold text-zinc-900">Vendor email</span>
              <span className="ml-2 truncate text-[13px] text-zinc-500">
                {data.delivery.email ? "Sent through your mail server" : "Recorded only; set RESEND_API_KEY or SMTP_URL to send"}
                {data.delivery.vendorEmail ? " · all vendor mail goes to " + data.delivery.vendorEmail : ""}
              </span>
            </>
          )}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {view.kind === "mail" ? (
            <MailList data={data} />
          ) : (
            <Messages
              messages={messages}
              data={data}
              empty={view.kind === "channel" ? "Nothing posted in #" + view.name + " yet." : "No messages to " + person?.name + " yet."}
            />
          )}
        </div>
      </section>
    </div>
  );
}
