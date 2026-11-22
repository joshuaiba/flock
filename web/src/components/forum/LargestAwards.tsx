import Link from "next/link";
import { NoRows, OrgLink, Panel } from "@/components/Signals";
import { serverGet } from "@/lib/api";
import { day, money } from "@/lib/format";
import { signalPath, type AwardRow, type Page } from "@/lib/signals";
import { tagLabel, tagPhrase } from "@/lib/tags";
import { Down, lastLabel, Scroll, type PanelProps } from "./shared";

const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

/** The panel's one-line reading: how many awards are listed, and the category
 *  that took the most of them. */
function reading(items: AwardRow[], days: number, tag: string | null): string {
  const n = items.length;
  const head = `The ${n === 1 ? "largest single award" : `${WORDS[n]?.toLowerCase() ?? n} largest single awards`} in ${lastLabel(days)}${tag ? `, in ${tagPhrase(tag)}` : ""}.`;
  if (tag || n < 2) return head;
  const counts = new Map<string, number>();
  for (const a of items) for (const t of a.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  const [top, k] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  if (!top || k < 2) return head;
  return `${head} ${WORDS[k] ?? k} went to ${tagPhrase(top)}.`;
}

/** The ten biggest single awards in the window: when, who got it, who paid,
 *  in which category and how much, with a link to the source record when
 *  there is one. */
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
      takeaway={d.items.length > 0 ? reading(d.items, days, tag) : undefined}
      note={<>Largest obligated amount first. Point at a recipient for what the award was for.</>}
    >
      {d.items.length === 0 ? (
        <NoRows>
          No {tag && <>{tagPhrase(tag)} </>}awards on record in {lastLabel(days)}.
        </NoRows>
      ) : (
        <Scroll label="Largest awards">
          {/* On a phone the office and the date move under the recipient. */}
          <table className="ledger">
            <thead>
              <tr>
                <th scope="col" className="hidden md:table-cell">
                  Date
                </th>
                <th scope="col">Recipient</th>
                <th scope="col" className="hidden md:table-cell">
                  Awarding office
                </th>
                <th scope="col" className="hidden lg:table-cell">
                  Category
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
                    <td className="hidden w-px whitespace-nowrap pr-8! text-muted md:table-cell">{day(a.day, true)}</td>
                    <td className="max-w-0 md:w-[30%]" title={a.description ?? undefined}>
                      {a.recipient ? (
                        <OrgLink org={a.recipient} className="max-w-full align-middle" />
                      ) : (
                        <span className="name text-muted">Unnamed recipient</span>
                      )}
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[0.8125rem] text-muted md:hidden">
                        {a.agency && <span className="min-w-0 truncate">{a.agency.name}</span>}
                        <span className="whitespace-nowrap">{day(a.day)}</span>
                        <span className="sm:hidden">{source}</span>
                      </span>
                    </td>
                    <td className="hidden max-w-0 md:table-cell md:w-[32%]">
                      {a.agency ? (
                        <Link href={`/entity/${a.agency.id}`} className="block truncate font-medium no-underline hover:underline">
                          {a.agency.name}
                        </Link>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="hidden whitespace-nowrap text-muted lg:table-cell">
                      {a.tags.length > 0 ? tagLabel(a.tags[0]) : "—"}
                    </td>
                    <td className="num money">{money(a.amount)}</td>
                    <td className="hidden w-px text-right sm:table-cell">{source}</td>
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
