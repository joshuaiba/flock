import { NoRows, OrgLink, Panel } from "@/components/Signals";
import { serverGet } from "@/lib/api";
import { money, plural } from "@/lib/format";
import { mixText, signalPath, type AgencyRow, type Page } from "@/lib/signals";
import { tagPhrase } from "@/lib/tags";
import { Down, lastLabel, type PanelProps } from "./shared";

const LIMIT = 8;

/** The panel's one-line reading: the biggest buyer and what it mostly buys. */
function reading(items: AgencyRow[], total: number, days: number, tag: string | null): string {
  const top = items[0]; // the API sorts by award dollars
  if (top.amount <= 0) {
    // Every agency in the list awarded or posted, and none awarded: `total` is
    // the number that posted (the list on screen may be cut short).
    const what = tag ? `${tagPhrase(tag)} award` : "award";
    return `No agency made ${/^[aeiou]/i.test(what) ? "an" : "a"} ${what} in ${lastLabel(days)}; ${plural(total, "agency", "agencies")} posted solicitations.`;
  }
  if (tag) return `${top.org.name} bought the most ${tagPhrase(tag)}: ${money(top.amount)} in ${lastLabel(days)}.`;
  const lead = top.mix.find((m) => m.amount > 0);
  const categorized = top.mix.reduce((s, m) => s + m.amount, 0);
  if (!lead) return `${top.org.name} bought the most: ${money(top.amount)} in ${lastLabel(days)}.`;
  const how = lead.amount / categorized >= 0.5 ? "mostly" : "led by";
  return `${top.org.name} bought the most: ${money(top.amount)} in ${lastLabel(days)}, ${how} ${tagPhrase(lead.category)}.`;
}

/** Which agencies and offices are buying, and what: a name, its dollars, a
 *  thin bar for the dollars against the largest buyer, and its categories in
 *  words. The bar is the accent because it measures dollars awarded; the mix
 *  is told in words, not in colors. */
export async function Agencies({ days, tag, className = "" }: PanelProps) {
  const d = await serverGet<Page<AgencyRow>>(signalPath("agencies", { window: days, tag, limit: LIMIT }));
  if (!d)
    return (
      <Panel title="Agencies" className={className}>
        <Down />
      </Panel>
    );
  if (d.items.length === 0)
    return (
      <Panel title="Agencies" className={className}>
        <NoRows>
          No agency awarded or posted anything{tag && <> in {tagPhrase(tag)}</>} in {lastLabel(days)}.
        </NoRows>
      </Panel>
    );

  const max = Math.max(...d.items.map((a) => a.amount));
  return (
    <Panel
      title="Agencies"
      className={className}
      takeaway={reading(d.items, d.total, days, tag)}
      note={
        <>
          Award dollars in {lastLabel(days)} by awarding agency or office, as the source recorded it (offices are not
          rolled up into their parent){tag && <>, {tagPhrase(tag)} only</>}. The shares are of each agency&rsquo;s
          categorized dollars; an award with two categories counts in both.
          {d.total > d.items.length && <> The top {d.items.length} of {d.total.toLocaleString("en-US")}.</>}
        </>
      }
    >
      <ul className="forum-rows border-t border-line2">
        {d.items.map((a) => {
          const mix = (tag ? a.mix.filter((m) => m.category === tag) : a.mix).filter((m) => m.amount > 0);
          // An award with two categories counts in both, so shares are taken of
          // the categorized dollars, which can be more than the agency's total.
          const words = mixText(
            mix,
            mix.reduce((s, m) => s + m.amount, 0),
          );
          return (
            <li key={a.org.id} className="py-3">
              <div className="flex items-baseline justify-between gap-x-4">
                <OrgLink org={a.org} className="min-w-0" />
                {a.amount > 0 ? (
                  <span className="forum-num money shrink-0">{money(a.amount)}</span>
                ) : (
                  <span className="shrink-0 text-muted">no awards in this window</span>
                )}
              </div>
              {a.amount > 0 && (
                // The same dollars as a length, against the largest buyer.
                <div
                  className="mt-1.5 h-[3px] min-w-[3px] rounded-full bg-accent"
                  style={{ width: `${max > 0 ? ((a.amount / max) * 100).toFixed(2) : 0}%` }}
                  aria-hidden="true"
                />
              )}
              {(words || a.posted > 0) && (
                <p className="mt-1.5 flex flex-wrap justify-between gap-x-4 text-muted">
                  <span>{words}</span>
                  {a.posted > 0 && <span>{plural(a.posted, "solicitation")} posted</span>}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
