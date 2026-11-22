import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Art } from "@/components/Art";
import { Empty } from "@/components/Empty";
import { EntitySignals, EntitySignalsSkeleton } from "@/components/EntitySignals";
import { FlightPath, pathReading } from "@/components/FlightPath";
import { Footer } from "@/components/Footer";
import { PinButton } from "@/components/PinButton";
import { GraphLink } from "@/components/Signals";
import { serverGet, type Org, type OrgAward } from "@/lib/api";
import { day, money, plural, truncate } from "@/lib/format";
import { tagLabel } from "@/lib/tags";
import "./entity.css";

export const metadata: Metadata = { title: "Organization" };

const STAGE: Record<string, string> = { phase_1: "Phase I", phase_2: "Phase II", production: "Production" };

/** A section of the page: a plain serif title, one sentence under it, then
 *  the content. No card and no rule: sections are set apart by space. */
function Section({
  title,
  lede,
  className = "",
  children,
}: {
  title: string;
  lede?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`min-w-0 ${className}`}>
      <h2 className="panel-title">{title}</h2>
      {lede && <p className="lede mt-1.5">{lede}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** The frame of the signals row. It is handed to the row itself, so it
 *  disappears with the readings when there is nothing to show. */
function SignalsFrame({ children }: { children: React.ReactNode }) {
  return <div className="mt-12">{children}</div>;
}

function AwardRows({ awards, counterpart }: { awards: OrgAward[]; counterpart: string }) {
  return (
    <div className="relative overflow-x-auto" tabIndex={0} role="region" aria-label="Awards: table">
      <table className="ledger">
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Description</th>
            <th scope="col" className="hidden sm:table-cell">
              {counterpart}
            </th>
            <th scope="col" className="num">
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {awards.map((a) => (
            <tr key={a.id}>
              <td className="w-px whitespace-nowrap pr-6! align-top! text-muted">{day(a.day)}</td>
              <td className="align-top! font-medium">
                {a.url ? (
                  <a href={a.url} target="_blank" rel="noreferrer" className="no-underline hover:underline">
                    {truncate(a.description, 110) || "Award record"}
                  </a>
                ) : (
                  truncate(a.description, 110) || "—"
                )}
                {a.stage && <span className="block font-normal text-muted">{STAGE[a.stage]}</span>}
                {/* on a phone the other party moves under the description */}
                {a.other_name && <span className="block font-normal text-muted sm:hidden">{a.other_name}</span>}
              </td>
              <td className="hidden w-[28%] align-top! text-muted sm:table-cell">
                {a.other_id ? (
                  <Link href={`/entity/${a.other_id}`} className="no-underline hover:underline">
                    {a.other_name}
                  </Link>
                ) : (
                  "—"
                )}
              </td>
              <td className="num money align-top!">{money(a.amount)}</td>
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
      <Empty title="No organization by that number">
        It may have been merged into another record, or the data service is not answering.{" "}
        <Link href="/graph">Back to the graph</Link>
      </Empty>
    );

  const company = org.kind === "company";
  const first = org.awards.slice(0, 25);
  const rest = org.awards.slice(25);
  // The primary category first, then the others.
  const tags = [...org.tags].sort((a, b) => Number(b.slug === org.tag) - Number(a.slug === org.tag));
  const paidMax = Math.max(0, ...org.related.map((r) => r.total));
  const payers = company ? "office" : "company";

  return (
    <>
      {/* The page's one engraving: the painted garland as a faint band in the
          top right corner, fading out toward the name. */}
      <figure className="entity-band">
        <Art
          name="fresco/garland-band"
          sizes="(min-width: 768px) 56vw, 100vw"
          opacity={0.38}
          className="h-full w-full"
          imgClassName="object-cover object-right"
        />
        <figcaption className="caption entity-band-caption">Detail of a wall painting from Boscoreale.</figcaption>
      </figure>

      <header className="relative">
        <p className="text-muted">
          <span className="capitalize">{org.kind}</span>
          {tags.length > 0 && <> · {tags.map((t) => tagLabel(t.slug)).join(", ")}</>}
        </p>
        {/* The name is the hero. */}
        <h1 className="entity-name mt-2">{org.name}</h1>
        <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3">
          <p className="text-muted">
            {org.uei ? `UEI ${org.uei}` : "No UEI on record"}
            {org.first_award && <> · First seen {day(org.first_award)}</>}
            {" · "}
            {plural(org.award_count, "award")} on record
            {org.total > 0 && (
              <>
                , <span className="money">{money(org.total)}</span>
              </>
            )}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <PinButton entity={{ id: org.id, name: org.name, tag: org.tag, kind: org.kind }} small />
            <Link href={`/graph?focus=${encodeURIComponent(`org:${org.id}`)}`} className="btn btn-sm">
              Show in graph
            </Link>
          </div>
        </div>
        {org.aliases.length > 0 && (
          <p className="mt-3 max-w-2xl text-muted">Also recorded as {org.aliases.slice(0, 6).join("; ")}.</p>
        )}
      </header>

      {/* Signals load on their own, so the page never waits for them. An
          organization with no awards has none, and gets no row. */}
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
        <Section title="Path to production" lede={pathReading(org.path)} className="mt-16">
          <FlightPath stages={org.path} />
        </Section>
      )}

      {/* Two columns on a wide screen: the awards, and beside them who is on
          the other side of the money and where the records came from. */}
      <div className="mt-16 grid grid-cols-1 gap-x-14 gap-y-14 lg:grid-cols-12">
        <Section title="Awards" lede="Newest first. Amounts are obligations." className="lg:col-span-7">
          {org.awards.length === 0 ? (
            <p className="name font-normal text-muted">No autonomy awards on record yet.</p>
          ) : (
            <>
              <AwardRows awards={first} counterpart={company ? "Office" : "Recipient"} />
              {rest.length > 0 && (
                <details className="mt-3">
                  <summary className="ui-link w-fit cursor-pointer py-1">Show {plural(rest.length, "older award")}</summary>
                  <AwardRows awards={rest} counterpart={company ? "Office" : "Recipient"} />
                </details>
              )}
            </>
          )}
        </Section>

        <div className="flex min-w-0 flex-col gap-y-14 lg:col-span-5">
          {(org.related.length > 0 || org.family.length > 0) && (
            <Section
              title={company ? "Who pays them" : "Where the money goes"}
              lede={
                org.related.length > 0
                  ? `${plural(org.related.length, payers, company ? "offices" : "companies")}, by dollars on record.`
                  : undefined
              }
            >
              <ul className="border-t border-line2">
                {org.related.map((r) => (
                  <li key={r.id} className="org-link border-b border-line py-3">
                    <div className="flex items-baseline justify-between gap-x-4">
                      <span className="name inline-flex min-w-0 items-center gap-2">
                        <Link href={`/entity/${r.id}`} className="min-w-0 truncate">
                          {r.name}
                        </Link>
                        <GraphLink id={r.id} name={r.name} />
                      </span>
                      <span className="money shrink-0 text-[0.875rem]">{money(r.total)}</span>
                    </div>
                    {/* The same dollars as a length, against the largest. */}
                    {r.total > 0 && (
                      <div
                        className="mt-1.5 h-[3px] min-w-[3px] rounded-full bg-accent"
                        style={{ width: `${paidMax > 0 ? ((r.total / paidMax) * 100).toFixed(2) : 0}%` }}
                        aria-hidden="true"
                      />
                    )}
                  </li>
                ))}
                {org.family.map((r) => (
                  <li key={`f${r.id}`} className="flex items-baseline justify-between gap-x-4 border-b border-line py-3">
                    <span className="name min-w-0 truncate">
                      <Link href={`/entity/${r.id}`}>{r.name}</Link>
                    </span>
                    <span className="shrink-0 text-muted">{r.relation === "parent" ? "part of" : "includes"}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {org.opportunities.length > 0 && (
            <Section title={company ? "Solicitations answered" : "Solicitations issued"}>
              <ul className="border-t border-line2">
                {org.opportunities.map((o) => (
                  <li key={o.id} className="border-b border-line py-2.5">
                    <p className="font-medium">
                      {o.url ? (
                        <a href={o.url} target="_blank" rel="noreferrer" className="no-underline hover:underline">
                          {o.title}
                        </a>
                      ) : (
                        o.title
                      )}
                    </p>
                    <p className="text-muted">
                      Posted {day(o.posted)} · {o.open ? `open until ${day(o.closes, true)}` : "closed"}
                    </p>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {org.sources.length > 0 && (
            <Section title="Source documents">
              <ul className="border-t border-line2">
                {org.sources.map((s) => (
                  <li key={s.url} className="flex items-baseline justify-between gap-4 border-b border-line py-2.5">
                    <a href={s.url} target="_blank" rel="noreferrer" className="truncate font-medium no-underline hover:underline">
                      {s.label}
                    </a>
                    <span className="shrink-0 text-muted">Fetched {day(s.day, true)}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      </div>
    </>
  );
}

export default function EntityPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <>
      <main className="entity-main relative mx-auto max-w-[71.75rem] px-4 sm:px-6">
        <Suspense fallback={<div className="h-[70vh]" />}>
          <Sheet params={params} />
        </Suspense>
      </main>
      <Footer />
    </>
  );
}
