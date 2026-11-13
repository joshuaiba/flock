"use client";

import { AnimatePresence, motion as m } from "motion/react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clientGet, type Graph, type GraphEdge, type GraphNode, type NodeKind, type Org } from "@/lib/api";
import { andList, day, moneyRound, spell, truncate } from "@/lib/format";
import { TONES } from "@/lib/art";
import { ALL_KINDS, hiddenNodes, stressGraph } from "@/lib/graphLayout";
import { nodeSpriteSrcSet, nodeSpriteUrl, type NodeSprite } from "@/lib/nodeSprites";
import { MAX_PINS, useStore, type Pin } from "@/lib/store";
import { tagLabel, TAGS } from "@/lib/tags";
import { Empty } from "./Empty";
import {
  CloseIcon,
  DEFAULT_WINDOW,
  GraphFilters,
  shortName,
  STALE_DAYS,
  windowOf,
  windowPhrase,
  WINDOWS,
  type Window,
  type WindowKey,
} from "./GraphFilters";
import { GraphFlat } from "./GraphFlat";
import { NO_API, type GraphViewApi } from "./GraphView";

// The graph explorer: the whole /graph screen. It fetches the graph, holds the
// filters, the search text and the selection, and shows them through one of
// two renderers: the flat canvas (the default) or the 3D scene (?view=3d).
// The two are views of the same filtered graph, so everything chosen here
// carries across the switch, and the reader's last choice is remembered for
// the next visit. The rail is GraphFilters.tsx, the renderers are Graph3D.tsx
// and GraphFlat.tsx, and the filter itself is one function (lib/graphLayout.ts
// hiddenNodes) used for both. Over the map, top left, one line in the reading
// serif says what the map in view shows (the takeaway); the view and zoom
// controls sit in the map's own bottom-left corner, just right of the rail,
// and follow it when the rail folds; the legend sits bottom-right, and the
// selected entity's card top-right. Nothing here is decorated: no art sits
// behind the map, and the only color is the accent on dollars awarded. Looks:
// graph-rail.css.

// three.js is large and needs a browser: it loads only when the 3D view is shown.
const Graph3D = dynamic(() => import("./Graph3D"), { ssr: false });

type ViewName = "3d" | "flat";
const NO_PINS: ReadonlySet<string> = new Set();
const NO_TAGS: ReadonlySet<string> = new Set();
const EVERY_KIND: ReadonlySet<NodeKind> = new Set(ALL_KINDS);
const NOTHING_HIDDEN: ReadonlySet<string> = new Set();

const KIND_NAME: Record<NodeKind, string> = {
  company: "Company",
  agency: "Agency",
  office: "Office",
  opportunity: "Solicitation",
};

/** A small preference of this screen, kept in localStorage. */
function recallText(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // a private window: the preference just does not persist
  }
}
function remember(key: string, value: boolean | string): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* as above */
  }
}
function recall(key: string): boolean | null {
  const raw = recallText(key);
  return raw === null ? null : raw === "true";
}

/** The reader's last choice of view. A link that names one (?view=3d or
 *  ?view=flat) wins over it; without either, the map opens flat. */
const VIEW_KEY = "flock.graph.view";
function recallView(): ViewName | null {
  const raw = recallText(VIEW_KEY);
  return raw === "3d" || raw === "flat" ? raw : null;
}
/** Put the view in the address, so a copied link opens the same one. Flat is
 *  the default and needs no parameter. */
function writeView(view: ViewName): void {
  const q = new URLSearchParams(window.location.search);
  if (view === "3d") q.set("view", "3d");
  else q.delete("view");
  const s = q.toString();
  // Next folds this into its router, so useSearchParams follows it.
  window.history.replaceState(null, "", s ? `?${s}` : window.location.pathname);
}

/** Tell the mounted view that the rail or the legend changed shape, so names
 *  on the map keep clear of where they are now. */
function chromeMoved(): void {
  window.dispatchEvent(new Event("graph:chrome"));
}

/** The four marks of the map, drawn as the canvases draw them. */
/** One node sprite as a legend icon. Both tones are in the markup and the
 *  mode shows one (see .graph-legend-sprite in graph-rail.css), the way
 *  components/Art.tsx does it, so a theme change never flashes; the hidden
 *  tone is never fetched, because both load lazily. */
function LegendSprite({ name }: { name: NodeSprite }) {
  return (
    <>
      {TONES.map((tone) => (
        <img
          key={tone}
          src={nodeSpriteUrl(name, tone, 64)}
          srcSet={nodeSpriteSrcSet(name, tone)}
          sizes="18px"
          width={18}
          height={18}
          alt=""
          className={`art-${tone}`}
          loading="lazy"
          decoding="async"
          draggable={false}
        />
      ))}
    </>
  );
}

/** The legend's picture of each kind of mark, drawn the way the map draws it:
 *  a silver coin for a company (a text-colored disc with the coin's lines in
 *  the opposite tone on top), the laurel wreath for an agency, the open tablet
 *  for a solicitation, and the accent line for dollars awarded. */
function Mark({ kind }: { kind: "company" | "org" | "opportunity" | "award" }) {
  if (kind === "award") return <span className="block h-[2px] w-[16px] rounded-full bg-accent" />;
  if (kind === "company")
    return (
      <span className="graph-legend-coin graph-legend-sprite">
        <LegendSprite name="coin-aerial" />
      </span>
    );
  return (
    <span className="graph-legend-sprite">
      <LegendSprite name={kind === "org" ? "wreath-laurel" : "tablet-open"} />
    </span>
  );
}

/** What the marks on the map mean. It lives in the map's corner, never under
 *  the rail, and folds to a button. */
function Legend({ open, onOpen }: { open: boolean; onOpen: (open: boolean) => void }) {
  // Folding replaces the button that was pressed: the keyboard's place moves
  // to the one that takes its place.
  const button = useRef<HTMLButtonElement>(null);
  const pressed = useRef(false);
  useEffect(() => {
    if (pressed.current) button.current?.focus();
    pressed.current = false;
  }, [open]);
  const toggle = () => {
    pressed.current = true;
    onOpen(!open);
  };
  if (!open)
    return (
      <div className="graph-legend">
        <button ref={button} type="button" className="btn btn-sm graph-float" aria-expanded={false} onClick={toggle}>
          Legend
        </button>
      </div>
    );
  return (
    <div className="graph-legend" data-obstacle>
      <section className="graph-legend-panel" aria-label="Legend">
        <span className="graph-legend-head">Legend</span>
        <ul>
          <li>
            <span className="graph-legend-key">
              <Mark kind="company" />
            </span>
            Company, sized by dollars
          </li>
          <li>
            <span className="graph-legend-key">
              <Mark kind="org" />
            </span>
            Agency, sized by dollars
          </li>
          <li>
            <span className="graph-legend-key">
              <Mark kind="opportunity" />
            </span>
            Solicitation
          </li>
          <li>
            <span className="graph-legend-key">
              <Mark kind="award" />
            </span>
            Dollars awarded
          </li>
        </ul>
        <button ref={button} type="button" className="graph-icon-btn" aria-label="Hide the legend" aria-expanded={true} onClick={toggle}>
          <CloseIcon size={12} />
        </button>
      </section>
    </div>
  );
}

// ---- The takeaway: one line over the map that says what it shows ----

const isOrg = (n: GraphNode) => n.kind === "agency" || n.kind === "office";

/** The agency an office answers to, at the top of its part_of chain, if the
 *  graph has it and the filters show it: the takeaway names agencies, so an
 *  office's dollars count for the department it is part of. */
function topAgencies(graph: Graph, hidden: ReadonlySet<string>): Map<string, string> {
  const parent = new Map<string, string>();
  for (const e of graph.edges) if (e.kind === "part_of") parent.set(e.source, e.target);
  const top = new Map<string, string>();
  for (const id of parent.keys()) {
    let at = id;
    // a cycle in the data cannot hang the walk
    for (let step = 0; step < 8 && parent.has(at) && !hidden.has(parent.get(at)!); step++) at = parent.get(at)!;
    if (at !== id) top.set(id, at);
  }
  return top;
}

/** The window as the end of a sentence about the whole map: "in the last 90
 *  days", "in the last year", "on record". Recent ends on the newest award,
 *  so once that is stale it says where it ends instead of "last". */
function lastPhrase(w: Window, latest: string | null, age: number | null): string {
  if (!w.days) return "on record";
  if (w.recent && latest && age != null && age > STALE_DAYS) {
    const thisYear = Number(latest.slice(0, 4)) === new Date().getFullYear();
    return `in the ${w.days} days to ${day(latest, thisYear)}`;
  }
  return w.days === 365 ? "in the last year" : `in the last ${w.days} days`;
}

/** The window after one entity's figure: "in 90 days", "in the last year". */
function inPhrase(w: Window): string {
  if (!w.days) return "on record";
  return w.days === 365 ? "in the last year" : `in ${w.days} days`;
}

/** What the map in view says, in a sentence or two: which agencies paid most
 *  of the dollars on it (an office's awards count for its department) and
 *  which companies lead. Only award edges with both ends
 *  shown count, so the line follows every filter. Null when there are no
 *  dollars in view to speak of. */
function summary(graph: Graph, hidden: ReadonlySet<string>, w: Window, latest: string | null, age: number | null): string | null {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const up = topAgencies(graph, hidden);
  const paid = new Map<GraphNode, number>(); // agency (offices folded in): dollars paid
  const got = new Map<GraphNode, number>(); // company: dollars received
  let all = 0;
  for (const e of graph.edges) {
    if (e.kind !== "award" || !(e.amount > 0) || hidden.has(e.source) || hidden.has(e.target)) continue;
    const a = byId.get(e.source);
    const b = byId.get(e.target);
    if (!a || !b) continue;
    const [office, payee] = isOrg(a) ? [a, b] : [b, a];
    const payer = byId.get(up.get(office.id) ?? office.id) ?? office;
    paid.set(payer, (paid.get(payer) ?? 0) + e.amount);
    got.set(payee, (got.get(payee) ?? 0) + e.amount);
    all += e.amount;
  }
  if (!all) return null;
  const rank = (m: Map<GraphNode, number>) => [...m].sort((x, y) => y[1] - x[1]);
  const payers = rank(paid);
  const companies = rank(got);
  const when = lastPhrase(w, latest, age);

  let first: string;
  if (payers.length === 1) {
    // one buyer on the map: its sum says more than "all of it"
    first = `${shortName(payers[0][0])} paid ${moneyRound(all)} ${when}.`;
  } else if (payers.length <= 3) {
    // every buyer on the map is named, so the share would always be 100%
    first = `${andList(payers.map(([n]) => shortName(n)))} paid all ${moneyRound(all)} ${when}.`;
  } else {
    const top = payers.slice(0, 3);
    const share = top.reduce((sum, [, v]) => sum + v, 0) / all;
    // never "100%" while others paid something
    const pct = Math.min(99, Math.round(share * 100));
    first = `${andList(top.map(([n]) => shortName(n)))} paid ${pct}% of autonomy dollars ${when}.`;
  }
  const leaders = companies.slice(0, 2).map(([n]) => shortName(n));
  const second = leaders.length === 2 ? ` ${andList(leaders)} lead.` : leaders.length === 1 ? ` ${leaders[0]} leads.` : "";
  return first + second;
}

/** The takeaway for one selected entity: its figure for the window and who
 *  is on the other end of it. Counted over the whole graph, as the side card
 *  is: these are facts about the entity, not about the filters. */
function selectionLine(graph: Graph, id: string, w: Window): string | null {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const node = byId.get(id);
  if (!node) return null;
  const name = shortName(node);
  const others = new Set<string>();
  let sum = 0;
  if (node.kind === "opportunity") {
    let issuer: GraphNode | undefined;
    for (const e of graph.edges) {
      if (e.kind === "issued" && e.target === id) issuer = byId.get(e.source);
      else if (e.kind === "answered" && e.source === id) others.add(e.target);
    }
    const from = issuer ? `, from ${shortName(issuer)}` : "";
    const n = others.size;
    const answered = n ? `: answered by ${spell(n)} ${n === 1 ? "company" : "companies"}` : "";
    return `${truncate(name, 72)}${from}${answered}.`;
  }
  for (const e of graph.edges) {
    if (e.kind !== "award") continue;
    const other = e.source === id ? e.target : e.target === id ? e.source : null;
    if (!other) continue;
    others.add(other);
    sum += e.amount;
  }
  const n = others.size;
  const amount = node.total || sum;
  if (!n && !amount) return `${name}: no awards ${inPhrase(w)}.`;
  if (node.kind === "company") return `${name}: ${moneyRound(amount)} from ${spell(n)} ${n === 1 ? "buyer" : "buyers"} ${inPhrase(w)}.`;
  return `${name}: ${moneyRound(amount)} paid to ${spell(n)} ${n === 1 ? "company" : "companies"} ${inPhrase(w)}.`;
}

/** A name in one of the side card's lists: a link to that entity on the
 *  map, or plain text when the filters hide it. */
function CardName({ node, hidden, onSelect }: { node: GraphNode; hidden: boolean; onSelect: (id: string) => void }) {
  const name = shortName(node);
  const title = name !== node.name ? node.name : undefined;
  if (hidden)
    return (
      <span className="graph-card-name" title={title}>
        {name}
      </span>
    );
  return (
    <button type="button" className="graph-card-name" title={title} onClick={() => onSelect(node.id)}>
      {name}
    </button>
  );
}

/** The side card's watch button: the watchlist (lib/store.tsx), as the
 *  entity page's "Add to watchlist", in the card's short words. */
function WatchButton({ entity }: { entity: Pin }) {
  const { pin, unpin, isPinned, pins } = useStore();
  const [full, setFull] = useState(false);
  const on = isPinned(entity.id);
  return (
    <>
      <button
        type="button"
        className="btn btn-sm"
        aria-pressed={on}
        title={on ? "Remove from your watchlist" : "Add to your watchlist"}
        onClick={() => {
          if (on) return unpin(entity.id);
          setFull(pin(entity) === "full");
        }}
      >
        {on ? "Watching" : "Watch"}
      </button>
      {full && !on && pins.length >= MAX_PINS && (
        <p role="status" className="graph-detail-note">
          The watchlist holds {MAX_PINS}. Remove one first.
        </p>
      )}
    </>
  );
}

/** How the card heads each kind of non-money link, by the edge's kind and
 *  which end the selected entity is on. */
const LINK_HEAD: Record<`${Exclude<GraphEdge["kind"], "award">}:${"from" | "to"}`, string> = {
  "part_of:from": "Part of",
  "part_of:to": "Offices",
  "issued:from": "Solicitations issued",
  "issued:to": "Issued by",
  "answered:from": "Answered by",
  "answered:to": "Solicitations answered",
};
const LINK_ORDER = Object.keys(LINK_HEAD) as (keyof typeof LINK_HEAD)[];
/** Rows a list on the card shows before "and N more". */
const CARD_ROWS = 5;

export function GraphExplorer() {
  const params = useSearchParams();
  const focus = params.get("focus");
  const stress = process.env.NODE_ENV !== "production" ? Number(params.get("stress")) || 0 : 0;
  const { motion, pins } = useStore();

  // The view: flat unless the link asks for 3D (?view=3d) or the reader chose
  // 3D last time. A link that names a view always gets it, so a shared link
  // opens what its sender saw; the remembered choice fills in when it names
  // none. Until localStorage has been read (just after the first render) no
  // view is mounted, so a 3D reader never sees the flat map flash first.
  const [no3d, setNo3d] = useState(false); // this browser cannot draw the 3D view
  const asked = params.get("view");
  const linked: ViewName | null = asked === "3d" || asked === "flat" ? asked : null;
  const [saved, setSaved] = useState<ViewName | null | undefined>(undefined); // undefined: not read yet
  useEffect(() => {
    const was = recallView();
    setSaved(was);
    // the address says what is shown, so copying it keeps the view
    if (was === "3d" && !new URLSearchParams(window.location.search).has("view")) writeView("3d");
  }, []);
  const view: ViewName = no3d ? "flat" : (linked ?? saved ?? "flat");
  const viewKnown = no3d || linked !== null || saved !== undefined;

  // The window opens on "Recent": the newest stretch of the record, which has
  // something in it however long ago the data was last loaded.
  const [win, setWin] = useState<WindowKey>(DEFAULT_WINDOW);
  const chosen = windowOf(win);
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

  // The rail folded to its icon strip, and the legend folded to its button.
  // Both are remembered. The legend opens by itself only where there is room.
  const [railFolded, setRailFolded] = useState(false);
  const [legend, setLegend] = useState(false);
  useEffect(() => {
    setRailFolded(recall("flock.graph.rail") ?? false);
    setLegend(recall("flock.graph.legend") ?? window.matchMedia("(min-width: 768px)").matches);
  }, []);
  useEffect(chromeMoved, [railFolded, legend]);
  const foldRail = useCallback((folded: boolean) => {
    setRailFolded(folded);
    remember("flock.graph.rail", folded);
  }, []);
  const openLegend = (open: boolean) => {
    setLegend(open);
    remember("flock.graph.legend", open);
  };

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
    const path = `graph?days=${chosen.days}${chosen.recent ? "&recent=true" : ""}`;
    (stress ? Promise.resolve(stressGraph(stress)) : clientGet<Graph>(path, ac.signal))
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
  }, [chosen, stress]);

  // A bird clicked on the landing page lands on its node here.
  useEffect(() => {
    if (!graph || !ready || !focus || focused.current === focus) return;
    if (graph.nodes.some((n) => n.id === focus)) {
      focused.current = focus;
      setSelected(focus);
      requestAnimationFrame(() => api.current.focusOn(focus, true));
    } else if (chosen.days !== 0 && (chosen.recent || chosen.days < 365) && widened.current !== focus) {
      // older than the window: widen it once (once per focus, so a node that is
      // never found does not hold the window open). A year, unless the record
      // is so stale that the year would not reach what Recent shows.
      widened.current = focus;
      setWin((graph.age ?? 0) + WINDOWS[0].days > 365 ? "all" : "1y");
    }
  }, [graph, ready, focus, chosen]);

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

  // What each row of the rail would show: the entities in a category, or of a
  // kind, under every other filter in force. So a count is what ticking that
  // row adds to the map, and it does not drop to zero because of its own group.
  const tagCounts = useMemo(() => {
    const out: Record<string, number> = {};
    if (!graph) return out;
    const hid = tags.size ? hiddenNodes(graph, { tags: NO_TAGS, agency, min, kinds, watch }, watched) : hidden;
    for (const n of graph.nodes) {
      if (n.kind === "agency" || n.kind === "office" || hid.has(n.id)) continue;
      for (const t of n.tags) out[t] = (out[t] ?? 0) + 1;
    }
    return out;
  }, [graph, hidden, tags, agency, min, kinds, watch, watched]);
  const kindCounts = useMemo(() => {
    const out: Record<NodeKind, number> = { company: 0, agency: 0, office: 0, opportunity: 0 };
    if (!graph) return out;
    const hid =
      kinds.size < ALL_KINDS.length ? hiddenNodes(graph, { tags, agency, min, kinds: EVERY_KIND, watch }, watched) : hidden;
    for (const n of graph.nodes) if (!hid.has(n.id)) out[n.kind]++;
    return out;
  }, [graph, hidden, tags, agency, min, kinds, watch, watched]);

  // A selection the filters have hidden would dim the map around nothing.
  useEffect(() => {
    if (selected && hidden.has(selected)) setSelected(null);
  }, [selected, hidden]);

  const select = useCallback((id: string) => {
    setSelected(id);
    api.current.focusOn(id, false);
  }, []);
  const clearSelection = useCallback(() => setSelected(null), []);

  const setView = (next: ViewName) => {
    if (next === view) return;
    remember(VIEW_KEY, next);
    setSaved(next);
    writeView(next);
  };

  // Escape clears the selection from anywhere on the screen (the views also
  // take it while they hold the keyboard). Not from a field, where it clears
  // the text, nor from the top bar's menu, which it closes.
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target;
      if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (t instanceof Element && t.closest("nav, header, [role=menu], [role=dialog]")) return;
      setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

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
      .filter(
        (n) => !hidden.has(n.id) && (n.name.toLowerCase().includes(needle) || !!n.display_name?.toLowerCase().includes(needle)),
      )
      .sort((a, b) => b.total - a.total)
      .slice(0, 7);
  }, [graph, hidden, needle]);

  // The side card's figures. The money on it is the entity's own in the
  // window, so it is counted over the whole graph, not only what the filters
  // leave: "Paid by" adds up to "Awarded". A name the filters hide is listed
  // but not a link, since selecting it would select nothing on the map.
  const detail = useMemo(() => {
    if (!graph || !selected) return null;
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const node = byId.get(selected);
    if (!node) return null;
    const paid = new Map<string, number>();
    const links = new Map<keyof typeof LINK_HEAD, Map<string, GraphNode>>();
    for (const e of graph.edges) {
      const from = e.source === selected;
      const otherId = from ? e.target : e.target === selected ? e.source : null;
      const o = otherId ? byId.get(otherId) : undefined;
      if (!o) continue;
      if (e.kind === "award") {
        paid.set(o.id, (paid.get(o.id) ?? 0) + e.amount);
        continue;
      }
      const head = `${e.kind}:${from ? "from" : "to"}` as const;
      const group = links.get(head) ?? new Map<string, GraphNode>();
      group.set(o.id, o);
      links.set(head, group);
    }
    // Who is on the other end of the money: the buyers that pay a company,
    // or the companies an agency or office pays. Largest first.
    const partners = [...paid]
      .map(([id, amount]) => ({ node: byId.get(id)!, amount }))
      .sort((a, b) => b.amount - a.amount);
    const amount = node.total || partners.reduce((sum, p) => sum + p.amount, 0);
    const groups = LINK_ORDER.filter((h) => links.has(h)).map((h) => ({
      head: LINK_HEAD[h],
      nodes: [...links.get(h)!.values()].sort((a, b) => b.total - a.total),
    }));
    return { node, partners, amount, groups };
  }, [graph, selected]);

  // How far the selected company has come (Phase I, Phase II, production):
  // read from its entity record, which the graph does not carry. The row
  // waits for it and stays away when the record has none.
  const [stage, setStage] = useState<{ id: string; label: string } | null>(null);
  const stageFor = detail?.node.kind === "company" && !stress ? detail.node.id : null;
  useEffect(() => {
    if (!stageFor) return;
    const ac = new AbortController();
    clientGet<Org>(`orgs/${stageFor.split(":")[1]}`, ac.signal)
      .then((org) => {
        const reached = (org.path ?? []).filter((p) => p.reached);
        const last = reached[reached.length - 1];
        if (last) setStage({ id: stageFor, label: last.label });
      })
      .catch(() => {
        /* no stage row: the card is complete without it */
      });
    return () => ac.abort();
  }, [stageFor]);
  const stageLabel = stage && stage.id === detail?.node.id ? stage.label : null;

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

  const latest = graph?.latest ?? null;
  const age = graph?.age ?? null;
  const span = windowPhrase(chosen, latest);
  const shown = graph ? graph.nodes.length - hidden.size : 0;
  const empty = ready && graph && graph.nodes.length === 0;
  const filteredOut = ready && graph && graph.nodes.length > 0 && shown === 0;
  const shared = { graph, hidden, tags, selected, query: needle, ready, api, onSelect: setSelected };

  // The takeaway line: the selected entity's figure while one is selected,
  // otherwise what the map in view says.
  const said = useMemo(() => {
    if (!graph || !ready || filteredOut || empty) return null;
    if (selected) return selectionLine(graph, selected, chosen);
    return summary(graph, hidden, chosen, latest, age);
  }, [graph, ready, filteredOut, empty, selected, hidden, chosen, latest, age]);
  // The line is an obstacle to the views' names: they measure it again when
  // it changes shape. So is the side card, which grows a row when the stage
  // reached comes in.
  useEffect(chromeMoved, [said, stageLabel]);

  return (
    <div data-graph-root data-rail={railFolded ? "closed" : "open"} className="fixed inset-0 z-20 overflow-hidden bg-bg">
      {/* The plain page: no frame, no art, nothing behind the map. */}
      {!viewKnown ? null : view === "flat" ? (
        <GraphFlat {...shared} onReady={readyFlat} />
      ) : (
        <Graph3D {...shared} onReady={ready3d} onUnsupported={noWebGL} />
      )}

      {/* The takeaway, top left of the map. Before the rail in the page, so
          the phone's filter sheet covers it. */}
      {said && (
        <p className="graph-takeaway" data-obstacle>
          {said}
          {selected && <span className="graph-takeaway-esc"> Press Esc to clear.</span>}
        </p>
      )}

      {!ready && !failed && (
        <p className="pointer-events-none absolute inset-0 grid place-items-center text-muted">Drawing the map…</p>
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
          <Empty title="Nothing landed in this window">
            {latest && !chosen.recent ? (
              <>
                The newest award on record is from {day(latest)}.{" "}
                <button type="button" onClick={() => setWin("recent")} className="pointer-events-auto cursor-pointer text-ink underline">
                  Show the most recent
                </button>
                .
              </>
            ) : (
              "Try a longer stretch of time."
            )}
          </Empty>
        </div>
      )}
      {filteredOut && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <Empty title="Nothing matches these filters">
            Loosen one of them, or{" "}
            <button type="button" onClick={reset} className="pointer-events-auto cursor-pointer text-ink underline">
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
        selected={!!selected}
        onClear={clearSelection}
        win={win}
        onWin={setWin}
        latest={latest}
        age={age}
        sample={graph?.sample ?? false}
        present={present}
        tagCounts={tagCounts}
        tags={tags}
        onToggleTag={toggleTag}
        agencies={agencies}
        agency={agency}
        onAgency={setAgency}
        min={min}
        onMin={setMin}
        kinds={kinds}
        kindCounts={kindCounts}
        onToggleKind={toggleKind}
        watch={watch}
        onWatch={setWatch}
        pins={pins.length}
        active={active}
        onReset={reset}
        shown={shown}
        total={graph?.nodes.length ?? 0}
        collapsed={railFolded}
        onCollapsed={foldRail}
      />

      <Legend open={legend} onOpen={openLegend} />

      {/* View and zoom, in the map's bottom-left corner */}
      <div className="graph-controls">
        <div className="seg graph-float" role="group" aria-label="Graph view">
          {(["3d", "flat"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              aria-label={v === "3d" ? "3D view" : "Flat view"}
              disabled={v === "3d" && no3d}
              title={v === "3d" && no3d ? "This browser cannot draw the 3D view" : undefined}
              onClick={() => setView(v)}
              className="disabled:cursor-default disabled:opacity-50"
            >
              {v === "3d" ? "3D" : "Flat"}
            </button>
          ))}
        </div>
        <div className="graph-zoom" role="group" aria-label="Zoom">
          <button type="button" className="btn btn-sm btn-icon graph-float" aria-label="Zoom out" onClick={() => api.current.zoom(1 / 1.4)}>
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
              <path d="M4 8h8" />
            </svg>
          </button>
          <button type="button" className="btn btn-sm graph-float" aria-label="Fit the whole graph" onClick={() => api.current.fit(true)}>
            Fit
          </button>
          <button type="button" className="btn btn-sm btn-icon graph-float" aria-label="Zoom in" onClick={() => api.current.zoom(1.4)}>
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
              <path d="M4 8h8M8 4v8" />
            </svg>
          </button>
        </div>
      </div>

      {/* The side card: the selected entity. Its short name in the display
          serif with the legal name in small capitals under it, then its
          figures, who is on the other end of its money, and the way to its
          page. Dollars are in the accent. */}
      <AnimatePresence>
        {detail && (
          <m.aside
            key={detail.node.id}
            data-obstacle
            data-kind={detail.node.kind}
            aria-label={detail.node.name}
            initial={motion ? { opacity: 0, y: 4 } : false}
            animate={{ opacity: 1, y: 0 }}
            exit={motion ? { opacity: 0, transition: { duration: 0.15 } } : { opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="graph-detail surface"
          >
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="graph-kicker">
                  {KIND_NAME[detail.node.kind]}
                  {detail.node.tag && <> · {tagLabel(detail.node.tag)}</>}
                </p>
                <h2>{shortName(detail.node)}</h2>
                {detail.node.kind !== "opportunity" && shortName(detail.node) !== detail.node.name && (
                  <p className="graph-legal">{detail.node.name}</p>
                )}
              </div>
              <button type="button" onClick={() => setSelected(null)} aria-label="Close" className="graph-icon-btn -mr-1.5 -mt-1">
                <CloseIcon size={14} />
              </button>
            </div>

            {detail.node.kind === "opportunity" ? (
              <dl className="graph-facts">
                <div>
                  <dt>Posted</dt>
                  <dd>{day(detail.node.posted)}</dd>
                </div>
                <div>
                  <dt>Closes</dt>
                  <dd>{day(detail.node.closes)}</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>{detail.node.open ? "Open" : "Closed"}</dd>
                </div>
              </dl>
            ) : (
              <dl className="graph-facts">
                <div>
                  <dt>
                    {detail.node.kind === "company" ? "Awarded" : "Paid"}, {chosen.days ? (chosen.recent ? `${chosen.days} days` : span) : "on record"}
                  </dt>
                  <dd className="money">{moneyRound(detail.amount)}</dd>
                </div>
                <div>
                  <dt>Awards</dt>
                  <dd>{detail.node.awards.toLocaleString("en-US")}</dd>
                </div>
                {stageLabel && (
                  <div>
                    <dt>Stage reached</dt>
                    <dd>{stageLabel}</dd>
                  </div>
                )}
                {detail.node.uei && (
                  <div>
                    <dt>UEI</dt>
                    <dd>{detail.node.uei}</dd>
                  </div>
                )}
              </dl>
            )}

            {detail.node.tags.length > 1 && (
              <p className="graph-detail-note">
                Also tagged {detail.node.tags.filter((t) => t !== detail.node.tag).map(tagLabel).join(", ")}.
              </p>
            )}

            {detail.partners.length > 0 && (
              <section className="graph-card-list" aria-label={detail.node.kind === "company" ? "Paid by" : "Paid to"}>
                <h3>{detail.node.kind === "company" ? "Paid by" : "Paid to"}</h3>
                <ul>
                  {detail.partners.slice(0, CARD_ROWS).map((p) => (
                    <li key={p.node.id}>
                      <CardName node={p.node} hidden={hidden.has(p.node.id)} onSelect={select} />
                      <span className="money">{moneyRound(p.amount)}</span>
                    </li>
                  ))}
                  {detail.partners.length > CARD_ROWS && (
                    <li className="graph-card-more">and {detail.partners.length - CARD_ROWS} more</li>
                  )}
                </ul>
              </section>
            )}

            {detail.groups.map((g) => (
              <section key={g.head} className="graph-card-list" aria-label={g.head}>
                <h3>{g.head}</h3>
                <ul>
                  {g.nodes.slice(0, CARD_ROWS).map((n) => (
                    <li key={n.id}>
                      <CardName node={n} hidden={hidden.has(n.id)} onSelect={select} />
                    </li>
                  ))}
                  {g.nodes.length > CARD_ROWS && <li className="graph-card-more">and {g.nodes.length - CARD_ROWS} more</li>}
                </ul>
              </section>
            ))}

            <div className="graph-card-actions">
              {detail.node.kind === "opportunity" ? (
                detail.node.url && (
                  <a className="btn btn-sm btn-primary" href={detail.node.url} target="_blank" rel="noreferrer">
                    Read the notice<span className="sr-only"> (opens in a new tab)</span>
                  </a>
                )
              ) : (
                <>
                  <Link className="btn btn-sm btn-primary" href={`/entity/${detail.node.id.split(":")[1]}`}>
                    Open profile
                  </Link>
                  <WatchButton
                    entity={{
                      id: Number(detail.node.id.split(":")[1]),
                      name: detail.node.name,
                      tag: detail.node.tag,
                      kind: detail.node.kind,
                    }}
                  />
                </>
              )}
            </div>
          </m.aside>
        )}
      </AnimatePresence>
      <span className="sr-only" aria-live="polite">
        {ready && graph
          ? `${shown} of ${graph.nodes.length} entities shown, ${span}, ${view === "3d" ? "3D" : "flat"} view`
          : "Drawing the map"}
      </span>
    </div>
  );
}
