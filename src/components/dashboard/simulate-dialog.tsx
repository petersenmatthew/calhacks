"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ArrowRight, LoaderCircle, Plus, X } from "lucide-react";
import { postJson } from "@/lib/api";
import { money } from "@/lib/format";
import { cn } from "@/lib/utils";
import { CrewMeadow } from "../crew-meadow";
import { Flower, UI_FLOWERS } from "../landing/meadow";
import { Button } from "../ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

type Scenario = "overbilling" | "shared_allocation" | "next_month_shared" | "early_job_end" | "custom" | "duplicate";

const OPTIONS: { key: Scenario; title: string; body: string; tag?: string }[] = [
  {
    key: "overbilling",
    title: "GPU overbilling",
    body: "Lambda bills 36 h at $100/h for an 8x H100 instance whose lifecycle shows 24 h.",
    tag: "Scenario 1",
  },
  {
    key: "shared_allocation",
    title: "Shared cluster allocation",
    body: "CoreWeave bills a $12,400 reservation that two research teams used.",
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
  "PRV-HELIOS": { label: "Lambda · 8x H100 · $100/h · billed per started hour", rate: 10_000, min: 1 },
  "PRV-MERIDIAN": { label: "Nebius · 8x H200 · $120/h · 8 h minimum", rate: 12_000, min: 8 },
} as const;

type ProviderId = keyof typeof PROVIDERS;

const OPTION_FLOWERS = [UI_FLOWERS.yellow, UI_FLOWERS.pink, UI_FLOWERS.purple, UI_FLOWERS.peach, UI_FLOWERS.green, UI_FLOWERS.yellow];

/** The header button and its dialog. Pass open/onOpenChange to open it from elsewhere (the intro). */
export function SimulateDialog({ onDone, open: openProp, onOpenChange }: { onDone: () => void; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const router = useRouter();
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (v: boolean) => (onOpenChange ? onOpenChange(v) : setOpenState(v));
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
        toast.success("Discrepancy detected. Opened " + id + " and assigned the Compute Investigator.", {
          action: { label: "Open", onClick: () => router.push("/canvas?task=" + id) },
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
      <DialogContent showCloseButton={false} className="max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto p-0 sm:max-w-[640px]">
        <CrewMeadow seed={11}>
          <DialogClose
            aria-label="Close"
            className="absolute top-2.5 right-2.5 grid size-7 place-items-center rounded-lg bg-white/80 text-zinc-500 backdrop-blur-sm hover:bg-white hover:text-zinc-900"
          >
            <X className="size-4" />
          </DialogClose>
        </CrewMeadow>
        <div className="px-7 pt-6 pb-7">
        <DialogTitle className="text-[24px] leading-[1.15] font-semibold tracking-[-0.02em]">Pick a billing event</DialogTitle>
        <DialogDescription className="mt-1.5 text-[14px] leading-relaxed text-zinc-600">
          It goes through the same checks and the same team as a real provider bill.
        </DialogDescription>
        <div className="mt-5 grid gap-2 sm:grid-cols-2">
          {OPTIONS.map((o, i) => (
            <button
              key={o.key}
              type="button"
              onClick={() => setScenario(o.key)}
              className={cn(
                "flex gap-3 rounded-xl p-3 text-left ring-1 transition-colors",
                scenario === o.key ? "bg-white ring-2 ring-zinc-900" : "ring-zinc-200 hover:bg-zinc-50",
              )}
            >
              <Flower petal={OPTION_FLOWERS[i].petal} eye={OPTION_FLOWERS[i].eye} size={13} className="mt-0.5 shrink-0" />
              <div className="min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[14px] font-medium text-zinc-900">{o.title}</span>
                  {o.tag ? <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-[10.5px] font-medium text-zinc-500">{o.tag}</span> : null}
                </div>
                <p className="mt-0.5 text-[12.5px] leading-snug text-zinc-500">{o.body}</p>
              </div>
            </button>
          ))}
        </div>
        {scenario === "custom" ? (
          <div className="mt-3 space-y-3 rounded-xl bg-zinc-50 p-3.5">
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
            <div className="grid grid-cols-3 gap-2 rounded-lg bg-white p-2.5 text-center text-[11.5px] ring-1 ring-zinc-200">
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
        <div className="mt-7 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-zinc-900 px-4 text-[14px] font-medium text-white hover:bg-zinc-800 disabled:opacity-60"
          >
            Send billing event
            {busy ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowRight className="size-4" />}
          </button>
          <button type="button" onClick={() => setOpen(false)} className="h-10 rounded-lg px-3 text-[14px] text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900">
            Cancel
          </button>
        </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
