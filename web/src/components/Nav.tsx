"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { useStore } from "@/lib/store";

// `short` is what a narrow screen shows; the link keeps its full name for
// screen readers. A `tiny` link is dropped on phones narrower than 390px,
// where the bar would reach the watchlist chain (it is also in the footer).
const LINKS: { href: string; label: string; short?: string; tiny?: boolean }[] = [
  { href: "/forum", label: "Forum" },
  { href: "/graph", label: "Graph" },
  { href: "/feed", label: "Field Report", short: "Report" },
  { href: "/#about", label: "About", tiny: true },
];

// Room on a 390px phone. The wordmark ends 66px from the left edge and the
// watchlist chain hangs 44px from the right edge, which leaves 71px to 346px.
// In Inter at 13px, Forum, Graph, Report and About come to about 165px; with
// 6px of padding a side, the display button (28px), the rule and the bar's own
// padding and border the bar is about 258px wide, runs from 71px to 329px, and
// clears both. From `sm` up it is centered with roomier spacing, and "Field
// Report" is spelled out from `md`.
const ITEM =
  "inline-flex h-7 items-center rounded-[5px] px-1.5 font-sans text-[0.8125rem] font-medium leading-none whitespace-nowrap no-underline transition-colors sm:px-2.5";

/** The top bar: forum, graph, field report, about, and a small Display menu
 *  that holds the two view settings (day or dusk, motion on or off). Centered
 *  when there is room; on a phone it sits just to the right of the wordmark. */
export function Nav() {
  const path = usePathname();
  return (
    <header className="pointer-events-none fixed inset-x-0 top-0 z-30 flex items-start justify-between px-4 py-4 sm:px-8">
      <Link
        href="/"
        className="pointer-events-auto font-display text-[1.6rem] leading-none text-ink no-underline"
        aria-label="flock, home"
      >
        flock
      </Link>
      <nav
        aria-label="Main"
        className="site-nav pointer-events-auto absolute left-[max(71px,calc(50%_-_129px))] top-3 flex items-center gap-0.5 p-[3px] sm:left-1/2 sm:-translate-x-1/2"
      >
        {LINKS.map((l) => {
          // "/forum" is also current on the pages below it; "/#about" never is.
          const active = l.href !== "/#about" && (path === l.href || path.startsWith(`${l.href}/`));
          return (
            <Link
              key={l.href}
              href={l.href}
              aria-current={active ? "page" : undefined}
              aria-label={l.short ? l.label : undefined}
              className={`${ITEM} ${active ? "bg-ink/8 text-ink" : "text-muted hover:text-ink"} ${
                l.tiny ? "max-[390px]:hidden" : ""
              }`}
            >
              {l.short ? (
                <>
                  <span className="md:hidden">{l.short}</span>
                  <span className="hidden md:inline">{l.label}</span>
                </>
              ) : (
                l.label
              )}
            </Link>
          );
        })}
        <span aria-hidden className="mx-0.5 h-4 w-px bg-frame" />
        <DisplayMenu key={path} />
      </nav>
      <span />
    </header>
  );
}

/** Day or dusk, and motion on or off, behind one small button. It closes on
 *  Escape (focus returns to the button), on a click outside, and when the page
 *  changes (it is keyed by the path). */
function DisplayMenu() {
  const { theme, toggleTheme, still, toggleStill } = useStore();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrap} className="relative flex">
      <button
        ref={button}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={id}
        aria-label="Display settings"
        className={`${ITEM} cursor-pointer gap-1.5 !px-1.5 ${open ? "bg-ink/8 text-ink" : "text-muted hover:text-ink"}`}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
          <path d="M2.5 5h4M10.5 5h3M2.5 11h3M9.5 11h4" />
          <circle cx="8.5" cy="5" r="1.75" />
          <circle cx="7.5" cy="11" r="1.75" />
        </svg>
        <span className="hidden sm:inline">Display</span>
      </button>
      {open && (
        <div
          id={id}
          role="group"
          aria-label="Display settings"
          className="surface absolute right-[-3px] top-[calc(100%+9px)] w-[16.5rem] p-3"
        >
          <div className="flex items-center justify-between gap-4">
            <span className="label" id={`${id}-theme`}>
              Theme
            </span>
            <div className="seg w-36" role="group" aria-labelledby={`${id}-theme`}>
              <button type="button" aria-pressed={theme === "day"} onClick={() => theme !== "day" && toggleTheme()}>
                Day
              </button>
              <button type="button" aria-pressed={theme === "dusk"} onClick={() => theme !== "dusk" && toggleTheme()}>
                Dusk
              </button>
            </div>
          </div>
          <div className="mt-2.5 flex items-center justify-between gap-4">
            <span className="label" id={`${id}-motion`}>
              Motion
            </span>
            <div className="seg w-36" role="group" aria-labelledby={`${id}-motion`}>
              <button type="button" aria-pressed={!still} onClick={() => still && toggleStill()}>
                On
              </button>
              <button type="button" aria-pressed={still} onClick={() => !still && toggleStill()}>
                Off
              </button>
            </div>
          </div>
          <p className="ui mt-2.5 text-muted">Off holds the birds, the scenery and the watchlist chain still.</p>
        </div>
      )}
    </div>
  );
}
