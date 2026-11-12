"use client";

import { AnimatePresence, motion as m } from "motion/react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clientGet, type Graph, type GraphNode, type NodeKind } from "@/lib/api";
import { medallionFor } from "@/lib/art";
import { day, money } from "@/lib/format";
import { ALL_KINDS, hiddenNodes, stressGraph } from "@/lib/graphLayout";
import { useStore } from "@/lib/store";
import { tagLabel, TAGS } from "@/lib/tags";
import { MedallionImg } from "./Art";
import { Empty } from "./Empty";
import { GraphFilters, WINDOWS } from "./GraphFilters";
import { GraphFlat } from "./GraphFlat";
import { NO_API, type GraphViewApi } from "./GraphView";
import { PinButton } from "./PinButton";

// The graph explorer: the whole /graph screen. It fetches the graph, holds the
// filters, the search text and the selection, and shows them through one of
// two renderers: the 3D scene (the default) or the flat canvas (?view=flat).
// The two are views of the same filtered graph, so everything chosen here
// carries across the switch. The rail is GraphFilters.tsx, the renderers are
// Graph3D.tsx and GraphFlat.tsx, and the filter itself is one function
// (lib/graphLayout.ts hiddenNodes) used for both.

// three.js is large and needs a browser: it loads only when the 3D view is shown.
const Graph3D = dynamic(() => import("./Graph3D"), { ssr: false });

type ViewName = "3d" | "flat";
const NO_PINS: ReadonlySet<string> = new Set();
const NOTHING_HIDDEN: ReadonlySet<string> = new Set();

export function GraphExplorer() {
  const params = useSearchParams();
  const focus = params.get("focus");
  const stress = process.env.NODE_ENV !== "production" ? Number(params.get("stress")) || 0 : 0;
  const { motion, pins } = useStore();

  // The choice of view lives in the URL, so a link opens the same one.
  const [no3d, setNo3d] = useState(false); // this browser cannot draw the 3D view
  const view: ViewName = no3d || params.get("view") === "flat" ? "flat" : "3d";

  const [days, setDays] = useState(90);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [readyIn, setReadyIn] = useState<ViewName | null>(null); // which view has drawn the current graph
  const [failed, setFailed] = useState(false);
  const [tags, setTags] = useState<Set<string>>(new Set());
  const [agency, setAgency] = useState<string | null>(null);
  const [min, setMin] = useState(0);
  const [kinds, setKinds] = useState<Set<NodeKind>>(() => new Set(ALL_KINDS));
  const [watch, setWatch] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const ready = readyIn === view;

  const api = useRef<GraphViewApi>(NO_API); // the camera of whichever view is mounted
  const focused = useRef<string | null>(null);
  const widened = useRef<string | null>(null); // the focus the window was last widened for
  const seenIn = useRef<ViewName>(view); // the view the reader last saw ready

  // Data. Each view lays the graph out for itself when it arrives.
  useEffect(() => {
    let alive = true;
    const ac = new AbortController();
    setFailed(false);
    setReadyIn(null);
    (stress ? Promise.resolve(stressGraph(stress)) : clientGet<Graph>(`graph?days=${days}`, ac.signal))
      .then((g) => {
        if (!alive) return;
        // A selection that is not in the new graph would dim the whole map.
        setSelected((was) => (was && !g.nodes.some((n) => n.id === was) ? null : was));
        setGraph(g);
      })
      .catch((e) => {
        if (alive && e.name !== "AbortError") setFailed(true);
      });
    return () => {
      alive = false;
      ac.abort();
    };
  }, [days, stress]);

  // A bird clicked on the landing page lands on its node here.
  useEffect(() => {
    if (!graph || !ready || !focus || focused.current === focus) return;
    if (graph.nodes.some((n) => n.id === focus)) {
      focused.current = focus;
      setSelected(focus);
      requestAnimationFrame(() => api.current.focusOn(focus, true));
    } else if (days !== 0 && days < 365 && widened.current !== focus) {
      // older than the window: widen it once (once per focus, so a node that is
      // never found does not hold the window at a year)
      widened.current = focus;
      setDays(365);
    }
  }, [graph, ready, focus, days]);

  // After a switch of view, the new one brings the selection into view.
  useEffect(() => {
    if (!ready || seenIn.current === view) return;
    seenIn.current = view;
    if (selected) api.current.focusOn(selected, false);
  }, [ready, view, selected]);

  // ---- Filters: one function, both views ----

  const pinned = useMemo(() => new Set(pins.map((p) => `org:${p.id}`)), [pins]);
  const watched = watch ? pinned : NO_PINS;
  const hidden = useMemo(
    () => (graph ? hiddenNodes(graph, { tags, agency, min, kinds, watch }, watched) : NOTHING_HIDDEN),
    [graph, tags, agency, min, kinds, watch, watched],
  );
  const active = (tags.size ? 1 : 0) + (agency ? 1 : 0) + (min ? 1 : 0) + (kinds.size < ALL_KINDS.length ? 1 : 0) + (watch ? 1 : 0);
  const reset = () => {
    setTags(new Set());
    setAgency(null);
    setMin(0);
    setKinds(new Set(ALL_KINDS));
    setWatch(false);
  };

  // A selection the filters have hidden would dim the map around nothing.
  useEffect(() => {
    if (selected && hidden.has(selected)) setSelected(null);
  }, [selected, hidden]);

  const select = useCallback((id: string) => {
    setSelected(id);
    api.current.focusOn(id, false);
  }, []);

  const setView = (next: ViewName) => {
    if (next === view) return;
    const q = new URLSearchParams(window.location.search);
    if (next === "flat") q.set("view", "flat");
    else q.delete("view");
    const s = q.toString();
    // Next folds this into its router, so useSearchParams above follows it.
    window.history.replaceState(null, "", s ? `?${s}` : window.location.pathname);
  };

  // Derived UI
  const present = useMemo(() => {
    const s = new Set<string>();
    graph?.nodes.forEach((n) => n.tags.forEach((t) => s.add(t)));
    return [...TAGS.filter((t) => s.has(t)), ...[...s].filter((t) => !TAGS.includes(t)).sort()];
  }, [graph]);

  const agencies = useMemo(() => graph?.nodes.filter((n) => n.kind === "agency" || n.kind === "office") ?? [], [graph]);

  // A category or agency filter that the new window no longer offers is
  // dropped, or it would hide the whole map with no pressed button to show why.
  useEffect(() => {
    if (!graph) return;
    setTags((was) => {
      const next = new Set([...was].filter((t) => present.includes(t)));
      return next.size === was.size ? was : next;
    });
    setAgency((was) => (was && !graph.nodes.some((n) => n.id === was) ? null : was));
  }, [graph, present]);

  const needle = query.trim().toLowerCase();
  const hits = useMemo(() => {
    if (!needle || !graph) return [];
    return graph.nodes
      .filter((n) => !hidden.has(n.id) && n.name.toLowerCase().includes(needle))
      .sort((a, b) => b.total - a.total)
      .slice(0, 7);
  }, [graph, hidden, needle]);

  const detail = useMemo(() => {
    if (!graph || !selected) return null;
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const node = byId.get(selected);
    if (!node) return null;
    const around = new Map<string, { node: GraphNode; amount: number; kind: string }>();
    for (const e of graph.edges) {
      const other = e.source === selected ? e.target : e.target === selected ? e.source : null;
      const o = other && byId.get(other);
      if (!o || hidden.has(o.id)) continue;
      const cur = around.get(o.id) ?? { node: o, amount: 0, kind: e.kind };
      cur.amount += e.amount;
      if (e.kind === "award") cur.kind = "award";
      around.set(o.id, cur);
    }
    return { node, around: [...around.values()].sort((a, b) => b.amount - a.amount).slice(0, 5) };
  }, [graph, selected, hidden]);

  const toggleTag = (t: string) =>
    setTags((was) => {
      const next = new Set(was);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  const toggleKind = (k: NodeKind) =>
    setKinds((was) => {
      const next = new Set(was);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const ready3d = useCallback((ok: boolean) => setReadyIn(ok ? "3d" : null), []);
  const readyFlat = useCallback((ok: boolean) => setReadyIn(ok ? "flat" : null), []);
  const noWebGL = useCallback(() => setNo3d(true), []);

  const span = WINDOWS.find((w) => w.days === days)?.long ?? `${days} days`;
  const shown = graph ? graph.nodes.length - hidden.size : 0;
  const empty = ready && graph && graph.nodes.length === 0;
  const filteredOut = ready && graph && graph.nodes.length > 0 && shown === 0;
  const caps = "font-caps text-[0.66rem] uppercase tracking-[0.14em]";
  const shared = { graph, hidden, tags, selected, query: needle, ready, api, onSelect: setSelected };

  return (
    <div data-graph-root className="fixed inset-0 z-20 overflow-hidden bg-paper">
      {/* Plain parchment. A hairline frame; labels keep clear of it. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-3 rounded-sm border border-hair" />
      {view === "flat" ? (
        <GraphFlat {...shared} onReady={readyFlat} />
      ) : (
        <Graph3D {...shared} onReady={ready3d} onUnsupported={noWebGL} />
      )}

      {!ready && !failed && (
        <p className="note pointer-events-none absolute inset-0 grid place-items-center">drawing the map…</p>
      )}
      {failed && (
        <div className="absolute inset-0 grid place-items-center">
          <Empty title="The flock is out of sight">
            The data service is not answering. Start it with <code>uv run python -m pipeline.api.dev</code>.
          </Empty>
        </div>
      )}
      {empty && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <Empty title="Nothing landed in this window">Try a longer stretch of time.</Empty>
        </div>
      )}
      {filteredOut && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <Empty title="Nothing matches these filters">
            Loosen one of them, or{" "}
            <button type="button" onClick={reset} className="pointer-events-auto cursor-pointer text-cypress underline">
              clear them all
            </button>
            .
          </Empty>
        </div>
      )}

      <GraphFilters
        query={query}
        onQuery={setQuery}
        hits={hits}
        onPick={select}
        days={days}
        onDays={setDays}
        present={present}
        tags={tags}
        onToggleTag={toggleTag}
        onClearTags={() => setTags(new Set())}
        agencies={agencies}
        agency={agency}
        onAgency={setAgency}
        min={min}
        onMin={setMin}
        kinds={kinds}
        onToggleKind={toggleKind}
        watch={watch}
        onWatch={setWatch}
        pins={pins.length}
        active={active}
        onReset={reset}
      />

      {/* Legend */}
      <div className="absolute bottom-7 left-12 hidden max-w-[calc(100%-22rem)] flex-wrap items-center gap-x-5 gap-y-1 text-[0.95rem] italic text-muted md:flex">
        <span className="flex items-center gap-2">
          <MedallionImg name="column" size={22} /> agency
        </span>
        <span className="flex items-center gap-2">
          <span className="flex -space-x-1.5">
            <MedallionImg name="wing" size={22} />
            <MedallionImg name="anchor" size={22} />
            <MedallionImg name="laurel" size={22} />
          </span>
          company, by category
        </span>
        <span className="flex items-center gap-2">
          <MedallionImg name="laurel" size={14} className="opacity-60" /> solicitation
        </span>
        <span className="flex items-center gap-2">
          <span className="inline-block h-[3px] w-6 rounded-full bg-pompeii" /> dollars awarded
        </span>
      </div>

      {/* View and zoom */}
      <div className="absolute bottom-6 right-12 flex items-center gap-2">
        <div className="marble inline-flex rounded-full p-1" role="group" aria-label="Graph view">
          {(["3d", "flat"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              aria-label={v === "3d" ? "3D view" : "Flat view"}
              disabled={v === "3d" && no3d}
              title={v === "3d" && no3d ? "This browser cannot draw the 3D view" : undefined}
              onClick={() => setView(v)}
              className={`h-7 cursor-pointer rounded-full px-3 transition-colors disabled:cursor-default disabled:opacity-50 ${caps} ${
                view === v ? "bg-card text-ink shadow-[0_0_0_1px_var(--frame)]" : "text-muted hover:text-ink"
              }`}
            >
              {v === "3d" ? "3D" : "Flat"}
            </button>
          ))}
        </div>
        <div className="marble flex items-center rounded-full p-1">
          <button type="button" className="h-7 w-7 cursor-pointer rounded-full hover:bg-hair" aria-label="Zoom out" onClick={() => api.current.zoom(1 / 1.4)}>
            −
          </button>
          <button type="button" className={`h-7 cursor-pointer rounded-full px-2 hover:bg-hair ${caps}`} onClick={() => api.current.fit(true)}>
            fit
          </button>
          <button type="button" className="h-7 w-7 cursor-pointer rounded-full hover:bg-hair" aria-label="Zoom in" onClick={() => api.current.zoom(1.4)}>
            +
          </button>
        </div>
      </div>

      {/* Right panel */}
      <AnimatePresence>
        {detail && (
          <m.aside
            key={detail.node.id}
            data-obstacle
            aria-label={detail.node.name}
            initial={motion ? { opacity: 0, x: 36 } : false}
            animate={{ opacity: 1, x: 0 }}
            exit={motion ? { opacity: 0, x: 24, transition: { duration: 0.15 } } : { opacity: 0 }}
            transition={{ type: "spring", stiffness: 170, damping: 26 }}
            className="paper-card absolute inset-x-3 bottom-16 max-h-[55vh] overflow-y-auto p-6 md:inset-x-auto md:bottom-auto md:right-7 md:top-48 md:max-h-[calc(100vh-15.5rem)] md:w-[22rem]"
          >
            <div className="flex items-start gap-3">
              <MedallionImg name={medallionFor(detail.node.tag, detail.node.kind)} size={44} className="mt-0.5" />
              <div className="min-w-0">
                <p className="label">{detail.node.kind === "opportunity" ? "solicitation" : detail.node.kind}</p>
                <h2 className="mt-1 text-[1.6rem]">{detail.node.name}</h2>
              </div>
              <button type="button" onClick={() => setSelected(null)} aria-label="Close" className="-mr-1 -mt-1 ml-auto cursor-pointer p-1 text-muted hover:text-ink">
                ×
              </button>
            </div>

            {detail.node.kind === "opportunity" ? (
              <dl className="fig mt-4 grid grid-cols-2 gap-y-1">
                <dt className="text-muted">Posted</dt>
                <dd className="text-right">{day(detail.node.posted)}</dd>
                <dt className="text-muted">Closes</dt>
                <dd className="text-right">{day(detail.node.closes)}</dd>
                <dt className="text-muted">Status</dt>
                <dd className="text-right">{detail.node.open ? "Open" : "Closed"}</dd>
              </dl>
            ) : (
              <dl className="fig mt-4 grid grid-cols-2 gap-y-1">
                <dt className="text-muted">{days ? `Awarded, ${span}` : "Awarded, on record"}</dt>
                <dd className="text-right text-pompeii">{money(detail.node.total)}</dd>
                <dt className="text-muted">Awards</dt>
                <dd className="text-right">{detail.node.awards}</dd>
                {detail.node.uei && (
                  <>
                    <dt className="text-muted">UEI</dt>
                    <dd className="text-right">{detail.node.uei}</dd>
                  </>
                )}
              </dl>
            )}

            {detail.node.tags.length > 0 && (
              <p className="mt-3 italic text-muted">{detail.node.tags.map(tagLabel).join(", ")}</p>
            )}

            {detail.around.length > 0 && (
              <>
                <p className="label mt-5">Connected to</p>
                <ul className="mt-1">
                  {detail.around.map((a) => (
                    <li key={a.node.id} className="flex items-baseline gap-3 border-b border-hair py-1.5 last:border-0">
                      <button type="button" onClick={() => select(a.node.id)} className="min-w-0 flex-1 cursor-pointer truncate text-left hover:text-cypress">
                        {a.node.name}
                      </button>
                      <span className="fig shrink-0 text-muted">
                        {a.kind === "award" ? money(a.amount) : a.kind.replace("_", " ")}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            <div className="mt-5 flex flex-wrap items-center gap-2">
              {detail.node.kind === "opportunity" ? (
                detail.node.url && (
                  <a className="marble pill" href={detail.node.url} target="_blank" rel="noreferrer">
                    read the notice ↗
                  </a>
                )
              ) : (
                <>
                  <PinButton
                    entity={{
                      id: Number(detail.node.id.split(":")[1]),
                      name: detail.node.name,
                      tag: detail.node.tag,
                      kind: detail.node.kind,
                    }}
                  />
                  <Link className="marble pill" href={`/entity/${detail.node.id.split(":")[1]}`}>
                    specimen sheet →
                  </Link>
                </>
              )}
            </div>
          </m.aside>
        )}
      </AnimatePresence>
      <span className="sr-only" aria-live="polite">
        {ready && graph
          ? `${shown} of ${graph.nodes.length} entities shown, ${days ? `last ${days} days` : "everything on record"}, ${view === "3d" ? "3D" : "flat"} view`
          : "Drawing the map"}
      </span>
    </div>
  );
}
