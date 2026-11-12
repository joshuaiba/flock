// The leaderboards page keeps everything in the URL, so any view can be shared:
//   /forum/leaderboards?tab=entrants&window=365&tag=maritime&sort=first_day&order=asc&page=2
// This file reads that query leniently (anything unknown becomes the default)
// and writes links back in the same shape, leaving defaults out.

import { parseWindow, type WindowDays } from "@/lib/signals";
import { TAGS } from "@/lib/tags";

export const BASE = "/forum/leaderboards";
export const PAGE_SIZE = 25;
// The ledger's id: paging links jump back to its top.
export const LEDGER_ID = "ledger";

export type Order = "asc" | "desc";
export type Sort = { sort: string; order: Order };

export type TabKey = "recipients" | "rising" | "entrants" | "transitions" | "agencies" | "topics";

export type Tab = {
  key: TabKey;
  label: string;
  /** false where the category filter means nothing (topics are the categories) */
  usesTag: boolean;
  /** the column the API sorts by when none is asked for */
  sort: string;
  /** every sortable column, with the direction a first click gives it:
   *  largest first for figures, A to Z for names */
  sorts: Record<string, Order>;
};

// The sort keys are the API's (see the *_SORT tables in pipeline/api/signals.py).
export const TABS: Tab[] = [
  {
    key: "recipients",
    label: "Top recipients",
    usesTag: true,
    sort: "amount",
    sorts: { amount: "desc", awards: "desc", pct: "desc", name: "asc" },
  },
  {
    key: "rising",
    label: "Fastest rising",
    usesTag: true,
    sort: "pct",
    sorts: { pct: "desc", delta: "desc" },
  },
  {
    key: "entrants",
    label: "New entrants",
    usesTag: true,
    sort: "amount",
    sorts: { amount: "desc", first_day: "desc", first_amount: "desc", awards: "desc", name: "asc" },
  },
  {
    key: "transitions",
    label: "Most transitions",
    usesTag: true,
    sort: "transitions",
    sorts: { transitions: "desc", transitions_total: "desc", stage: "desc", days_total: "asc", name: "asc" },
  },
  {
    key: "agencies",
    label: "Top agencies",
    usesTag: true,
    sort: "amount",
    sorts: { amount: "desc", awards: "desc", posted: "desc", name: "asc" },
  },
  {
    key: "topics",
    label: "Rising topics",
    usesTag: false,
    sort: "delta",
    sorts: { delta: "desc", posted: "desc", prev_posted: "desc", open: "desc", amount: "desc", category: "asc" },
  },
];

export function tabOf(key: TabKey): Tab {
  return TABS.find((t) => t.key === key) ?? TABS[0];
}

export type View = {
  tab: TabKey;
  window: WindowDays;
  /** kept on every tab so it survives a visit to one that ignores it */
  tag: string | null;
  sort: string;
  order: Order;
  page: number;
};

export function defaultSort(tab: Tab): Sort {
  return { sort: tab.sort, order: tab.sorts[tab.sort] };
}
export function sameSort(a: Sort, b: Sort): boolean {
  return a.sort === b.sort && a.order === b.order;
}

type Query = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Read the query string. Never throws: a value we do not know is the default. */
export function parseView(q: Query): View {
  const tab = TABS.find((t) => t.key === one(q.tab)) ?? TABS[0];
  const tag = one(q.tag);
  const asked = one(q.sort);
  const sort = asked && Object.hasOwn(tab.sorts, asked) ? asked : tab.sort;
  const order = one(q.order);
  const page = Number(one(q.page));
  return {
    tab: tab.key,
    window: parseWindow(q.window),
    tag: tag && TAGS.includes(tag) ? tag : null,
    sort,
    order: order === "asc" || order === "desc" ? order : tab.sorts[sort],
    // The cap keeps a typed-in page number from asking the API for an absurd offset.
    page: Number.isInteger(page) && page >= 1 && page <= 10_000 ? page : 1,
  };
}

/** The query values that differ from the defaults, in a fixed order. */
function query(v: View): [string, string][] {
  const tab = tabOf(v.tab);
  const out: [string, string][] = [];
  if (v.tab !== TABS[0].key) out.push(["tab", v.tab]);
  if (v.window !== 90) out.push(["window", String(v.window)]);
  if (v.tag) out.push(["tag", v.tag]);
  if (!sameSort(v, defaultSort(tab))) out.push(["sort", v.sort], ["order", v.order]);
  if (v.page > 1) out.push(["page", String(v.page)]);
  return out;
}

/** A link to this view with some of it changed. */
export function viewHref(view: View, change: Partial<View> = {}, hash = ""): string {
  const s = new URLSearchParams(query({ ...view, ...change })).toString();
  return `${BASE}${s ? `?${s}` : ""}${hash ? `#${hash}` : ""}`;
}

/** Another tab: same window and category, that tab's own default order, page one. */
export function tabHref(view: View, tab: Tab): string {
  return viewHref(view, { tab: tab.key, ...defaultSort(tab), page: 1 });
}

/** A column header: a first click sorts by it, a second reverses it. */
export function sortHref(view: View, sort: string, active: Sort | null): { href: string; next: Order } {
  const tab = tabOf(view.tab);
  const next: Order = active?.sort === sort ? (active.order === "asc" ? "desc" : "asc") : tab.sorts[sort];
  return { href: viewHref(view, { sort, order: next, page: 1 }), next };
}

/** What SignalFilters must carry along when it changes the window or the
 *  category: the tab and the sort, not the page number. */
export function filterParams(view: View): Record<string, string | undefined> {
  const tab = tabOf(view.tab);
  const sorted = !sameSort(view, defaultSort(tab));
  return {
    tab: view.tab !== TABS[0].key ? view.tab : undefined,
    sort: sorted ? view.sort : undefined,
    order: sorted ? view.order : undefined,
  };
}

/** Changes whenever the rows on screen would: used to show the skeleton again. */
export function viewKey(v: View): string {
  return [v.tab, v.window, v.tag ?? "", v.sort, v.order, v.page].join("|");
}
