"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { LoaderCircle, RotateCcw } from "lucide-react";
import { postJson } from "@/lib/api";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "../ui/dialog";

export function ResetButton({ onDone }: { onDone?: () => void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const reset = async () => {
    setBusy(true);
    try {
      await postJson("/api/demo/reset", {});
      setOpen(false);
      toast.success("Sandbox reset to the seeded October month");
      onDone?.();
      router.push("/");
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          <RotateCcw /> Reset demo
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Reset the sandbox?</DialogTitle>
          <DialogDescription>
            Deletes all work items, postings, audit events, and learned policies, then reloads the seeded Atlas Research month. Use this to
            repeat the demo.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={reset} disabled={busy}>
            {busy ? <LoaderCircle className="animate-spin" /> : null}
            Reset sandbox
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
