import Link from "next/link";
import "../forum/forum.css";
import { Empty } from "@/components/Empty";
import { NoRows, Panel, SkeletonRows } from "@/components/Signals";
import { serverGet } from "@/lib/api";
import { day } from "@/lib/format";
import { priorLabel, WINDOWS, windowLabel, type Page } from "@/lib/signals";
import { tagLabel } from "@/lib/tags";
import type { Board, Column, Ctx } from "./boards";
import { getRecord } from "./record";
import {
  defaultSort,
  LEDGER_ID,
  PAGE_SIZE,
  sameSort,
  sortHref,
  tabOf,
  viewHref,
  type Order,
  type Sort,
  type View,
} from "./view";

// One leaderboard, drawn from its description in boards.tsx: the request, the
// table with its sortable headers, the paging line, and the states around it
// (nothing to show, nothing to compare with, API not answering).

// Paging links jump to the ledger's top; this keeps it clear of the top bar.
const CARD = "scroll-mt-24";

/** Are two neighbouring values in the order asked for? Names are compared
 *  loosely: the database's alphabet is not exactly JavaScript's, and this must
 *  never call a correctly sorted list unsorted. */
function agrees(a: number | string, b: number | string, order: Order): boolean {
  const [lo, hi] = order === "asc" ? [a, b] : [b, a];
  if (typeof lo === "number" && typeof hi === "number") return lo <= hi;
  const x = String(lo);
  const y = String(hi);
  return (
    x <= y ||
    x.localeCompare(y, "en", { sensitivity: "base" }) <= 0 ||
    x.localeCompare(y, "en", { sensitivity: "base", ignorePunctuation: true }) <= 0
  );
}

/** True when the rows are ordered by `value` as asked, blanks last (the API
 *  puts them last in both directions). */
function inOrder<R>(rows: R[], value: (row: R) => number | string | null, order: Order): boolean {
  let last: number | string | null = null;
  let blanks = false;
  for (const row of rows) {
    const v = value(row);
    if (v == null) {
      blanks = true;
      continue;
    }
    if (blanks || (last != null && !agrees(last, v, order))) return false;
    last = v;
  }
  return true;
}

/** Ask for the rows in one order. Null when the API did not answer, refused
 *  the sort, or sent rows that are not in it. The last case is an API that
 *  predates a sort option: it ignores the parameter instead of refusing it,
 *  and the page must not put a sort mark over rows that are not sorted. */
async function load<R, P extends Page<R>>(board: Board<R, P>, view: View, sort: Sort): Promise<P | null> {
  const usual = sameSort(sort, defaultSort(tabOf(view.tab)));
  const page = await serverGet<P>(board.path(view, usual ? null : sort));
  if (!page || usual) return page;
  const value = board.columns.find((c) => c.sort === sort.sort)?.value;
  return value && !inOrder(page.items, value, sort.order) ? null : page;
}

/** The section while its rows load. It carries the ledger's id: a paging link
 *  jumps to `#ledger` when the navigation commits, and this is what is on
 *  screen then. */
export function LedgerSkeleton({ title }: { title?: string }) {
  return (
    <section id={LEDGER_ID} className={CARD} aria-busy="true">
      {title ? <h2 className="panel-title">{title}</h2> : <span className="skeleton h-7 w-52" />}
      <span className="sr-only">Loading</span>
      <span className="skeleton mt-3 h-3.5 w-full max-w-xl" />
      <SkeletonRows rows={10} className="mt-5" />
    </section>
  );
}

function Head<R, P>({
  col,
  view,
  active,
  sortable,
}: {
  col: Column<R, P>;
  view: View;
  active: Sort | null;
  sortable: boolean;
}) {
  const align = col.num ? "num" : "";
  if (!sortable || !col.sort)
    return (
      <th scope="col" className={align} title={col.hint}>
        {col.head}
      </th>
    );
  const on = active?.sort === col.sort ? active.order : null;
  const { href, next } = sortHref(view, col.sort, active);
  return (
    <th scope="col" className={align} title={col.hint} aria-sort={on ? (on === "asc" ? "ascending" : "descending") : undefined}>
      {/* On a column of figures the caret sits before the word, so the word
          ends where the figures do. */}
      <Link href={href} scroll={false} className={`inline-flex items-center gap-1 hover:text-ink ${col.num ? "flex-row-reverse" : ""}`}>
        {col.head}
        <span className="sr-only">: sort {next === "asc" ? "ascending" : "descending"}</span>
        {/* The caret keeps its place on every sortable header, so the columns
            do not shift when the sort moves; it shows faintly on hover. It
            points up for ascending, down for descending. */}
        <svg
          viewBox="0 0 10 10"
          className="forum-sort"
          data-on={on ? "" : undefined}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d={(on ?? next) === "asc" ? "M2 6.5 5 3.5l3 3" : "M2 3.5 5 6.5l3-3"} />
        </svg>
      </Link>
    </th>
  );
}

/** "rows 26 to 50 of 132", with previous and next when there is more than one page. */
function Pager<R>({ page, view }: { page: Page<R>; view: View }) {
  const n = (v: number) => v.toLocaleString("en-US");
  const from = page.offset + 1;
  const to = page.offset + page.items.length;
  const step = (label: string, target: number, on: boolean) =>
    on ? (
      <Link href={viewHref(view, { page: target }, LEDGER_ID)} className="btn btn-sm">
        {label}
      </Link>
    ) : (
      // No such page: the same button, faded, so the row does not jump
      // between pages. Hidden from screen readers, which have the count.
      <span className="btn btn-sm" aria-disabled="true" aria-hidden="true">
        {label}
      </span>
    );
  return (
    <nav className="mt-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-3" aria-label="Pages of this leaderboard">
      <p className="text-muted">
        Rows {n(from)} to {n(to)} of {n(page.total)}
      </p>
      {page.total > PAGE_SIZE && (
        <div className="flex items-center gap-2">
          {step("Previous", view.page - 1, view.page > 1)}
          {step("Next", view.page + 1, to < page.total)}
        </div>
      )}
    </nav>
  );
}

export async function Ledger<R, P extends Page<R>>({ board, view }: { board: Board<R, P>; view: View }) {
  const usual = defaultSort(tabOf(view.tab));
  const asked: Sort = { sort: view.sort, order: view.order };
  // Started now, read after the rows: the two requests run side by side.
  const pending = getRecord();

  // If the order asked for cannot be had: once more in the endpoint's own order.
  let page: P | null = await load(board, view, asked);
  let active: Sort | null = asked;
  if (!page && !sameSort(asked, usual)) {
    page = await load(board, view, usual);
    active = usual;
  }
  if (!page)
    return <Empty title="Nothing to rank right now">The data service is not answering, so there are no figures to show.</Empty>;
  const fellBack = !sameSort(asked, active);

  const prior = page.coverage.prior_complete;
  // The topics board counts solicitations, and the API judges its prior period by them.
  const bySolicitations = board.tab === "topics";
  const began = bySolicitations ? page.coverage.first_solicitation_day : page.coverage.first_award_day;
  const noPrior = began
    ? `Our ${bySolicitations ? "solicitation record" : "data"} begins ${day(began)}, after ${priorLabel(page.window_days)} began, so there is no full earlier period to compare with.`
    : `There are no ${bySolicitations ? "solicitations" : "awards"} on record yet, so there is no earlier period to compare with.`;

  // Columns that compare with the prior period go when there is none. If the
  // rows were ordered by one of them, ask again in an order the reader can see.
  const columns = prior ? board.columns : board.columns.filter((c) => !c.needsPrior);
  if (active && !columns.some((c) => c.sort === active?.sort)) {
    const instead = board.noPriorSort ?? usual;
    const again =
      !sameSort(instead, active) && columns.some((c) => c.sort === instead.sort) ? await load(board, view, instead) : null;
    if (again) page = again;
    active = again ? instead : null;
  }

  const ctx: Ctx<P> = { page, view, active, record: await pending };
  const title = board.title;
  // Kept to a readable measure: the section is as wide as the widest table.
  const note = <span className="block max-w-3xl">{board.note(ctx)}</span>;

  if (board.needsPrior && !prior)
    return (
      <Panel title={title} id={LEDGER_ID} className={CARD}>
        <Empty title="No earlier period to compare with">
          {noPrior}
          {/* Only when a shorter window exists and there are awards for it to reach. */}
          {began && page.window_days > WINDOWS[0] && " Try a shorter window."}
        </Empty>
      </Panel>
    );

  if (page.items.length === 0)
    return (
      <Panel title={title} note={note} id={LEDGER_ID} className={CARD}>
        {page.total > 0 ? (
          // A page number past the end, most likely from an old link.
          <NoRows>
            There is no page {view.page} of this list. <Link href={viewHref(view, { page: 1 })}>Back to the first page</Link>
          </NoRows>
        ) : (
          <Empty title={board.empty.title}>{board.empty.text(ctx)}</Empty>
        )}
      </Panel>
    );

  const rows = board.arrange ? board.arrange(page.items, ctx) : page.items;
  const sorts = tabOf(view.tab).sorts;
  const caption = `${title}, ${windowLabel(page.window_days)}${page.tag ? `, ${tagLabel(page.tag)}` : ""}`;

  return (
    <Panel title={title} note={note} id={LEDGER_ID} className={CARD}>
      {!prior && columns.length < board.columns.length && <p className="mb-3 max-w-3xl text-muted">{noPrior} Changes are not shown.</p>}
      {fellBack && (
        <p className="mb-3 max-w-3xl text-muted" role="status">
          The data service could not sort by that column just now, so the list is in its usual order.
        </p>
      )}
      {/* A wide ledger scrolls inside its section, never the page. The region can
          take focus, so it also scrolls from the keyboard. It is `relative` so
          the visually hidden labels inside far-right cells (absolutely
          positioned) are clipped with the table instead of widening the page. */}
      <div className="relative overflow-x-auto" tabIndex={0} role="region" aria-label={`${caption}: table`}>
        <table className={`ledger ${board.width}`}>
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {columns.map((col) => (
                <Head key={col.key} col={col} view={view} active={active} sortable={col.sort != null && Object.hasOwn(sorts, col.sort)} />
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={board.rowKey(row)}>
                {columns.map((col) => (
                  <td key={col.key} className={`${col.num ? "num" : ""} ${col.className ?? ""}`}>
                    {col.cell(row, ctx, page.offset + i)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager page={page} view={view} />
    </Panel>
  );
}
