import { Check, LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { StepState } from "@/lib/agent-steps";

export function StepList({ steps, className, dim, onSelect, accent }: { steps: { label: string; state: StepState }[]; className?: string; dim?: boolean; accent?: boolean; onSelect?: (label: string) => void }) {
  return (
    <ol className={cn("space-y-1 font-mono text-[12px]", className)}>
      {steps.map((s) => (
        <li
          key={s.label}
          className={cn(
            "flex items-center gap-2",
            s.state === "active" ? accent ? "text-zinc-900" : "text-brand-ink" : s.state === "done" ? "text-zinc-500" : "text-zinc-400",
            dim && s.state !== "active" && "text-zinc-400",
          )}
        >
          <span className="flex min-w-0 flex-1 items-center gap-2">
          {s.state === "done" ? (
            <Check className={cn("size-3.5", accent ? "text-zinc-600" : "text-brand-ink")} />
          ) : s.state === "active" ? (
            <LoaderCircle className={cn("size-3.5 animate-spin", accent && "rounded-full bg-primary text-zinc-900")} />
          ) : (
            <span className="grid size-3.5 place-items-center">
              <span className="size-2.5 rounded-full border border-current" />
            </span>
          )}
          {onSelect ? <button type="button" onClick={() => onSelect(s.label)} aria-label={`View subtask: ${s.label}`} className={cn("flex min-w-0 flex-1 items-center justify-between gap-2 rounded px-1 py-1 text-left focus-visible:outline-2", accent ? "hover:bg-accent hover:text-zinc-900 focus-visible:outline-primary" : "hover:bg-accent hover:text-brand-ink focus-visible:outline-primary")}><span>{s.label}</span><span aria-hidden="true" className="text-[10px]">↗</span></button> : s.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

const TONE = {
  blue: "text-brand-ink",
  orange: "text-brand-ink",
  red: "text-destructive",
  green: "text-brand-ink",
  zinc: "text-zinc-500",
};

/** Small uppercase pill naming what is happening right now, e.g. CHECKING CONTRACT. */
export function StatusPill({ label, tone = "blue", spin = false, className }: { label: string; tone?: keyof typeof TONE; spin?: boolean; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-full bg-white px-3 font-mono text-[11px] font-medium tracking-wider uppercase shadow-sm ring-1 ring-zinc-200",
        TONE[tone],
        className,
      )}
    >
      {spin ? <LoaderCircle className="size-3.5 animate-spin" /> : <span className="size-1.5 rounded-full bg-current" />}
      {label}
    </span>
  );
}
