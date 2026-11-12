"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { clientGet, type Summary } from "@/lib/api";
import { useStore } from "@/lib/store";

// `short` is what a narrow screen shows; the link keeps its full name for
// screen readers. A `tiny` link is dropped on phones narrower than 390px,
// where the row would reach the Display button (it is also in the footer).
const LINKS: { href: string; label: string; short?: string; tiny?: boolean }[] = [
  { href: "/forum", label: "Forum" },
  { href: "/graph", label: "Graph" },
  { href: "/feed", label: "Field Report", short: "Report" },
  { href: "/#about", label: "About", tiny: true },
];

// Room on a 390px phone: the wordmark ends about 66px from the left edge. In
// Inter at 13px, Forum, Graph, Report and About come to about 165px; with 6px
// of padding a side they run from 78px to about 290px, which leaves the
// Display button its 28px at the right edge. From `sm` up the links are
// centered with roomier spacing, and "Field Report" is spelled out from `md`.
const ITEM =
  "inline-flex h-7 items-center rounded-[5px] px-1.5 text-[0.8125rem] leading-none whitespace-nowrap no-underline transition-colors sm:px-3 md:px-4";

let sampleSeen: boolean | null = null; // asked once per page load

/** True when the API says it is serving sample data. */
function useSample(): boolean {
  const [sample, setSample] = useState(sampleSeen ?? false);
  useEffect(() => {
    if (sampleSeen != null) return;
    const ctl = new AbortController();
    clientGet<Summary>("summary", ctl.signal)
      .then((s) => {
        sampleSeen = !!s.sample;
        setSample(sampleSeen);
      })
      .catch(() => {
        /* no data service: no badge */
      });
    return () => ctl.abort();
  }, []);
  return sample;
}

/** The top bar: the wordmark, then forum, graph, field report and about as
 *  plain words (the current page in the text color), and at the right the
 *  sample-data mark, the watchlist count and the Display menu. Centered links
 *  when there is room; on a phone they sit just to the right of the wordmark.
 *  The bar has no box of its own: a veil of page color keeps its words
 *  readable when a page scrolls under it. */
export function Nav() {
  const path = usePathname();
  const { pins } = useStore();
  const sample = useSample();
  return (
    <header className="site-nav fixed inset-x-0 top-0 z-30 flex h-16 items-center justify-between px-4 sm:px-8">
      <Link href="/" className="font-display text-[1.75rem] leading-none text-ink no-underline" aria-label="flock, home">
        flock
      </Link>
      <nav
        aria-label="Main"
        className="absolute left-[78px] top-1/2 flex -translate-y-1/2 items-center sm:left-1/2 sm:-translate-x-1/2"
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
              className={`${ITEM} ${active ? "font-medium text-ink" : "text-muted hover:text-ink"} ${
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
      </nav>
      <div className="flex items-center gap-2 sm:gap-4">
        {sample && (
          <span className="hidden h-6 items-center rounded-[5px] border border-line2 px-2 text-[0.75rem] text-muted lg:inline-flex">
            Sample data
          </span>
        )}
        {/* The watchlist is a panel on the Forum; the bar only counts it. */}
        {pins.length > 0 && (
          <Link
            href="/forum#watchlist"
            className={`${ITEM} hidden !px-0 text-muted hover:text-ink md:inline-flex`}
            aria-label={`Watchlist, ${pins.length} ${pins.length === 1 ? "organization" : "organizations"}`}
          >
            Watchlist <span className="ml-1.5 text-ink">{pins.length}</span>
          </Link>
        )}
        <DisplayMenu key={path} />
      </div>
    </header>
  );
}

/** Dark, paper or Classic, and motion on or off, behind one small button. It closes on
 *  Escape (focus returns to the button), on a click outside, and when the page
 *  changes (it is keyed by the path). */
function DisplayMenu() {
  const { theme, setTheme, still, toggleStill } = useStore();
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
        className={`${ITEM} cursor-pointer !px-0 ${open ? "text-ink" : "text-muted hover:text-ink"}`}
      >
        <svg
          viewBox="0 0 16 16"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          aria-hidden="true"
          className="mx-1.5 sm:hidden"
        >
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
          className="surface absolute right-0 top-[calc(100%+10px)] w-[16.5rem] p-3"
        >
          <div className="flex items-center justify-between gap-4">
            <span className="label" id={`${id}-theme`}>
              Mode
            </span>
            <div className="seg w-46" role="group" aria-labelledby={`${id}-theme`}>
              <button type="button" aria-pressed={theme === "dark"} onClick={() => setTheme("dark")}>
                Dark
              </button>
              <button type="button" aria-pressed={theme === "paper"} onClick={() => setTheme("paper")}>
                Paper
              </button>
              <button type="button" aria-pressed={theme === "classic"} onClick={() => setTheme("classic")}>
                Classic
              </button>
            </div>
          </div>
          <div className="mt-2.5 flex items-center justify-between gap-4">
            <span className="label" id={`${id}-motion`}>
              Motion
            </span>
            <div className="seg w-46" role="group" aria-labelledby={`${id}-motion`}>
              <button type="button" aria-pressed={!still} onClick={() => still && toggleStill()}>
                On
              </button>
              <button type="button" aria-pressed={still} onClick={() => !still && toggleStill()}>
                Off
              </button>
            </div>
          </div>
          <p className="mt-2.5 text-muted">Off holds the swallows still.</p>
        </div>
      )}
    </div>
  );
}
