import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Empty } from "@/components/Empty";
import { FlightPath } from "@/components/FlightPath";
import { Footer } from "@/components/Footer";
import { Landscape } from "@/components/Landscape";
import { Medallion, MedallionLink } from "@/components/Medallion";
import { PinButton } from "@/components/PinButton";
import { serverGet, type Org, type OrgAward } from "@/lib/api";
import { day, dollars, money, plural, truncate } from "@/lib/format";
import { tagLabel } from "@/lib/icons";

export const metadata: Metadata = { title: "Specimen sheet" };

const STAGE: Record<string, string> = { phase_1: "Phase I", phase_2: "Phase II", production: "Production" };

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="mt-16">
      <div className="flex items-baseline justify-between gap-4 border-b border-frame pb-2">
        <h2 className="text-[2rem]">{title}</h2>
        {note && <p className="fig text-muted">{note}</p>}
      </div>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function AwardRows({ awards, counterpart }: { awards: OrgAward[]; counterpart: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-left">
        <thead>
          <tr className="label">
            <th className="py-2 pr-4 font-normal">Date</th>
            <th className="py-2 pr-4 text-right font-normal">Amount</th>
            <th className="py-2 pr-4 font-normal">Stage</th>
            <th className="py-2 pr-4 font-normal">{counterpart}</th>
            <th className="py-2 font-normal">For</th>
          </tr>
        </thead>
        <tbody>
          {awards.map((a) => (
            <tr key={a.id} className="border-t border-hair align-baseline">
              <td className="fig whitespace-nowrap py-2.5 pr-4 text-muted">{day(a.day)}</td>
              <td className="fig whitespace-nowrap py-2.5 pr-4 text-right">{dollars(a.amount)}</td>
              <td className="fig whitespace-nowrap py-2.5 pr-4 text-muted">{a.stage ? STAGE[a.stage] : "—"}</td>
              <td className="py-2.5 pr-4 text-[0.98rem]">
                {a.other_id ? <Link href={`/entity/${a.other_id}`}>{a.other_name}</Link> : "—"}
              </td>
              <td className="py-2.5 text-[0.98rem]">
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
      <header className="relative">
        <Landscape
          seed={org.id}
          height={420}
          horizon={0.52}
          trees={18}
          villa={org.kind !== "company"}
          className="fade-edges absolute inset-x-0 top-0 z-0 h-60 w-full"
        />
        <div className="relative z-20 flex flex-col gap-5 pt-40 sm:flex-row sm:items-end sm:gap-7">
          <Medallion id={org.id} tag={org.tag} kind={org.kind} size={112} morph="always" />
          <div className="min-w-0 flex-1" data-flock-avoid>
            <p className="label">{org.kind}</p>
            <h1 className="mt-1 text-4xl sm:text-6xl">{org.name}</h1>
            <p className="fig mt-3 text-muted">
              {org.uei ? `UEI ${org.uei}` : "no UEI on record"}
              {org.tags.map((t) => (
                <span key={t.slug}> · {tagLabel(t.slug)}</span>
              ))}
            </p>
          </div>
          {spotted && <p className="note shrink-0 -rotate-3 sm:pb-3">{spotted}</p>}
        </div>
      </header>

      <div className="relative z-20" data-flock-avoid>
        <div className="mt-8 flex flex-wrap items-center gap-x-10 gap-y-4">
          <dl className="fig flex flex-wrap gap-x-10 gap-y-3">
            <div>
              <dt className="label">{company ? "Awarded" : "Obligated"}</dt>
              <dd className="mt-1 font-display text-3xl text-pompeii">{money(org.total)}</dd>
            </div>
            <div>
              <dt className="label">Awards</dt>
              <dd className="mt-1 font-display text-3xl">{org.award_count}</dd>
            </div>
            <div>
              <dt className="label">First seen</dt>
              <dd className="mt-1 font-display text-3xl">{day(org.first_award)}</dd>
            </div>
            <div>
              <dt className="label">Last seen</dt>
              <dd className="mt-1 font-display text-3xl">{day(org.last_award)}</dd>
            </div>
          </dl>
          <PinButton entity={{ id: org.id, name: org.name, tag: org.tag, kind: org.kind }} className="sm:ml-auto" />
        </div>
        {org.aliases.length > 0 && (
          <p className="mt-4 text-muted">Also recorded as {org.aliases.slice(0, 6).join("; ")}.</p>
        )}

        {org.path && (
          <Section title="Path to production" note="read from award descriptions">
            <FlightPath stages={org.path} />
          </Section>
        )}

        <Section
          title="Awards"
          note={org.award_count ? `${plural(org.award_count, "award")} · newest first` : undefined}
        >
          {org.awards.length === 0 ? (
            <p className="text-muted">No autonomy awards on record yet.</p>
          ) : (
            <>
              <AwardRows awards={first} counterpart={company ? "From" : "To"} />
              {rest.length > 0 && (
                <details className="mt-2">
                  <summary className="fig cursor-pointer py-2 text-cypress">
                    show {plural(rest.length, "older award")}
                  </summary>
                  <AwardRows awards={rest} counterpart={company ? "From" : "To"} />
                </details>
              )}
            </>
          )}
        </Section>

        {(org.related.length > 0 || org.family.length > 0) && (
          <Section title={company ? "Who pays them" : "Where the money goes"}>
            <div className="flex flex-wrap gap-x-6 gap-y-8">
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
                  <span className="fig text-muted">{day(o.posted)}</span>
                  <span>{o.url ? <a href={o.url} target="_blank" rel="noreferrer">{o.title}</a> : o.title}</span>
                  <span className="fig text-muted">{o.open ? `open until ${day(o.closes, true)}` : "closed"}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {org.sources.length > 0 && (
          <Section title="Source documents" note="where each record came from">
            <ul className="grid gap-x-10 sm:grid-cols-2">
              {org.sources.map((s) => (
                <li key={s.url} className="fig flex justify-between gap-4 border-b border-hair py-1.5">
                  <a href={s.url} target="_blank" rel="noreferrer" className="truncate">
                    {s.label}
                  </a>
                  <span className="shrink-0 text-muted">{day(s.day, true)}</span>
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
      <main className="mx-auto max-w-5xl px-5 pt-16 sm:px-8" data-flock-column>
        <Suspense fallback={<div className="h-[70vh]" />}>
          <Sheet params={params} />
        </Suspense>
      </main>
      <Footer />
    </>
  );
}
