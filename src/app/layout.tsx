import type { Metadata } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { AppShell } from "@/components/app-shell";
import { LiveEventsProvider } from "@/components/live-events";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

export const metadata: Metadata = {
  title: "ExperimentLedger",
  description: "Autonomous finance operations for AI research labs",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={GeistSans.variable + " " + GeistMono.variable + " h-full antialiased"}>
      <body className="h-full overflow-hidden bg-background text-foreground">
        <TooltipProvider delayDuration={150}>
          <LiveEventsProvider>
            <AppShell>{children}</AppShell>
          </LiveEventsProvider>
        </TooltipProvider>
        <Toaster position="bottom-right" />
      </body>
    </html>
  );
}
