"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useStore } from "@/lib/store";

// `short` is what a narrow screen shows; the link keeps its full name for
// screen readers. A `tiny` link is dropped on phones narrower than 390px,
// where the pill would reach the watchlist chain (it is also in the footer).
const LINKS: { href: string; label: string; short?: string; tiny?: boolean }[] = [
  { href: "/forum", label: "Forum" },
  { href: "/graph", label: "Graph" },
  { href: "/feed", label: "Field Report", short: "Report" },
  { href: "/#about", label: "About", tiny: true },
];

// Room on a 390px phone, measured from the fonts' advance widths. The wordmark
// ends 66px from the left edge (16px padding + 50px of "flock") and the
// watchlist chain hangs 44px from the right edge. In Cinzel at 0.65rem with
// 0.1em tracking, FORUM GRAPH REPORT ABOUT DUSK come to about 209px; five
// items at 8px of padding, the rule and the pill's own padding and border add
// 55px. So the pill is about 264px wide, runs from 71px to 335px, and clears
// both. From `sm` up it is centered with the roomier spacing, and "field
// report" is spelled out from `md`, where the centered pill has the width.
const ITEM =
  "rounded-full px-1 py-1 font-caps text-[0.65rem] uppercase tracking-[0.1em] transition-colors hover:text-ink sm:px-2.5 sm:text-[0.68rem] sm:tracking-[0.18em]";

/** Minimal top nav on a marble pill: forum · graph · field report · about ·
 *  day/dusk · still. Centered when there is room; on a phone it sits just to
 *  the right of the wordmark, so it never covers it. */
export function Nav() {
  const path = usePathname();
  const { theme, toggleTheme, still, toggleStill } = useStore();
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
        className="marble pointer-events-auto absolute left-[max(71px,calc(50%_-_132px))] top-3 flex items-center gap-0 rounded-full px-1.5 py-1 sm:left-1/2 sm:-translate-x-1/2 sm:gap-0.5 sm:px-2"
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
              className={`${ITEM} whitespace-nowrap no-underline ${active ? "text-ink" : "text-muted"} ${
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
        <span aria-hidden className="h-3 w-px bg-frame sm:mx-0.5" />
        <button
          type="button"
          onClick={toggleTheme}
          className={`${ITEM} cursor-pointer text-muted`}
          aria-label={`Switch to ${theme === "dusk" ? "day" : "dusk"}`}
        >
          {theme === "dusk" ? "day" : "dusk"}
        </button>
        <button
          type="button"
          onClick={toggleStill}
          aria-pressed={still}
          title="Freeze the birds, the paintings and the physics"
          className={`${ITEM} hidden cursor-pointer sm:block ${
            still ? "bg-card text-ink shadow-[0_0_0_1px_var(--frame)]" : "text-muted"
          }`}
        >
          still
        </button>
      </nav>
      <span />
    </header>
  );
}
