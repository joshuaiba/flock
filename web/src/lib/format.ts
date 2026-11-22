// Deterministic formatting: no locale or time-zone surprises between server and browser.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** $2.1B, $476.9K. Compact, for prose and labels. */
export function money(n: number | null | undefined): string {
  if (n == null) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${Math.round(n)}`;
}

/** $212M, $64M, $8.4M, $1.2B. Compact and rounded for reading: whole units
 *  from ten up, one decimal below that (and none when it is zero). For a
 *  sentence or a short breakdown, where "$212.0M" would be noise. */
export function moneyRound(n: number | null | undefined): string {
  if (n == null) return "—";
  const a = Math.abs(n);
  // Each step starts where the one below would round up to 1,000.
  const [unit, sign] = a >= 999.5e6 ? [1e9, "B"] : a >= 999.5e3 ? [1e6, "M"] : a >= 999.5 ? [1e3, "K"] : [1, ""];
  const v = n / unit;
  const s = Math.abs(v) >= 9.95 || unit === 1 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, "");
  return `$${s}${sign}`;
}

const SMALL = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/** A count as prose sets it: spelled out up to ten ("three"), figures above. */
export function spell(n: number): string {
  return Number.isInteger(n) && n >= 0 && n <= 10 ? SMALL[n] : n.toLocaleString("en-US");
}

/** "Army", "Army and Navy", "Army, Air Force and Navy": no serial comma. */
export function andList(items: readonly string[]): string {
  if (items.length < 2) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** $1,507,737. Exact, for tables. */
export function dollars(n: number | null | undefined): string {
  if (n == null) return "—";
  return "$" + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** "2026-11-10" -> "Nov 10, 2026" (or "Nov 10" when short). */
export function day(iso: string | null | undefined, short = false): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return iso;
  return short ? `${MONTHS[m - 1]} ${d}` : `${MONTHS[m - 1]} ${d}, ${y}`;
}

/** How long ago, from a count of days: "today", "12 days ago", "5 months ago". */
export function ago(days: number): string {
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 60) return `${days} days ago`;
  return `${Math.round(days / 30.44)} months ago`;
}

export function plural(n: number, one: string, many = one + "s"): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

export function truncate(s: string | null | undefined, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}
