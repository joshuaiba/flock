import Link from "next/link";
import { tabHref, TABS, type View } from "./view";

/** The six leaderboards as a row of small-caps links; the one on screen is
 *  underlined in ink. Each link keeps the window and the category, and starts
 *  that board in its own usual order. The row wraps on a narrow screen. */
export function Tabs({ view }: { view: View }) {
  return (
    <nav aria-label="Leaderboards" className="relative z-20">
      <ul className="flex flex-wrap gap-x-7 gap-y-1 border-b border-frame">
        {TABS.map((tab) => {
          const on = tab.key === view.tab;
          return (
            <li key={tab.key}>
              <Link
                href={tabHref(view, tab)}
                scroll={false}
                aria-current={on ? "page" : undefined}
                className={`-mb-px inline-block border-b-2 py-2.5 font-caps text-[0.72rem] uppercase tracking-[0.16em] no-underline transition-colors ${
                  on ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink"
                }`}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
