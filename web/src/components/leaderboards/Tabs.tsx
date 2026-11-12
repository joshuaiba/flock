import Link from "next/link";
import { tabHref, TABS, type View } from "./view";
import "../forum/forum.css";

/** The six leaderboards as a row of plain links; the one on screen is
 *  underlined. Each link keeps the window and the category, and starts
 *  that board in its own usual order. The row wraps on a narrow screen. */
export function Tabs({ view }: { view: View }) {
  return (
    <nav aria-label="Leaderboards">
      <ul className="forum-tabs">
        {TABS.map((tab) => (
          <li key={tab.key}>
            <Link
              href={tabHref(view, tab)}
              scroll={false}
              aria-current={tab.key === view.tab ? "page" : undefined}
              className="forum-tab"
            >
              {tab.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
