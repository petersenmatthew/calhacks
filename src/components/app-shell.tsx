"use client";

export function AppShell({ children }: { children: React.ReactNode }) {
  return <main className="h-dvh overflow-hidden">{children}</main>;
}
