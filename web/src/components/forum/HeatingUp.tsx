import { SeriesChart } from "@/components/SeriesChart";
import { Panel, signedPct } from "@/components/Signals";
import { serverGet } from "@/lib/api";
import { plural } from "@/lib/format";
import { bucketLabels, pct, priorLabel, signalPath, type TopicPage, type TopicRow } from "@/lib/signals";
import { tagLabel, tagPhrase } from "@/lib/tags";
import { getDefinitions } from "./data";
import { Down, lastLabel, PanelEmpty, type PanelProps } from "./shared";

// Topic heat: solicitations posted per category, this period against the last.
// Solicitations come before money, so this is the Forum's leading indicator.

/** One topic's change in a sentence. A percentage is used only when the API
 *  gives one (the prior period had enough postings to make it meaningful);
 *  otherwise the two counts are stated. */
function sentence(r: TopicRow, days: number): string {
  const name = tagLabel(r.category);
  const prior = priorLabel(days);
  if (r.delta === 0) return `${name} solicitations held level with ${prior}, at ${r.posted}.`;
  const verb = r.delta > 0 ? "rose" : "fell";
  // Also when the rise is tenfold or more: pct() would write a multiple
  // ("12×"), and "rose 12×" can be read two ways. The counts cannot.
  if (r.pct == null || r.pct >= 10)
    return `${name} solicitations ${verb} from ${r.prev_posted} in ${prior} to ${r.posted}.`;
  if (Math.round(r.pct * 100) === 100) return `${name} solicitations doubled against ${prior}.`;
  return `${name} solicitations ${verb} ${pct(r.pct)} against ${prior}.`;
}

/** The panel's one-line reading. With a category chosen it is about that
 *  category; otherwise about the topic that gained the most postings. */
function reading(d: TopicPage, days: number, tag: string | null): string {
  if (!d.coverage.prior_complete)
    return `The record does not reach back to the start of ${priorLabel(days)}, so no topic can be called rising yet.`;
  if (tag) {
    const chosen = d.items.find((r) => r.category === tag);
    // A topic with no postings in either period is not in the list at all.
    return chosen
      ? sentence(chosen, days)
      : `No ${tagPhrase(tag)} solicitations were posted in ${lastLabel(days)} or in ${priorLabel(days)}.`;
  }
  const rising = d.items.filter((r) => r.rising);
  if (rising.length === 0) return "No topic is rising this period.";
  return `${sentence(rising[0], days)} ${rising.length} of ${plural(d.items.length, "topic")} ${rising.length === 1 ? "is" : "are"} rising.`;
}

/** One topic as a tile: its name, the postings over time, then the count
 *  against the prior period in words ("14 posted, up from 6") and what is
 *  open now. */
function Topic({
  r,
  labels,
  comparable,
  chosen,
}: {
  r: TopicRow;
  labels: string[];
  /** false when there is no full prior period: no change is shown */
  comparable: boolean;
  chosen: boolean;
}) {
  const name = tagLabel(r.category);
  const against = !comparable
    ? "posted"
    : r.delta === 0
      ? `posted, level with ${r.prev_posted.toLocaleString("en-US")}`
      : `posted, ${r.delta > 0 ? "up" : "down"} from ${r.prev_posted.toLocaleString("en-US")}`;
  return (
    <li aria-current={chosen ? "true" : undefined} className="forum-tile">
      <h3 className="forum-tile-name">
        {name}
        {chosen && <span className="label ml-2 whitespace-nowrap">selected</span>}
      </h3>
      {/* A long name may take two lines; the chart is pushed down, so the
          charts in a row still line up. */}
      <SeriesChart
        className="mt-auto pt-3"
        values={r.series}
        labels={labels}
        split={Math.floor(r.series.length / 2)}
        unit="posted"
        height={36}
        title={`${name}, solicitations posted`}
      />
      <p className="mt-3 text-muted">
        <span className="forum-tile-figure mr-1.5 text-ink">{r.posted.toLocaleString("en-US")}</span>
        {against}
        {comparable && r.pct != null && r.delta !== 0 && <span className="sr-only"> ({signedPct(r.pct)})</span>}
      </p>
      <p className="text-muted">{r.open > 0 ? `${r.open} open now` : "none open now"}</p>
    </li>
  );
}

export async function HeatingUp({ days, tag, className = "" }: PanelProps) {
  // Topics are categories, so this endpoint takes no category filter: every
  // topic is listed and the chosen one is marked.
  const [d, defs] = await Promise.all([
    serverGet<TopicPage>(signalPath("topics", { window: days })),
    getDefinitions(),
  ]);
  if (!d)
    return (
      <Panel title="Heating up" className={className}>
        <Down />
      </Panel>
    );

  if (d.items.length === 0)
    return (
      <Panel
        title="Heating up"
        className={className}
        note="Solicitations posted per category. Demand shows here before it shows as awards."
      >
        <PanelEmpty>
          {defs != null && defs.opportunities === 0
            ? "No solicitation source is loaded yet, so there are no topics to rank. This panel fills in once one is."
            : `No solicitations were posted in ${lastLabel(days)} or in ${priorLabel(days)}.`}
        </PanelEmpty>
      </Panel>
    );

  const n = d.items[0].series.length;
  const labels = bucketLabels(d.series_start, d.bucket_days, n);
  const comparable = d.coverage.prior_complete;
  return (
    <Panel
      title="Heating up"
      className={className}
      takeaway={reading(d, days, tag)}
      note={
        <>
          Solicitations posted per category, {lastLabel(days)} against {priorLabel(days)}. Demand shows here before it
          shows as awards. Each line runs across both periods, the earlier one fainter, on its own scale.
          {tag && " All topics with postings are listed; the category filter marks its own."}
        </>
      }
    >
      {/* One tile per topic, in the API's order. */}
      <ul className="forum-tiles">
        {d.items.map((r) => (
          <Topic key={r.category} r={r} labels={labels} comparable={comparable} chosen={r.category === tag} />
        ))}
      </ul>
    </Panel>
  );
}
