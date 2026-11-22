import { SeriesChart } from "@/components/SeriesChart";
import { Delta, NoRows, Panel } from "@/components/Signals";
import { serverGet } from "@/lib/api";
import { day, money } from "@/lib/format";
import {
  bucketLabels,
  pct,
  period,
  priorLabel,
  signalPath,
  type CategorySeries,
  type CategorySeriesRow,
} from "@/lib/signals";
import { tagLabel } from "@/lib/tags";
import { Down, type PanelProps } from "./shared";

/** The reading with a category chosen: that category's dollars and how they
 *  moved, so the sentence is about what the filter picked. */
function chosenReading(c: CategorySeriesRow, d: CategorySeries, days: number): string {
  const drew = `${tagLabel(c.category)} drew ${money(c.amount)} in ${period(d)}`;
  if (!d.coverage.prior_complete) return `${drew}. The record has no full earlier period to compare with.`;
  if (c.prev_amount <= 0) return `${drew}, and nothing in ${priorLabel(days)}.`;
  if (c.delta === 0) return `${drew}, level with ${priorLabel(days)}.`;
  const dir = c.delta > 0 ? "up" : "down";
  if (c.pct == null) return `${drew}, ${dir} ${money(Math.abs(c.delta))} on ${priorLabel(days)}.`;
  // pct() writes large growth as a multiple ("25×"), which needs other words.
  if (c.pct >= 10) return `${drew}, ${pct(c.pct)} its total in ${priorLabel(days)}.`;
  return `${drew}, ${dir} ${pct(c.pct)} on ${priorLabel(days)}.`;
}

/** The panel's one-line reading: the category whose dollars rose the most
 *  against the prior period, with a percentage only when the API gives one.
 *  With a category chosen, it is about that category instead. */
function reading(d: CategorySeries, days: number, tag: string | null): string {
  const chosen = tag ? d.items.find((c) => c.category === tag) : undefined;
  if (chosen) return chosenReading(chosen, d, days);
  const top = d.items[0]; // the API lists the largest category first
  if (!d.coverage.prior_complete)
    return `${tagLabel(top.category)} drew the most in ${period(d)}: ${money(top.amount)}. The record has no full earlier period to compare with.`;
  const up = d.items.filter((c) => c.delta > 0).sort((a, b) => b.delta - a.delta)[0];
  if (!up) return `No category grew against ${priorLabel(days)}.`;
  const name = tagLabel(up.category);
  if (up.pct == null) return `${name} rose the most: up ${money(up.delta)} against ${priorLabel(days)}.`;
  // pct() writes large growth as a multiple ("25×"), which needs other words.
  if (up.pct >= 10) return `${name} rose the most: up ${money(up.delta)}, to ${pct(up.pct)} its total in ${priorLabel(days)}.`;
  return `${name} rose the most: up ${pct(up.pct)} (${money(up.delta)}) against ${priorLabel(days)}.`;
}

/** Award dollars over time, one small chart per category. */
export async function FundingByCategory({ days, tag, className = "" }: PanelProps) {
  // Per-category by nature, so the endpoint takes no category filter: every
  // category is drawn and the chosen one is marked.
  const d = await serverGet<CategorySeries>(signalPath("categories/series", { window: days }));
  if (!d)
    return (
      <Panel title="Funding by category" className={className}>
        <Down />
      </Panel>
    );
  // Categories with nothing in either period would be flat lines at zero.
  const items = d.items.filter((c) => c.amount > 0 || c.prev_amount > 0);
  if (items.length === 0)
    return (
      <Panel title="Funding by category" className={className}>
        <NoRows>
          No awards on record in {period(d)} or in {priorLabel(days)}.
        </NoRows>
      </Panel>
    );

  const n = items[0].series.length;
  const labels = bucketLabels(d.series_start, d.bucket_days, n);
  return (
    <Panel
      title="Funding by category"
      className={className}
      takeaway={reading({ ...d, items }, days, tag)}
      note={
        <>
          Award dollars across {priorLabel(days)} (fainter) and {period(d)}. Each chart has its own scale, so
          compare shapes, not heights. An award with two categories counts in both here; &ldquo;Where the money
          went&rdquo; splits it instead.
          {!d.coverage.prior_complete && d.coverage.first_award_day && (
            <>
              {" "}
              The record starts on {day(d.coverage.first_award_day)}, so the fainter half of each line is not a full{" "}
              {days === 365 ? "year" : "period"}.
            </>
          )}
          {tag && " All categories are drawn; the category filter marks one."}
        </>
      }
    >
      <ul className="forum-tiles">
        {items.map((c) => {
          const name = tagLabel(c.category);
          const chosen = c.category === tag;
          return (
            <li key={c.category} aria-current={chosen ? "true" : undefined} className="forum-tile">
              <h3 className="forum-tile-name">
                {name}
                {chosen && <span className="label mt-0.5 block">selected</span>}
              </h3>
              {/* A long name may take two lines; the chart is pushed down, so
                  the charts in a row still line up. */}
              <SeriesChart
                className="mt-auto pt-3"
                values={c.series}
                labels={labels}
                split={Math.floor(n / 2)}
                format="money"
                height={36}
                title={`${name}, award dollars`}
              />
              <p className="mt-3">
                <span className="forum-tile-figure money">{money(c.amount)}</span>
              </p>
              <p>
                <Delta cur={c.amount} prev={c.prev_amount} pct={c.pct} env={d} short />
              </p>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
