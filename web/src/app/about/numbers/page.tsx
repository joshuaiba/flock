import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Empty } from "@/components/Empty";
import { Footer } from "@/components/Footer";
import { serverGet } from "@/lib/api";
import { day, dollars } from "@/lib/format";
import { signalPath, type Definitions } from "@/lib/signals";

export const metadata: Metadata = { title: "About the numbers" };

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
    <article className="relative z-20 mx-auto max-w-2xl">
      <header className="text-center">
        <h1 className="title-plaque">About the numbers</h1>
        <p className="ui mt-4 text-muted">
          As of {day(d.as_of)}
          {d.sample && " · sample data"}
        </p>
      </header>

      {/* What the record holds. */}
      <dl className="mt-9 grid grid-cols-3 border-y border-frame">
        {[
          { k: "First award on record", v: d.first_award_day ? day(d.first_award_day) : "None yet" },
          { k: "Awards", v: count(d.awards) },
          { k: "Solicitations", v: count(d.opportunities) },
        ].map((x, i) => (
          <div key={x.k} className={`px-3 py-4 text-center ${i ? "border-l border-hair" : ""}`}>
            <dt className="label">{x.k}</dt>
            <dd className="mt-1 font-display text-2xl leading-tight">{x.v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-6 text-muted">
        The figures defined below are computed from these records, once a night. Only awards and solicitations
        tagged as autonomy are in them.
        {d.opportunities === 0 && " No solicitation source is loaded, so the solicitation count is zero."}
        {d.sample &&
          " This is sample data: the companies and amounts are invented, so the site can be tried without the real sources."}
      </p>

      {/* One section per definition, in the API's own words. */}
      {d.items.map((it) => (
        <section key={it.key} id={it.key} className="mt-8 scroll-mt-24 border-t border-hair pt-6">
          <h2 className="text-[1.75rem] leading-tight">{it.name}</h2>
          <p className="mt-2.5">{it.text}</p>
          {it.tables.length > 0 && <p className="ui mt-2.5 text-muted">Source tables: {it.tables.join(", ")}</p>}
        </section>
      ))}

      <section id="limits" className="mt-14 scroll-mt-24 border-t border-frame pt-8">
        <h2 className="text-[2rem] leading-tight">What these numbers cannot tell you</h2>
        <ul className="mt-4">
          {limits(d).map((l) => (
            <li key={l.lead} className="border-b border-hair py-3.5 last:border-b-0">
              <span className="text-ink">{l.lead}</span> <span className="text-muted">{l.rest}</span>
            </li>
          ))}
        </ul>
      </section>

      <p className="mt-10">
        <Link href="/forum" className="btn">
          Back to the Forum
        </Link>
      </p>
    </article>
  );
}

export default function AboutNumbersPage() {
  return (
    <>
      <main className="mx-auto max-w-3xl px-4 pt-28 sm:px-8">
        <Suspense
          fallback={
            <section className="relative z-20 mx-auto min-h-[70vh] max-w-2xl" aria-busy="true">
              <span className="sr-only">Loading</span>
              <span className="skeleton mx-auto h-16 w-80 max-w-full" />
              <div className="mt-10 space-y-4" aria-hidden="true">
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
