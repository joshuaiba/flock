import Link from "next/link";
import type { ReactNode } from "react";
import { MedallionImg } from "@/components/Art";
import { OrgLink, RankChange, StageTrack } from "@/components/Signals";
import { medallionForFamily } from "@/lib/art";
import { day, dollars, plural } from "@/lib/format";
import {
  familyOfTag,
  mixText,
  pct,
  priorLabel,
  signalPath,
  STAGE_LABEL,
  windowLabel,
  type AgencyRow,
  type Definitions,
  type EntrantRow,
  type FundingPage,
  type FundingRow,
  type Page,
  type SignalOrg,
  type StageKey,
  type TopicPage,
  type TopicRow,
  type TransitionCompanyRow,
} from "@/lib/signals";
import { tagLabel, tagPhrase } from "@/lib/tags";
import { PAGE_SIZE, viewHref, type Sort, type TabKey, type View } from "./view";

// The six leaderboards: for each, where its rows come from, its columns and
// the sentences around it. The Ledger component (Ledger.tsx) draws any of them.

/** What a cell or a sentence can read besides its own row. */
export type Ctx<P> = {
  page: P;
  view: View;
  /** the order the rows are really in; null when it matches no column on screen */
  active: Sort | null;
  /** the size of the whole record, when the API gave it (see Ledger.tsx) */
  record: Definitions | null;
};

export type Column<R, P> = {
  key: string;
  head: string;
  /** a longer explanation, shown as the header's tooltip */
  hint?: string;
  /** the API sort key; the header becomes a link when the tab lists it */
  sort?: string;
  /** what the API orders this column by, so the page can check the order it was sent */
  value?: (row: R) => number | string | null;
  /** right-aligned figures */
  num?: boolean;
  /** compares with the prior period: left out when the data does not reach back that far */
  needsPrior?: boolean;
  className?: string;
  /** `position` counts rows from zero across pages */
  cell: (row: R, ctx: Ctx<P>, position: number) => ReactNode;
};

export type Board<R, P extends Page<R>> = {
  tab: TabKey;
  title: string;
  /** the API path for this view; `sort` null asks for the endpoint's own order */
  path: (view: View, sort: Sort | null) => string;
  rowKey: (row: R) => string | number;
  columns: Column<R, P>[];
  /** the smallest width the table is drawn at before it scrolls sideways */
  width: string;
  /** under the title: what is counted, and the caveats the reader must know */
  note: (ctx: Ctx<P>) => ReactNode;
  /** the empty state: a title and one line saying what would appear here */
  empty: { title: string; text: (ctx: Ctx<P>) => string };
  /** the whole board is a comparison with the prior period */
  needsPrior?: boolean;
  /** the order to use when the usual one is by a column that had to be left out */
  noPriorSort?: Sort;
  /** a last pass over the rows before they are drawn (see TOPICS) */
  arrange?: (rows: R[], ctx: Ctx<P>) => R[];
};

// ------------------------------------------------------------ shared pieces

/** The parameters every endpoint takes. `tag` is left out where it does not apply. */
function params(view: View, sort: Sort | null, tag = true) {
  return {
    window: view.window,
    tag: tag ? view.tag : null,
    limit: PAGE_SIZE,
    offset: (view.page - 1) * PAGE_SIZE,
    sort: sort?.sort,
    order: sort?.order,
  };
}

/** "the last 90 days" / "the last year" */
function lastLabel(days: number): string {
  return days === 365 ? "the last year" : `the last ${windowLabel(days)}`;
}
/** ", maritime only" when a category is chosen */
function only(tag: string | null): string {
  return tag ? `, ${tagPhrase(tag)} only` : "";
}

/** ", among companies with maritime awards": for the boards whose figures
 *  cover all of a company's awards, where the filter only picks the companies. */
function among(tag: string | null): string {
  return tag ? `, among companies with ${tagPhrase(tag)} awards` : "";
}

/** Dollars awarded: the one place the accent is used. */
function Awarded({ v }: { v: number }) {
  return <span className="money">{dollars(v)}</span>;
}

/** A change with its sign, "+12%" or "−$1,204": the sign carries the
 *  direction. A multiple ("13×") is growth by definition and takes none. */
function Move({ v, text, title }: { v: number; text: string; title?: string }) {
  if (v === 0)
    return (
      <span className="text-muted" title={title}>
        <span aria-hidden="true">–</span>
        <span className="sr-only">no change</span>
      </span>
    );
  return (
    <span className="whitespace-nowrap text-ink" title={title}>
      {text.endsWith("×") ? "" : v > 0 ? "+" : "−"}
      {text}
    </span>
  );
}

const Dash = () => <span className="text-muted">—</span>;

/** A company or agency: its name, and the "show in graph" link. */
function Who({ org }: { org: SignalOrg | null }) {
  return org ? <OrgLink org={org} className="max-w-[15rem] sm:max-w-[22rem]" /> : <Dash />;
}
function Category({ org }: { org: SignalOrg | null }) {
  return org?.tag ? <span className="text-muted">{tagLabel(org.tag)}</span> : <Dash />;
}

/** The row's place in the list as it is ordered now. */
function place<R, P extends Page<R>>(): Column<R, P> {
  return {
    key: "place",
    head: "No.",
    hint: "Place in the list as it is ordered now",
    className: "w-px text-muted",
    cell: (_row, _ctx, position) => position + 1,
  };
}

const STAGE_ORDER: StageKey[] = ["solicitation", "phase_1", "phase_2", "production"];

// ------------------------------------------------------------ top recipients

export const RECIPIENTS: Board<FundingRow, FundingPage> = {
  tab: "recipients",
  title: "Top recipients",
  path: (view, sort) => signalPath("funding", { by: "company", ...params(view, sort) }),
  rowKey: (r) => r.org?.id ?? "none",
  width: "min-w-[760px]",
  note: ({ page }) => (
    <>
      Award dollars by company in {lastLabel(page.window_days)}
      {only(page.tag)}.
      {page.coverage.prior_complete && <> Rank moves and changes are against {priorLabel(page.window_days)}.</>}
    </>
  ),
  empty: {
    title: "No awards in this window",
    text: ({ page }) =>
      `Companies would be ranked here by the award dollars they received in ${lastLabel(page.window_days)}${only(page.tag)}.`,
  },
  columns: [
    {
      key: "rank",
      head: "Rank",
      hint: "By award dollars in the window",
      className: "w-px",
      cell: (r, { page }) => (
        <span className="inline-grid grid-cols-[minmax(1.25rem,auto)_auto] items-baseline gap-2 whitespace-nowrap [&>:first-child]:text-right">
          <span>{r.rank ?? "—"}</span>
          {page.coverage.prior_complete && <RankChange rank={r.rank} prev={r.prev_rank} />}
        </span>
      ),
    },
    { key: "org", head: "Company", sort: "name", value: (r) => r.org?.name ?? null, cell: (r) => <Who org={r.org} /> },
    { key: "category", head: "Category", hint: "The company's largest category", cell: (r) => <Category org={r.org} /> },
    { key: "amount", head: "Awarded", sort: "amount", value: (r) => r.amount, num: true, cell: (r) => <Awarded v={r.amount} /> },
    { key: "awards", head: "Awards", sort: "awards", value: (r) => r.awards, num: true, cell: (r) => r.awards },
    {
      key: "change",
      head: "Change",
      hint: "Against the prior period. A percentage when the prior period was large enough to give one, otherwise the change in dollars.",
      sort: "pct",
      value: (r) => r.pct,
      num: true,
      needsPrior: true,
      cell: (r, { page }) => {
        const was = `${dollars(r.prev_amount)} in ${priorLabel(page.window_days)}`;
        // Under half a percent reads as level, as it does everywhere else on the site.
        if (r.pct != null) return <Move v={Math.abs(r.pct) < 0.005 ? 0 : r.pct} text={pct(r.pct)} title={was} />;
        return <Move v={r.delta} text={dollars(Math.abs(r.delta))} title={was} />;
      },
    },
  ],
};

// ------------------------------------------------------------ fastest rising

export const RISING: Board<FundingRow, FundingPage> = {
  tab: "rising",
  title: "Fastest rising",
  needsPrior: true,
  path: (view, sort) => signalPath("momentum", { by: "company", direction: "rising", ...params(view, sort) }),
  rowKey: (r) => r.org?.id ?? "none",
  width: "min-w-[860px]",
  note: ({ page }) => (
    <>
      Companies whose award dollars grew against {priorLabel(page.window_days)}
      {only(page.tag)}. Those with under {dollars(page.min_baseline)} in the prior period are left out of percentage
      rankings, because growth from almost nothing is noise; sort by dollar change to see them.
    </>
  ),
  empty: {
    title: "No one rising",
    text: ({ page, active }) =>
      active?.sort === "delta"
        ? `Companies whose award dollars grew against ${priorLabel(page.window_days)} would be ranked here${only(page.tag)}.`
        : `Companies whose award dollars grew against ${priorLabel(page.window_days)}, from at least ${dollars(page.min_baseline)}, would be ranked here${only(page.tag)}.`,
  },
  columns: [
    {
      key: "rank",
      head: "Rank",
      hint: "By growth, or by dollar change when sorted by it",
      className: "w-px",
      // By percentage the API gives the rank. By dollar change the list holds
      // every riser in order, so the rank is the row's place counted from the
      // biggest change, whichever way the list is turned.
      cell: (r, { page, active }, position) =>
        active?.sort === "delta" ? (active.order === "asc" ? page.total - position : position + 1) : (r.pct_rank ?? "—"),
    },
    { key: "org", head: "Company", cell: (r) => <Who org={r.org} /> },
    { key: "category", head: "Category", hint: "The company's largest category", cell: (r) => <Category org={r.org} /> },
    { key: "amount", head: "Awarded", hint: "Award dollars in the window", num: true, cell: (r) => <Awarded v={r.amount} /> },
    {
      key: "prev",
      head: "Prior",
      hint: "Award dollars in the prior period",
      num: true,
      className: "text-muted",
      cell: (r) => dollars(r.prev_amount),
    },
    {
      key: "pct",
      head: "Growth",
      sort: "pct",
      value: (r) => r.pct,
      num: true,
      cell: (r, { page }) =>
        r.pct != null ? (
          <Move v={r.pct} text={pct(r.pct)} />
        ) : (
          <span className="text-muted" title={`Under ${dollars(page.min_baseline)} in the prior period: no percentage`}>
            —
          </span>
        ),
    },
    {
      key: "delta",
      head: "Dollar change",
      sort: "delta",
      value: (r) => r.delta,
      num: true,
      cell: (r) => <Move v={r.delta} text={dollars(Math.abs(r.delta))} />,
    },
  ],
};

// ------------------------------------------------------------ new entrants

export const ENTRANTS: Board<EntrantRow, Page<EntrantRow>> = {
  tab: "entrants",
  title: "New entrants",
  path: (view, sort) => signalPath("new-entrants", params(view, sort)),
  rowKey: (r) => r.org.id,
  width: "min-w-[860px]",
  note: ({ page }) => (
    <>
      Companies whose first award in this data set falls in {lastLabel(page.window_days)}
      {among(page.tag)}. New means new to this record
      {page.coverage.first_award_day && <>, which begins {day(page.coverage.first_award_day)}</>}; a company can have won
      awards before it.
    </>
  ),
  empty: {
    title: "No newcomers",
    text: ({ page }) =>
      `Companies with their first award on record in ${lastLabel(page.window_days)} would be listed here${among(page.tag)}.`,
  },
  columns: [
    place(),
    { key: "org", head: "Company", sort: "name", value: (r) => r.org.name, cell: (r) => <Who org={r.org} /> },
    { key: "category", head: "Category", hint: "The company's largest category", cell: (r) => <Category org={r.org} /> },
    {
      key: "first_day",
      head: "First award",
      sort: "first_day",
      value: (r) => r.first_day,
      num: true,
      cell: (r) => day(r.first_day),
    },
    {
      key: "first_amount",
      head: "First award dollars",
      hint: "Awarded on the day of the first award",
      sort: "first_amount",
      value: (r) => r.first_amount,
      num: true,
      cell: (r) => <Awarded v={r.first_amount} />,
    },
    {
      key: "amount",
      head: "Total since",
      hint: "Everything awarded from the first award to the as-of date",
      sort: "amount",
      value: (r) => r.amount,
      num: true,
      cell: (r) => <Awarded v={r.amount} />,
    },
    { key: "awards", head: "Awards", sort: "awards", value: (r) => r.awards, num: true, cell: (r) => r.awards },
  ],
};

// ------------------------------------------------------------ most transitions

export const TRANSITIONS: Board<TransitionCompanyRow, Page<TransitionCompanyRow>> = {
  tab: "transitions",
  title: "Most transitions",
  path: (view, sort) => signalPath("transitions/companies", params(view, sort)),
  rowKey: (r) => r.org.id,
  width: "min-w-[900px]",
  note: ({ page }) => (
    <>
      Companies that moved from one stage to the next in {lastLabel(page.window_days)}
      {among(page.tag)}. Stages are read from award descriptions; the sources publish no stage field. A filled dot is a
      stage on record.
    </>
  ),
  empty: {
    title: "No moves between stages",
    text: ({ page }) =>
      `Companies that moved from one stage to the next in ${lastLabel(page.window_days)} would be ranked here${among(page.tag)}.`,
  },
  columns: [
    place(),
    { key: "org", head: "Company", sort: "name", value: (r) => r.org.name, cell: (r) => <Who org={r.org} /> },
    { key: "category", head: "Category", hint: "The company's largest category", cell: (r) => <Category org={r.org} /> },
    {
      key: "transitions",
      head: "Moves",
      hint: "Stage-to-stage moves inside the window",
      sort: "transitions",
      value: (r) => r.transitions,
      num: true,
      cell: (r) => r.transitions,
    },
    {
      key: "transitions_total",
      head: "On record",
      hint: "Stage-to-stage moves in all our data",
      sort: "transitions_total",
      value: (r) => r.transitions_total,
      num: true,
      cell: (r) => r.transitions_total,
    },
    {
      key: "stage",
      head: "Furthest stage",
      sort: "stage",
      value: (r) => STAGE_ORDER.indexOf(r.stage),
      cell: (r) => (
        <span className="inline-flex items-center gap-3 whitespace-nowrap">
          <StageTrack path={r.path} />
          <span>{STAGE_LABEL[r.stage]}</span>
        </span>
      ),
    },
    {
      key: "days_total",
      head: "First to furthest",
      hint: "Days from the first stage on record to the furthest",
      sort: "days_total",
      value: (r) => r.days_total,
      num: true,
      cell: (r) => (r.days_total == null ? <Dash /> : plural(r.days_total, "day")),
    },
  ],
};

// ------------------------------------------------------------ top agencies

/** An agency's categories in words. Without a category filter each is a share
 *  of the agency's categorized dollars (an award in two categories counts in
 *  both, so these can come to more than its total; the Forum's Agencies panel
 *  does the same). With one, the row's dollars are that category
 *  alone, so there is no honest total to take shares of: names only, largest
 *  first. */
function mix(r: AgencyRow, filtered: boolean): string {
  if (!filtered) return mixText(r.mix, r.mix.reduce((s, m) => s + Math.max(m.amount, 0), 0));
  return r.mix
    .filter((m) => m.amount > 0)
    .slice(0, 3)
    .map((m) => tagLabel(m.category))
    .join(", ");
}

export const AGENCIES: Board<AgencyRow, Page<AgencyRow>> = {
  tab: "agencies",
  title: "Top agencies",
  path: (view, sort) => signalPath("agencies", params(view, sort)),
  rowKey: (r) => r.org.id,
  width: "min-w-[900px]",
  note: ({ page, record }) => (
    <>
      Agencies and offices by the award dollars they obligated in {lastLabel(page.window_days)}
      {only(page.tag)}, as the source recorded them: offices are not rolled up into their parent.{" "}
      {page.tag
        ? "The mix names each agency's largest categories in the window, across all of its awards."
        : "The mix is each category's share of the agency's categorized dollars; an award in two categories counts in both."}
      {record?.opportunities === 0 && <> No solicitation source is loaded yet, so postings cannot be counted.</>}
    </>
  ),
  empty: {
    title: "No agencies in this window",
    text: ({ page }) =>
      `Agencies and offices that awarded or posted in ${lastLabel(page.window_days)} would be ranked here${only(page.tag)}.`,
  },
  columns: [
    {
      key: "rank",
      head: "Rank",
      hint: "By award dollars in the window",
      className: "w-px",
      cell: (r, { page }) => (
        <span className="inline-grid grid-cols-[minmax(1.25rem,auto)_auto] items-baseline gap-2 whitespace-nowrap [&>:first-child]:text-right">
          {/* An agency that only posted solicitations has no place by dollars. */}
          <span>{r.rank ?? "—"}</span>
          {page.coverage.prior_complete && <RankChange rank={r.rank} prev={r.prev_rank} />}
        </span>
      ),
    },
    { key: "org", head: "Agency", sort: "name", value: (r) => r.org.name, cell: (r) => <Who org={r.org} /> },
    { key: "amount", head: "Awarded", sort: "amount", value: (r) => r.amount, num: true, cell: (r) => <Awarded v={r.amount} /> },
    { key: "awards", head: "Awards", sort: "awards", value: (r) => r.awards, num: true, cell: (r) => r.awards },
    {
      key: "posted",
      head: "Solicitations",
      hint: "Solicitations posted in the window",
      sort: "posted",
      value: (r) => r.posted,
      num: true,
      // With no solicitation source loaded a zero would read as "none posted".
      cell: (r, { record }) => (record?.opportunities === 0 ? <Dash /> : r.posted),
    },
    {
      key: "mix",
      head: "Category mix",
      className: "min-w-[15rem] text-muted",
      cell: (r, { page }) => mix(r, page.tag != null) || <Dash />,
    },
  ],
};

// ------------------------------------------------------------ rising topics

export const TOPICS: Board<TopicRow, TopicPage> = {
  tab: "topics",
  title: "Rising topics",
  path: (view, sort) => signalPath("topics", params(view, sort, false)),
  rowKey: (r) => r.category,
  width: "min-w-[780px]",
  // Without a prior period the change column goes, and the list is ordered by
  // what was posted instead.
  noPriorSort: { sort: "posted", order: "desc" },
  note: ({ page, record }) => (
    <>
      Solicitations posted per category in {lastLabel(page.window_days)}
      {page.coverage.prior_complete && <> against {priorLabel(page.window_days)}</>}. Solicitations come before money,
      so this is the leading indicator.
      {page.coverage.prior_complete && record && (
        <> A percentage is given only when the prior period had at least {record.min_topic_baseline}.</>
      )}
    </>
  ),
  empty: {
    title: "No solicitations on record",
    text: ({ page, record }) =>
      `Categories would be ranked here by the solicitations posted in ${lastLabel(page.window_days)}.` +
      (record?.opportunities === 0 ? " No solicitation source is loaded yet." : ""),
  },
  // The API orders categories by their slug, and the page shows their names
  // ("gps-denied-nav" is "Navigation without GPS"). There are few enough
  // categories to fit on one page, so order them by the name the reader sees.
  arrange: (rows, { page, active }) => {
    if (active?.sort !== "category" || page.total > rows.length) return rows;
    const sign = active.order === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => sign * tagLabel(a.category).localeCompare(tagLabel(b.category), "en"));
  },
  columns: [
    place(),
    {
      key: "category",
      head: "Category",
      sort: "category",
      value: (r) => r.category,
      // A list of categories is where a picture helps: each one carries its
      // family's medallion as a small icon.
      cell: (r, { view, record }) => (
        <span className="name inline-flex items-center gap-2.5">
          <MedallionImg name={medallionForFamily(familyOfTag(record?.families, r.category))} size={22} />
          <Link
            href={viewHref(view, { tab: "recipients", tag: r.category, sort: "amount", order: "desc", page: 1 })}
            title={`Top recipients in ${tagPhrase(r.category)}`}
          >
            {tagLabel(r.category)}
          </Link>
        </span>
      ),
    },
    { key: "posted", head: "Posted", hint: "Solicitations posted in the window", sort: "posted", value: (r) => r.posted, num: true, cell: (r) => r.posted },
    {
      key: "prev_posted",
      head: "Prior",
      hint: "Solicitations posted in the prior period",
      sort: "prev_posted",
      value: (r) => r.prev_posted,
      num: true,
      needsPrior: true,
      className: "text-muted",
      cell: (r) => r.prev_posted,
    },
    {
      key: "delta",
      head: "Change",
      sort: "delta",
      value: (r) => r.delta,
      num: true,
      needsPrior: true,
      cell: (r) => (
        <>
          <Move v={r.delta} text={String(Math.abs(r.delta))} />
          {r.pct != null && r.delta !== 0 && <span className="text-muted"> ({pct(r.pct)})</span>}
        </>
      ),
    },
    { key: "open", head: "Open now", hint: "Solicitations open on the as-of date", sort: "open", value: (r) => r.open, num: true, cell: (r) => r.open },
    {
      key: "amount",
      head: "Award dollars",
      hint: "Awarded in this category in the same window",
      sort: "amount",
      value: (r) => r.amount,
      num: true,
      cell: (r) => <Awarded v={r.amount} />,
    },
  ],
};
