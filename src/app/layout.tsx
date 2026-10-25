import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { AppShell } from "@/components/app-shell";
import { LiveEventsProvider } from "@/components/live-events";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

export const metadata: Metadata = {
  title: "MOA",
  description: "Autonomous finance operations for AI research labs",
};

export const viewport: Viewport = {
  // "only light" opts out of browsers' automatic dark mode, which turns the brand green black.
  colorScheme: "only light",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={GeistSans.variable + " " + GeistMono.variable + " h-full antialiased"}>
      <head>
        <meta name="darkreader-lock" />
        {/* Draft background picker for review: ?bg=plain|warm|grid|fine|glow|paper */}
        <script
          dangerouslySetInnerHTML={{
            __html: "try{var b=new URLSearchParams(location.search).get('bg');if(b)document.documentElement.dataset.bg=b}catch(e){}",
          }}
        />
      </head>
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
