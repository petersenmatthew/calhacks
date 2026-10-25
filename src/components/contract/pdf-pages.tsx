"use client";

import { useEffect, useRef, useState } from "react";

type Mark = { ref: string; top: number; bottom: number };
type Page = { n: number; src: string; ratio: number; marks: Mark[] };

const CLAUSE = /^(\d+\.\d+)(\s|$)/;
const ARTICLE = /^(\d+)\.(\s+[A-Z]|$)|^(EXHIBIT|SCHEDULE|IN WITNESS)/;

/**
 * Renders a PDF with pdf.js as page images, so it looks the same in every browser.
 * Finds where each numbered clause sits on its page, highlights the one asked for,
 * and scrolls to it.
 */
export function PdfPages({ src, highlight }: { src: string; highlight?: string | null }) {
  const [pages, setPages] = useState<Page[] | null>(null);
  const [failed, setFailed] = useState(false);
  const marked = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
        const doc = await pdfjs.getDocument(src).promise;
        const out: Page[] = [];
        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n);
          const viewport = page.getViewport({ scale: 2 });
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          await page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport }).promise;
          // Where each clause starts, and where the next clause or article starts.
          const text = await page.getTextContent();
          const starts: { ref: string | null; top: number }[] = [];
          for (const item of text.items) {
            if (!("str" in item)) continue;
            const s = item.str.replace(/\u00a0/g, " ");
            const clause = s.match(CLAUSE);
            if (!clause && !ARTICLE.test(s)) continue;
            const t = pdfjs.Util.transform(viewport.transform, item.transform);
            // Clause numbers and headings sit at the left margin; skip numbers inside sentences.
            if (t[4] > viewport.width * 0.2) continue;
            const size = Math.hypot(t[2], t[3]);
            starts.push({ ref: clause ? clause[1] : null, top: (t[5] - size) / viewport.height });
          }
          starts.sort((a, b) => a.top - b.top);
          const marks = starts.flatMap((s, i) => (s.ref ? [{ ref: s.ref, top: s.top, bottom: starts[i + 1]?.top ?? s.top + 0.06 }] : []));
          out.push({ n, src: canvas.toDataURL("image/png"), ratio: viewport.height / viewport.width, marks });
        }
        if (!cancelled) setPages(out);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [src]);

  useEffect(() => {
    marked.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [pages, highlight]);

  if (failed) {
    return (
      <p className="p-8 text-[13px] text-zinc-500">
        Could not display the PDF here.{" "}
        <a href={src} className="underline">
          Open it directly
        </a>
        .
      </p>
    );
  }
  if (!pages) return <div className="mx-auto mt-6 aspect-[8.5/11] w-full max-w-[820px] animate-pulse rounded-sm bg-white/70 ring-1 ring-zinc-200" />;

  return (
    <div className="space-y-5 px-6 py-6">
      {pages.map((p) => (
        <div key={p.n} className="relative mx-auto w-full max-w-[820px] bg-white shadow-[0_1px_3px_rgb(0_0_0/0.08),0_8px_24px_rgb(0_0_0/0.06)]" style={{ aspectRatio: 1 / p.ratio }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={p.src} alt={"Page " + p.n} className="absolute inset-0 size-full" />
          {p.marks
            .filter((m) => m.ref === highlight)
            .map((m) => (
              <div
                key={m.ref}
                ref={marked}
                className="pointer-events-none absolute right-[10%] left-[10%] rounded-[3px] bg-[#ffe066]/45 mix-blend-multiply ring-1 ring-[#e8b500]/50"
                style={{ top: (m.top - 0.004) * 100 + "%", height: (m.bottom - m.top - 0.002) * 100 + "%" }}
              />
            ))}
        </div>
      ))}
    </div>
  );
}
