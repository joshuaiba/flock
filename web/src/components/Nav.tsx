"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useStore } from "@/lib/store";

const LINKS = [
  { href: "/graph", label: "graph" },
  { href: "/feed", label: "feed" },
  { href: "/#about", label: "about" },
];

const ITEM = "rounded-full px-2.5 py-1 font-caps text-[0.68rem] uppercase tracking-[0.18em] transition-colors hover:text-ink";

/** Minimal top-center nav on a marble pill: graph · feed · about · day/dusk. */
export function Nav() {
  const path = usePathname();
  const { theme, toggleTheme, still, toggleStill } = useStore();
  return (
    <header className="pointer-events-none fixed inset-x-0 top-0 z-30 flex items-start justify-between px-5 py-4 sm:px-8">
      <Link
        href="/"
        className="pointer-events-auto font-display text-[1.6rem] leading-none text-ink no-underline"
        aria-label="flock, home"
      >
        flock
      </Link>
      <nav
        aria-label="Main"
        className="marble pointer-events-auto absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-0.5 rounded-full px-2 py-1"
      >
        {LINKS.map((l) => {
          const active = path === l.href || (l.href !== "/#about" && path.startsWith(l.href));
          return (
            <Link
              key={l.href}
              href={l.href}
              aria-current={active ? "page" : undefined}
              className={`${ITEM} no-underline ${active ? "text-ink" : "text-muted"}`}
            >
              {l.label}
            </Link>
          );
        })}
        <span aria-hidden className="mx-0.5 h-3 w-px bg-frame" />
        <button
          type="button"
          onClick={toggleTheme}
          className={`${ITEM} cursor-pointer text-muted`}
          aria-label={`Switch to ${theme === "night" ? "day" : "dusk"}`}
        >
          {theme === "night" ? "day" : "dusk"}
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
