import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Art } from "@/components/Art";
import { Empty } from "@/components/Empty";
import { Footer } from "@/components/Footer";
import { serverGet, type Digest, type RecentItem } from "@/lib/api";
import { day, money, plural, truncate } from "@/lib/format";
import { tagPhrase } from "@/lib/tags";
import "./feed.css";

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

  // The report is a short run of paragraphs, written from the week's records.
  const lines: React.ReactNode[] = [];
  if (d.awards === 0) {
    lines.push(<>A quiet week. No autonomy awards landed between {day(d.week_of, true)} and {day(d.through, true)}.</>);
  } else {
    lines.push(
      <>
        {plural(d.awards, "award")} landed this week, worth <span className="money">{money(d.amount)}</span>.
        {d.prev_awards > 0 && <> The week before it was {plural(d.prev_awards, "award")} and {money(d.prev_amount)}.</>}
      </>,
    );
    d.top.slice(0, 3).forEach((a, i) =>
      lines.push(
        <>
          {i === 0 ? "The largest went to " : i === 1 ? "Then " : "And "}
          <Entity id={a.org_id} name={a.org_name} />: <span className="money">{money(a.amount)}</span>
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
          Most of the money moved in {tagPhrase(d.by_tag[0].slug)} (<span className="money">{money(d.by_tag[0].amount)}</span>{" "}
          across {plural(d.by_tag[0].n, "award")})
          {d.by_tag[1] && (
            <>
              , then {tagPhrase(d.by_tag[1].slug)} (<span className="money">{money(d.by_tag[1].amount)}</span>)
            </>
          )}
          .
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

  return (
    <>
      <article>
        <h1 className="feed-title">Field Report</h1>
        <p className="mt-2 font-display text-[1.4375rem] leading-tight">Week of {day(d.week_of)}</p>
        {/* The week's figures come from the same views as the Forum. */}
        <p className="mt-2 text-muted">
          Written from the records of {day(d.week_of, true)} to {day(d.through)}. The same figures, by quarter:{" "}
          <Link href="/forum" className="ui-link">
            the Forum
          </Link>
          {" · "}
          <Link href="/about/numbers" className="ui-link">
            How these are counted
          </Link>
        </p>
        <div className="reading feed-body mt-9">
          {lines.map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </div>
        <p className="reading mt-8 italic text-muted">Flock, from the lake</p>
      </article>

      {recent && recent.length > 0 && (
        <section className="mt-14 border-t border-line pt-10">
          <h2 className="panel-title">Everything spotted lately</h2>
          <p className="lede mt-1.5">One row per swallow on the landing page.</p>
          <div className="relative mt-4 overflow-x-auto" tabIndex={0} role="region" aria-label="Everything spotted lately: table">
            <table className="ledger">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col" className="hidden sm:table-cell">
                    Kind
                  </th>
                  <th scope="col">What</th>
                  <th scope="col" className="num">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => {
                  const award = r.kind === "award";
                  // An award is named by who received it; a solicitation by its title.
                  const under = award ? (r.agency_name ?? truncate(r.title, 90)) : r.agency_name;
                  return (
                    <tr key={`${r.kind}${r.id}`}>
                      <td className="w-px whitespace-nowrap pr-6! align-top! text-muted">{day(r.day, true)}</td>
                      <td className="hidden w-px whitespace-nowrap pr-6! align-top! text-muted sm:table-cell">
                        {award ? "Award" : "Solicitation"}
                      </td>
                      <td className="w-full max-w-0">
                        <span className="name block truncate">
                          {award ? <Entity id={r.org_id} name={r.org_name} /> : truncate(r.title, 90) || "Untitled solicitation"}
                        </span>
                        {under && <span className="block truncate text-[0.8125rem] text-muted">{under}</span>}
                        <span className="text-[0.8125rem] text-muted sm:hidden">{!award && "Solicitation"}</span>
                      </td>
                      <td className="num money align-top!">{award ? money(r.amount) : ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

export default function FeedPage() {
  return (
    <>
      {/* The page's one engraving: the vine, in the left margin when the
          window is wide enough to have one. */}
      <Art name="margins/vine" sizes="360px" opacity={0.3} className="feed-vine" />
      <main className="mx-auto max-w-[41.75rem] px-4 pt-28 sm:px-6 sm:pt-36">
        <Suspense fallback={<div className="h-[70vh]" />}>
          <Report />
        </Suspense>
      </main>
      <Footer width="reading" />
    </>
  );
}
