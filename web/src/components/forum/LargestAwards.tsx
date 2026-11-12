import { NoRows, OrgLink, Panel } from "@/components/Signals";
import { serverGet } from "@/lib/api";
import { day, money, truncate } from "@/lib/format";
import { signalPath, type AwardRow, type Page } from "@/lib/signals";
import { tagPhrase } from "@/lib/tags";
import { Down, lastLabel, type PanelProps } from "./shared";

/** The ten biggest single awards in the window: who got it, who paid, when,
 *  how much and what for, with a link to the source record when there is one. */
export async function LargestAwards({ days, tag, className = "" }: PanelProps) {
  const d = await serverGet<Page<AwardRow>>(signalPath("largest-awards", { window: days, tag, limit: 10 }));
  if (!d)
    return (
      <Panel title="Largest awards" className={className}>
        <Down />
      </Panel>
    );
  return (
    <Panel
      title="Largest awards"
      className={className}
      note={
        <>
          Single awards in {lastLabel(days)}
          {tag && <>, in {tagPhrase(tag)}</>}, largest obligated amount first.
        </>
      }
    >
      {d.items.length === 0 ? (
        <NoRows>
          No {tag && <>{tagPhrase(tag)} </>}awards on record in {lastLabel(days)}.
        </NoRows>
      ) : (
        <ol>
          {d.items.map((a) => (
            <li key={a.id} className="border-b border-hair py-3 first:pt-0 last:border-b-0">
              <div className="flex items-center justify-between gap-4">
                {a.recipient ? (
                  <OrgLink org={a.recipient} size={26} />
                ) : (
                  <span className="text-muted">Unnamed recipient</span>
                )}
                <span className="fig shrink-0 text-pompeii">{money(a.amount)}</span>
              </div>
              <div className="fig mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.92rem] text-muted">
                {a.agency && (
                  <>
                    <span>from</span>
                    <OrgLink org={a.agency} size={18} className="gap-1.5!" />
                    <span aria-hidden="true">·</span>
                  </>
                )}
                <span className="whitespace-nowrap">{day(a.day)}</span>
              </div>
              {(a.description || a.url) && (
                <p className="mt-1 text-[0.98rem] leading-snug">
                  {truncate(a.description, 120)}
                  {a.url && (
                    <>
                      {a.description && " "}
                      <a href={a.url} target="_blank" rel="noreferrer" className="fig whitespace-nowrap text-[0.92rem]">
                        source<span className="sr-only">: award record for {a.recipient?.name ?? "this award"}</span>
                      </a>
                    </>
                  )}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
