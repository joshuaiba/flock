// Types and helpers for the signals API (pipeline/api/signals.py). Every
// response carries the same envelope: when the numbers were computed, the
// window, the category filter, the tables they came from, and how far back the
// data reaches.

import type { OrgKind, Stage } from "./api";
import { tagLabel } from "./tags";

export type SignalOrg = { id: number; name: string; kind: OrgKind; tag: string | null };

export type Envelope = {
  as_of: string;
  refreshed_at: string;
  window_days: number;
  tag: string | null;
  sample: boolean;
  sources: string[];
  coverage: {
    first_award_day: string | null;
    /** false when the record starts after the prior period does: show no change */
    prior_complete: boolean;
    first_solicitation_day: string | null;
    /** the same test for solicitations, which can start on a different day */
    solicitations_prior_complete: boolean;
  };
};
export type Page<T> = Envelope & { total: number; limit: number; offset: number; items: T[] };

export type Overview = Envelope & {
  amount: number;
  prev_amount: number;
  awards: number;
  prev_awards: number;
  new_entrants: number;
  prev_new_entrants: number;
  open_solicitations: number;
  prev_open_solicitations: number;
  posted: number;
  prev_posted: number;
  /** absent from an API that predates the money chart */
  money_by_family?: MoneyByFamily;
};

// "Where the money went": the window's award dollars as parts of a whole. An
// award's dollars are split evenly across the category families it is tagged
// with (and, inside a family, across its tags there), so the parts add up to
// the Awarded figure. The families and which tags belong to each are defined
// once, in config/taxonomy.yaml, and reach the site through the API.
export type MoneyTag = { tag: string; amount: number; share: number; awards: number };
export type MoneyFamily = {
  /** "aerial" | "maritime" | "navigation" | "counter" | "other", or
   *  "uncategorized" for awards with no category tag */
  family: string;
  label: string;
  covers: string;
  amount: number;
  /** of the window's total, 0 to 1 */
  share: number;
  /** an award counts once in each family it touches */
  awards: number;
  /** the family's dollars by tag; shares are of the family */
  tags: MoneyTag[];
};
/** Always the five families in their fixed order, then "uncategorized". It
 *  covers the whole window whatever the category filter is. */
export type MoneyByFamily = { total: number; items: MoneyFamily[] };
export type FamilyDef = { key: string; label: string; covers: string; tags: string[] };

export type FundingRow = {
  org: SignalOrg | null;
  category: string | null;
  amount: number;
  awards: number;
  prev_amount: number;
  prev_awards: number;
  delta: number;
  pct: number | null;
  rank: number | null;
  prev_rank: number | null;
  pct_rank: number | null;
};
export type FundingPage = Page<FundingRow> & { by: "company" | "agency" | "category"; min_baseline: number };

export type EntrantRow = {
  org: SignalOrg;
  first_day: string;
  first_amount: number;
  amount: number;
  awards: number;
  tags: string[];
};

export type StageKey = Stage["key"];
export type StagePoint = { stage: StageKey; day: string | null };

export type TransitionRow = {
  org: SignalOrg;
  from_stage: StageKey | null;
  to_stage: StageKey;
  from_day: string | null;
  day: string;
  days_between: number | null;
  amount: number;
  awards: number;
  path: StagePoint[];
};
export type TransitionCompanyRow = {
  org: SignalOrg;
  transitions: number;
  transitions_total: number;
  stage: StageKey;
  latest_day: string;
  days_total: number | null;
  path: StagePoint[];
};

export type TopicRow = {
  category: string;
  posted: number;
  prev_posted: number;
  delta: number;
  pct: number | null;
  open: number;
  rising: boolean;
  amount: number;
  series: number[];
};
export type TopicPage = Page<TopicRow> & { bucket_days: number; series_start: string };

export type AwardRow = {
  id: number;
  amount: number | null;
  day: string;
  description: string | null;
  url: string | null;
  stage: StageKey | null;
  tags: string[];
  recipient: SignalOrg | null;
  agency: SignalOrg | null;
};

export type MixPart = { category: string; amount: number; awards: number; posted: number };
export type AgencyRow = {
  org: SignalOrg;
  amount: number;
  awards: number;
  prev_amount: number;
  delta: number;
  pct: number | null;
  rank: number | null;
  prev_rank: number | null;
  posted: number;
  prev_posted: number;
  open: number;
  mix: MixPart[];
};

export type CategorySeriesRow = {
  category: string;
  amount: number;
  awards: number;
  prev_amount: number;
  delta: number;
  pct: number | null;
  series: number[];
};
export type CategorySeries = Envelope & {
  bucket_days: number;
  series_start: string;
  items: CategorySeriesRow[];
};

export type WatchRow = {
  org: SignalOrg;
  new_awards: { id: number; amount: number | null; day: string; description: string | null; stage: StageKey | null }[];
  new_amount: number;
  new_stages: StagePoint[];
  rank: number | null;
  rank_then: number | null;
  last_award_day: string | null;
  days_since_last: number | null;
};
export type Watchlist = Envelope & { since: string | null; items: WatchRow[] };

export type OrgSignals = Envelope & {
  org: SignalOrg;
  amount: number;
  prev_amount: number;
  delta: number;
  pct: number | null;
  rank: number | null;
  prev_rank: number | null;
  category: string | null;
  category_rank: number | null;
  category_prev_rank: number | null;
  stage: StageKey | null;
  stage_day: string | null;
  path: StagePoint[];
  first_day: string | null;
  last_award_day: string | null;
  days_since_last: number | null;
};

export type Definitions = {
  as_of: string;
  refreshed_at: string;
  sample: boolean;
  first_award_day: string | null;
  awards: number;
  opportunities: number;
  min_baseline: number;
  min_topic_baseline: number;
  /** the category families, in their fixed order; absent from an older API */
  families?: FamilyDef[];
  items: { key: string; name: string; text: string; tables: string[] }[];
};

// ------------------------------------------------------------ parameters

/** The windows the dashboard offers. (The API also has 7, for the field report.) */
export const WINDOWS = [30, 90, 365] as const;
export type WindowDays = (typeof WINDOWS)[number];

export function windowLabel(days: number): string {
  return days === 365 ? "1 year" : `${days} days`;
}
/** "the prior 90 days" */
export function priorLabel(days: number): string {
  return days === 365 ? "the prior year" : `the prior ${days} days`;
}

/** Read `?window=` leniently: anything unknown becomes 90. */
export function parseWindow(v: string | string[] | undefined): WindowDays {
  const n = Number(Array.isArray(v) ? v[0] : v);
  return (WINDOWS as readonly number[]).includes(n) ? (n as WindowDays) : 90;
}

/** "funding?by=company&window=90&tag=maritime": skips empty values. */
export function signalPath(path: string, params: Record<string, string | number | boolean | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return `signals/${path}${s ? `?${s}` : ""}`;
}

// ------------------------------------------------------------ wording

export const STAGE_LABEL: Record<StageKey, string> = {
  solicitation: "Solicitation",
  phase_1: "Phase I",
  phase_2: "Phase II",
  production: "Production",
};

/** Growth as text: 0.41 -> "41%", 4.83 -> "483%". Tenfold growth and more is
 *  written as a multiple of the prior figure: growth of 12.3 is "13×" (the
 *  new figure is 13.3 times the old one). */
export function pct(v: number): string {
  const a = Math.abs(v);
  if (a >= 10) return `${Math.round(a + 1).toLocaleString("en-US")}×`;
  // A real change too small to round to 1% is not "0%".
  if (a > 0 && a < 0.005) return "under 1%";
  return `${Math.round(a * 100)}%`;
}

/** An envelope whose `prior_complete` is the solicitation one, for figures
 *  that count solicitations (open, posted) inside a response about awards. */
export function forSolicitations<E extends Pick<Envelope, "window_days" | "coverage">>(env: E): E {
  return { ...env, coverage: { ...env.coverage, prior_complete: env.coverage.solicitations_prior_complete } };
}

/** Change between two counts or amounts, or null when there is nothing to
 *  compare with (no prior value, or the data does not reach back that far). */
export function change(cur: number, prev: number, complete: boolean): { up: boolean; flat: boolean; text: string } | null {
  if (!complete || prev <= 0) return null;
  const d = (cur - prev) / prev;
  return { up: d > 0, flat: Math.abs(d) < 0.005, text: pct(d) };
}

// ------------------------------------------------------------ categories in words

/** The family a category tag belongs to, from the API's list of families. */
export function familyOfTag(families: FamilyDef[] | undefined, tag: string): string | null {
  return families?.find((f) => f.tags.includes(tag))?.key ?? null;
}

/** A list of categories in words: "Maritime 62%, Swarming 30%". */
export function mixText(mix: MixPart[], total: number, max = 3): string {
  if (total <= 0) return "";
  return mix
    .filter((m) => m.amount > 0)
    .slice(0, max)
    .map((m) => `${tagLabel(m.category)} ${Math.round((m.amount / total) * 100)}%`)
    .join(", ");
}

// ------------------------------------------------------------ series

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Aug 14 to Aug 28" for each bucket of a series that starts on `start`
 *  (ISO date) and has buckets of `bucketDays` days (may be fractional: bucket
 *  i covers the days whose offset * n / span rounds down to i). A series that
 *  runs longer than about ten months carries the year, so the same month in
 *  two different years cannot be mistaken for each other. */
export function bucketLabels(start: string, bucketDays: number, n: number): string[] {
  const [y, m, d] = start.split("-").map(Number);
  const t0 = Date.UTC(y, m - 1, d);
  const years = bucketDays * n > 300;
  const fmt = (offset: number) => {
    const t = new Date(t0 + offset * 86_400_000);
    return `${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()}${years ? `, ${t.getUTCFullYear()}` : ""}`;
  };
  return Array.from({ length: n }, (_, i) => {
    const from = Math.ceil(i * bucketDays);
    const to = Math.ceil((i + 1) * bucketDays) - 1;
    return to <= from ? fmt(from) : `${fmt(from)} to ${fmt(to)}`;
  });
}
