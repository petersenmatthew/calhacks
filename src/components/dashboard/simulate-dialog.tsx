"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { LoaderCircle, Plus } from "lucide-react";
import { postJson } from "@/lib/api";
import { money } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

type Scenario = "overbilling" | "shared_allocation" | "next_month_shared" | "early_job_end" | "custom" | "duplicate";

const OPTIONS: { key: Scenario; title: string; body: string; tag?: string }[] = [
  {
    key: "overbilling",
    title: "GPU overbilling",
    body: "Helios bills 36 h at $100/h for an 8x H100 instance whose lifecycle shows 24 h.",
    tag: "Scenario 1",
  },
  {
    key: "shared_allocation",
    title: "Shared cluster allocation",
    body: "Stratus bills a $12,400 reservation that two research teams used.",
    tag: "Scenario 2",
  },
  {
    key: "next_month_shared",
    title: "Next month: similar reservation",
    body: "A November reservation owned by Multimodal Perception, borrowed by RL and Agents.",
    tag: "Scenario 3",
  },
  {
    key: "early_job_end",
    title: "Correct bill, job ended early",
    body: "The invoice matches the instance lifetime, but the training job ended 6 h before termination.",
  },
  { key: "custom", title: "Custom invoice line", body: "Choose the provider, hours, rate, and project yourself." },
  { key: "duplicate", title: "Resend last billing event", body: "Deliver the most recent provider event again to test idempotency." },
];

const PROJECTS = [
  { id: "PRJ-FLM", name: "Frontier Language Models" },
  { id: "PRJ-MMP", name: "Multimodal Perception" },
  { id: "PRJ-RLA", name: "RL and Agents" },
  { id: "PRJ-INF", name: "Inference Efficiency" },
];

const PROVIDERS = {
  "PRV-HELIOS": { label: "Helios Cloud · 8x H100 · $100/h · billed per started hour", rate: 10_000, min: 1 },
  "PRV-MERIDIAN": { label: "Meridian Compute · 8x H200 · $120/h · 8 h minimum", rate: 12_000, min: 8 },
} as const;

type ProviderId = keyof typeof PROVIDERS;

export function SimulateDialog({ onDone }: { onDone: () => void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [scenario, setScenario] = useState<Scenario>("overbilling");
  const [busy, setBusy] = useState(false);
  const [providerId, setProviderId] = useState<ProviderId>("PRV-HELIOS");
  const [projectId, setProjectId] = useState("PRJ-RLA");
  const [provisioned, setProvisioned] = useState("30");
  const [jobHours, setJobHours] = useState("26");
  const [billed, setBilled] = useState("40");
  const [rate, setRate] = useState("");

  const provider = PROVIDERS[providerId];
  const rateCents = rate ? Math.round(Number(rate) * 100) : provider.rate;
  const billableHours = Math.max(Math.ceil(Number(provisioned) || 0), provider.min);
  const expected = billableHours * provider.rate;
  const invoiced = Math.round((Number(billed) || 0) * rateCents);

  const submit = async () => {
    setBusy(true);
    try {
      const body =
        scenario === "custom"
          ? {
              scenario,
              params: {
                providerId,
                projectId,
                provisionedHours: Number(provisioned),
                jobHours: Number(jobHours),
                billedHours: Number(billed),
                rateCents: rate ? rateCents : null,
              },
            }
          : { scenario };
      const result = await postJson<{ status: string; workItemId?: string | null; entryId?: string }>("/api/demo/simulate", body);
      setOpen(false);
      onDone();
      if (result.status === "work_item_created" && result.workItemId) {
        const id = result.workItemId;
        toast.success("Discrepancy detected. Opened " + id + " and assigned the Compute Agent.", {
          action: { label: "Open", onClick: () => router.push("/investigations/" + id) },
        });
      } else if (result.status === "auto_matched") {
        toast.success("Invoice matched the contract-supported charge. Posted " + result.entryId + " under the auto-match policy.");
      } else {
        toast.message("Duplicate event ignored. No new work item, posting, or dispute was created.");
      }
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus /> Simulate billing event
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[620px]">
        <DialogHeader>
          <DialogTitle>Simulate a billing event</DialogTitle>
          <DialogDescription>
            Writes simulated source records (scheduler, infrastructure controller, provider meter), then sends the provider invoice line through
            the same ingestion, checks, and agent workflow as any other event.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 sm:grid-cols-2">
          {OPTIONS.map((o) => (
            <button
              key={o.key}
              type="button"
              onClick={() => setScenario(o.key)}
              className={cn(
                "rounded-lg border p-3 text-left transition-colors",
                scenario === o.key ? "border-zinc-900 bg-zinc-50 ring-1 ring-zinc-900" : "hover:bg-zinc-50",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-medium">{o.title}</span>
                {o.tag ? <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600">{o.tag}</span> : null}
              </div>
              <p className="mt-1 text-[12px] leading-snug text-muted-foreground">{o.body}</p>
            </button>
          ))}
        </div>
        {scenario === "custom" ? (
          <div className="space-y-3 rounded-lg border bg-zinc-50/60 p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label className="text-xs">Provider and contract</Label>
                <Select value={providerId} onValueChange={(v) => setProviderId(v as ProviderId)}>
                  <SelectTrigger className="w-full bg-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(PROVIDERS).map(([id, p]) => (
                      <SelectItem key={id} value={id}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Owning project</Label>
                <Select value={projectId} onValueChange={setProjectId}>
                  <SelectTrigger className="w-full bg-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PROJECTS.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Billed rate per hour (blank = contract)</Label>
                <Input className="bg-white" inputMode="decimal" placeholder={String(provider.rate / 100)} value={rate} onChange={(e) => setRate(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Instance lifetime (provisioned to terminated), h</Label>
                <Input className="bg-white" inputMode="decimal" value={provisioned} onChange={(e) => setProvisioned(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Training job runtime, h</Label>
                <Input className="bg-white" inputMode="decimal" value={jobHours} onChange={(e) => setJobHours(e.target.value)} />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label className="text-xs">Hours billed on the invoice</Label>
                <Input className="bg-white" inputMode="decimal" value={billed} onChange={(e) => setBilled(e.target.value)} />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 rounded-md bg-white p-2.5 text-center text-[11.5px] ring-1 ring-zinc-200">
              <div>
                <div className="text-muted-foreground">Invoice</div>
                <div className="font-semibold tnum">{money(invoiced)}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Contract estimate</div>
                <div className="font-semibold tnum">{money(expected)}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Difference</div>
                <div className={cn("font-semibold tnum", invoiced - expected >= 100 ? "text-destructive" : "text-zinc-900")}>
                  {money(invoiced - expected, { sign: true })}
                </div>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">Preview only. The server&apos;s deterministic checks decide whether a work item opens.</p>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? <LoaderCircle className="animate-spin" /> : null}
            Send billing event
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
