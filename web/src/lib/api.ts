// Types and fetch helpers for the read-only FastAPI service (pipeline/api).

export type Summary = {
  awards_30d: number;
  amount_30d: number;
  awards_total: number;
  amount_total: number;
  companies: number;
  open_opportunities: number;
  updated_at: string | null;
  sample: boolean;
};

export type RecentItem = {
  kind: "award" | "opportunity";
  id: number;
  amount: number | null;
  day: string;
  title: string | null;
  tags: string[];
  url: string | null;
  org_id: number | null;
  org_name: string | null;
  agency_name: string | null;
  closes?: string | null;
  is_new: boolean;
};

export type OrgKind = "company" | "agency" | "office";
export type NodeKind = OrgKind | "opportunity";

export type GraphNode = {
  id: string; // "org:12" | "opp:5"
  kind: NodeKind;
  name: string;
  total: number;
  awards: number;
  tags: string[];
  tag: string | null;
  uei?: string | null;
  url?: string | null;
  posted?: string | null;
  closes?: string | null;
  open?: boolean;
};
export type GraphEdge = {
  source: string;
  target: string;
  kind: "award" | "issued" | "answered" | "part_of";
  amount: number;
  n: number;
};
export type Graph = { days: number; nodes: GraphNode[]; edges: GraphEdge[] };

export type Stage = {
  key: "solicitation" | "phase_1" | "phase_2" | "production";
  label: string;
  reached: boolean;
  date: string | null;
  amount: number;
  n: number;
};
export type OrgAward = {
  id: number;
  amount: number | null;
  day: string;
  description: string | null;
  url: string | null;
  tags: string[];
  source: string;
  source_id: string;
  stage: Stage["key"] | null;
  other_id: number | null;
  other_name: string | null;
};
export type Org = {
  id: number;
  name: string;
  kind: OrgKind;
  uei: string | null;
  aliases: string[];
  tags: { slug: string; amount: number }[];
  tag: string | null;
  total: number;
  award_count: number;
  first_award: string | null;
  last_award: string | null;
  days_since_last: number | null;
  path: Stage[] | null;
  awards: OrgAward[];
  related: { id: number; name: string; kind: OrgKind; total: number; awards: number }[];
  family: { id: number; name: string; kind: OrgKind; relation: "parent" | "child" }[];
  opportunities: {
    id: number;
    title: string;
    url: string | null;
    posted: string | null;
    closes: string | null;
    open: boolean;
  }[];
  sources: { label: string; url: string; day: string }[];
};

export type Digest = {
  week_of: string;
  through: string;
  awards: number;
  amount: number;
  prev_awards: number;
  prev_amount: number;
  top: {
    id: number;
    amount: number;
    day: string;
    description: string | null;
    tags: string[];
    org_id: number | null;
    org_name: string | null;
    agency_id: number | null;
    agency_name: string | null;
  }[];
  by_tag: { slug: string; n: number; amount: number }[];
  newcomers: { id: number; name: string; first_day: string; amount: number }[];
  opened: {
    id: number;
    title: string;
    url: string | null;
    posted: string | null;
    closes: string | null;
    agency_id: number | null;
    agency_name: string | null;
  }[];
  closing: {
    id: number;
    title: string;
    url: string | null;
    closes: string;
    agency_id: number | null;
    agency_name: string | null;
  }[];
};

export type SearchHit = { id: number; name: string; kind: OrgKind; uei: string | null };

/** Base URL of the API service. On Vercel (and under `vercel dev`) API_URL is
 *  injected by the web service's binding to the api service (vercel.json); it
 *  resolves at request time only, never during `next build`. Locally it falls
 *  back to `uv run python -m pipeline.api.dev`. */
function apiBase(): string {
  const base = process.env.API_URL ?? "http://127.0.0.1:8000";
  // new URL() drops the last path segment of a base without a trailing slash.
  return base.endsWith("/") ? base : `${base}/`;
}

/** Server-side fetch, straight to the API. Returns null when it is unreachable
 *  or the row does not exist, so pages can show an empty state. */
export async function serverGet<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(new URL(`api/${path}`, apiBase()), { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Browser fetch, same origin. On Vercel the top-level /api rewrite in
 *  vercel.json routes it to the api service; under `pnpm dev` the rewrite in
 *  next.config.ts proxies it. */
export async function clientGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`/api/${path}`, { signal });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
}
