import { NoRows } from "@/components/Signals";
import { money } from "@/lib/format";
import { windowLabel } from "@/lib/signals";

// Small pieces the Forum's panels share. Nothing here needs the browser, so
// both the server panels and the watchlist (a client component) can use them.

/** What every panel on the Forum is given: the window in days, the category
 *  filter (or null), and the grid span the page chose for it. */
export type PanelProps = { days: number; tag: string | null; className?: string };

/** The line a panel shows when the API did not answer. */
export function Down() {
  return <NoRows>The data service is not answering.</NoRows>;
}

/** A link that keeps the reader's window and category:
 *  "/forum/leaderboards?tab=rising&window=30&tag=maritime". The default window
 *  (90 days) is left out, as the filters do. */
export function carry(path: string, days: number, tag: string | null, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams(extra);
  if (days !== 90) q.set("window", String(days));
  if (tag) q.set("tag", tag);
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

/** "the last 90 days" / "the last year" */
export function lastLabel(days: number): string {
  return days === 365 ? "the last year" : `the last ${windowLabel(days)}`;
}

/** A dollar change with its sign: "+$54.5M", "−$1.2M". */
export function signedMoney(n: number): string {
  if (n === 0) return money(0);
  return `${n > 0 ? "+" : "−"}${money(Math.abs(n))}`;
}

/** A wide ledger scrolls inside its panel, never the page. The region can be
 *  focused, so it also scrolls from the keyboard. */
export function Scroll({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="relative overflow-x-auto" tabIndex={0} role="region" aria-label={label}>
      {children}
    </div>
  );
}

/** An empty state inside a section: one plain line saying what would appear
 *  here. No illustration: the dashboard keeps its ornaments to the page's
 *  edges. */
export function PanelEmpty({ children }: { children: React.ReactNode }) {
  return <p className="forum-name max-w-md text-muted">{children}</p>;
}
