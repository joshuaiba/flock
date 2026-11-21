"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clientGet } from "@/lib/api";
import { day, moneyRound, spell } from "@/lib/format";
import {
  awardsOf,
  buildModel,
  byDollars,
  filterAwards,
  headline,
  isMission,
  missionLabel,
  names,
  NO_FILTERS,
  parseWindowKey,
  span,
  windowPhrase,
  type Filters,
  type Flows,
  type WindowKey,
} from "@/lib/flows";
import { Empty } from "../Empty";
import { ConstellationView } from "./ConstellationView";
import { FilterRail, MINIMUMS } from "./FilterRail";
import { WINDOW_KEYS, WINDOW_NAMES } from "@/lib/flows";
import { FlowView, type Fresh } from "./FlowView";
import { Inspector } from "./Inspector";
import { useLastVisit } from "./parts";
import { ConstellationFan } from "./variants/ConstellationFan";
import { FlowBundled } from "./variants/FlowBundled";
import { FlowChord } from "./variants/FlowChord";
import { Timeline, type Brush } from "./Timeline";
import "./explorer.css";

// The graph explorer: the whole /graph screen. One answer from the API (the
// window's awards and who they connect, lib/flows.ts) drawn three ways:
//
//   Flow           who pays whom, how much: the default
//   Constellation  what one company or agency is connected to
//   Timeline       what changed and when
//
// A filter rail on the left, the inspector on the right, and under the first
// two views a timeline strip whose brush narrows everything. The window, the
// view, the selection and every filter live in the address, so any state can
// be linked to. Nothing here animates on its own: bands and edges ink in once
// when data arrives, and after that the page moves only when the reader does.

export type View = "flow" | "constellation" | "timeline";
const VIEWS: { key: View; label: string }[] = [
  { key: "flow", label: "Flow" },
  { key: "constellation", label: "Constellation" },
  { key: "timeline", label: "Timeline" },
];
const isView = (v: string | null): v is View => v === "flow" || v === "constellation" || v === "timeline";

type UrlState = { view: View; focus: string | null; hops: 1 | 2; filters: Filters; fresh: boolean; viz: string | null };

function readUrl(search: string): UrlState {
  const q = new URLSearchParams(search);
  const focus = q.get("focus");
  const view = q.get("view");
  const missions = q.get("mission");
  const min = Number(q.get("min"));
  const iso = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const from = iso(q.get("from"));
  const to = iso(q.get("to"));
  return {
    // A link that names an entity and no view wants its neighborhood.
    view: isView(view) ? view : focus && !isMission(focus) ? "constellation" : "flow",
    focus: focus || null,
    hops: q.get("hops") === "1" ? 1 : 2,
    fresh: q.get("new") === "1",
    // Chart variants under comparison: ?viz=sankey|chord|bundled for the flow,
    // ?viz=rings|fan for the constellation.
    viz: q.get("viz"),
    filters: {
      ...NO_FILTERS,
      missions: missions ? new Set(missions.split(",").filter(Boolean)) : null,
      agency: q.get("agency") || null,
      min: MINIMUMS.some((m) => m.value === min) ? min : 0,
      from: from && to ? from : null,
      to: from && to ? to : null,
    },
  };
}

function writeUrl(key: WindowKey, s: UrlState): void {
  const q = new URLSearchParams(window.location.search);
  const put = (name: string, value: string | null) => (value ? q.set(name, value) : q.delete(name));
  put("window", key);
  put("view", s.view === "flow" ? null : s.view);
  put("focus", s.focus);
  put("hops", s.view === "constellation" && s.hops === 1 ? "1" : null);
  put("mission", s.filters.missions ? [...s.filters.missions].join(",") : null);
  put("agency", s.filters.agency);
  put("min", s.filters.min ? String(s.filters.min) : null);
  put("from", s.filters.from);
  put("to", s.filters.to);
  put("new", s.fresh ? "1" : null);
  const next = `?${q.toString()}`;
  if (next !== window.location.search) window.history.replaceState(null, "", next);
}

export function Explorer({ initial, search }: { initial: Flows | null; search: string }) {
  const [data, setData] = useState<Flows | null>(initial);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [gen, setGen] = useState(0);
  // The address as the server saw it, so the first render here matches its HTML.
  const [state, setState] = useState<UrlState>(() => readUrl(search));
  const ready = useRef(false);
  const { view, focus, hops, filters } = state;
  const patch = useCallback((p: Partial<UrlState>) => setState((s) => ({ ...s, ...p })), []);
  const setFilters = useCallback(
    (p: Partial<Filters>) => setState((s) => ({ ...s, filters: { ...s.filters, ...p } })),
    [],
  );

  useEffect(() => {
    ready.current = true;
  }, []);
  // Keep the address in step with the state, the window included: the default
  // window is written out, so a copied link opens on the same days.
  useEffect(() => {
    if (ready.current && data) writeUrl(data.window.key, state);
  }, [state, data]);

  const loadWindow = useCallback(
    (key: WindowKey) => {
      if (!data || key === data.window.key) return;
      const ctl = new AbortController();
      setPending(true);
      setFailed(false);
      clientGet<Flows>(`flows?window=${key}`, ctl.signal)
        .then((next) => {
          setData(next);
          setGen((g) => g + 1);
          // The brush named days of the old window.
          setFilters({ from: null, to: null });
        })
        .catch(() => setFailed(true))
        .finally(() => setPending(false));
    },
    [data, setFilters],
  );
  // The API was not answering when the page was rendered: ask again from here.
  useEffect(() => {
    if (initial) return;
    const key = parseWindowKey(new URLSearchParams(window.location.search).get("window"));
    clientGet<Flows>(key ? `flows?window=${key}` : "flows")
      .then(setData)
      .catch(() => setFailed(true));
  }, [initial]);

  const who = useMemo(() => (data ? names(data) : new Map()), [data]);
  const order = useMemo(() => {
    const m = new Map<string, number>();
    if (!data) return m;
    data.agencies.forEach((a, i) => m.set(a.id, i));
    data.companies.forEach((c, i) => m.set(c.id, i));
    [...data.missions].sort(byDollars).forEach((x, i) => m.set(x.id, i));
    return m;
  }, [data]);

  const last = useLastVisit(data?.max_award_id);
  const freshSets = useMemo(() => {
    if (!data || !last) return null;
    const awards = new Set(data.awards.filter((a) => a.id > last.maxAwardId).map((a) => a.id));
    const companies = new Set(data.companies.filter((c) => (c.first_award_id ?? 0) > last.maxAwardId).map((c) => c.id));
    return { awards, companies };
  }, [data, last]);
  const fresh: Fresh = state.fresh && freshSets ? freshSets : null;

  // The window's awards under every filter but the brush (what the timeline
  // draws), and under the brush too (what everything else counts).
  const unbrushed = useMemo(
    () => (data ? filterAwards(data.awards, { ...filters, from: null, to: null }) : []),
    [data, filters],
  );
  const inView = useMemo(
    () => filterAwards(unbrushed, { ...NO_FILTERS, from: filters.from, to: filters.to }),
    [unbrushed, filters.from, filters.to],
  );
  const model = useMemo(() => buildModel(inView, filters.missions), [inView, filters.missions]);
  const counts = useMemo(() => {
    const m = new Map<string, Set<string>>();
    if (!data) return new Map<string, number>();
    for (const a of filterAwards(data.awards, { ...filters, missions: null }))
      for (const s of a.missions) (m.get(s) ?? m.set(s, new Set()).get(s)!).add(a.company);
    return new Map([...m].map(([k, v]) => [k, v.size]));
  }, [data, filters]);

  if (!data) {
    return failed ? (
      <Empty title="The map is quiet">The data service is not answering. Try again in a moment.</Empty>
    ) : (
      <div className="ex-wrap">
        <div className="skeleton ex-skeleton" aria-hidden="true" />
      </div>
    );
  }

  const w = data.window;
  const brush: Brush = filters.from && filters.to ? { from: filters.from, to: filters.to } : null;
  const selected = focus && (who.has(focus) || focus.includes(">")) ? focus : null;
  const isParty = (id: string | null): id is string =>
    !!id && !id.includes(">") && !isMission(id) && (model.companies.has(id) || model.agencies.has(id));
  // The constellation needs a company or an agency at its center: the
  // selection if it is one, else the largest recipient in view.
  const center = isParty(selected) ? selected : ([...model.companies.values()].sort(byDollars)[0]?.id ?? null);
  const select = (id: string | null) => patch({ focus: id });
  const days = span(w, data.awards);
  const marked = selected
    ? new Set(awardsOf(buildModel(unbrushed, filters.missions), selected).map((a) => a.id))
    : null;

  const h = headline(model, who);
  const when = brush ? `between ${day(brush.from, true)} and ${day(brush.to, true)}` : windowPhrase(w);
  const centerTally = center ? (model.companies.get(center) ?? model.agencies.get(center)) : null;
  const centerNamed = center ? who.get(center) : null;
  const partners = center ? [...model.ac.values()].filter((l) => l.source === center || l.target === center).length : 0;
  const centerMissions = center
    ? [...model.mc.values()]
        .filter((l) => l.target === center)
        .sort(byDollars)
        .map((l) => missionLabel(l.source.slice(4)))
    : [];
  const sentence =
    view === "constellation" && centerTally && centerNamed
      ? centerNamed.kind === "company"
        ? `${centerNamed.label} received ${moneyRound(centerTally.dollars)} from ${spell(partners)} ${partners === 1 ? "agency" : "agencies"} ${when}.`
        : `${centerNamed.label} paid ${moneyRound(centerTally.dollars)} to ${spell(partners)} ${partners === 1 ? "company" : "companies"} ${when}.`
      : h
        ? `${h.claim} ${when}.`
        : null;

  const reset = () => patch({ filters: NO_FILTERS });
  const freshCount = freshSets?.awards.size ?? 0;

  return (
    <div className="ex-wrap">
      <div className="ex-head">
        <div className="min-w-0">
          {view === "constellation" && centerNamed && (
            <nav aria-label="Breadcrumb" className="ex-crumbs">
              <button type="button" onClick={() => patch({ view: "flow" })}>
                Graph
              </button>
              <span aria-hidden="true">/</span>
              <span>{centerNamed.kind === "company" ? "Companies" : "Agencies"}</span>
              <span aria-hidden="true">/</span>
              <span aria-current="page">{centerNamed.label}</span>
            </nav>
          )}
          <h1 className="ex-headline">
            {sentence ??
              (data.awards.length ? "No awards match these filters." : "No autonomy awards are on record yet.")}
          </h1>
          {view !== "constellation" && h?.leaders && <p className="ex-leaders">{h.leaders}</p>}
        </div>
        <div className="ex-switches">
          {view === "constellation" && (
            <div className="ex-seg" role="group" aria-label={`Window: ${w.label}`}>
              {WINDOW_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={w.key === key}
                  disabled={!data.windows.find((x) => x.key === key)?.awards}
                  onClick={() => loadWindow(key)}
                >
                  {WINDOW_NAMES[key]}
                </button>
              ))}
            </div>
          )}
          {view === "constellation" && (
            <div className="ex-seg" role="group" aria-label="Depth">
              <button type="button" aria-pressed={hops === 1} onClick={() => patch({ hops: 1 })}>
                1 hop
              </button>
              <button type="button" aria-pressed={hops === 2} onClick={() => patch({ hops: 2 })}>
                2 hops
              </button>
            </div>
          )}
          <div className="ex-seg" role="group" aria-label="View">
            {VIEWS.map((v) => (
              <button key={v.key} type="button" aria-pressed={view === v.key} onClick={() => patch({ view: v.key })}>
                {v.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="ex-grid">
        {/* The constellation takes the rail's room; its window is in the head,
            and the other filters still apply (the legend says so). */}
        {view !== "constellation" && (
          <FilterRail
            data={data}
            who={who}
            filters={filters}
            counts={counts}
            shown={{ awards: inView.length, of: data.awards.length }}
            pending={pending}
            onWindow={loadWindow}
            onChange={setFilters}
            onReset={reset}
          />
        )}

        <div className={`ex-main ${pending ? "ex-pending" : ""}`}>
          {model.total > 0 ? (
            <>
              {view === "flow" && (
                <section className="ex-card" aria-label="Flow of dollars">
                  {state.viz === "chord" ? (
                    <FlowChord model={model} who={who} selected={selected} onSelect={select} />
                  ) : state.viz === "bundled" ? (
                    <FlowBundled model={model} who={who} selected={selected} onSelect={select} />
                  ) : (
                    <FlowView
                      model={model}
                      who={who}
                      order={order}
                      selected={selected}
                      onSelect={(id) => select(id && id.endsWith(">others") ? id.split(">")[0] : id)}
                      fresh={fresh}
                      gen={gen}
                      label={when}
                    />
                  )}
                  <p className="ex-legend">
                    <span>
                      <i className="ex-key ex-key-on" aria-hidden="true" />
                      Selected
                    </span>
                    <span>
                      <i className="ex-key ex-key-band" aria-hidden="true" />
                      Band width = dollars
                    </span>
                    <span>Hover a band to isolate it · click a node or a band to select it</span>
                  </p>
                </section>
              )}
              {view === "constellation" && (
                <section className="ex-card" aria-label="Constellation">
                  {state.viz === "fan" ? (
                    <ConstellationFan
                      model={model}
                      who={who}
                      center={center}
                      hops={hops}
                      onCenter={(id) => select(id)}
                    />
                  ) : (
                    <ConstellationView
                      model={model}
                      who={who}
                      center={center}
                      hops={hops}
                      onCenter={(id) => select(id)}
                      fresh={fresh}
                      gen={gen}
                      missions={centerMissions}
                    />
                  )}
                  <p className="ex-legend">
                    <span>
                      <i className="ex-key ex-key-edge" aria-hidden="true" />
                      Edge width = dollars with {centerNamed?.label ?? "the center"}
                    </span>
                    <span>
                      <i className="ex-key ex-key-thin" aria-hidden="true" />
                      {centerNamed?.kind === "company" ? "Also funded by that agency" : "Also pays that company"}
                    </span>
                    <span>Everything else is ghosted · click any node to re-center</span>
                    {inView.length < data.awards.length && (
                      <span>
                        {inView.length.toLocaleString("en-US")} of {data.awards.length.toLocaleString("en-US")} awards
                        shown
                        <button type="button" className="ex-linkish" onClick={reset}>
                          reset filters
                        </button>
                      </span>
                    )}
                  </p>
                </section>
              )}
            </>
          ) : (
            <section className="ex-card ex-empty">
              <p className="ex-empty-title">Nothing under these filters.</p>
              <p>
                {data.awards.length
                  ? `The window holds ${data.awards.length.toLocaleString("en-US")} awards (${w.label}), and none of them match.`
                  : w.latest_data_date
                    ? `No award falls in this window. The newest on record is from ${day(w.latest_data_date)}.`
                    : "No autonomy awards have been loaded yet."}
              </p>
              {data.awards.length > 0 && (
                <button type="button" className="btn btn-sm" onClick={reset}>
                  Reset the filters
                </button>
              )}
            </section>
          )}

          {days && (
            <section className="ex-card ex-card-time" aria-label="Awards over time">
              <div className="ex-time-head">
                <h2 className="ex-sec">
                  {view === "timeline" ? "Awards by mission" : "Awards over time"} · drag to filter
                  {brush && (
                    <button type="button" className="ex-linkish" onClick={() => setFilters({ from: null, to: null })}>
                      clear {day(brush.from, true)} – {day(brush.to, true)}
                    </button>
                  )}
                </h2>
                <button
                  type="button"
                  className="ex-chip"
                  aria-pressed={state.fresh}
                  disabled={!freshSets}
                  title={
                    freshSets
                      ? `Awards loaded since ${day(last!.at.slice(0, 10))}`
                      : "Nothing to compare yet: this is your first visit"
                  }
                  onClick={() => patch({ fresh: !state.fresh })}
                >
                  New since your last visit{freshSets ? ` · ${freshCount}` : ""}
                </button>
              </div>
              <Timeline
                awards={unbrushed}
                solicitations={data.solicitations}
                start={days.start}
                end={days.end}
                brush={brush}
                onBrush={(b) => setFilters({ from: b?.from ?? null, to: b?.to ?? null })}
                marked={marked}
                fresh={fresh?.awards ?? null}
                who={who}
                rows={view === "timeline" ? "missions" : "one"}
              />
              {state.fresh && freshSets && (
                <p className="ex-note" role="status">
                  {freshCount
                    ? `${freshCount.toLocaleString("en-US")} ${freshCount === 1 ? "award was" : "awards were"} loaded since ${day(last!.at.slice(0, 10), true)}, ${
                        freshSets.companies.size
                          ? `${spell(freshSets.companies.size)} to first-time ${freshSets.companies.size === 1 ? "awardee" : "awardees"}`
                          : "none to a first-time awardee"
                      }. They are drawn bright; the rest is dimmed.`
                    : `Nothing in this window was loaded since ${day(last!.at.slice(0, 10), true)}.`}
                </p>
              )}
              {data.solicitations.length > 0 && (
                <p className="ex-legend ex-legend-plain">
                  <span>
                    <span className="ex-sol-mark" aria-hidden="true">
                      ◇
                    </span>{" "}
                    Solicitation posted
                  </span>
                  <span>
                    <span className="ex-sol-mark" aria-hidden="true">
                      ◆
                    </span>{" "}
                    Answered by an award
                  </span>
                  <span>Tick height = award dollars (log scale)</span>
                </p>
              )}
            </section>
          )}
          {failed && (
            <p className="ex-note" role="alert">
              That window did not load. The one on screen is still {w.label}.
            </p>
          )}
        </div>

        <Inspector
          data={data}
          model={model}
          who={who}
          selected={view === "constellation" ? center : selected}
          onSelect={select}
          onConstellation={(id) => patch({ view: "constellation", focus: id })}
          inConstellation={view === "constellation"}
        />
      </div>

      <p className="ex-foot">
        {w.latest_data_date ? (
          <>
            Data through {day(w.latest_data_date)}. USAspending publishes Defense contracts about 90 days after they are
            signed, so every window ends on the newest award on record, not on today.{" "}
            <Link href="/about/numbers">How the numbers are counted</Link>
            {data.sample ? " · Sample data" : ""}
          </>
        ) : (
          "No awards on record."
        )}
      </p>
    </div>
  );
}
