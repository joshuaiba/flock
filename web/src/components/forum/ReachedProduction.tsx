import { NoRows, OrgLink, Panel, StageTrack } from "@/components/Signals";
import { serverGet } from "@/lib/api";
import { day, money, plural } from "@/lib/format";
import { period, signalPath, STAGE_LABEL, type Page, type TransitionRow } from "@/lib/signals";
import { tagPhrase } from "@/lib/tags";
import { Down, type PanelProps } from "./shared";

const LIMIT = 8;

/** How the company got here: the stage it was last seen at before production
 *  and the days between, or that production is the first stage on record. */
function cameFrom(t: TransitionRow): string {
  if (!t.from_stage) return "first seen at production";
  // mid-sentence: "solicitation" is a common noun, "Phase II" a name
  const from = t.from_stage === "solicitation" ? "solicitation" : STAGE_LABEL[t.from_stage];
  return t.days_between == null ? `after ${from}` : `${plural(t.days_between, "day")} from ${from}`;
}

/** Companies whose first production award on record falls in the window. */
export async function ReachedProduction({ days, tag, className = "" }: PanelProps) {
  const d = await serverGet<Page<TransitionRow>>(
    signalPath("transitions", { stage: "production", entries: true, window: days, tag, limit: LIMIT }),
  );
  if (!d)
    return (
      <Panel title="Reached production" className={className}>
        <Down />
      </Panel>
    );
  const some = d.items.length > 0;
  return (
    <Panel
      title="Reached production"
      className={className}
      takeaway={
        some ? (
          <>
            {plural(d.total, "company", "companies")}
            {tag && <> with {tagPhrase(tag)} awards</>} crossed into production in {period(d)}.
          </>
        ) : undefined
      }
      note={
        <>
          Companies with a first production award in {period(d)}
          {/* The filter is on the company (any award in the category), not on
              the production award itself. */}
          {tag && <>, among companies with {tagPhrase(tag)} awards</>}. Stages are read from award descriptions; the
          sources publish no stage field. The amount is every production dollar on record for the company.
        </>
      }
    >
      {!some ? (
        <NoRows>
          No company{tag && <> with {tagPhrase(tag)} awards</>} reached production in {period(d)}.
        </NoRows>
      ) : (
        <>
          {/* The ends of the tracks, named once above them. The head is as
              wide as a track (four 9px dots and three links, see StageTrack),
              so each name sits over its own end; four names would not fit over
              four dots, and the two between are Phase I and Phase II, as each
              dot says when pointed at. */}
          <div className="forum-cols flex justify-end" aria-hidden="true">
            <span className="flex w-[132px] justify-between sm:w-[144px]">
              <span>Solicitation</span>
              <span>Production</span>
            </span>
          </div>
          <ul className="forum-rows">
            {d.items.map((t) => (
              // On a phone the name has the whole first line, so the figures
              // beside the other lines cannot squeeze it to an ellipsis.
              <li key={t.org.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 py-3">
                <div className="min-w-0 max-sm:col-span-2">
                  <OrgLink org={t.org} className="max-w-full" />
                </div>
                <StageTrack path={t.path} wide className="justify-self-end max-sm:order-2" />
                <p className="min-w-0 text-muted max-sm:order-1">
                  {day(t.day)} · {cameFrom(t)}
                </p>
                <p className="text-right text-muted max-sm:order-3 max-sm:col-span-2 max-sm:text-left">
                  <span className="money">{money(t.amount)}</span> in {plural(t.awards, "production award")}
                </p>
              </li>
            ))}
          </ul>
          {d.total > d.items.length && (
            <p className="mt-3 text-muted">
              Showing the latest {d.items.length} of {d.total.toLocaleString("en-US")}.
            </p>
          )}
        </>
      )}
    </Panel>
  );
}
