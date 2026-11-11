// Types and helpers for the signals API (pipeline/api/signals.py). Every
// response carries the same envelope: when the numbers were computed, the
// window, the category filter, the tables they came from, and how far back the
// data reaches.

import { medallionForTag } from "./art";
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
  coverage: { first_award_day: string | null; prior_complete: boolean };
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
};

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

/** 0.41 -> "41%", 4.83 -> "483%", 12.3 -> "12x". */
export function pct(v: number): string {
  const a = Math.abs(v);
  if (a >= 10) return `${Math.round(a + 1)}x`;
  return `${Math.round(a * 100)}%`;
}

/** Change between two counts or amounts, or null when there is nothing to
 *  compare with (no prior value, or the data does not reach back that far). */
export function change(cur: number, prev: number, complete: boolean): { up: boolean; flat: boolean; text: string } | null {
  if (!complete || prev <= 0) return null;
  const d = (cur - prev) / prev;
  return { up: d > 0, flat: Math.abs(d) < 0.005, text: pct(d) };
}

// ------------------------------------------------------------ chart colors

// Ten categories are too many hues for this palette to keep apart, so charts
// that color by category use the five medallion families instead. The color
// follows the family, never its rank, and every chart that uses it also names
// the categories in words.
export const FAMILIES = ["aerial", "maritime", "navigation", "counter", "other"] as const;
export type Family = (typeof FAMILIES)[number];

export const FAMILY_LABEL: Record<Family, string> = {
  aerial: "Aerial",
  maritime: "Maritime",
  navigation: "Navigation",
  counter: "Counter-drone",
  other: "Ground, software, command",
};

export function familyOf(tag: string): Family {
  switch (medallionForTag(tag)) {
    case "wing":
      return "aerial";
    case "anchor":
      return "maritime";
    case "compass":
      return "navigation";
    case "shield":
      return "counter";
    default:
      return "other";
  }
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
