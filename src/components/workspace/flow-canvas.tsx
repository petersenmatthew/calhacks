"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { connectedPaths, type FlowEdge } from "@/lib/flow-paths";

type Path = FlowEdge & { d: string };

/** Connect measured node boundaries, including after workbook updates or resizing. */
export function FlowCanvas({ children }: { children: ReactNode }) {
  const canvas = useRef<HTMLDivElement>(null);
  const [paths, setPaths] = useState<Path[]>([]);
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const selected = hovered ?? focused;
  const highlighted = connectedPaths(paths, selected);

  useEffect(() => {
    const root = canvas.current!;
    let frame = 0;
    const measure = () => {
      const origin = root.getBoundingClientRect();
      const nodes = new Map(Array.from(root.querySelectorAll<HTMLElement>("[data-flow-node]")).map(el => [el.dataset.flowNode!, el]));
      const next: Path[] = [];
      for (const [to, el] of nodes) {
        const child = el.getBoundingClientRect();
        for (const from of (el.dataset.flowParents ?? "").split(" ").filter(Boolean)) {
          const parent = nodes.get(from)?.getBoundingClientRect();
          if (!parent) continue;
          const x1 = parent.right - origin.left;
          const y1 = parent.top + parent.height / 2 - origin.top;
          const x2 = child.left - origin.left;
          const y2 = child.top + child.height / 2 - origin.top;
          const bend = Math.max(32, (x2 - x1) / 2);
          const d = `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
          next.push({ from, to, d });
        }
      }
      setPaths(old => JSON.stringify(old) === JSON.stringify(next) ? old : next);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const resize = new ResizeObserver(schedule);
    const observe = () => {
      resize.disconnect();
      resize.observe(root);
      root.querySelectorAll<HTMLElement>("[data-flow-node]").forEach(el => resize.observe(el));
      schedule();
    };
    const mutations = new MutationObserver(observe);
    mutations.observe(root, { childList: true, subtree: true, characterData: true });
    observe();
    return () => { cancelAnimationFrame(frame); resize.disconnect(); mutations.disconnect(); };
  }, []);

  const nodeAt = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLElement>("[data-flow-node]")?.dataset.flowNode ?? null : null;
  return (
    <div ref={canvas} className="relative isolate flex min-h-full w-max min-w-full items-center justify-center gap-16 px-10 py-12"
      onPointerOver={e => setHovered(nodeAt(e.target))} onPointerLeave={() => setHovered(null)}
      onFocusCapture={e => setFocused(nodeAt(e.target))} onBlurCapture={e => setFocused(nodeAt(e.relatedTarget))}>
      <svg aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 h-full w-full overflow-visible">
        {paths.map(path => {
          const lit = highlighted.has(`${path.from}:${path.to}`);
          return <g key={`${path.from}:${path.to}`}>
            {lit && <path d={path.d} fill="none" stroke="var(--primary)" strokeWidth="9" opacity="0.14" />}
            <path d={path.d} fill="none" stroke={lit ? "var(--primary)" : "#d4d4d4"} strokeWidth={lit ? 2.5 : 1.25}
              strokeDasharray={lit ? undefined : "4 5"} opacity={selected && !lit ? 0.3 : 1} className="transition-[stroke,opacity] duration-150 motion-reduce:transition-none" />
          </g>;
        })}
      </svg>
      {children}
    </div>
  );
}
