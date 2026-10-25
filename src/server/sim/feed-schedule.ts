import { nowIso, type AppContext } from "../context";
import { feedEvents } from "../db/schema";
import { DAY_MS, HOUR_MS } from "../clock";
import { buildInstanceCase, type ScenarioData } from "./scenarios";

/*
 * Simulated provider outboxes. Each provider "publishes" invoice lines over
 * the coming days of business time; the scheduler's feed sync picks them up
 * without anyone clicking anything. The publish offsets are relative to when
 * the sandbox was loaded, so a fresh deployment always has upcoming work.
 */

interface Scheduled {
  offsetMs: number;
  label: string;
  data: ScenarioData;
}

function schedule(): Scheduled[] {
  return [
    {
      offsetMs: 2 * 60_000,
      label: "Nebius line that matches the contract exactly",
      data: buildInstanceCase({
        key: "feed-1", providerId: "PRV-MERIDIAN", instanceId: "i-mer-2231", instanceType: "h200.8x", projectId: "PRJ-INF",
        experimentId: "exp-inf-batching-v4", experimentName: "Continuous batching v4", owner: "Diego Alvarez",
        provisionedAt: "2026-10-19T04:00:00.000Z", lifecycleHours: 16, jobHours: 15.6, billedHours: 16, rateCents: 12_000,
        invoice: { id: "INV-MER-2026-10-051", number: "MER-2026-10-051", lineId: "MER-2026-10-051-L1" }, jobId: "job-88512",
      }),
    },
    {
      offsetMs: 6 * 60_000,
      label: "Lambda A100 line billed $0.40/h above contract ($12 variance)",
      data: buildInstanceCase({
        key: "feed-2", providerId: "PRV-HELIOS", instanceId: "i-hel-4541", instanceType: "a100.8x", projectId: "PRJ-MMP",
        experimentId: "exp-mmp-caption-rl", experimentName: "Caption model RLHF", owner: "Lena Ortiz",
        provisionedAt: "2026-10-20T02:00:00.000Z", lifecycleHours: 30, jobHours: 29.5, billedHours: 30, rateCents: 6_440,
        invoice: { id: "INV-HEL-2026-10-151", number: "HEL-2026-10-151", lineId: "HEL-2026-10-151-L1" }, jobId: "job-88530",
      }),
    },
    {
      offsetMs: 1 * DAY_MS,
      label: "Nebius short run billed at the 8-hour contract minimum",
      data: buildInstanceCase({
        key: "feed-3", providerId: "PRV-MERIDIAN", instanceId: "i-mer-2240", instanceType: "h200.8x", projectId: "PRJ-RLA",
        experimentId: "exp-rla-smoke-test", experimentName: "Environment smoke test", owner: "Elena Petrova",
        provisionedAt: "2026-10-21T13:00:00.000Z", lifecycleHours: 3, jobHours: 2.4, billedHours: 8, meterHours: 3, rateCents: 12_000,
        invoice: { id: "INV-MER-2026-10-052", number: "MER-2026-10-052", lineId: "MER-2026-10-052-L1" }, jobId: "job-88560",
      }),
    },
    {
      offsetMs: 3 * DAY_MS,
      label: "Lambda billed 6 h after the instance was terminated",
      data: buildInstanceCase({
        key: "feed-4", providerId: "PRV-HELIOS", instanceId: "i-hel-4558", instanceType: "h100.8x", projectId: "PRJ-FLM",
        experimentId: "exp-flm-long-context-04", experimentName: "Long-context extension 04", owner: "Jonah Brooks",
        provisionedAt: "2026-10-22T06:00:00.000Z", lifecycleHours: 40, jobHours: 39.2, billedHours: 46, meterHours: 46, rateCents: 10_000,
        invoice: { id: "INV-HEL-2026-10-152", number: "HEL-2026-10-152", lineId: "HEL-2026-10-152-L1" }, jobId: "job-88591",
        terminationRef: "hel-api-req-91c2e0",
      }),
    },
    {
      offsetMs: 9 * DAY_MS + 4 * HOUR_MS,
      label: "Lambda H100 line that matches the contract exactly",
      data: buildInstanceCase({
        key: "feed-5", providerId: "PRV-HELIOS", instanceId: "i-hel-4570", instanceType: "h100.8x", projectId: "PRJ-RLA",
        experimentId: "exp-rla-critic-v2", experimentName: "Critic model v2", owner: "Elena Petrova",
        provisionedAt: "2026-10-24T08:00:00.000Z", lifecycleHours: 20, jobHours: 19.6, billedHours: 20, rateCents: 10_000,
        invoice: { id: "INV-HEL-2026-10-153", number: "HEL-2026-10-153", lineId: "HEL-2026-10-153-L1" }, jobId: "job-88620",
      }),
    },
  ];
}

export function seedFeedSchedule(ctx: AppContext, base = Date.now()) {
  const createdAt = nowIso();
  ctx.db
    .insert(feedEvents)
    .values(
      schedule().map((s) => ({
        source: s.data.event.source,
        externalEventId: s.data.event.externalEventId,
        publishAt: new Date(base + s.offsetMs).toISOString(),
        label: s.label,
        payload: s.data as unknown as Record<string, unknown>,
        createdAt,
      })),
    )
    .onConflictDoNothing()
    .run();
}
