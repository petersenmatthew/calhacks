"use client";

import { createContext, useContext, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type { ActivityRow } from "@/server/queries";

type Listener = (event: ActivityRow) => void;

interface LiveContextValue {
  subscribe: (listener: Listener) => () => void;
  subscribeReset: (listener: () => void) => () => void;
  connected: boolean;
}

const LiveContext = createContext<LiveContextValue | null>(null);

/** One SSE connection for the whole app, fanned out to subscribers. */
export function LiveEventsProvider({ children }: { children: React.ReactNode }) {
  const listeners = useRef(new Set<Listener>());
  const resetListeners = useRef(new Set<() => void>());
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const source = new EventSource("/api/stream");
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.addEventListener("activity", (message) => {
      const row = JSON.parse((message as MessageEvent<string>).data) as ActivityRow;
      listeners.current.forEach((listener) => listener(row));
    });
    source.addEventListener("reset", () => {
      resetListeners.current.forEach((listener) => listener());
    });
    return () => source.close();
  }, []);

  const value = useMemo<LiveContextValue>(
    () => ({
      subscribe: (listener) => {
        listeners.current.add(listener);
        return () => {
          listeners.current.delete(listener);
        };
      },
      subscribeReset: (listener) => {
        resetListeners.current.add(listener);
        return () => {
          resetListeners.current.delete(listener);
        };
      },
      connected,
    }),
    [connected],
  );

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLiveConnected() {
  return useContext(LiveContext)?.connected ?? false;
}

export function useLiveEvents(handler: Listener) {
  const ctx = useContext(LiveContext);
  const onEvent = useEffectEvent(handler);
  useEffect(() => {
    if (!ctx) return;
    return ctx.subscribe((event) => onEvent(event));
  }, [ctx]);
}

export function useLiveReset(handler: () => void) {
  const ctx = useContext(LiveContext);
  const onReset = useEffectEvent(handler);
  useEffect(() => {
    if (!ctx) return;
    return ctx.subscribeReset(() => onReset());
  }, [ctx]);
}

/** Revalidate data shortly after relevant live events (coalesced). */
export function useLiveRefresh(refresh: () => unknown, filter?: (event: ActivityRow) => boolean, delayMs = 200) {
  const ctx = useContext(LiveContext);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onEvent = useEffectEvent((event: ActivityRow) => {
    if ((filter && !filter(event)) || timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      refresh();
    }, delayMs);
  });
  const onReset = useEffectEvent(() => refresh());
  useEffect(() => {
    if (!ctx) return;
    const offEvent = ctx.subscribe((event) => onEvent(event));
    const offReset = ctx.subscribeReset(() => onReset());
    return () => {
      offEvent();
      offReset();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [ctx]);
}
