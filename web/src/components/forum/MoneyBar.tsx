"use client";

import Link from "next/link";
import { useState } from "react";

/** One part of the bar. */
export type MoneySegment = {
  key: string;
  name: string;
  /** "$361.2M" */
  dollars: string;
  /** share of the bar, 0 to 1 */
  share: number;
  /** "46.6%" */
  percent: string;
  /** "131 awards" */
  awards: string;
  /** a CSS color: one of the --chart-* tokens, or a tint of one */
  color: string;
  /** where a click goes: the Forum with the category filter set, or nothing */
  href: string | null;
  /** what the click does, for the accessible name: "Show Aerial only" */
  action?: string;
  current?: boolean;
};

// A share is printed inside a segment that is at least this much of the bar.
const LABEL_FROM = 0.07;

/** A tall segmented bar: the parts of a whole, in a fixed order, with 2px
 *  gaps and rounded outer ends. Hovering or focusing a segment names it with
 *  its dollars, share and awards; clicking one sets the category filter. The
 *  table under the bar carries the same figures, so nothing is told by color
 *  alone. */
export function MoneyBar({ segments, label }: { segments: MoneySegment[]; label: string }) {
  const [at, setAt] = useState<number | null>(null);
  const open = at != null ? segments[at] : undefined;
  // where the open segment's middle sits along the bar, 0 to 1
  const mid = open ? segments.slice(0, at!).reduce((s, x) => s + x.share, 0) + open.share / 2 : 0;
  return (
    <div className="money-bar" onPointerLeave={() => setAt(null)}>
      <div className="money-track" role="group" aria-label={label}>
        {segments.map((s, i) => {
          const text = `${s.name}: ${s.dollars}, ${s.percent}, ${s.awards}`;
          const props = {
            className: "money-seg",
            style: { flexGrow: s.share, background: s.color },
            onPointerEnter: () => setAt(i),
            onFocus: () => setAt(i),
            onBlur: () => setAt(null),
            "aria-current": s.current ? ("true" as const) : undefined,
          };
          const inside = s.share >= LABEL_FROM && <span aria-hidden="true">{Math.round(s.share * 100)}%</span>;
          return s.href ? (
            <Link key={s.key} href={s.href} scroll={false} aria-label={`${text}. ${s.action ?? ""}`.trim()} {...props}>
              {inside}
            </Link>
          ) : (
            <span key={s.key} tabIndex={0} role="img" aria-label={text} {...props}>
              {inside}
            </span>
          );
        })}
      </div>
      {open && (
        <div
          className="tip"
          aria-hidden="true"
          style={{
            left: `${mid * 100}%`,
            bottom: "calc(100% + 6px)",
            transform: `translateX(${mid < 0.2 ? "-12%" : mid > 0.8 ? "-88%" : "-50%"})`,
          }}
        >
          {open.name}
          <br />
          <span className="money">{open.dollars}</span> · {open.percent}
          <br />
          <span className="text-muted">{open.awards}</span>
        </div>
      )}
    </div>
  );
}
