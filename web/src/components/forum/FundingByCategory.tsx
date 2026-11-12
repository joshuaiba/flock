import { SeriesChart } from "@/components/SeriesChart";
import { Delta, NoRows, Panel } from "@/components/Signals";
import { serverGet } from "@/lib/api";
import { day, money } from "@/lib/format";
import { bucketLabels, pct, priorLabel, signalPath, type CategorySeries } from "@/lib/signals";
import { tagLabel } from "@/lib/tags";
import { Down, lastLabel, type PanelProps } from "./shared";

/** The panel's one-line reading: the category whose dollars rose the most
 *  against the prior period, with a percentage only when the API gives one. */
function reading(d: CategorySeries, days: number): string {
  const top = d.items[0]; // the API lists the largest category first
  if (!d.coverage.prior_complete)
    return `${tagLabel(top.category)} drew the most in ${lastLabel(days)}: ${money(top.amount)}. The record has no full earlier period to compare with.`;
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
          No awards on record in {lastLabel(days)} or in {priorLabel(days)}.
        </NoRows>
      </Panel>
    );

  const n = items[0].series.length;
  const labels = bucketLabels(d.series_start, d.bucket_days, n);
  return (
    <Panel
      title="Funding by category"
      className={className}
      takeaway={reading({ ...d, items }, days)}
      note={
        <>
          Award dollars across {priorLabel(days)} (fainter) and {lastLabel(days)}. Each chart has its own scale, so
          compare shapes, not heights. An award with two categories counts in both.
          {!d.coverage.prior_complete && d.coverage.first_award_day && (
            <> The record starts on {day(d.coverage.first_award_day)}.</>
          )}
          {tag && " All categories are drawn; the category filter marks one."}
        </>
      }
    >
      <ul className="grid grid-cols-2 gap-x-8 gap-y-8 sm:grid-cols-3 lg:grid-cols-5">
        {items.map((c) => {
          const name = tagLabel(c.category);
          const chosen = c.category === tag;
          return (
            <li key={c.category} aria-current={chosen ? "true" : undefined} className="flex min-w-0 flex-col">
              {/* A long name may take two lines; the chart is pushed to the
                  bottom of the tile, so the charts in a row still line up. */}
              <h3 className="forum-name">
                {name}
                {chosen && <span className="label ml-2 whitespace-nowrap">selected</span>}
              </h3>
              <p className="mt-0.5 flex flex-wrap items-baseline gap-x-2.5">
                <span className="forum-num text-accent">{money(c.amount)}</span>
                <Delta cur={c.amount} prev={c.prev_amount} pct={c.pct} env={d} short />
              </p>
              <SeriesChart
                className="mt-auto pt-2"
                values={c.series}
                labels={labels}
                split={Math.floor(n / 2)}
                format="money"
                height={56}
                title={`${name}, award dollars`}
              />
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
