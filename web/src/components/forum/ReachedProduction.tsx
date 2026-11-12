import { NoRows, OrgLink, Panel, StageTrack } from "@/components/Signals";
import { serverGet } from "@/lib/api";
import { day, money, plural } from "@/lib/format";
import { signalPath, STAGE_LABEL, type Page, type TransitionRow } from "@/lib/signals";
import { tagPhrase } from "@/lib/tags";
import { Down, lastLabel, type PanelProps } from "./shared";

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
  return (
    <Panel
      title="Reached production"
      className={className}
      note={
        <>
          Companies with a first production award in {lastLabel(days)}
          {/* The filter is on the company (any award in the category), not on
              the production award itself. */}
          {tag && <>, among companies with {tagPhrase(tag)} awards</>}. Stages are read from award descriptions; the
          sources publish no stage field. The amount is every production dollar on record for the company.
        </>
      }
    >
      {d.items.length === 0 ? (
        <NoRows>
          No company{tag && <> with {tagPhrase(tag)} awards</>} reached production in {lastLabel(days)}.
        </NoRows>
      ) : (
        <>
          <ul>
            {d.items.map((t) => (
              <li key={t.org.id} className="border-b border-hair py-3 first:pt-0 last:border-b-0">
                <div className="flex items-center justify-between gap-4">
                  <OrgLink org={t.org} size={26} />
                  <span className="fig shrink-0 text-pompeii">{money(t.amount)}</span>
                </div>
                <div className="fig mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.92rem] text-muted">
                  <StageTrack path={t.path} />
                  <span className="whitespace-nowrap">{day(t.day)}</span>
                  <span aria-hidden="true">·</span>
                  <span>{cameFrom(t)}</span>
                  <span aria-hidden="true">·</span>
                  <span>{plural(t.awards, "production award")} on record</span>
                </div>
              </li>
            ))}
          </ul>
          {d.total > d.items.length && (
            <p className="fig mt-3 text-[0.92rem] text-muted">
              Showing the latest {d.items.length} of {d.total.toLocaleString("en-US")}.
            </p>
          )}
        </>
      )}
    </Panel>
  );
}
