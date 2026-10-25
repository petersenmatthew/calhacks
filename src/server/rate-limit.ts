import type { AppContext } from "./context";

/*
 * Per-visitor limits for a public demo (PUBLIC_DEMO=1), so one visitor cannot
 * spend the model budget or keep resetting everyone else's demo. In-memory and
 * per process: right for one Railway instance; off everywhere else.
 */

const hits = new Map<string, number[]>();

export const LIMITS = {
  simulate: { max: 12, windowMs: 3_600_000, what: "new billing events" },
  reset: { max: 4, windowMs: 3_600_000, what: "demo resets" },
  chat: { max: 40, windowMs: 3_600_000, what: "questions" },
  decide: { max: 60, windowMs: 3_600_000, what: "decisions" },
  vendor: { max: 20, windowMs: 3_600_000, what: "vendor replies" },
} as const;

function visitor(request: Request) {
  const fly = request.headers.get("fly-client-ip");
  if (fly) return fly.trim();
  const fwd = request.headers.get("x-forwarded-for");
  return (fwd ? fwd.split(",")[0] : request.headers.get("x-real-ip") ?? "local").trim();
}

/** A 429 response when this visitor is over the limit, else null (and the hit is counted). */
export function rateLimited(ctx: AppContext, request: Request, kind: keyof typeof LIMITS): Response | null {
  if (!ctx.config.publicDemo) return null;
  const { max, windowMs, what } = LIMITS[kind];
  const key = kind + ":" + visitor(request);
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    const retry = Math.ceil((windowMs - (now - recent[0])) / 60_000);
    return Response.json({ error: "This shared demo allows " + max + " " + what + " an hour per visitor. Try again in about " + retry + " min." }, { status: 429 });
  }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) hits.clear();
  return null;
}
