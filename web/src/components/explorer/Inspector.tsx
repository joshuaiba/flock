"use client";

import Link from "next/link";
import { useState } from "react";
import { day, dollars, moneyRound, plural } from "@/lib/format";
import {
  awardsOf,
  byDollars,
  isMission,
  missionLabel,
  OTHERS,
  pct,
  sourceLinks,
  type Award,
  type Company,
  type Flows,
  type Model,
  type Named,
  type Tally,
} from "@/lib/flows";
import { MAX_PINS, useStore } from "@/lib/store";
import { CloseIcon, TickRing } from "./parts";

// The inspector: what is selected, in numbers that each lead to their source.
// A total is a link to the list of award records it was summed from (at the
// foot of this panel), and each record there links to its page on USAspending.
// With nothing selected it describes the whole window.

const ROWS = 6;

function Bars({
  title,
  rows,
  whole,
  onPick,
}: {
  title: string;
  rows: { id: string; label: string; dollars: number }[];
  whole: number;
  onPick: (id: string) => void;
}) {
  if (!rows.length) return null;
  const top = rows[0].dollars || 1;
  return (
    <section>
      <h3 className="ex-sec">{title}</h3>
      <ul className="ex-bars">
        {rows.slice(0, 7).map((r) => (
          <li key={r.id}>
            <button type="button" className="ex-barname" onClick={() => onPick(r.id)} title={`Select ${r.label}`}>
              {r.label}
            </button>
            <span className="ex-bartrack" aria-hidden="true">
              <span style={{ width: `${Math.max(2, (r.dollars / top) * 100)}%` }} />
            </span>
            <span className="ex-barpct" title={dollars(r.dollars)}>
              {pct(r.dollars, whole)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Awards per week over the span in view, the newest week in copper. */
function Weeks({ awards, label }: { awards: Award[]; label: string }) {
  if (awards.length < 2) return null;
  const n = (iso: string) =>
    Math.floor(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 604_800_000);
  const first = n(awards[0].day);
  const last = n(awards[awards.length - 1].day);
  const weeks = Math.min(26, last - first + 1);
  if (weeks < 2) return null;
  const sums = new Array(weeks).fill(0);
  for (const a of awards) {
    const i = n(a.day) - (last - weeks + 1);
    if (i >= 0) sums[i] += a.amount ?? 0;
  }
  const top = Math.max(1, ...sums);
  const w = 280 / weeks;
  return (
    <section>
      <h3 className="ex-sec">Dollars by week · {label}</h3>
      <svg
        viewBox="0 0 280 54"
        className="ex-weeks"
        role="img"
        aria-label={`Award dollars in each of the last ${weeks} weeks with awards; the largest week was ${moneyRound(top)}.`}
      >
        {sums.map((v, i) => {
          const h = v ? Math.max(2, (v / top) * 50) : 1;
          return (
            <rect
              key={i}
              x={i * w + 1}
              y={52 - h}
              width={Math.max(2, w - 3)}
              height={h}
              className={i === weeks - 1 ? "ex-week ex-week-now" : "ex-week"}
            >
              <title>{moneyRound(v)}</title>
            </rect>
          );
        })}
      </svg>
    </section>
  );
}

function Records({ awards, who, id }: { awards: Award[]; who: Map<string, Named>; id: string }) {
  const [all, setAll] = useState(false);
  const sorted = [...awards].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : b.id - a.id));
  const shown = all ? sorted.slice(0, 200) : sorted.slice(0, ROWS);
  return (
    <section id={id} className="ex-records" tabIndex={-1}>
      <h3 className="ex-sec">
        Award records <span className="ex-count">{awards.length.toLocaleString("en-US")}</span>
      </h3>
      {awards.length === 0 ? (
        <p className="ex-note">No awards match the filters.</p>
      ) : (
        <ul>
          {shown.map((a) => (
            <li key={a.id}>
              <span className="ex-rec-main">
                <span className="ex-rec-name">
                  {who.get(a.agency)?.label ?? "Agency"} → {who.get(a.company)?.label ?? "Company"}
                </span>
                <span className="ex-rec-sub">{a.missions.map(missionLabel).join(" · ")}</span>
              </span>
              <span className="ex-rec-num">
                {a.url ? (
                  <a
                    href={a.url}
                    target="_blank"
                    rel="noreferrer"
                    title={`${dollars(a.amount)} · open the source record (${a.source})`}
                  >
                    {moneyRound(a.amount)} ↗
                  </a>
                ) : (
                  <span title={dollars(a.amount)}>{moneyRound(a.amount)}</span>
                )}
                <span className="ex-rec-day">{day(a.day, true)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {awards.length > ROWS && (
        <button type="button" className="ex-more" onClick={() => setAll((v) => !v)} aria-expanded={all}>
          {all ? "Show fewer" : `Show all ${Math.min(200, awards.length).toLocaleString("en-US")}`}
          {all && awards.length > 200 ? " (the newest 200 are listed)" : ""}
        </button>
      )}
    </section>
  );
}

export function Inspector({
  data,
  model,
  who,
  selected,
  onSelect,
  onConstellation,
  inConstellation,
}: {
  data: Flows;
  model: Model;
  who: Map<string, Named>;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onConstellation: (id: string) => void;
  inConstellation: boolean;
}) {
  const { pin, unpin, isPinned, pins } = useStore();
  const label = (id: string) => who.get(id)?.label ?? id;
  const band = selected?.includes(">") ? selected : null;
  const party = selected && !band ? who.get(selected) : null;
  const awards = selected ? awardsOf(model, selected) : model.awards;
  const tally: Tally | undefined = selected
    ? (model.agencies.get(selected) ?? model.companies.get(selected) ?? model.missions.get(selected))
    : undefined;
  const records = "ex-records";

  /** dollars counted for the selection, by the party at the other end */
  const split = (
    links: Iterable<{ source: string; target: string; dollars: number }>,
    side: "source" | "target",
    match: string,
  ) => {
    const other = side === "source" ? "target" : "source";
    const out = new Map<string, number>();
    for (const l of links) if (l[side] === match) out.set(l[other], (out.get(l[other]) ?? 0) + l.dollars);
    return [...out].map(([id, dollars]) => ({ id, label: label(id), dollars })).sort(byDollars);
  };

  const Total = ({ value, n }: { value: number; n: number }) => (
    <div className="ex-figures">
      <div>
        <p className="ex-big">{pct(value, model.total)}</p>
        <p className="ex-figsub">of autonomy dollars in view</p>
      </div>
      <div>
        <p className="ex-money">
          <a href={`#${records}`} title={`${dollars(value)} · see the award records`}>
            {moneyRound(value)}
          </a>
        </p>
        <p className="ex-figsub">
          across <a href={`#${records}`}>{plural(n, "award")}</a>
        </p>
      </div>
    </div>
  );

  const head = (kicker: string, title: string, kind?: Named["kind"]) => (
    <header className="ex-insp-head">
      <svg width="52" height="52" viewBox="0 0 52 52" aria-hidden="true" className="ex-insp-mark">
        <TickRing cx={26} cy={26} r={21} n={24} len={4} />
        {kind === "company" ? (
          <circle cx="26" cy="26" r="9" className="ex-mark-company" />
        ) : kind === "mission" ? (
          <path d="M26 12L40 26L26 40L12 26Z" className="ex-mark-ring" />
        ) : (
          <>
            <circle cx="26" cy="26" r="17" className="ex-mark-ring" />
            <circle cx="26" cy="26" r="7" className="ex-mark-core" />
          </>
        )}
      </svg>
      <div className="min-w-0">
        <p className="ex-kicker">{kicker}</p>
        <h2 className="ex-insp-title">{title}</h2>
      </div>
      {selected && (
        <button type="button" className="ex-clear" aria-label="Clear selection" onClick={() => onSelect(null)}>
          <CloseIcon />
        </button>
      )}
    </header>
  );

  const sources = (p: { name: string; uei?: string | null; kind: string }) => (
    <p className="ex-sources">
      {sourceLinks(p).map((s) => (
        <a key={s.label} href={s.href} target="_blank" rel="noreferrer">
          {s.label} ↗
        </a>
      ))}
    </p>
  );

  const openSolicitations = (agency: string | null, mission: string | null) => {
    const list = data.solicitations.filter(
      (s) => s.open && (!agency || s.agency === agency) && (!mission || s.missions.includes(mission)),
    );
    if (!list.length) return null;
    return (
      <section>
        <h3 className="ex-sec">
          Open solicitations <span className="ex-count">{list.length}</span>
        </h3>
        <ul className="ex-sols">
          {list.slice(0, 4).map((s) => (
            <li key={s.id}>
              <span aria-hidden="true" className="ex-sol-mark">
                ◇
              </span>
              <span className="ex-sol-title">{s.url ? <a href={s.url}>{s.title}</a> : s.title}</span>
              {s.closes && <span className="ex-rec-day">closes {day(s.closes, true)}</span>}
            </li>
          ))}
        </ul>
      </section>
    );
  };

  let body: React.ReactNode;
  if (band) {
    const [s, t] = band.split(">");
    const l = model.am.get(band) ?? model.mc.get(band) ?? model.ac.get(band);
    const tName = t === OTHERS ? "All other companies" : label(t);
    const folded = t === OTHERS;
    const value = folded ? awards.reduce((sum, a) => sum + (a.amount ?? 0) / a.missions.length, 0) : (l?.dollars ?? 0);
    body = (
      <>
        {head("Flow · selected", `${label(s)} → ${tName}`)}
        <Total value={value} n={folded ? awards.length : (l?.awards.length ?? 0)} />
        <p className="ex-note">Every award in this band is listed below, each with its source record.</p>
      </>
    );
  } else if (party && tally && party.kind === "company") {
    const co = data.companies.find((c) => c.id === party.id) as Company | undefined;
    const paidBy = split(model.ac.values(), "target", party.id);
    const builds = split(model.mc.values(), "target", party.id);
    // Funded alongside: the largest other recipients of each paying agency.
    const alongside: { id: string; via: string }[] = [];
    for (const a of paidBy.slice(0, 4)) {
      const peer = split(model.ac.values(), "source", a.id).find(
        (p) => p.id !== party.id && !alongside.some((x) => x.id === p.id),
      );
      if (peer) alongside.push({ id: peer.id, via: a.label });
    }
    const pinned = co?.org_id != null && isPinned(co.org_id);
    body = (
      <>
        {head("Company", party.label, "company")}
        {party.full !== party.label && <p className="ex-legal">{party.full}</p>}
        <p className="ex-chips">
          {builds.slice(0, 3).map((b) => (
            <button key={b.id} type="button" className="ex-chip-serif" onClick={() => onSelect(b.id)}>
              {b.label}
            </button>
          ))}
        </p>
        <p className="ex-actions">
          {co?.org_id != null && (
            <button
              type="button"
              className="btn btn-sm"
              aria-pressed={pinned}
              disabled={!pinned && pins.length >= MAX_PINS}
              title={!pinned && pins.length >= MAX_PINS ? `The watchlist holds ${MAX_PINS}` : undefined}
              onClick={() =>
                pinned
                  ? unpin(co.org_id!)
                  : pin({ id: co.org_id!, name: co.name, tag: co.missions[0] ?? null, kind: "company" })
              }
            >
              {pinned ? "Watching" : "Watch"}
            </button>
          )}
          {!inConstellation && (
            <button type="button" className="btn btn-sm" onClick={() => onConstellation(party.id)}>
              Constellation
            </button>
          )}
          {co?.org_id != null && (
            <Link href={`/entity/${co.org_id}`} className="btn btn-sm">
              Full record
            </Link>
          )}
        </p>
        <Total value={tally.dollars} n={tally.awards} />
        <dl className="ex-facts">
          <div>
            <dt>Paying agencies</dt>
            <dd>{paidBy.length}</dd>
          </div>
          <div>
            <dt>Missions</dt>
            <dd>{builds.length}</dd>
          </div>
          <div>
            <dt>First award on record</dt>
            <dd className="ex-fact-small">{day(co?.first_award)}</dd>
          </div>
        </dl>
        <Bars title="Paid by" rows={paidBy} whole={tally.dollars} onPick={onSelect} />
        <Weeks awards={awards} label={data.window.label} />
        {alongside.length > 0 && (
          <section>
            <h3 className="ex-sec">Funded alongside</h3>
            <ul className="ex-along">
              {alongside.map((p) => (
                <li key={p.id}>
                  <button type="button" onClick={() => onSelect(p.id)}>
                    {label(p.id)}
                  </button>
                  <span>via {p.via}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {co && sources(co)}
      </>
    );
  } else if (party && tally && (party.kind === "agency" || party.kind === "office")) {
    const ag = data.agencies.find((a) => a.id === party.id);
    const goes = split(model.am.values(), "source", party.id);
    const pays = split(model.ac.values(), "source", party.id);
    body = (
      <>
        {head(`${party.kind === "office" ? "Office" : "Agency"} · selected`, party.label, party.kind)}
        {party.full !== party.label && <p className="ex-legal">{party.full}</p>}
        {!inConstellation && (
          <p className="ex-actions">
            <button type="button" className="btn btn-sm" onClick={() => onConstellation(party.id)}>
              Constellation
            </button>
            {ag?.org_id != null && (
              <Link href={`/entity/${ag.org_id}`} className="btn btn-sm">
                Full record
              </Link>
            )}
          </p>
        )}
        <Total value={tally.dollars} n={tally.awards} />
        <Bars title="Where it goes" rows={goes} whole={tally.dollars} onPick={onSelect} />
        <Bars title="Largest recipients" rows={pays} whole={tally.dollars} onPick={onSelect} />
        {openSolicitations(party.id, null)}
        {ag && sources(ag)}
      </>
    );
  } else if (party && tally && isMission(party.id)) {
    const paidBy = split(model.am.values(), "target", party.id);
    const goes = split(model.mc.values(), "source", party.id);
    body = (
      <>
        {head("Mission · selected", party.label, "mission")}
        <Total value={tally.dollars} n={tally.awards} />
        <dl className="ex-facts">
          <div>
            <dt>Paying agencies</dt>
            <dd>{paidBy.length}</dd>
          </div>
          <div>
            <dt>Recipients</dt>
            <dd>{goes.length}</dd>
          </div>
        </dl>
        <Bars title="Paid by" rows={paidBy} whole={tally.dollars} onPick={onSelect} />
        <Bars title="Largest recipients" rows={goes} whole={tally.dollars} onPick={onSelect} />
        {openSolicitations(null, party.id.slice(4))}
      </>
    );
  } else {
    const payers = [...model.agencies.values()]
      .sort(byDollars)
      .map((t) => ({ id: t.id, label: label(t.id), dollars: t.dollars }));
    const leaders = [...model.companies.values()]
      .sort(byDollars)
      .map((t) => ({ id: t.id, label: label(t.id), dollars: t.dollars }));
    body = (
      <>
        {head(
          selected ? "Not in view" : "The window",
          selected ? "Nothing here under these filters" : data.window.label,
        )}
        <div className="ex-figures">
          <div>
            <p className="ex-money">
              <a href={`#${records}`} title={`${dollars(model.total)} · see the award records`}>
                {moneyRound(model.total)}
              </a>
            </p>
            <p className="ex-figsub">
              across <a href={`#${records}`}>{plural(model.awards.length, "award")}</a>
            </p>
          </div>
          <div>
            <p className="ex-big">{model.companies.size.toLocaleString("en-US")}</p>
            <p className="ex-figsub">
              recipients, {model.agencies.size} paying {model.agencies.size === 1 ? "agency" : "agencies"}
            </p>
          </div>
        </div>
        <Bars title="Who paid" rows={payers} whole={model.total} onPick={onSelect} />
        <Bars title="Who leads" rows={leaders} whole={model.total} onPick={onSelect} />
        {openSolicitations(null, null)}
        <p className="ex-sources">
          <a href="https://www.usaspending.gov/" target="_blank" rel="noreferrer">
            USAspending ↗
          </a>
          <a href="https://sam.gov/" target="_blank" rel="noreferrer">
            SAM.gov ↗
          </a>
        </p>
      </>
    );
  }

  return (
    <aside className="ex-inspector" aria-label={party ? `${party.label} details` : "Selection details"}>
      {body}
      <Records key={selected ?? "all"} awards={awards} who={who} id={records} />
    </aside>
  );
}
