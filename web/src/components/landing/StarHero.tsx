"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { day, dollars, moneyRound, plural, spell } from "@/lib/format";
import { buildModel, byDollars, headline, missionLabel, names, pct, type Award, type Flows } from "@/lib/flows";
import { layoutStarChart, limbTicks, polar, R, SIZE } from "@/lib/starChart";
import { useStore } from "@/lib/store";
import { Hatch, useSvgId, useTip } from "../explorer/parts";
import "./landing.css";

// The landing page's second screen: an engraved star chart of the window's
// awards, the words about it beside it, and under them the newest awards as a
// feed. Agencies sit on the chart's outer ring, missions are its sectors,
// companies the stars inside them, and every arc is an agency paying a
// company. The copper arcs are the newest awards on record and ink in once
// when the page arrives; hovering any arc says what it is, and a copper one
// opens its source record.
//
// "Play the narrated tour" walks the chart in a few paragraphs, set beside it,
// moving the view to what each one is about. It starts only when asked, and
// with motion off it steps without moving. The chart itself never moves on its
// own: the page's ambient motion is the hero's swallows and boats, above.

/** What is lit: whole agencies, companies or a sector (the tour, a hovered
 *  node), the newest arcs, or one arc by key with its two ends. */
type Hot = {
  agencies?: ReadonlySet<string>;
  companies?: ReadonlySet<string>;
  sector?: string;
  live?: boolean;
  key?: string;
  ends?: [string, string];
} | null;
type Step = { text: ReactNode; hot: Hot; at?: [number, number]; zoom?: number };

const C = SIZE / 2;
const STEP_MS = 6500;

export function StarHero({ data }: { data: Flows }) {
  const { motion } = useStore();
  const who = useMemo(() => names(data), [data]);
  const model = useMemo(() => buildModel(data.awards), [data]);
  const chart = useMemo(() => layoutStarChart(data, model, who), [data, model, who]);
  const head = useMemo(() => headline(model, who), [model, who]);
  const ticks = useMemo(limbTicks, []);
  const hatch = useSvgId("sh");
  const ids = useSvgId("sp");
  const { tip, show, hide } = useTip();
  const [hover, setHover] = useState<Hot>(null);
  const [step, setStep] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const caption = useRef<HTMLParagraphElement>(null);

  const label = (id: string) => who.get(id)?.label ?? id;
  const w = data.window;
  const entities = model.companies.size + model.agencies.size;
  const live = chart.live;

  const steps: Step[] = useMemo(() => {
    const payers = [...model.agencies.values()].sort(byDollars);
    const out: Step[] = [
      {
        text: (
          <>
            This is {w.days ? `${w.days} days` : "the whole record"} of autonomy contracts, drawn as a star chart. The{" "}
            {spell(payers.length)} paying agencies sit on the outer ring. Every star inside is a company, placed in the
            sector of the mission it is paid most for.
          </>
        ),
        hot: null,
      },
    ];
    const a = chart.agencies[0];
    if (a)
      out.push({
        text: (
          <>
            {a.label} paid {pct(a.dollars, model.total)} of the dollars: {moneyRound(a.dollars)} across{" "}
            {plural(a.awards, "award")}. Its arcs are lit.
          </>
        ),
        hot: { agencies: new Set([a.id]) },
        at: [a.x, a.y],
        zoom: 1.18,
      });
    const rest = chart.agencies.slice(1, 3);
    if (rest.length === 2 && head)
      out.push({
        text: (
          <>
            {rest[0].label} and {rest[1].label} add {pct(rest[0].dollars + rest[1].dollars, model.total)}. Together the
            three paid {Math.min(99, Math.round(head.share * 100))}% of everything on the chart.
          </>
        ),
        hot: { agencies: new Set(rest.map((r) => r.id)) },
        at: [(rest[0].x + rest[1].x) / 2, (rest[0].y + rest[1].y) / 2],
        zoom: 1.12,
      });
    const s = chart.sectors[0];
    if (s)
      out.push({
        text: (
          <>
            {s.label} is the widest sector: {plural(s.companies, "company", "companies")} and{" "}
            {pct(s.dollars, model.total)} of the dollars.
          </>
        ),
        hot: { sector: s.id },
        at: polar((s.a0 + s.a1) / 2, 170),
        zoom: 1.5,
      });
    const star = chart.stars[0];
    if (star) {
      const paid = [...model.ac.values()].filter((l) => l.target === star.id).length;
      out.push({
        text: (
          <>
            {star.label} is the brightest star: {moneyRound(star.dollars)} from {spell(paid)}{" "}
            {paid === 1 ? "agency" : "agencies"}.
          </>
        ),
        hot: { companies: new Set([star.id]) },
        at: [star.x, star.y],
        zoom: 1.9,
      });
    }
    out.push({
      text: (
        <>
          The copper arcs are the newest awards on record, through {day(w.latest_data_date, true)}. Hover one to read
          it, and click it to open the contract. <Link href="/graph">Open the graph</Link> to follow any of them
          further.
        </>
      ),
      hot: { live: true },
    });
    return out;
  }, [chart, model, head, w]);

  // The tour advances by itself only while playing, and only with motion on.
  useEffect(() => {
    if (!playing || step == null || !motion) return;
    if (step >= steps.length - 1) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setStep(step + 1), STEP_MS);
    return () => clearTimeout(t);
  }, [playing, step, steps.length, motion]);

  const touring = step != null;
  const cur = touring ? steps[step] : null;
  const hot: Hot = hover ?? cur?.hot ?? null;
  const zoom = cur?.zoom ?? 1;
  // The view pushes in on a point: the point drifts a third of the way toward
  // the middle of the chart while everything around it grows.
  const rest = cur?.at ? [cur.at[0] + (C - cur.at[0]) * 0.35, cur.at[1] + (C - cur.at[1]) * 0.35] : null;
  const camera =
    cur?.at && rest
      ? `translate(${(rest[0] - cur.at[0] * zoom).toFixed(1)}px, ${(rest[1] - cur.at[1] * zoom).toFixed(1)}px) scale(${zoom})`
      : undefined;
  const start = () => {
    setStep(0);
    setPlaying(true);
    requestAnimationFrame(() => caption.current?.focus());
  };
  const stop = () => {
    setStep(null);
    setPlaying(false);
  };
  const go = (n: number) => {
    setPlaying(false);
    setStep(Math.max(0, Math.min(steps.length - 1, n)));
  };

  const arcOn = (source: string, target: string, key: string, isLive: boolean) =>
    !hot ||
    hot.key === key ||
    (hot.live && isLive) ||
    !!hot.agencies?.has(source) ||
    !!hot.companies?.has(target) ||
    (!!hot.sector && chart.stars.find((s) => s.id === target)?.sector === hot.sector);
  const starOn = (id: string, sector: string) =>
    !hot ||
    hot.live ||
    !!hot.companies?.has(id) ||
    hot.sector === sector ||
    (!!hot.agencies && chart.arcs.some((a) => a.target === id && hot.agencies!.has(a.source))) ||
    hot.ends?.[1] === id;

  const awardNote = (a: Award) => (
    <>
      <strong>
        {label(a.agency)} → {label(a.company)}
      </strong>
      <span className="ex-tip-row">
        <span className="money">{moneyRound(a.amount)}</span>
        <span>{day(a.day)}</span>
      </span>
      <span className="ex-tip-row">{a.missions.map(missionLabel).join(" · ")}</span>
      <span className="ex-tip-hint">Click to open the source record</span>
    </>
  );
  const awardText = (a: Award) =>
    `${label(a.agency)} to ${label(a.company)}, ${a.missions.map(missionLabel).join(", ")}, ${dollars(a.amount)}, ${day(a.day)}`;
  const leave = () => {
    setHover(null);
    hide();
  };

  return (
    <>
      <section id="chart" className="ld-chartsec">
        <div className="ld-chart">
          <svg
            viewBox={`-30 -30 ${SIZE + 60} ${SIZE + 60}`}
            role="img"
            aria-label={`Star chart of autonomy funding, ${w.label}: ${spell(chart.agencies.length)} agencies on the outer ring send contract arcs to ${chart.stars.length} companies grouped into ${spell(chart.sectors.length)} mission sectors.${head ? ` ${head.claim}.` : ""}`}
            className={`ld-star ${hot ? "ld-star-focus" : ""}`}
          >
            <defs>
              <Hatch id={hatch} gap={4} weight={0.7} opacity={0.16} />
              <clipPath id={`${ids}clip`}>
                <rect x="-30" y="-30" width={SIZE + 60} height={SIZE + 60} />
              </clipPath>
            </defs>
            <g clipPath={`url(#${ids}clip)`}>
              <g className="ld-camera" style={{ transform: camera }}>
                {/* the instrument: limb, ticks, degrees, rings, spokes */}
                <g aria-hidden="true">
                  <circle cx={C} cy={C} r={R.limb} className="ld-ring" />
                  <circle cx={C} cy={C} r={R.limbIn} className="ld-ring" />
                  <circle cx={C} cy={C} r={R.sector} className="ld-ring-faint" />
                  <circle cx={C} cy={C} r={R.hub} className="ld-ring" />
                  {ticks.map((t, i) => (
                    <line
                      key={i}
                      x1={t.x1}
                      y1={t.y1}
                      x2={t.x2}
                      y2={t.y2}
                      className={t.major ? "ld-tick ld-tick-major" : "ld-tick"}
                    />
                  ))}
                  {Array.from({ length: 12 }, (_, i) => {
                    const [x, y] = polar((i * 30 * Math.PI) / 180, R.limb + 12);
                    return (
                      <text key={i} x={x} y={y + 3} className="ld-deg">
                        {String(i * 30).padStart(3, "0")}
                      </text>
                    );
                  })}
                  {chart.sectors.map((s) => (
                    <line
                      key={s.id}
                      x1={s.spoke[0]}
                      y1={s.spoke[1]}
                      x2={s.spoke[2]}
                      y2={s.spoke[3]}
                      className="ld-spoke"
                    />
                  ))}
                  {chart.figures.map((points, i) => (
                    <polyline key={i} points={points} className="ld-figure" />
                  ))}
                </g>

                {/* every agency -> company flow, faintly */}
                <g>
                  {chart.arcs.map((a) => {
                    const on = arcOn(a.source, a.target, a.key, false);
                    const note = (
                      <>
                        <strong>
                          {label(a.source)} → {label(a.target)}
                        </strong>
                        <span className="ex-tip-row">
                          <span className="money">{moneyRound(a.dollars)}</span>
                          <span>
                            {plural(a.awards, "award")} · {w.label}
                          </span>
                        </span>
                        <span className="ex-tip-hint">Click to see its records in the graph</span>
                      </>
                    );
                    return (
                      <Link
                        key={a.key}
                        href={`/graph?view=constellation&focus=${encodeURIComponent(a.target)}`}
                        tabIndex={-1}
                        aria-label={`${label(a.source)} to ${label(a.target)}: ${moneyRound(a.dollars)} across ${plural(a.awards, "award")}`}
                        className={`ld-arc ${a.lead ? "ld-arc-lead" : ""} ${on ? "" : "ld-off"} ${hot && on && !hot.live ? "ld-arc-lit" : ""}`}
                        onPointerEnter={() => setHover({ key: a.key, ends: [a.source, a.target] })}
                        onPointerMove={(e) => show(e, note)}
                        onPointerLeave={leave}
                      >
                        <path d={a.d} className="ld-arc-hit" />
                        <path d={a.d} className="ld-arc-line" />
                      </Link>
                    );
                  })}
                </g>

                {/* the newest awards: one copper arc each, inking in on arrival */}
                <g>
                  {live.map((l, i) => {
                    const key = `live:${l.award.id}`;
                    const on = arcOn(l.source, l.target, key, true);
                    const inner = (
                      <>
                        <path d={l.d} className="ld-arc-hit" />
                        <path
                          d={l.d}
                          pathLength={1}
                          className="ld-live-line"
                          style={{ animationDelay: `${(0.3 + i * 0.22).toFixed(2)}s` }}
                        />
                      </>
                    );
                    const props = {
                      className: `ld-live ${on ? "" : "ld-off"} ${hot?.key === key ? "ld-live-hot" : ""}`,
                      "aria-label": `Award: ${awardText(l.award)}. Opens the source record.`,
                      onPointerEnter: () => setHover({ key, ends: [l.source, l.target] }),
                      onPointerMove: (e: React.PointerEvent) => show(e, awardNote(l.award)),
                      onPointerLeave: leave,
                      onFocus: () => setHover({ key, ends: [l.source, l.target] }),
                      onBlur: leave,
                    };
                    return l.award.url ? (
                      <a key={l.award.id} href={l.award.url} target="_blank" rel="noreferrer" {...props}>
                        {inner}
                      </a>
                    ) : (
                      <g key={l.award.id} {...props}>
                        {inner}
                      </g>
                    );
                  })}
                </g>

                {/* companies */}
                <g>
                  {chart.stars.map((s) => (
                    <Link
                      key={s.id}
                      href={`/graph?view=constellation&focus=${encodeURIComponent(s.id)}`}
                      tabIndex={s.rank < 4 ? 0 : -1}
                      aria-label={`${who.get(s.id)?.full ?? s.label}: ${moneyRound(s.dollars)} across ${plural(s.awards, "award")}. Opens its constellation.`}
                      className={`ld-starlink ${starOn(s.id, s.sector) ? "" : "ld-off"}`}
                      onPointerEnter={() => setHover({ companies: new Set([s.id]) })}
                      onPointerMove={(e) =>
                        show(
                          e,
                          <>
                            <strong>{who.get(s.id)?.full ?? s.label}</strong>
                            <span className="ex-tip-row">
                              <span className="money">{moneyRound(s.dollars)}</span>
                              <span>
                                {plural(s.awards, "award")} · {missionLabel(s.sector.slice(4))}
                              </span>
                            </span>
                            <span className="ex-tip-hint">Click to open its constellation</span>
                          </>,
                        )
                      }
                      onPointerLeave={leave}
                    >
                      <circle cx={s.x} cy={s.y} r={Math.max(7, s.r + 3)} className="ld-hit" />
                      <circle cx={s.x} cy={s.y} r={s.r} className="ld-starmark" />
                    </Link>
                  ))}
                  {chart.named.map((s, i) => (
                    <g key={s.id} className={starOn(s.id, s.sector) ? "" : "ld-off"} pointerEvents="none">
                      <path
                        d={`M${s.x - s.r - 8} ${s.y}H${s.x + s.r + 8}M${s.x} ${s.y - s.r - 8}V${s.y + s.r + 8}`}
                        className="ld-spike"
                      />
                      {i === 0 && <circle cx={s.x} cy={s.y} r={s.r + 7} className="ld-lead-ring" />}
                      <text x={s.lx} y={s.ly} textAnchor={s.anchor} className="ld-named ld-halo">
                        {s.label.length > 24 ? `${s.label.slice(0, 23)}…` : s.label}
                      </text>
                    </g>
                  ))}
                </g>

                {/* agencies on the limb, their names set along it */}
                <g>
                  {chart.agencies.map((a, i) => (
                    <Link
                      key={a.id}
                      href={`/graph?view=flow&focus=${encodeURIComponent(a.id)}`}
                      aria-label={`${who.get(a.id)?.full ?? a.label}: paid ${moneyRound(a.dollars)}, ${pct(a.dollars, model.total)} of dollars. Opens the flow with it selected.`}
                      className={`ld-agency ${!hot || hot.live || hot.agencies?.has(a.id) || hot.ends?.[0] === a.id ? "" : "ld-off"}`}
                      onPointerEnter={() => setHover({ agencies: new Set([a.id]) })}
                      onPointerMove={(e) =>
                        show(
                          e,
                          <>
                            <strong>{who.get(a.id)?.full ?? a.label}</strong>
                            <span className="ex-tip-row">
                              <span className="money">{moneyRound(a.dollars)}</span>
                              <span>
                                {pct(a.dollars, model.total)} of dollars · {plural(a.awards, "award")}
                              </span>
                            </span>
                            <span className="ex-tip-hint">Click to select it in the flow</span>
                          </>,
                        )
                      }
                      onPointerLeave={leave}
                    >
                      <circle cx={a.x} cy={a.y} r={14} className="ld-hit" />
                      <circle cx={a.x} cy={a.y} r={8} className="ld-agency-ring" />
                      <circle cx={a.x} cy={a.y} r={3.6} className={a.lead ? "ld-agency-core" : "ld-agency-open"} />
                      <path id={`${ids}a${i}`} d={a.labelPath} fill="none" />
                      <text className="ld-agencylabel">
                        <textPath
                          href={`#${ids}a${i}`}
                          startOffset={Math.cos(a.angle + 0.3) < -0.15 ? "100%" : "0%"}
                          textAnchor={Math.cos(a.angle + 0.3) < -0.15 ? "end" : "start"}
                        >
                          {a.label}
                        </textPath>
                      </text>
                    </Link>
                  ))}
                </g>

                {/* mission names along their sectors */}
                <g className={hot ? "ld-sectorlabels ld-sectorlabels-quiet" : "ld-sectorlabels"}>
                  {chart.sectors.map((s, i) =>
                    s.labelPath ? (
                      <g key={s.id}>
                        <path id={`${ids}s${i}`} d={s.labelPath} fill="none" />
                        <text className={`ld-sectorlabel ld-halo ${hot?.sector === s.id ? "ld-sectorlabel-on" : ""}`}>
                          <textPath href={`#${ids}s${i}`} startOffset="50%" textAnchor="middle">
                            {s.label}
                          </textPath>
                        </text>
                      </g>
                    ) : (
                      <line
                        key={s.id}
                        x1={s.spoke[0]}
                        y1={s.spoke[1]}
                        x2={s.spoke[2]}
                        y2={s.spoke[3]}
                        className="ld-spoke"
                      >
                        <title>{`${s.label}: ${plural(s.companies, "company", "companies")}`}</title>
                      </line>
                    ),
                  )}
                </g>

                {/* the hub: the headline's number, on a hatched disk and a compass rose */}
                <g aria-hidden="true">
                  <circle cx={C} cy={C} r={R.disk} style={{ fill: `url(#${hatch})` }} />
                  <circle cx={C} cy={C} r={R.disk} className="ld-ring-faint" />
                  <polygon
                    points={Array.from({ length: 16 }, (_, i) =>
                      polar((i * Math.PI) / 8, i % 4 === 0 ? 66 : i % 2 === 0 ? 52 : 26).join(","),
                    ).join(" ")}
                    className="ld-rose"
                  />
                  <circle cx={C} cy={C} r={R.core} className="ld-core" />
                  <text x={C} y={C + 10} className="ld-big">
                    {head
                      ? model.agencies.size <= 3
                        ? "100%"
                        : `${Math.min(99, Math.round(head.share * 100))}%`
                      : "—"}
                  </text>
                  <text x={C} y={C + 28} className="ld-cap">
                    {spell(Math.min(3, model.agencies.size))} {model.agencies.size === 1 ? "agency" : "agencies"}
                  </text>
                </g>
              </g>
            </g>
          </svg>

          {tip}
        </div>

        <div className="ld-side">
          <p className="ld-eyebrow">The chart · {w.label}</p>
          <h2 className="ld-h2">Every arc is an agency paying a company.</h2>
          {touring && cur ? (
            <div className="ld-tour" role="group" aria-label="Narrated tour">
              <p ref={caption} tabIndex={-1} aria-live="polite" className="ld-tour-text">
                {cur.text}
              </p>
              <p className="ld-tour-nav">
                <span className="ld-tour-count">
                  {step! + 1} / {steps.length}
                </span>
                <button type="button" onClick={() => go(step! - 1)} disabled={step === 0}>
                  Back
                </button>
                <button type="button" onClick={() => go(step! + 1)} disabled={step === steps.length - 1}>
                  Next
                </button>
                {motion && step! < steps.length - 1 && (
                  <button type="button" onClick={() => setPlaying((p) => !p)} aria-pressed={playing}>
                    {playing ? "Pause" : "Play"}
                  </button>
                )}
                <button type="button" onClick={stop}>
                  End
                </button>
              </p>
            </div>
          ) : (
            <p className="ld-body">
              The {spell(model.agencies.size)} paying agencies sit on the outer ring, the missions are its sectors, and
              every company is a star in the sector it is paid most for. The copper arcs are the newest awards on
              record: hover one to read it, click it to open the contract.
            </p>
          )}
          <p className="ld-actions">
            <button
              type="button"
              className="ld-btn ld-btn-primary"
              onClick={touring ? stop : start}
              aria-expanded={touring}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
                {touring ? (
                  <path d="M6 6h12v12H6z" fill="currentColor" />
                ) : (
                  <path d="M7 4l13 8-13 8z" fill="currentColor" />
                )}
              </svg>
              {touring ? "End the tour" : "Play the narrated tour"}
            </button>
            <Link href="/graph" className="ld-btn">
              Open the graph
            </Link>
          </p>
          <dl className="ld-stats">
            <div>
              <dt>Entities</dt>
              <dd>
                <Link href="/graph" title="Counted from the window's award records: open them in the graph">
                  {entities.toLocaleString("en-US")}
                </Link>
              </dd>
            </div>
            <div>
              <dt>Missions</dt>
              <dd>
                <Link href="/graph" title="Counted from the window's award records: open them in the graph">
                  {model.missions.size}
                </Link>
              </dd>
            </div>
            <div>
              <dt>Paying agencies</dt>
              <dd>
                <Link href="/graph" title="Counted from the window's award records: open them in the graph">
                  {model.agencies.size}
                </Link>
              </dd>
            </div>
          </dl>
        </div>
      </section>

      {/* The feed: the newest awards, each a link to its record. It scrolls by
          hand; it does not crawl. */}
      <section className="ld-feed" aria-label="Newest awards on record">
        <h2 className="ld-feed-head">
          Latest
          <span>through {day(w.latest_data_date, true)}</span>
        </h2>
        <ul className="ld-feed-row" tabIndex={0} aria-label="Newest awards, newest first; scroll sideways for more">
          {live.map((l, i) => {
            const a = l.award;
            const key = `live:${a.id}`;
            const body = (
              <>
                <span aria-hidden="true" className="ld-dot">
                  ●
                </span>
                <span className="ld-feed-who">
                  {label(a.agency)} → {label(a.company)}
                </span>
                <span className="ld-feed-what">{missionLabel(a.missions[0])}</span>
                <span className="ld-feed-amt">{moneyRound(a.amount)}</span>
                <span className="ld-feed-what">{day(a.day, true)}</span>
              </>
            );
            return (
              <li
                key={a.id}
                style={{ animationDelay: `${(0.2 + i * 0.08).toFixed(2)}s` }}
                onPointerEnter={() => setHover({ key, ends: [l.source, l.target] })}
                onPointerLeave={() => setHover(null)}
              >
                {a.url ? (
                  <a
                    href={a.url}
                    target="_blank"
                    rel="noreferrer"
                    title={`${dollars(a.amount)} · open the source record`}
                    onFocus={() => setHover({ key, ends: [l.source, l.target] })}
                    onBlur={() => setHover(null)}
                  >
                    {body}
                  </a>
                ) : (
                  <span>{body}</span>
                )}
              </li>
            );
          })}
          {data.solicitations
            .filter((s) => s.open)
            .slice(-4)
            .reverse()
            .map((s) => {
              const body = (
                <>
                  <span aria-hidden="true" className="ld-sol">
                    ◇
                  </span>
                  <span className="ld-feed-who">{label(s.agency)} · solicitation opened</span>
                  <span className="ld-feed-what">{s.missions[0] ? missionLabel(s.missions[0]) : s.title}</span>
                  {s.closes && <span className="ld-feed-amt">closes {day(s.closes, true)}</span>}
                </>
              );
              return <li key={s.id}>{s.url ? <a href={s.url}>{body}</a> : <span>{body}</span>}</li>;
            })}
        </ul>
      </section>
    </>
  );
}
