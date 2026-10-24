import { cn } from "@/lib/utils";

export function MetricCard({
  label,
  value,
  sub,
  tone = "default",
  icon,
  children,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "default" | "danger" | "warning" | "success";
  icon?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col rounded-xl bg-white p-4 ring-1 ring-zinc-200/80">
      <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div
        className={cn(
          "mt-2 text-[22px] leading-none font-semibold tracking-tight tnum",
          tone === "danger" && "text-rose-600",
          tone === "warning" && "text-orange-600",
          tone === "success" && "text-emerald-700",
        )}
      >
        {value}
      </div>
      {sub ? <div className="mt-2 text-[11.5px] leading-snug text-muted-foreground">{sub}</div> : null}
      {children}
    </div>
  );
}
