import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Empty } from "@/components/Empty";
import { Footer } from "@/components/Footer";
import { Landscape } from "@/components/Landscape";
import { Letter } from "@/components/Letter";
import { serverGet, type Digest, type RecentItem } from "@/lib/api";
import { day, money, plural, truncate } from "@/lib/format";
import { tagPhrase } from "@/lib/icons";

export const metadata: Metadata = { title: "Field report" };

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
        {plural(d.awards, "award")} landed this week, worth <span className="text-pompeii">{money(d.amount)}</span>.
        {d.prev_awards > 0 && <> The week before it was {plural(d.prev_awards, "award")} and {money(d.prev_amount)}.</>}
      </>,
    );
    d.top.slice(0, 3).forEach((a, i) =>
      lines.push(
        <>
          {i === 0 ? "The largest went to " : i === 1 ? "Then " : "And "}
          <Entity id={a.org_id} name={a.org_name} />: <span className="text-pompeii">{money(a.amount)}</span>
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
      <article className="paper-card relative z-20 mx-auto max-w-2xl overflow-hidden" data-flock-avoid>
        <Letter week={d.week_of}>
          <div className="px-7 pt-10 sm:px-12 sm:pt-14">
            <p className="label">
              {day(d.week_of, true)} to {day(d.through)}
            </p>
            <h1 className="mt-2 text-4xl sm:text-5xl">Field report, week of {day(d.week_of, true)}</h1>
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
        <div className="relative mt-2 h-44">
          <Landscape seed={21} height={420} horizon={0.6} trees={14} sun={false} villa={false} className="fade-top absolute inset-0 h-full w-full" />
        </div>
      </article>

      {recent && recent.length > 0 && (
        <section className="relative z-20 mx-auto mt-20 max-w-3xl" data-flock-avoid>
          <div className="flex items-baseline justify-between border-b border-frame pb-2">
            <h2 className="text-[2rem]">Everything spotted lately</h2>
            <p className="fig text-muted">one row per bird</p>
          </div>
          <ul>
            {recent.map((r) => (
              <li key={`${r.kind}${r.id}`} className="row grid-cols-[4.5rem_1fr_auto] sm:grid-cols-[5rem_15rem_1fr_auto]">
                <span className="fig text-muted">{day(r.day, true)}</span>
                <span className="truncate">
                  <Entity id={r.org_id} name={r.org_name} />
                </span>
                <span className="col-span-3 truncate text-[0.95rem] text-muted sm:col-span-1">
                  {truncate(r.title, 90)}
                </span>
                <span className={`fig col-start-3 row-start-1 text-right sm:col-start-4 ${r.kind === "award" ? "text-pompeii" : "text-muted"}`}>
                  {r.kind === "award" ? money(r.amount) : "solicitation"}
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
      <main className="mx-auto max-w-3xl px-4 pt-28 sm:px-8" data-flock-column>
        <Suspense fallback={<div className="h-[70vh]" />}>
          <Report />
        </Suspense>
      </main>
      <Footer />
    </>
  );
}
