import { NoRows, Panel } from "@/components/Signals";
import { serverGet } from "@/lib/api";
import { money, plural } from "@/lib/format";
import {
  FAMILIES,
  FAMILY_LABEL,
  familyOf,
  mixText,
  signalPath,
  type AgencyRow,
  type Page,
} from "@/lib/signals";
import { tagLabel, tagPhrase } from "@/lib/tags";
import { AgencyBars, type AgencyBar } from "./AgencyBars";
import { Down, lastLabel, type PanelProps } from "./shared";

const LIMIT = 8;

/** One agency's row for the chart: its bar length, and its dollars grouped
 *  into the five category families (always in the same order, so a color
 *  means the same family in every bar). With a category chosen, the bar is
 *  that category alone. */
function toBar(a: AgencyRow, max: number, tag: string | null): AgencyBar {
  const mix = (tag ? a.mix.filter((m) => m.category === tag) : a.mix).filter((m) => m.amount > 0);
  // An award with two categories counts in both, so shares are taken of the
  // categorized dollars, which can be more than the agency's total.
  const categorized = mix.reduce((s, m) => s + m.amount, 0);
  const segments = FAMILIES.map((family) => {
    const parts = mix.filter((m) => familyOf(m.category) === family);
    const amount = parts.reduce((s, m) => s + m.amount, 0);
    return {
      family,
      amount,
      share: categorized > 0 ? amount / categorized : 0,
      categories: parts.map((m) => tagLabel(m.category)).join(", "),
    };
  }).filter((s) => s.amount > 0);
  return {
    org: a.org,
    amount: a.amount,
    frac: max > 0 ? a.amount / max : 0,
    posted: a.posted,
    words: mixText(mix, categorized, 10),
    segments,
  };
}

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

/** Which agencies and offices are buying, and what. */
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
          rolled up into their parent){tag ? <>, {tagPhrase(tag)} only</> : <>, split by category family</>}. An award
          with two categories counts in both.
          {d.total > d.items.length && <> The top {d.items.length} of {d.total.toLocaleString("en-US")}.</>}
        </>
      }
    >
      <ul className="ui mb-3 flex flex-wrap gap-x-4 gap-y-1 text-muted" aria-label="Category families">
        {FAMILIES.map((f) => (
          <li key={f} className="inline-flex items-center gap-1.5">
            <span
              className="block h-2.5 w-2.5 rounded-[2px]"
              style={{ background: `var(--chart-${f})`, boxShadow: "inset 0 0 0 1px var(--frame)" }}
              aria-hidden="true"
            />
            {FAMILY_LABEL[f]}
          </li>
        ))}
      </ul>
      <AgencyBars bars={d.items.map((a) => toBar(a, max, tag))} />
    </Panel>
  );
}
