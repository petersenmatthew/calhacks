"use client";

import { useState } from "react";
import { toast } from "sonner";
import { postJson } from "@/lib/api";
import type { DashboardData } from "@/server/queries";
import { Switch } from "../ui/switch";

/** Lets the controller watch one case at a time, or let every case run at once. */
export function RunModeSwitch({ data, onDone }: { data: DashboardData; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const one = data.settings.runMode === "one";
  const change = async (next: boolean) => {
    setBusy(true);
    try {
      await postJson("/api/settings", { runMode: next ? "one" : "all" });
      onDone();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <label
      className="flex cursor-pointer items-center gap-1.5 text-[12px] text-muted-foreground"
      title={one ? "The team finishes each case before starting the next" : "Every case runs at once"}
    >
      <Switch size="sm" checked={one} disabled={busy} onCheckedChange={change} />
      One case at a time
    </label>
  );
}
