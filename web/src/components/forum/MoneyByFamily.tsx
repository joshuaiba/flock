import Link from "next/link";
import { NoRows } from "@/components/Signals";
import { money, plural } from "@/lib/format";
import type { MoneyFamily } from "@/lib/signals";
import { tagLabel } from "@/lib/tags";
import { getOverview } from "./data";
import { MoneyBar, type MoneySegment } from "./MoneyBar";
import { OliveSprig } from "./Olive";
import { carry, Down, lastLabel, type PanelProps } from "./shared";

// "Where the money went": the window's award dollars as parts of a whole, in
// a tall segmented bar with the exact figures in a table under it. This is the
// one chart on the site with category colors (--chart-* in globals.css). The
// bar keeps the families' fixed order, because the colors were checked as
// neighbors in that order; the table is sorted by dollars.

// The tags inside one family share the family's color, each a step further
// toward the text color: lighter on the dark page, darker on paper, which is
// the direction that keeps the share printed on a segment legible.
const TAG_STEPS = [100, 82, 66, 52, 40];
const tint = (family: string, i: number) => {
  const step = TAG_STEPS[i] ?? TAG_STEPS[TAG_STEPS.length - 1];
  return step === 100 ? `var(--chart-${family})` : `color-mix(in srgb, var(--chart-${family}) ${step}%, var(--text))`;
};

const percent = (share: number) => `${(share * 100).toFixed(1)}%`;

/** "Where the money went": title, the olive sprig, and the window's total. */
function Heading({ days, total, of }: { days: number; total: number | null; of?: string }) {
  return (
    <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
      <h2 className="panel-title flex items-center gap-3">
        Where the money went
        <OliveSprig className="h-[26px] w-auto opacity-50" />
      </h2>
      {total != null && (
        <p className="text-muted">
          {lastLabel(days).replace(/^the /, "")}
          {of && <> · {of}</>} · <span className="money font-display text-[1.4375rem] leading-none">{money(total)}</span>
        </p>
      )}
    </header>
  );
}

/** The family's tag with the most dollars: where a click on a family goes. */
function leadTag(f: MoneyFamily): string | null {
  return [...f.tags].sort((a, b) => b.amount - a.amount)[0]?.tag ?? null;
}

export async function WhereTheMoneyWent({ days, tag, className = "" }: PanelProps) {
  const o = await getOverview(days, tag);
  const frame = `flex scroll-mt-20 flex-col ${className}`;
  if (!o)
    return (
      <section id="money" className={frame}>
        <Heading days={days} total={null} />
        <div className="mt-4">
          <Down />
        </div>
      </section>
    );
  // An API from before this chart: there is nothing to draw, so no section.
  const m = o.money_by_family;
  if (!m) return null;

  // With a category chosen, the bar is that category's family, split by the
  // tags inside it. A family with a single tag has nothing to split.
  const family = tag ? m.items.find((f) => f.tags.some((t) => t.tag === tag)) : undefined;
  if (tag && (!family || family.tags.length < 2)) return null;

  const total = family ? family.amount : m.total;
  if (total <= 0)
    return (
      <section id="money" className={frame}>
        <Heading days={days} total={null} />
        <div className="mt-4">
          <NoRows>
            No {family && <>{family.label.toLowerCase()} </>}awards on record in {lastLabel(days)}.
          </NoRows>
        </div>
      </section>
    );

  // The rows: families (uncategorized last, and only when it has dollars), or
  // the tags of one family.
  type Row = MoneySegment & { covers: string; amount: number; count: number };
  const rows: Row[] = family
    ? family.tags
        .filter((t) => t.amount > 0)
        .map((t, i) => ({
          key: t.tag,
          name: tagLabel(t.tag),
          covers: "",
          amount: t.amount,
          count: t.awards,
          dollars: money(t.amount),
          share: t.share,
          percent: percent(t.share),
          awards: plural(t.awards, "award"),
          color: tint(family.family, i),
          href: t.tag === tag ? null : carry("/forum", days, t.tag),
          action: `Show ${tagLabel(t.tag)} only`,
          current: t.tag === tag,
        }))
    : m.items
        .filter((f) => f.amount > 0)
        .map((f) => {
          const lead = leadTag(f);
          return {
            key: f.family,
            name: f.label,
            covers: f.covers,
            amount: f.amount,
            count: f.awards,
            dollars: money(f.amount),
            share: f.share,
            percent: percent(f.share),
            awards: plural(f.awards, "award"),
            color: `var(--chart-${f.family})`,
            href: lead ? carry("/forum", days, lead) : null,
            // A family is not a filter of its own: the click chooses its
            // largest category, and the bar then shows the family by category.
            action: lead ? (f.tags.length > 1 ? `Show ${f.label} by category` : `Show ${f.label} only`) : undefined,
          };
        });
  const byDollars = [...rows].sort((a, b) => b.amount - a.amount);

  return (
    <section id="money" className={frame}>
      <Heading days={days} total={total} of={family?.label} />
      <p className="lede mt-1.5">
        {family ? (
          <>
            {family.label} award dollars by category, across every award in {lastLabel(days)}. An award tagged with more
            than one of these categories is split evenly between them, so the parts add up to the total.
          </>
        ) : (
          <>
            Award dollars by category. An award tagged with more than one category is split evenly between them, so the
            parts add up to the total.
          </>
        )}
      </p>

      <MoneyBar segments={rows} label={family ? `${family.label} award dollars by category` : "Award dollars by category family"} />

      <div className="relative overflow-x-auto" tabIndex={0} role="region" aria-label="Where the money went: table">
        <table className="ledger">
          <thead>
            <tr>
              <th scope="col">Category</th>
              {!family && (
                <th scope="col" className="hidden md:table-cell">
                  What it covers
                </th>
              )}
              <th scope="col" className="num hidden sm:table-cell">
                Awards
              </th>
              <th scope="col" className="num">
                Share
              </th>
              <th scope="col" className="num">
                Awarded
              </th>
            </tr>
          </thead>
          <tbody>
            {byDollars.map((r) => (
              <tr key={r.key} aria-current={r.current ? "true" : undefined}>
                <td className="font-medium sm:whitespace-nowrap">
                  <span
                    className="mr-2.5 inline-block h-2.5 w-2.5 rounded-[2px]"
                    style={{ background: r.color }}
                    aria-hidden="true"
                  />
                  {r.href ? (
                    <Link href={r.href} scroll={false} className="no-underline hover:underline" title={r.action}>
                      {r.name}
                    </Link>
                  ) : (
                    r.name
                  )}
                  {r.current && <span className="label ml-2">selected</span>}
                </td>
                {!family && <td className="hidden w-[46%] text-[0.8125rem] text-muted md:table-cell">{r.covers}</td>}
                <td className="num hidden sm:table-cell">{r.count.toLocaleString("en-US")}</td>
                <td className="num">{r.percent}</td>
                <td className="num money">{r.dollars}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** The section while the overview loads. */
export function MoneySkeleton({ className = "" }: { className?: string }) {
  return (
    <section className={className} aria-busy="true">
      <h2 className="panel-title">Where the money went</h2>
      <span className="sr-only">Loading</span>
      <span className="skeleton mt-3 h-3.5 w-full max-w-md" aria-hidden="true" />
      <span className="skeleton mt-5 h-[46px] w-full" aria-hidden="true" />
    </section>
  );
}
