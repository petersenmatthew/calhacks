"use client";

import Link from "next/link";
import { useNow } from "@/lib/use-now";
import { relativeTime } from "@/lib/format";
import type { DashboardData } from "@/server/queries";
import { ActivityIcon } from "../activity-icon";

export function ActivityFeed({ data }: { data: DashboardData }) {
  const now = useNow();
  return (
    <div className="flex min-h-0 flex-col rounded-xl bg-white ring-1 ring-zinc-200/80">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div>
          <div className="text-[13px] font-semibold">Live activity</div>
          <div className="text-[11.5px] text-muted-foreground">Streamed from the backend as agents act</div>
        </div>
        <span className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-700">
          <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" /> Live
        </span>
      </div>
      <ol className="divide-y overflow-y-auto">
        {data.activity.length === 0 ? <li className="px-4 py-6 text-center text-xs text-muted-foreground">No activity yet.</li> : null}
        {data.activity.map((event) => {
          const actor = data.actors[event.actorId];
          const body = (
            <div className="flex gap-2.5 px-4 py-2.5 animate-enter hover:bg-zinc-50">
              <ActivityIcon type={event.type} status={event.status} className="mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="line-clamp-2 text-[12.5px] leading-snug text-zinc-800">{event.title}</div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span>{actor?.name ?? event.actorId}</span>
                  {event.workItemId ? <span className="font-mono">· {event.workItemId}</span> : null}
                  <span>· {relativeTime(event.createdAt, now)}</span>
                </div>
              </div>
            </div>
          );
          return (
            <li key={event.id}>
              {event.workItemId ? <Link href={"/investigations/" + event.workItemId}>{body}</Link> : body}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
