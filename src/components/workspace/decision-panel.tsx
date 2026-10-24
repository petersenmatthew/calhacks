"use client";

import { useState } from "react";
import { toast } from "sonner";
import { LoaderCircle } from "lucide-react";
import { postJson } from "@/lib/api";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { ApprovalCard } from "./approval-card";
import { useWorkspace } from "./workspace-context";

function InfoRequest() {
  const { data, refresh } = useWorkspace();
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const q = data.item.pendingQuestion;
  if ((data.item.state !== "NEEDS_INFO" && data.item.state !== "DISPUTED") || !q) return null;
  const send = async () => {
    setBusy(true);
    try {
      await postJson("/api/work-items/" + data.item.id + "/info", { answer });
      toast.success("Sent. The agent resumes with your answer.");
      setAnswer("");
      refresh();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 px-6 py-4">
      <div className="text-[13px] font-semibold">An agent has a question</div>
      <p className="text-[12.5px] leading-snug text-zinc-700">{q.question}</p>
      <Textarea value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Your answer" className="min-h-[64px] text-[12.5px]" />
      <Button size="sm" onClick={send} disabled={busy || answer.trim().length < 3}>
        {busy ? <LoaderCircle className="animate-spin" /> : null} Send and resume
      </Button>
    </div>
  );
}

/** Everything waiting on the controller for this item, shown above the timeline. */
export function DecisionPanel() {
  const { data } = useWorkspace();
  const pending = data.approvals.filter((a) => a.status === "PENDING");
  const asking = (data.item.state === "NEEDS_INFO" || data.item.state === "DISPUTED") && Boolean(data.item.pendingQuestion);
  const count = pending.length + (asking ? 1 : 0);
  if (!count) return null;
  return (
    <div className="max-h-[65vh] shrink-0 overflow-y-auto border-t-2 border-primary/50">
      <div className="divide-y">
        {pending.map((a) => (
          <ApprovalCard key={a.id} approval={a} />
        ))}
        <InfoRequest />
      </div>
    </div>
  );
}
