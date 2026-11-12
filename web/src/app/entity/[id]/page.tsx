import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Fresco } from "@/components/Art";
import { Empty } from "@/components/Empty";
import { EntitySignals, EntitySignalsSkeleton } from "@/components/EntitySignals";
import { FlightPath } from "@/components/FlightPath";
import { Footer } from "@/components/Footer";
import { Medallion, MedallionLink } from "@/components/Medallion";
import { PinButton } from "@/components/PinButton";
import { serverGet, type Org, type OrgAward } from "@/lib/api";
import { day, dollars, money, plural, truncate } from "@/lib/format";
import { tagLabel } from "@/lib/tags";

export const metadata: Metadata = { title: "Specimen sheet" };

const STAGE: Record<string, string> = { phase_1: "Phase I", phase_2: "Phase II", production: "Production" };

// The fresco strip: 160px, 200px from the sm breakpoint. It is the page's one
// ornament; everything under the header is a working sheet.
const BANNER = "h-40 sm:h-[200px]";

/** A section of the sheet: a rule, a plain serif title with an optional note
 *  beside it, then the content. No card and no ornament. */
function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="relative z-20 mt-14 border-t border-frame pt-7">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h2 className="panel-title">{title}</h2>
        {note && <p className="ui text-muted">{note}</p>}
      </div>
      <div className="mt-5">{children}</div>
    </section>
  );
}

/** The frame of the Signals block. It is handed to the block itself, so the
 *  title disappears with the readings when there is nothing to show. */
function SignalsFrame({ children }: { children: React.ReactNode }) {
  return (
    <Section title="Signals" note="The last 90 days, against the 90 before">
      {children}
    </Section>
  );
}

function AwardRows({ awards, counterpart }: { awards: OrgAward[]; counterpart: string }) {
  return (
    <div className="relative overflow-x-auto">
      <table className="ledger min-w-[640px]">
        <thead>
          <tr>
            <th>Date</th>
            <th className="num">Amount</th>
            <th>Stage</th>
            <th>{counterpart}</th>
            <th>For</th>
          </tr>
        </thead>
        <tbody>
          {awards.map((a) => (
            <tr key={a.id}>
              <td className="ui whitespace-nowrap text-muted">{day(a.day)}</td>
              <td className="num">{dollars(a.amount)}</td>
              <td className="ui whitespace-nowrap text-muted">{a.stage ? STAGE[a.stage] : "—"}</td>
              <td className="text-[1.0625rem]">
                {a.other_id ? <Link href={`/entity/${a.other_id}`}>{a.other_name}</Link> : "—"}
              </td>
              <td className="text-[1rem] leading-snug">
                {a.url ? (
                  <a href={a.url} target="_blank" rel="noreferrer" className="text-ink no-underline hover:underline">
                    {truncate(a.description, 110) || "Award record"}
                  </a>
                ) : (
                  truncate(a.description, 110) || "—"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

async function Sheet({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const org = /^\d+$/.test(id) ? await serverGet<Org>(`orgs/${id}`) : null;
  if (!org)
    return (
      <Empty title="No specimen by that number">
        It may have been merged into another record, or the data service is not answering.{" "}
        <Link href="/graph">Back to the graph</Link>
      </Empty>
    );

  const company = org.kind === "company";
  const first = org.awards.slice(0, 25);
  const rest = org.awards.slice(25);
  const spotted =
    org.days_since_last == null
      ? null
      : org.days_since_last === 0
        ? "spotted today"
        : `spotted ${plural(org.days_since_last, "day")} ago`;

  return (
    <>
      <header>
        {/* The painted garland, as a strip. Nothing is written on it; the
            medallion hangs over its lower edge. */}
        <Fresco variant="band" eager className={`fade-sides z-0 w-full border-y border-frame ${BANNER}`} />
        <div className="relative z-20 flex flex-col items-center text-center">
          <div className="-mt-14">
            <Medallion id={org.id} tag={org.tag} kind={org.kind} size={112} morph="always" />
          </div>
          <p className="label mt-5 capitalize">{org.kind}</p>
          <h1 className="mt-1 text-4xl sm:text-6xl">{org.name}</h1>
          <p className="ui mt-3 text-muted">
            {org.uei ? `UEI ${org.uei}` : "No UEI on record"}
            {org.tags.map((t) => (
              <span key={t.slug}> · {tagLabel(t.slug)}</span>
            ))}
          </p>
          {/* a margin note: under the header on a phone, beside the medallion otherwise */}
          {spotted && (
            <p className="note mt-3 -rotate-2 sm:absolute sm:left-[calc(50%+4.75rem)] sm:top-4 sm:mt-0 sm:-rotate-3 sm:whitespace-nowrap">
              {spotted}
            </p>
          )}
          <PinButton
            entity={{ id: org.id, name: org.name, tag: org.tag, kind: org.kind }}
            className="mt-6 justify-center"
          />
        </div>
      </header>

      <div>
        <div className="relative z-20 mt-8">
          <dl className="grid grid-cols-2 border-y border-frame sm:grid-cols-4">
            {[
              { k: company ? "Awarded" : "Obligated", v: money(org.total), money: true },
              { k: "Awards", v: String(org.award_count) },
              { k: "First seen", v: day(org.first_award) },
              { k: "Last seen", v: day(org.last_award) },
            ].map((s, i) => (
              <div
                key={s.k}
                className={`px-4 py-4 text-center ${i % 2 ? "border-l border-hair" : ""} ${i > 1 ? "border-t border-hair sm:border-t-0" : ""} ${i === 2 ? "sm:border-l" : ""}`}
              >
                <dt className="label">{s.k}</dt>
                <dd className={`mt-1 font-display text-[1.75rem] leading-tight ${s.money ? "text-pompeii" : ""}`}>{s.v}</dd>
              </div>
            ))}
          </dl>
          {org.aliases.length > 0 && (
            <p className="mx-auto mt-4 max-w-2xl text-center text-muted">
              Also recorded as {org.aliases.slice(0, 6).join("; ")}.
            </p>
          )}
        </div>

        {/* Signals load on their own, so the sheet never waits for them. An
            organization with no awards has none, and gets no block. */}
        {org.award_count > 0 && (
          <Suspense
            fallback={
              <SignalsFrame>
                <EntitySignalsSkeleton company={company} />
              </SignalsFrame>
            }
          >
            <EntitySignals id={org.id} Frame={SignalsFrame} />
          </Suspense>
        )}

        {org.path && (
          <Section title="Path to production" note="Read from award descriptions">
            <FlightPath stages={org.path} />
          </Section>
        )}

        <Section
          title="Awards"
          note={org.award_count ? `${plural(org.award_count, "award")}, newest first` : undefined}
        >
          {org.awards.length === 0 ? (
            <p className="text-muted">No autonomy awards on record yet.</p>
          ) : (
            <>
              <AwardRows awards={first} counterpart={company ? "From" : "To"} />
              {rest.length > 0 && (
                <details className="mt-3">
                  <summary className="ui-link w-fit cursor-pointer py-1">
                    Show {plural(rest.length, "older award")}
                  </summary>
                  <AwardRows awards={rest} counterpart={company ? "From" : "To"} />
                </details>
              )}
            </>
          )}
        </Section>

        {(org.related.length > 0 || org.family.length > 0) && (
          <Section title={company ? "Who pays them" : "Where the money goes"}>
            <div className="flex flex-wrap gap-x-6 gap-y-8 pt-2">
              {org.related.map((r) => (
                <MedallionLink key={r.id} id={r.id} name={r.name} tag={null} kind={r.kind} note={money(r.total)} />
              ))}
              {org.family.map((r) => (
                <MedallionLink
                  key={`f${r.id}`}
                  id={r.id}
                  name={r.name}
                  tag={null}
                  kind={r.kind}
                  note={r.relation === "parent" ? "part of" : "includes"}
                />
              ))}
            </div>
          </Section>
        )}

        {org.opportunities.length > 0 && (
          <Section title={company ? "Solicitations answered" : "Solicitations issued"}>
            <ul>
              {org.opportunities.map((o) => (
                <li key={o.id} className="row sm:grid-cols-[7rem_1fr_auto]">
                  <span className="ui text-muted">{day(o.posted)}</span>
                  <span>{o.url ? <a href={o.url} target="_blank" rel="noreferrer">{o.title}</a> : o.title}</span>
                  <span className="ui text-muted">{o.open ? `Open until ${day(o.closes, true)}` : "Closed"}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {org.sources.length > 0 && (
          <Section title="Source documents" note="Where each record came from">
            <ul className="grid gap-x-10 sm:grid-cols-2">
              {org.sources.map((s) => (
                <li key={s.url} className="flex items-baseline justify-between gap-4 border-b border-hair py-1.5 text-[1.0625rem]">
                  <a href={s.url} target="_blank" rel="noreferrer" className="truncate">
                    {s.label}
                  </a>
                  <span className="ui shrink-0 text-muted">{day(s.day, true)}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </>
  );
}

export default function EntityPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <>
      <main className="mx-auto max-w-5xl px-5 pt-20 sm:px-8">
        <Suspense fallback={<div className="h-[70vh]" />}>
          <Sheet params={params} />
        </Suspense>
      </main>
      <Footer />
    </>
  );
}
