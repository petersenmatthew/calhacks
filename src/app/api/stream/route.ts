import { and, asc, eq, gt, sql } from "drizzle-orm";
import { activityEvents } from "@/server/db/schema";
import { contextFor } from "@/server/runtime";

export const dynamic = "force-dynamic";

/**
 * Server-sent events. Streams activity rows as they are written. Rows are
 * read from SQLite, so a reconnect with Last-Event-ID replays what was missed.
 */
export function GET(request: Request) {
  const ctx = contextFor(request);
  const url = new URL(request.url);
  const workItemId = url.searchParams.get("workItemId");
  const header = request.headers.get("last-event-id");
  const latest = ctx.db.select({ max: sql<number>`coalesce(max(${activityEvents.id}), 0)` }).from(activityEvents).get()?.max ?? 0;
  let lastId = header && Number.isFinite(Number(header)) ? Number(header) : latest;
  if (lastId > latest) lastId = 0;
  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      const send = (chunk: string) => {
        if (!closed) controller.enqueue(encoder.encode(chunk));
      };
      const flush = () => {
        if (closed) return;
        const filter = workItemId
          ? and(gt(activityEvents.id, lastId), eq(activityEvents.workItemId, workItemId))
          : gt(activityEvents.id, lastId);
        const rows = ctx.db.select().from(activityEvents).where(filter).orderBy(asc(activityEvents.id)).limit(200).all();
        for (const row of rows) {
          lastId = row.id;
          send("id: " + row.id + "\nevent: activity\ndata: " + JSON.stringify(row) + "\n\n");
        }
      };
      const onChange = (topic: string) => {
        if (topic === "reset") {
          lastId = 0;
          send("event: reset\ndata: {}\n\n");
        }
        flush();
      };
      ctx.bus.on("change", onChange);
      const poll = setInterval(flush, 1500);
      const ping = setInterval(() => send(": ping\n\n"), 15000);
      send("retry: 2000\n\n");
      flush();
      request.signal.addEventListener("abort", () => {
        closed = true;
        ctx.bus.off("change", onChange);
        clearInterval(poll);
        clearInterval(ping);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
