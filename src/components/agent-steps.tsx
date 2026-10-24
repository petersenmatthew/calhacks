import { Check, LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { StepState } from "@/lib/agent-steps";

export function StepList({ steps, className, dim }: { steps: { label: string; state: StepState }[]; className?: string; dim?: boolean }) {
  return (
    <ol className={cn("space-y-1 font-mono text-[12px]", className)}>
      {steps.map((s) => (
        <li
          key={s.label}
          className={cn(
            "flex items-center gap-2",
            s.state === "active" ? "text-blue-600" : s.state === "done" ? "text-zinc-500" : "text-zinc-400",
            dim && s.state !== "active" && "text-zinc-400",
          )}
        >
          {s.state === "done" ? (
            <Check className="size-3.5 text-emerald-600" />
          ) : s.state === "active" ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <span className="grid size-3.5 place-items-center">
              <span className="size-2.5 rounded-full border border-current" />
            </span>
          )}
          {s.label}
        </li>
      ))}
    </ol>
  );
}

const TONE = {
  blue: "text-blue-600",
  orange: "text-orange-600",
  red: "text-rose-600",
  green: "text-emerald-700",
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
