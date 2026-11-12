import { NoRows, OrgLink, Panel } from "@/components/Signals";
import { serverGet } from "@/lib/api";
import { day, money } from "@/lib/format";
import { signalPath, type AwardRow, type Page } from "@/lib/signals";
import { tagPhrase } from "@/lib/tags";
import { Down, lastLabel, Scroll, type PanelProps } from "./shared";

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
        <Scroll label="Largest awards">
          {/* On a phone the agency and the date move under the recipient, and
              the description is left to the source record. */}
          <table className="ledger">
            <thead>
              <tr>
                <th scope="col">Recipient</th>
                <th scope="col" className="hidden md:table-cell">
                  Awarded by
                </th>
                <th scope="col" className="hidden md:table-cell">
                  Date
                </th>
                <th scope="col" className="hidden lg:table-cell">
                  For
                </th>
                <th scope="col" className="num">
                  Amount
                </th>
                <th scope="col" className="hidden sm:table-cell">
                  <span className="sr-only">Source record</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {d.items.map((a) => {
                const source = a.url && (
                  <a href={a.url} target="_blank" rel="noreferrer" className="ui-link whitespace-nowrap">
                    Source<span className="sr-only">: award record for {a.recipient?.name ?? "this award"}</span>
                  </a>
                );
                return (
                  <tr key={a.id}>
                    <td className="forum-name max-w-0 md:w-[26%]">
                      {a.recipient ? (
                        <OrgLink org={a.recipient} size={22} className="max-w-full align-middle" />
                      ) : (
                        <span className="text-muted">Unnamed recipient</span>
                      )}
                      <span className="ui mt-0.5 flex flex-wrap items-center gap-x-2 text-muted md:hidden">
                        {a.agency && <span className="min-w-0 truncate">{a.agency.name}</span>}
                        <span className="whitespace-nowrap">{day(a.day)}</span>
                        <span className="sm:hidden">{source}</span>
                      </span>
                    </td>
                    <td className="forum-name forum-name-sm hidden max-w-0 md:table-cell md:w-[24%]">
                      {a.agency ? (
                        <OrgLink org={a.agency} size={18} graph={false} className="max-w-full align-middle" />
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="ui hidden whitespace-nowrap text-muted md:table-cell">{day(a.day)}</td>
                    <td className="ui hidden max-w-0 text-muted lg:table-cell lg:w-[34%]">
                      <span className="block truncate" title={a.description ?? undefined}>
                        {a.description ?? "—"}
                      </span>
                    </td>
                    <td className="num text-accent">{money(a.amount)}</td>
                    <td className="hidden text-right sm:table-cell">{source}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Scroll>
      )}
    </Panel>
  );
}
