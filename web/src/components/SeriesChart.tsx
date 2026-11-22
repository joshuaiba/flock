"use client";

import { useId, useRef, useState } from "react";
import { money } from "@/lib/format";

/** One series over time: a thin line in the text color, an end dot, and a
 *  crosshair with a tooltip under the pointer (or keyboard focus). Used as a
 *  sparkline in a tile.
 *
 *  `split` is the index where the current period starts: buckets before it are
 *  the prior period and are drawn fainter, so "this period against the last"
 *  is visible at a glance. A single series, so there is no legend: the title
 *  beside the chart says what it is. */
export function SeriesChart({
  values,
  labels,
  split,
  format = "count",
  unit = "",
  color = "var(--text)",
  height = 56,
  max,
  title,
  className = "",
}: {
  values: number[];
  /** one label per value, for the tooltip ("Aug 14 to Aug 28") */
  labels: string[];
  split?: number;
  format?: "count" | "money";
  /** what a count counts, for the tooltip: "solicitations" */
  unit?: string;
  color?: string;
  height?: number;
  /** share one scale across small multiples; defaults to this series' own peak */
  max?: number;
  /** accessible name: "Maritime, solicitations posted" */
  title: string;
  className?: string;
}) {
  const [at, setAt] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const clip = useId();
  const n = values.length;
  const W = 240; // drawing units; the SVG stretches to its container
  const H = height;
  const top = 6;
  const bottom = H - 3;
  const peak = Math.max(max ?? 0, ...values, 0) || 1;
  const x = (i: number) => (n <= 1 ? W / 2 : 4 + (i * (W - 8)) / (n - 1));
  const y = (v: number) => bottom - (v / peak) * (bottom - top);
  const line = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const cut = split != null && split > 0 && split < n ? (x(split - 1) + x(split)) / 2 : 0;
  const show = (v: number) => (format === "money" ? money(v) : `${v.toLocaleString("en-US")}${unit ? ` ${unit}` : ""}`);
  const total = values.reduce((a, b) => a + b, 0);

  const pick = (clientX: number) => {
    const r = box.current?.getBoundingClientRect();
    if (!r || !r.width) return;
    const px = ((clientX - r.left) / r.width) * W;
    setAt(Math.max(0, Math.min(n - 1, Math.round(((px - 4) / (W - 8)) * (n - 1)))));
  };

  return (
    <div
      ref={box}
      className={`relative ${className}`}
      tabIndex={0}
      role="img"
      aria-label={`${title}: ${show(total)} in all, ${show(values[n - 1] ?? 0)} in the latest period`}
      onPointerMove={(e) => pick(e.clientX)}
      onPointerLeave={() => setAt(null)}
      onFocus={() => setAt(n - 1)}
      onBlur={() => setAt(null)}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") setAt((i) => Math.max(0, (i ?? n - 1) - 1));
        if (e.key === "ArrowRight") setAt((i) => Math.min(n - 1, (i ?? 0) + 1));
      }}
    >
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" className="block overflow-visible" aria-hidden="true">
        <defs>
          <clipPath id={`${clip}-prev`}>
            <rect x="0" y="0" width={cut} height={H} />
          </clipPath>
          <clipPath id={`${clip}-cur`}>
            <rect x={cut} y="0" width={W - cut} height={H} />
          </clipPath>
        </defs>
        {/* The prior period at 40%, the current one at full strength. */}
        <g clipPath={`url(#${clip}-prev)`} opacity="0.4">
          <path d={line} fill="none" stroke={color} strokeWidth="1.25" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </g>
        <g clipPath={`url(#${clip}-cur)`}>
          <path d={line} fill="none" stroke={color} strokeWidth="1.25" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </g>
        {at != null && (
          <line x1={x(at)} x2={x(at)} y1={top - 2} y2={bottom} stroke="var(--muted)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        )}
      </svg>
      {/* Dots are HTML so they stay round while the SVG stretches. */}
      <Dot left={x(at ?? n - 1) / W} top={y(values[at ?? n - 1] ?? 0) / H} color={color} height={H} />
      {at != null && (
        <div
          className="tip"
          style={{
            left: `${(x(at) / W) * 100}%`,
            bottom: H + 6,
            transform: `translateX(${at < n / 3 ? "-12%" : at > (2 * n) / 3 ? "-88%" : "-50%"})`,
          }}
        >
          <span className="text-muted">{labels[at]}</span>
          <br />
          {show(values[at])}
        </div>
      )}
    </div>
  );
}

function Dot({ left, top, color, height }: { left: number; top: number; color: string; height: number }) {
  return (
    <span
      className="pointer-events-none absolute block h-[5px] w-[5px] rounded-full"
      style={{
        left: `${left * 100}%`,
        top: top * height,
        transform: "translate(-50%, -50%)",
        background: color,
        // a ring in the page's own color lifts the dot off the line
        boxShadow: "0 0 0 1.5px var(--bg)",
      }}
    />
  );
}
