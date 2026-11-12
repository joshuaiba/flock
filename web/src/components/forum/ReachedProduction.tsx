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
          <ul className="forum-rows border-t border-frame">
            {d.items.map((t) => (
              <li key={t.org.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 py-2.5">
                <div className="forum-name min-w-0">
                  <OrgLink org={t.org} size={22} className="max-w-full" />
                </div>
                <span className="forum-num self-center text-right text-pompeii">{money(t.amount)}</span>
                <div className="ui flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 text-muted">
                  <StageTrack path={t.path} />
                  <span>
                    {day(t.day)} · {cameFrom(t)}
                  </span>
                </div>
                <span className="ui text-right text-muted">{plural(t.awards, "production award")}</span>
              </li>
            ))}
          </ul>
          {d.total > d.items.length && (
            <p className="ui mt-3 text-muted">
              Showing the latest {d.items.length} of {d.total.toLocaleString("en-US")}.
            </p>
          )}
        </>
      )}
    </Panel>
  );
}
