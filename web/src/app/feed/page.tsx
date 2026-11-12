import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { CornerVine, Fresco, GreekKey } from "@/components/Art";
import { Empty } from "@/components/Empty";
import { Footer } from "@/components/Footer";
import { Letter } from "@/components/Letter";
import { serverGet, type Digest, type RecentItem } from "@/lib/api";
import { day, money, plural, truncate } from "@/lib/format";
import { tagPhrase } from "@/lib/tags";

export const metadata: Metadata = { title: "Field report" };

// The corner vine by the sign-off, in px: from the `sm` breakpoint up, and on phones.
const VINE = 150;
const VINE_SMALL = 96;

function Entity({ id, name }: { id: number | null; name: string | null }) {
  if (!name) return <>an unnamed recipient</>;
  return id ? <Link href={`/entity/${id}`}>{name}</Link> : <>{name}</>;
}

function list(items: React.ReactNode[]): React.ReactNode {
  return items.map((it, i) => (
    <span key={i}>
      {i > 0 && (i === items.length - 1 ? " and " : ", ")}
      {it}
    </span>
  ));
}

async function Report() {
  const [d, recent] = await Promise.all([
    serverGet<Digest>("digest"),
    serverGet<RecentItem[]>("recent?limit=60"),
  ]);
  if (!d)
    return (
      <Empty title="No report this week">The data service is not answering, so there is nothing to write home about.</Empty>
    );

  // The letter is a list of short lines, so it can write on one line at a time.
  const lines: React.ReactNode[] = [];
  lines.push(<>To whoever follows the money,</>);
  if (d.awards === 0) {
    lines.push(<>A quiet week. No autonomy awards landed between {day(d.week_of, true)} and {day(d.through, true)}.</>);
  } else {
    lines.push(
      <>
        {plural(d.awards, "award")} landed this week, worth <span className="text-accent">{money(d.amount)}</span>.
        {d.prev_awards > 0 && <> The week before it was {plural(d.prev_awards, "award")} and {money(d.prev_amount)}.</>}
      </>,
    );
    d.top.slice(0, 3).forEach((a, i) =>
      lines.push(
        <>
          {i === 0 ? "The largest went to " : i === 1 ? "Then " : "And "}
          <Entity id={a.org_id} name={a.org_name} />: <span className="text-accent">{money(a.amount)}</span>
          {a.agency_name && (
            <>
              {" "}
              from <Entity id={a.agency_id} name={a.agency_name} />
            </>
          )}
          {a.description && <>. &ldquo;{truncate(a.description, 130)}&rdquo;</>}
        </>,
      ),
    );
    if (d.by_tag.length)
      lines.push(
        <>
          Most of the money moved in {tagPhrase(d.by_tag[0].slug)} ({money(d.by_tag[0].amount)} across{" "}
          {plural(d.by_tag[0].n, "award")})
          {d.by_tag[1] && <>, then {tagPhrase(d.by_tag[1].slug)} ({money(d.by_tag[1].amount)})</>}.
        </>,
      );
    if (d.newcomers.length)
      lines.push(
        <>
          New to the flock: {list(d.newcomers.map((n) => <Entity key={n.id} id={n.id} name={n.name} />))}, with{" "}
          {d.newcomers.length === 1 ? "a first award" : "first awards"} on record this week.
        </>,
      );
  }
  if (d.opened.length)
    lines.push(
      <>
        {plural(d.opened.length, "new solicitation")} opened. Among them: {truncate(d.opened[0].title, 80)}
        {d.opened[0].agency_name && (
          <>
            , from <Entity id={d.opened[0].agency_id} name={d.opened[0].agency_name} />
          </>
        )}
        .
      </>,
    );
  if (d.closing.length)
    lines.push(
      <>
        Closing soon: {truncate(d.closing[0].title, 80)} ({day(d.closing[0].closes, true)}).
      </>,
    );
  lines.push(<>Until next week,</>);

  return (
    <>
      <article className="paper-card relative z-20 mx-auto max-w-2xl overflow-clip">
        {/* One vine, beside the sign-off, where the lines are short. */}
        <CornerVine corner="br" size={VINE} className="hidden sm:block" />
        <CornerVine corner="br" size={VINE_SMALL} className="sm:hidden" />

        {/* Header panel: the Boscoreale wall. No text sits on it. The grain
            ties the photograph to the drawn art. */}
        <div className="relative">
          <Fresco variant="wall" eager className="h-52 sm:h-64" />
          <div className="grain grain-local fade-bottom" aria-hidden="true" />
        </div>

        <Letter week={d.week_of}>
          {/* The title plaque sits on the faded foot of the fresco. */}
          <div className="relative z-10 -mt-3 px-4 text-center">
            <h1 className="title-plaque [--plaque-h:3.5rem] sm:[--plaque-h:4rem]">Field Report</h1>
            <p className="mt-3 font-display text-[1.5rem] leading-tight">Week of {day(d.week_of, true)}</p>
            <p className="ui mt-1.5 text-muted">
              {day(d.week_of, true)} to {day(d.through)}
            </p>
          </div>
          <div className="px-5 pb-12 sm:px-12 sm:pb-16">
            <GreekKey className="fade-sides mx-auto mt-6 max-w-[400px] sm:max-w-none" />
            {/* The week's figures come from the same views as the Forum. */}
            <p className="ui mt-5 text-center text-muted">
              The same figures, by quarter:{" "}
              <Link href="/forum" className="ui-link">
                the Forum
              </Link>
              {" · "}
              <Link href="/about/numbers" className="ui-link">
                How these are counted
              </Link>
            </p>
            <div className="fig mt-8 space-y-4 text-[1.12rem] leading-relaxed">
              {lines.map((line, i) => (
                <p key={i} className="type-line" style={{ "--i": i } as React.CSSProperties}>
                  {line}
                </p>
              ))}
            </div>
            <p
              className="note type-line mt-4 -rotate-2 !text-[2.3rem] !text-ink"
              style={{ "--i": lines.length } as React.CSSProperties}
            >
              the flock
            </p>
          </div>
        </Letter>
      </article>

      {recent && recent.length > 0 && (
        <section className="relative z-20 mx-auto mt-20 max-w-3xl">
          <div className="flex items-baseline justify-between border-b border-line2 pb-2.5">
            <h2 className="panel-title">Everything spotted lately</h2>
            <p className="ui text-muted">One row per bird on the landing page</p>
          </div>
          <ul>
            {recent.map((r) => (
              <li
                key={`${r.kind}${r.id}`}
                className="row grid-cols-[3.75rem_1fr_auto] !py-2 sm:grid-cols-[4rem_15rem_1fr_auto]"
              >
                <span className="ui text-muted">{day(r.day, true)}</span>
                <span className="truncate text-[1.0625rem]">
                  <Entity id={r.org_id} name={r.org_name} />
                </span>
                <span className="col-span-3 truncate text-[0.95rem] text-muted sm:col-span-1">
                  {truncate(r.title, 90)}
                </span>
                <span
                  className={`ui col-start-3 row-start-1 text-right sm:col-start-4 ${r.kind === "award" ? "text-accent" : "text-muted"}`}
                >
                  {r.kind === "award" ? money(r.amount) : "Solicitation"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

export default function FeedPage() {
  return (
    <>
      <main className="mx-auto max-w-3xl px-4 pt-28 sm:px-8">
        <Suspense fallback={<div className="h-[70vh]" />}>
          <Report />
        </Suspense>
      </main>
      <Footer />
    </>
  );
}
