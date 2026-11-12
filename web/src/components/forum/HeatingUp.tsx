import { SeriesChart } from "@/components/SeriesChart";
import { Panel } from "@/components/Signals";
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
  return (
    <li
      aria-current={chosen ? "true" : undefined}
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-5 gap-y-2 border-b border-hair py-3 last:border-b-0 sm:grid-cols-[10.5rem_minmax(0,1fr)_8.75rem]"
    >
      <div className="row-start-1 min-w-0 leading-tight">
        <p>
          {name}
          {chosen && <span className="label ml-2 whitespace-nowrap">selected</span>}
        </p>
        <p className="fig mt-0.5 text-[0.86rem] text-muted">{r.open > 0 ? `${r.open} open now` : "none open now"}</p>
      </div>
      {/* On a phone the sparkline takes its own line under the name and figures. */}
      <SeriesChart
        className="col-span-2 row-start-2 sm:col-span-1 sm:col-start-2 sm:row-start-1"
        values={r.series}
        labels={labels}
        split={Math.floor(r.series.length / 2)}
        unit="posted"
        color="var(--cypress)"
        height={40}
        title={`${name}, solicitations posted`}
      />
      <div className="fig row-start-1 text-right leading-tight sm:col-start-3">
        {/* Two unbreakable halves: with large counts the prior figure drops to
            its own line instead of running into the sparkline. */}
        <p>
          <span className="whitespace-nowrap">{r.posted.toLocaleString("en-US")} posted</span>
          {comparable && (
            <>
              {" "}
              <span className="whitespace-nowrap text-muted">· {r.prev_posted.toLocaleString("en-US")} prior</span>
            </>
          )}
        </p>
        {comparable && (
          <p className="mt-0.5 whitespace-nowrap text-[0.86rem]">
            {r.delta === 0 ? (
              <span className="text-muted">– level</span>
            ) : (
              <>
                <span aria-hidden="true">{r.delta > 0 ? "▲" : "▼"}</span>
                <span className="sr-only">{r.delta > 0 ? "up" : "down"}</span>{" "}
                {r.pct != null ? pct(r.pct) : `${Math.abs(r.delta)} ${r.delta > 0 ? "more" : "fewer"}`}
              </>
            )}
          </p>
        )}
      </div>
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
      <Panel title="Heating up" vine className={className}>
        <Down />
      </Panel>
    );

  if (d.items.length === 0)
    return (
      <Panel
        title="Heating up"
        vine
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
  const rising = comparable ? d.items.filter((r) => r.rising) : [];
  const rest = comparable ? d.items.filter((r) => !r.rising) : d.items;
  const row = (r: TopicRow) => (
    <Topic key={r.category} r={r} labels={labels} comparable={comparable} chosen={r.category === tag} />
  );
  return (
    <Panel
      title="Heating up"
      vine
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
      {rising.length > 0 && (
        <>
          <h3 className="label">Rising</h3>
          <ul className="mb-5">{rising.map(row)}</ul>
        </>
      )}
      {rest.length > 0 && (
        <>
          {comparable && <h3 className="label">Level or falling</h3>}
          <ul>{rest.map(row)}</ul>
        </>
      )}
    </Panel>
  );
}
