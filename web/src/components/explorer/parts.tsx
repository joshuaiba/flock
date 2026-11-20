"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

// Small pieces the explorer's views share: the engraving motifs (hatch fill,
// tick ring, the solicitation diamond), a pointer tooltip, a width measure,
// and the "last visit" record kept in the browser.

/** The diagonal hatch every band and disk is filled with: fine parallel lines
 *  at about 40 degrees, like the shading of a line engraving. `tone` picks the
 *  line color from the tokens; the id must be unique on the page. */
export function Hatch({
  id,
  tone = "text",
  gap = 5,
  weight = 1,
  opacity = 0.5,
}: {
  id: string;
  tone?: "text" | "accent";
  gap?: number;
  weight?: number;
  opacity?: number;
}) {
  return (
    <pattern id={id} patternUnits="userSpaceOnUse" width={gap} height={gap} patternTransform="rotate(38)">
      <line x1="0" y1="0" x2="0" y2={gap} stroke={`var(--${tone})`} strokeWidth={weight} opacity={opacity} />
    </pattern>
  );
}

/** Fine ticks around a point, like the limb of an astrolabe. */
export function TickRing({
  cx,
  cy,
  r,
  n = 24,
  len = 4,
  className = "ex-tickring",
}: {
  cx: number;
  cy: number;
  r: number;
  n?: number;
  len?: number;
  className?: string;
}) {
  const lines = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    lines.push(
      <line
        key={i}
        x1={(cx + c * r).toFixed(1)}
        y1={(cy + s * r).toFixed(1)}
        x2={(cx + c * (r + len)).toFixed(1)}
        y2={(cy + s * (r + len)).toFixed(1)}
      />,
    );
  }
  return <g className={className}>{lines}</g>;
}

/** The solicitation mark: a diamond, hollow while unanswered and filled once
 *  an award answered it. It is the only steel-colored thing on the site, and
 *  steel never appears without this shape. */
export function Diamond({ x, y, r = 4.5, filled = false }: { x: number; y: number; r?: number; filled?: boolean }) {
  return (
    <path
      d={`M${x} ${y - r}L${x + r} ${y}L${x} ${y + r}L${x - r} ${y}Z`}
      className={filled ? "ex-diamond ex-diamond-filled" : "ex-diamond"}
    />
  );
}

export const SearchIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5" />
  </svg>
);
export const CloseIcon = ({ size = 14 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

/** The width of an element, kept current. Until it is measured (the server's
 *  HTML, the first paint) it is `fallback`. */
export function useWidth<T extends HTMLElement>(fallback: number): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  const layout = typeof window === "undefined" ? useEffect : useLayoutEffect;
  layout(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setWidth((w) => (Math.abs(w - el.clientWidth) < 1 ? w : Math.round(el.clientWidth)));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

// ---- Tooltip ----

export type TipState = { x: number; y: number; body: ReactNode } | null;

/** One floating note that follows the pointer. `show` goes on pointermove,
 *  `hide` on pointerleave; the note is described to assistive tech by each
 *  mark's own <title> or aria-label, so it is hidden from them here. */
export function useTip(): {
  tip: ReactNode;
  show: (e: { clientX: number; clientY: number }, body: ReactNode) => void;
  hide: () => void;
} {
  const [state, setState] = useState<TipState>(null);
  const show = useCallback(
    (e: { clientX: number; clientY: number }, body: ReactNode) => setState({ x: e.clientX, y: e.clientY, body }),
    [],
  );
  const hide = useCallback(() => setState(null), []);
  const tip = state ? (
    <div
      className="tip ex-tip"
      aria-hidden="true"
      style={{
        left: Math.min(state.x + 14, (typeof window === "undefined" ? 1200 : window.innerWidth) - 280),
        top: state.y + 16,
      }}
    >
      {state.body}
    </div>
  ) : null;
  return { tip, show, hide };
}

/** A unique, CSS-safe id for an SVG pattern or path. */
export function useSvgId(prefix: string): string {
  return `${prefix}${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
}

// ---- The reader's last visit ----

// What "new since your last visit" compares against: when the reader last
// came, and the highest award id on record at that time. Ids only grow, so
// anything above it was loaded since (whatever date the award itself carries:
// USAspending publishes DoD awards about 90 days late, so a newly loaded award
// is usually an old one). A visit becomes "the last visit" once a new one
// starts more than half an hour later, so reloading does not erase it.
export type Visit = { at: string; maxAwardId: number };
const LAST = "flock.visit.last";
const THIS = "flock.visit.this";
const SESSION_MS = 30 * 60 * 1000;

function readVisit(key: string): Visit | null {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "null");
    return v && typeof v.at === "string" && typeof v.maxAwardId === "number" ? v : null;
  } catch {
    return null;
  }
}

/** The previous visit, or null on a first one. Records this visit as it goes. */
export function useLastVisit(maxAwardId: number | null | undefined): Visit | null {
  const [last, setLast] = useState<Visit | null>(null);
  useEffect(() => {
    if (maxAwardId == null) return;
    const now = Date.now();
    let prev = readVisit(LAST);
    const current = readVisit(THIS);
    try {
      if (current && now - Date.parse(current.at) > SESSION_MS) {
        prev = current;
        localStorage.setItem(LAST, JSON.stringify(current));
      }
      if (!current || now - Date.parse(current.at) > SESSION_MS)
        localStorage.setItem(THIS, JSON.stringify({ at: new Date(now).toISOString(), maxAwardId }));
    } catch {
      /* a private window: nothing to compare against next time */
    }
    setLast(prev);
  }, [maxAwardId]);
  return last;
}
