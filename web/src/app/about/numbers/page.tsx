import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Cartouche, CornerVine, Fresco, GreekKey } from "@/components/Art";
import { Empty } from "@/components/Empty";
import { Footer } from "@/components/Footer";
import { serverGet } from "@/lib/api";
import { day, dollars } from "@/lib/format";
import { signalPath, type Definitions } from "@/lib/signals";

export const metadata: Metadata = { title: "About the numbers" };

// Sizes of the art on the card, in px (the same as the field report's letter).
const PLAQUE_WIDTH = 520; // the title cartouche; it shrinks to fit narrow screens
const VINE = 150; // corner vines from the `sm` breakpoint up
const VINE_SMALL = 96; // corner vines on phones

const count = (n: number) => n.toLocaleString("en-US");

/** What the figures leave out, in plain words. Each line restates a limit that
 *  the definitions (or the data itself) already carry; none adds a claim. */
function limits(d: Definitions): { lead: string; rest: string }[] {
  return [
    {
      lead: "Stages are read from words, not from a field.",
      rest: "The sources publish no stage, so Phase I, Phase II and production are found in the wording of award descriptions. An award that does not name its stage is missed, and progress is followed per company, not per contract.",
    },
    {
      lead: "Solicitation figures are empty until a solicitation source is loaded.",
      rest:
        "That covers topic heat, open solicitations, the solicitation stage and what each agency posted." +
        (d.opportunities === 0 ? " None is loaded now, so those panels have nothing to show." : ""),
    },
    {
      lead: "A new entrant is new to this record, not necessarily to the market.",
      rest: d.first_award_day
        ? `The record starts on ${day(d.first_award_day)}. A company with years of awards before that day still counts as new the first time it appears here.`
        : "A company with years of earlier awards still counts as new the first time it appears here.",
    },
    {
      lead: "An award with two categories counts in both.",
      rest: "Category totals can therefore add up to more than the overall total.",
    },
    {
      lead: "Offices are not rolled up into their parent agency.",
      rest: "Each award is counted under the agency or office the source named, so an agency's own figure leaves out what its offices awarded.",
    },
    {
      lead: "Some percentages are withheld.",
      rest: `A change in dollars gets no percentage when the prior period is under ${dollars(d.min_baseline)}, and a change in solicitations gets none when the prior period had fewer than ${count(d.min_topic_baseline)}. Growth from almost nothing makes a large percentage that means little. When the record does not reach back a full prior period, no change is shown at all.`,
    },
    {
      lead: "There are no programs here.",
      rest: "The record knows companies, agencies, offices and solicitations. It cannot say which program an award belongs to.",
    },
  ];
}

async function Numbers() {
  const d = await serverGet<Definitions>(signalPath("definitions", {}));
  if (!d)
    return (
      <Empty title="The ledger is closed">
        The data service is not answering, so the definitions cannot be shown.{" "}
        <Link href="/forum">Back to the Forum</Link>
      </Empty>
    );

  return (
    <article className="paper-card relative z-20 mx-auto max-w-2xl" data-flock-avoid>
      <CornerVine corner="tl" size={VINE} className="hidden sm:block" />
      <CornerVine corner="tl" size={VINE_SMALL} className="sm:hidden" />
      <CornerVine corner="br" size={VINE} className="hidden sm:block" />
      <CornerVine corner="br" size={VINE_SMALL} className="sm:hidden" />

      {/* Header panel: the Boscoreale wall, set inside the card's inner rule.
          No text sits on it. The grain ties the photograph to the drawn art. */}
      <div className="relative mx-[6px] mt-[6px]">
        <Fresco variant="wall" eager className="h-56 sm:h-[272px]" />
        <div className="grain grain-local fade-bottom" aria-hidden="true" />
      </div>

      {/* The plaque rises a little into the faded foot of the fresco. */}
      <div className="px-2 sm:px-12">
        <Cartouche as="h1" width={PLAQUE_WIDTH} className="relative z-10 -mt-10 sm:-mt-14">
          <span className="block text-[clamp(1.25rem,6vw,2.3rem)]">About the numbers</span>
        </Cartouche>
      </div>

      <div className="px-5 pb-14 sm:px-12 sm:pb-16">
        <GreekKey className="fade-sides mx-auto mt-3 max-w-[400px] sm:max-w-none" />
        <p className="label mt-4 text-center">
          As of {day(d.as_of)}
          {d.sample && " · sample data"}
        </p>

        {/* What the record holds. */}
        <dl className="fig mt-8 flex flex-wrap justify-center gap-x-10 gap-y-4 border-y border-hair py-5 text-center">
          <div>
            <dt className="label">First award on record</dt>
            <dd className="mt-1 font-display text-2xl">{d.first_award_day ? day(d.first_award_day) : "none yet"}</dd>
          </div>
          <div>
            <dt className="label">Awards</dt>
            <dd className="mt-1 font-display text-2xl">{count(d.awards)}</dd>
          </div>
          <div>
            <dt className="label">Solicitations</dt>
            <dd className="mt-1 font-display text-2xl">{count(d.opportunities)}</dd>
          </div>
        </dl>
        <p className="mt-5 text-muted">
          The figures defined below are computed from these records, once a night. Only awards and solicitations
          tagged as autonomy are in them.
          {d.opportunities === 0 && " No solicitation source is loaded, so the solicitation count is zero."}
          {d.sample &&
            " This is sample data: the companies and amounts are invented, so the site can be tried without the real sources."}
        </p>

        {/* One section per definition, in the API's own words. */}
        {d.items.map((it) => (
          <section key={it.key} id={it.key} className="mt-9 scroll-mt-24 border-t border-hair pt-7">
            <h2 className="text-[1.75rem] leading-tight">{it.name}</h2>
            <p className="mt-2.5">{it.text}</p>
            {it.tables.length > 0 && (
              <p className="fig mt-2.5 text-[0.88rem] text-muted">Source tables: {it.tables.join(", ")}</p>
            )}
          </section>
        ))}

        <section id="limits" className="mt-12 scroll-mt-24">
          <GreekKey className="fade-sides mx-auto max-w-[400px] sm:max-w-none" />
          <h2 className="mt-8 text-center text-[2rem] leading-tight">What these numbers cannot tell you</h2>
          <ul className="mt-5">
            {limits(d).map((l) => (
              <li key={l.lead} className="border-b border-hair py-3.5 last:border-b-0">
                <span className="text-ink">{l.lead}</span> <span className="text-muted">{l.rest}</span>
              </li>
            ))}
          </ul>
        </section>

        <p className="mt-10 text-center">
          <Link href="/forum" className="marble pill">
            ← back to the forum
          </Link>
        </p>
      </div>
    </article>
  );
}

export default function AboutNumbersPage() {
  return (
    <>
      <main className="mx-auto max-w-3xl px-4 pt-28 sm:px-8" data-flock-column>
        <Suspense
          fallback={
            <section className="paper-card relative z-20 min-h-[70vh] px-5 py-10 sm:px-10" aria-busy="true">
              <span className="sr-only">Loading</span>
              <span className="skeleton h-9 w-72 max-w-full" />
              <div className="mt-8 space-y-4" aria-hidden="true">
                {[92, 100, 84, 96, 70, 88, 62].map((w, i) => (
                  <span key={i} className="skeleton h-4" style={{ width: `${w}%` }} />
                ))}
              </div>
            </section>
          }
        >
          <Numbers />
        </Suspense>
      </main>
      <Footer />
    </>
  );
}
