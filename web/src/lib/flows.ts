// The explorer's data: the shape of GET /api/flows (pipeline/api/flows.py) and
// the pure functions every view shares. A view never counts dollars itself: it
// filters the window's awards (filterAwards), tallies them once (buildModel)
// and draws the tally. So the flow, the constellation, the timeline, the
// inspector and the headline cannot disagree, and every figure can name the
// award records it was summed from.

import { andList, moneyRound } from "./format";
import { tagLabel } from "./tags";

// ---- The API's answer ----

export const WINDOW_KEYS = ["30d", "90d", "1y", "all"] as const;
export type WindowKey = (typeof WINDOW_KEYS)[number];
export const WINDOW_NAMES: Record<WindowKey, string> = { "30d": "30d", "90d": "90d", "1y": "1y", all: "All" };

/** `?window=`, read leniently. "recent" is the old name of the 90-day window. */
export function parseWindowKey(raw: string | string[] | null | undefined): WindowKey | null {
  const v = (Array.isArray(raw) ? raw[0] : raw)?.trim().toLowerCase();
  if (v === "recent") return "90d";
  return (WINDOW_KEYS as readonly string[]).includes(v ?? "") ? (v as WindowKey) : null;
}

export type FlowWindow = {
  key: WindowKey;
  days: number | null;
  start: string | null;
  end: string | null;
  /** the day of the newest award on record: where every window ends */
  latest_data_date: string | null;
  /** "90 days to Aug 19" */
  label: string;
  /** true when no window was asked for and the API chose this one */
  default?: boolean;
  today?: string;
  awards?: number;
};

export type Party = {
  id: string; // "org:12"
  org_id: number | null;
  name: string;
  display_name: string | null;
  kind: "company" | "agency" | "office";
  uei: string | null;
  dollars: number;
  awards: number;
};
export type Company = Party & {
  /** mission slugs, largest first */
  missions: string[];
  first_award: string | null;
  /** the first row the pipeline loaded for it: what "new since" compares */
  first_award_id: number | null;
};
export type Mission = { id: string; slug: string; dollars: number; awards: number; companies: number };
export type Band = {
  kind: "agency-mission" | "mission-company" | "agency-company";
  source: string;
  target: string;
  dollars: number;
  award_ids: number[];
};
export type Award = {
  id: number;
  day: string;
  amount: number | null;
  agency: string;
  company: string;
  missions: string[];
  url: string | null;
  source: string;
  source_id: string;
  description: string | null;
  opportunity: string | null;
};
export type Solicitation = {
  id: string; // "opp:5"
  title: string;
  agency: string;
  missions: string[];
  posted: string | null;
  closes: string | null;
  open: boolean;
  awarded_on: string | null;
  url: string | null;
  award_ids: number[];
};
export type Flows = {
  window: FlowWindow;
  windows: FlowWindow[];
  sample: boolean;
  max_award_id: number | null;
  totals: { dollars: number; awards: number; companies: number; agencies: number };
  agencies: Party[];
  missions: Mission[];
  companies: Company[];
  flows: Band[];
  awards: Award[];
  solicitations: Solicitation[];
};

// ---- Names ----

export type Named = { id: string; kind: "agency" | "office" | "company" | "mission"; label: string; full: string };

/** Every party in the answer by id, with the short name the charts print. */
export function names(data: Flows): Map<string, Named> {
  const out = new Map<string, Named>();
  for (const a of data.agencies)
    out.set(a.id, {
      id: a.id,
      kind: a.kind === "office" ? "office" : "agency",
      label: a.display_name || a.name,
      full: a.name,
    });
  for (const c of data.companies)
    out.set(c.id, { id: c.id, kind: "company", label: c.display_name || c.name, full: c.name });
  for (const m of data.missions)
    out.set(m.id, { id: m.id, kind: "mission", label: missionLabel(m.slug), full: missionLabel(m.slug) });
  return out;
}

export function missionLabel(slug: string): string {
  return slug === "other" ? "Other autonomy" : tagLabel(slug);
}
export const missionId = (slug: string) => `tag:${slug}`;
export const isMission = (id: string) => id.startsWith("tag:");

// ---- Filters ----

export type Filters = {
  /** mission slugs shown; null is all of them */
  missions: ReadonlySet<string> | null;
  /** one paying agency, or null for all */
  agency: string | null;
  /** awards below this many dollars are left out */
  min: number;
  /** the timeline brush, both days included; null is the whole window */
  from: string | null;
  to: string | null;
  /** only awards loaded since this award id (the reader's last visit) */
  sinceId: number | null;
};
export const NO_FILTERS: Filters = { missions: null, agency: null, min: 0, from: null, to: null, sinceId: null };

/** The window's awards that pass every filter. Dates compare as ISO strings,
 *  which sort like the days they name. */
export function filterAwards(awards: readonly Award[], f: Filters): Award[] {
  return awards.filter((a) => {
    if (f.agency && a.agency !== f.agency) return false;
    if (f.min && (a.amount ?? 0) < f.min) return false;
    if (f.from && a.day < f.from) return false;
    if (f.to && a.day > f.to) return false;
    if (f.sinceId != null && a.id <= f.sinceId) return false;
    if (f.missions && !a.missions.some((m) => f.missions!.has(m))) return false;
    return true;
  });
}

// ---- The tally ----

export type Tally = { id: string; dollars: number; awards: number };
export type Link = { key: string; source: string; target: string; dollars: number; awards: Award[] };
export type Model = {
  awards: Award[];
  /** dollars counted: the sum of every column of the flow */
  total: number;
  agencies: Map<string, Tally>;
  missions: Map<string, Tally>;
  companies: Map<string, Tally>;
  /** agency -> mission, mission -> company, agency -> company */
  am: Map<string, Link>;
  mc: Map<string, Link>;
  ac: Map<string, Link>;
};

export const linkKey = (source: string, target: string) => `${source}>${target}`;

/** Sum a set of awards into parties and links. An award with several missions
 *  splits its dollars evenly between them, as the API does; with a mission
 *  filter, only the shown missions' shares are counted, everywhere, so the
 *  three columns still add up to the same total. */
export function buildModel(awards: Award[], missions: ReadonlySet<string> | null = null): Model {
  const m: Model = {
    awards,
    total: 0,
    agencies: new Map(),
    missions: new Map(),
    companies: new Map(),
    am: new Map(),
    mc: new Map(),
    ac: new Map(),
  };
  const tally = (table: Map<string, Tally>, id: string, dollars: number) => {
    let t = table.get(id);
    if (!t) table.set(id, (t = { id, dollars: 0, awards: 0 }));
    t.dollars += dollars;
    t.awards += 1;
  };
  const link = (table: Map<string, Link>, source: string, target: string, dollars: number, a: Award) => {
    const key = linkKey(source, target);
    let l = table.get(key);
    if (!l) table.set(key, (l = { key, source, target, dollars: 0, awards: [] }));
    l.dollars += dollars;
    l.awards.push(a);
  };
  for (const a of awards) {
    const amount = a.amount ?? 0;
    const share = amount / Math.max(1, a.missions.length);
    const parts = missions ? a.missions.filter((s) => missions.has(s)) : a.missions;
    const counted = share * parts.length;
    if (!parts.length) continue;
    m.total += counted;
    tally(m.agencies, a.agency, counted);
    tally(m.companies, a.company, counted);
    link(m.ac, a.agency, a.company, counted, a);
    for (const s of parts) {
      const id = missionId(s);
      tally(m.missions, id, share);
      link(m.am, a.agency, id, share, a);
      link(m.mc, id, a.company, share, a);
    }
  }
  return m;
}

export const byDollars = <T extends { dollars: number; id?: string; key?: string }>(a: T, b: T) =>
  b.dollars - a.dollars || String(a.id ?? a.key).localeCompare(String(b.id ?? b.key));

/** A whole-number share for print: never "100%" while something else paid,
 *  never "0%" for something that did. */
export function pct(part: number, whole: number): string {
  if (!(whole > 0) || !(part > 0)) return "0%";
  const p = (part / whole) * 100;
  if (p >= 99.5 && part < whole) return "99%";
  if (p < 1) return "<1%";
  return `${Math.round(p)}%`;
}

/** The awards behind one party or one band of the model. */
export function awardsOf(model: Model, id: string): Award[] {
  if (id.includes(">")) return (model.am.get(id) ?? model.mc.get(id) ?? model.ac.get(id))?.awards ?? [];
  if (isMission(id)) {
    const slug = id.slice(4);
    return model.awards.filter((a) => a.missions.includes(slug));
  }
  return model.awards.filter((a) => a.agency === id || a.company === id);
}

// ---- The headline ----

/** How the window ends a sentence: "in the 90 days to Aug 19", "on record". */
export function windowPhrase(w: FlowWindow): string {
  if (!w.end || !w.days) return "on record";
  return `in the ${w.label}`;
}

export type Headline = { claim: string; leaders: string | null; share: number; agencies: string[] };

/** What the awards in view say, in the page's narrative voice: which agencies
 *  paid most of the dollars, and which companies lead. Null with no dollars. */
export function headline(model: Model, who: Map<string, Named>): Headline | null {
  if (!(model.total > 0)) return null;
  const label = (id: string) => who.get(id)?.label ?? "an unnamed agency";
  const payers = [...model.agencies.values()].sort(byDollars);
  const top = payers.slice(0, 3);
  const share = top.reduce((s, t) => s + t.dollars, 0) / model.total;
  let claim: string;
  if (payers.length === 1) claim = `${label(payers[0].id)} paid ${moneyRound(model.total)} of autonomy dollars`;
  else if (payers.length <= 3)
    claim = `${andList(payers.map((t) => label(t.id)))} paid all ${moneyRound(model.total)} of autonomy dollars`;
  else
    claim = `${andList(top.map((t) => label(t.id)))} paid ${Math.min(99, Math.round(share * 100))}% of autonomy dollars`;
  const lead = [...model.companies.values()]
    .sort(byDollars)
    .slice(0, 2)
    .map((t) => label(t.id));
  const leaders = lead.length === 2 ? `${andList(lead)} lead.` : lead.length === 1 ? `${lead[0]} leads.` : null;
  return { claim, leaders, share, agencies: top.map((t) => t.id) };
}

// ---- Source records ----

/** Where a party can be looked up in the public record. The award rows carry
 *  their own USAspending link; these are for the party itself. */
export function sourceLinks(p: { name: string; uei?: string | null; kind: string }): { label: string; href: string }[] {
  const term = encodeURIComponent(p.uei || p.name);
  const out = [{ label: "USAspending", href: `https://www.usaspending.gov/keyword_search/${term}` }];
  if (p.kind === "company") {
    const q = `sfm%5BsimpleSearch%5D%5BkeywordRadio%5D=ALL&sfm%5BsimpleSearch%5D%5BkeywordTags%5D%5B0%5D%5Bkey%5D=${term}&sfm%5BsimpleSearch%5D%5BkeywordTags%5D%5B0%5D%5Bvalue%5D=${term}`;
    out.push({ label: "SAM.gov", href: `https://sam.gov/search/?index=ei&page=1&sort=-relevance&${q}` });
  }
  return out;
}

/** One decimal place. Coordinates are rounded so the server's HTML and the
 *  browser's first render agree to the last digit (Math.log10, sin and cos may
 *  differ in their final bits between engines). */
export const r1 = (n: number) => Math.round(n * 10) / 10;

// ---- Days ----

const DAY = 86_400_000;
/** An ISO day as a count of days, in UTC so no zone can shift it. */
export function dayNumber(iso: string): number {
  return Math.round(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / DAY);
}
export function isoDay(n: number): string {
  return new Date(n * DAY).toISOString().slice(0, 10);
}
/** The first and last day a set of awards spans, or the window's own. */
export function span(w: FlowWindow, awards: readonly Award[]): { start: string; end: string } | null {
  const end = w.end ?? awards[awards.length - 1]?.day;
  const start = w.start ?? awards[0]?.day;
  return start && end ? { start, end } : null;
}

// ---- The flow: a three-column Sankey, laid out by hand ----

export type SankeyNode = {
  id: string;
  col: 0 | 1 | 2;
  label: string;
  dollars: number;
  awards: number;
  x: number;
  y: number;
  h: number;
  /** the folded tail: "All other companies (n)" */
  folded?: number;
};
export type SankeyBand = {
  key: string;
  source: string;
  target: string;
  dollars: number;
  awards: Award[];
  /** top edge at each end, and the thickness */
  y0: number;
  y1: number;
  h: number;
  d: string;
};
export type Sankey = {
  width: number;
  height: number;
  nodes: SankeyNode[];
  bands: SankeyBand[];
  /** x of each column's bar */
  cols: [number, number, number];
  bar: number;
  /** companies folded into the tail, largest first */
  tail: Tally[];
};

export const OTHERS = "others";
const BAR = 8;
const PAD = 7; // least gap between two nodes
const PITCH = 17; // least distance between two labels
const MIN_H = 1.5; // a node never thinner than this, so it can be seen and hit

/** Which companies get a node of their own: the top `perMission` recipients of
 *  each mission, then the largest `max` of those. The rest are the tail. */
export function namedCompanies(model: Model, perMission: number, max: number): Set<string> {
  const byMission = new Map<string, Link[]>();
  for (const l of model.mc.values()) {
    const list = byMission.get(l.source) ?? [];
    list.push(l);
    byMission.set(l.source, list);
  }
  const picked = new Set<string>();
  for (const list of byMission.values())
    for (const l of list.sort(byDollars).slice(0, perMission)) picked.add(l.target);
  const ranked = [...picked].map((id) => model.companies.get(id)!).sort(byDollars);
  return new Set(ranked.slice(0, max).map((t) => t.id));
}

/** Stack one column: every node `scale` pixels per dollar tall, labels at
 *  least PITCH apart, spare room shared out between the nodes. */
function stack(values: number[], scale: number, top: number, room: number): { y: number; h: number }[] {
  const hs = values.map((v) => Math.max(MIN_H, v * scale));
  const steps = hs.map((h, i) => (i === hs.length - 1 ? h : Math.max(h + PAD, PITCH)));
  const used = steps.reduce((s, v) => s + v, 0);
  const spare = Math.max(0, room - used) / Math.max(1, hs.length - 1);
  // A column with a single node, or little in it, is not stretched apart.
  const give = Math.min(spare, 26);
  let y = top;
  return hs.map((h, i) => {
    const at = { y, h };
    y += steps[i] + give;
    return at;
  });
}
function fits(values: number[], scale: number, room: number): boolean {
  const hs = values.map((v) => Math.max(MIN_H, v * scale));
  return hs.reduce((s, h, i) => s + (i === hs.length - 1 ? h : Math.max(h + PAD, PITCH)), 0) <= room;
}

/** Lay the model out as Agency -> Mission -> Recipient. Nodes keep the order
 *  of `order` (the whole window's ranking), so a filter thins the columns but
 *  never reshuffles them. Geometry is in pixels of a `width`-wide drawing. */
export function layoutSankey(
  model: Model,
  who: Map<string, Named>,
  order: Map<string, number>,
  opts: { width: number; minHeight: number; perMission: number; maxNamed: number; left: number; right: number },
): Sankey {
  const rank = (id: string) => order.get(id) ?? 1e9;
  const ranked = (ids: Iterable<string>) => [...ids].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const named = namedCompanies(model, opts.perMission, opts.maxNamed);
  const tail = [...model.companies.values()].filter((t) => !named.has(t.id)).sort(byDollars);
  const tailDollars = tail.reduce((s, t) => s + t.dollars, 0);
  const tailAwards = tail.reduce((s, t) => s + t.awards, 0);

  type Raw = { id: string; label: string; dollars: number; awards: number; folded?: number };
  const col = (ids: string[], table: Map<string, Tally>): Raw[] =>
    ids.map((id) => ({
      id,
      label: who.get(id)?.label ?? id,
      dollars: table.get(id)!.dollars,
      awards: table.get(id)!.awards,
    }));
  const columns: Raw[][] = [
    col(ranked(model.agencies.keys()), model.agencies),
    col(ranked(model.missions.keys()), model.missions),
    col(ranked(named), model.companies),
  ];
  if (tail.length)
    columns[2].push({
      id: OTHERS,
      label: tail.length === 1 ? "1 other company" : `All other companies (${tail.length.toLocaleString("en-US")})`,
      dollars: tailDollars,
      awards: tailAwards,
      folded: tail.length,
    });

  const top = 34;
  const longest = Math.max(1, ...columns.map((c) => c.length));
  const height = Math.max(opts.minHeight, top + longest * PITCH + 16);
  const room = height - top - 10;
  // One scale for the whole drawing: the largest at which every column fits.
  let lo = 0;
  let hi = model.total > 0 ? room / model.total : 0;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (
      columns.every((c) =>
        fits(
          c.map((n) => n.dollars),
          mid,
          room,
        ),
      )
    )
      lo = mid;
    else hi = mid;
  }
  const scale = lo;

  const x0 = opts.left;
  const x2 = opts.width - opts.right - BAR;
  // The middle column sits left of center: mission names are set to its right,
  // over the bands, and the longest of them needs the room.
  const x1 = Math.round(x0 + (x2 - x0) * 0.38);
  const cols: [number, number, number] = [x0, x1, x2];
  const nodes: SankeyNode[] = [];
  const at = new Map<string, SankeyNode>();
  columns.forEach((c, ci) => {
    const places = stack(
      c.map((n) => n.dollars),
      scale,
      top,
      room,
    );
    c.forEach((n, i) => {
      const node: SankeyNode = { ...n, col: ci as 0 | 1 | 2, x: cols[ci], y: r1(places[i].y), h: r1(places[i].h) };
      nodes.push(node);
      at.set(n.id, node);
    });
  });

  // Bands: at each node they stack in the order of the nodes they reach.
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  type Raw2 = { key: string; source: string; target: string; dollars: number; awards: Award[] };
  const raw: Raw2[] = [...model.am.values()];
  const folded = new Map<string, Raw2>();
  for (const l of model.mc.values()) {
    if (named.has(l.target)) raw.push(l);
    else {
      const key = linkKey(l.source, OTHERS);
      let f = folded.get(key);
      if (!f) folded.set(key, (f = { key, source: l.source, target: OTHERS, dollars: 0, awards: [] }));
      f.dollars += l.dollars;
      f.awards.push(...l.awards);
    }
  }
  raw.push(...folded.values());
  const out = new Map<string, number>(); // next free y at a node's right side
  const inn = new Map<string, number>(); // and at its left side
  const bySource = [...raw].sort(
    (a, b) => index.get(a.source)! - index.get(b.source)! || index.get(a.target)! - index.get(b.target)!,
  );
  const y0 = new Map<string, number>();
  for (const l of bySource) {
    const s = at.get(l.source)!;
    const y = out.get(l.source) ?? s.y;
    y0.set(l.key, y);
    out.set(l.source, y + l.dollars * scale);
  }
  const byTarget = [...raw].sort(
    (a, b) => index.get(a.target)! - index.get(b.target)! || index.get(a.source)! - index.get(b.source)!,
  );
  const bands: SankeyBand[] = [];
  for (const l of byTarget) {
    const s = at.get(l.source)!;
    const t = at.get(l.target)!;
    const ty = inn.get(l.target) ?? t.y;
    const h = Math.max(0.6, l.dollars * scale);
    inn.set(l.target, ty + l.dollars * scale);
    const sy = y0.get(l.key)!;
    const xa = s.x + BAR;
    const xb = t.x;
    const xm = (xa + xb) / 2;
    const f = (n: number) => n.toFixed(1);
    const d = `M${f(xa)} ${f(sy)}C${f(xm)} ${f(sy)} ${f(xm)} ${f(ty)} ${f(xb)} ${f(ty)}L${f(xb)} ${f(ty + h)}C${f(xm)} ${f(ty + h)} ${f(xm)} ${f(sy + h)} ${f(xa)} ${f(sy + h)}Z`;
    bands.push({ ...l, y0: sy, y1: ty, h, d });
  }
  // Draw the widest first, so a thin band is never buried under a wide one.
  bands.sort((a, b) => b.dollars - a.dollars);
  return { width: opts.width, height, nodes, bands, cols, bar: BAR, tail };
}

// ---- The constellation: one party's neighborhood on fixed rings ----

export type StarNode = {
  id: string;
  ring: 0 | 1 | 2;
  kind: Named["kind"];
  label: string;
  x: number;
  y: number;
  r: number;
  angle: number;
  dollars: number;
  awards: number;
  /** ring 2: the ring-1 node it hangs from */
  via?: string;
  /** a stub for the ring-1 parties left out: "+ 14 more" */
  more?: number;
  labeled: boolean;
};
export type StarEdge = {
  key: string;
  source: string;
  target: string;
  ring: 1 | 2;
  dollars: number;
  awards: Award[];
  width: number;
  d: string;
  /** a second tie from a ring-2 node to a ring-1 node that is not its own */
  extra?: boolean;
};
export type Ghost = { id: string; label: string; x: number; y: number; r: number };
export type Constellation = {
  width: number;
  height: number;
  cx: number;
  cy: number;
  /** ring 1 is a circle; ring 2 an ellipse, wider than tall on a wide drawing */
  r1: number;
  r2x: number;
  r2y: number;
  center: StarNode | null;
  nodes: StarNode[];
  edges: StarEdge[];
  ghosts: Ghost[];
};

/** A stable number in [0, 1) from a string: where a ghost sits never changes. */
export function hash01(s: string, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

const quad = (x0: number, y0: number, x1: number, y1: number, bend: number) => {
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  const cx = mx - (y1 - y0) * bend;
  const cy = my + (x1 - x0) * bend;
  return `M${x0.toFixed(1)} ${y0.toFixed(1)}Q${cx.toFixed(1)} ${cy.toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}`;
};

/** The neighborhood of `center` (a company or an agency): who it trades
 *  dollars with on ring 1, and, at two hops, who else those parties trade with
 *  on ring 2. Positions come from rank and count alone (no simulation), so the
 *  same selection always draws the same picture. */
export function layoutConstellation(
  model: Model,
  who: Map<string, Named>,
  center: string,
  hops: 1 | 2,
  opts: {
    width: number;
    height: number;
    ring1Max?: number;
    perParent?: number;
    ring2Max?: number;
    ghosts?: number;
    padX?: number;
    padY?: number;
  },
): Constellation {
  const { width, height } = opts;
  const cx = Math.round(width / 2);
  const cy = Math.round(height / 2 - (opts.padY != null ? 0 : 14));
  // Ring 2 leaves room at the sides for names; ring 1 sits at a little over
  // half of it.
  const r2y = Math.round(height / 2 - (opts.padY ?? 52));
  const r2x = Math.round(Math.max(r2y * 0.8, Math.min(width / 2 - (opts.padX ?? 150), r2y * 1.3)));
  const ring1 = Math.round(Math.min(r2x, r2y) * 0.56);
  const empty: Constellation = {
    width,
    height,
    cx,
    cy,
    r1: ring1,
    r2x,
    r2y,
    center: null,
    nodes: [],
    edges: [],
    ghosts: [],
  };
  const self = model.companies.get(center) ?? model.agencies.get(center);
  const kindOf = (id: string): Named["kind"] => who.get(id)?.kind ?? "company";
  const label = (id: string) => who.get(id)?.label ?? id;

  // Who trades with whom: agency <-> company, by the awards between them.
  const ties = new Map<string, Link[]>();
  for (const l of model.ac.values()) {
    (ties.get(l.source) ?? ties.set(l.source, []).get(l.source)!).push(l);
    (ties.get(l.target) ?? ties.set(l.target, []).get(l.target)!).push(l);
  }
  const other = (l: Link, id: string) => (l.source === id ? l.target : l.source);

  const ghostsFor = (placed: Set<string>): Ghost[] => {
    const rest = [...model.companies.values(), ...model.agencies.values()]
      .filter((t) => !placed.has(t.id))
      .sort(byDollars);
    return rest.slice(0, opts.ghosts ?? 170).map((t) => {
      // Scatter over the frame, kept off the middle where the rings are read.
      let x = 14 + hash01(t.id, 1) * (width - 28);
      let y = 16 + hash01(t.id, 2) * (height - 32);
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.hypot(dx, dy) || 1;
      if (d < ring1 * 0.55) {
        x = cx + (dx / d) * ring1 * (0.55 + hash01(t.id, 3) * 0.3);
        y = cy + (dy / d) * ring1 * (0.55 + hash01(t.id, 3) * 0.3);
      }
      return { id: t.id, label: label(t.id), x: r1(x), y: r1(y), r: r1(1 + Math.min(2.2, Math.sqrt(t.dollars / 4e7))) };
    });
  };

  if (!self) return { ...empty, ghosts: ghostsFor(new Set()) };

  const first = (ties.get(center) ?? []).slice().sort(byDollars);
  const ring1Max = opts.ring1Max ?? 10;
  const shown = first.slice(0, ring1Max);
  const hidden = first.slice(ring1Max);
  const placed = new Set<string>([center, ...shown.map((l) => other(l, center))]);

  // Ring 2: each ring-1 party's other partners, largest first; a partner of
  // several hangs from the one that trades most with it.
  const perParent =
    opts.perParent ?? Math.max(2, Math.min(5, Math.floor((opts.ring2Max ?? 36) / Math.max(1, shown.length))));
  const children = new Map<string, Link[]>();
  const home = new Map<string, { parent: string; dollars: number }>();
  if (hops === 2) {
    for (const l of shown) {
      const parent = other(l, center);
      for (const t of (ties.get(parent) ?? []).slice().sort(byDollars)) {
        const child = other(t, parent);
        if (placed.has(child)) continue;
        const had = home.get(child);
        if (!had || t.dollars > had.dollars) home.set(child, { parent, dollars: t.dollars });
      }
    }
    for (const l of shown) {
      const parent = other(l, center);
      const mine = (ties.get(parent) ?? [])
        .filter((t) => home.get(other(t, parent))?.parent === parent)
        .sort(byDollars)
        .slice(0, perParent);
      children.set(parent, mine);
    }
  }

  const nodes: StarNode[] = [];
  const edges: StarEdge[] = [];
  const maxTie = Math.max(1, ...shown.map((l) => l.dollars));
  const centerNode: StarNode = {
    id: center,
    ring: 0,
    kind: kindOf(center),
    label: label(center),
    x: cx,
    y: cy,
    r: 20,
    angle: 0,
    dollars: self.dollars,
    awards: self.awards,
    labeled: true,
  };

  // Sectors: each ring-1 party gets room in proportion to what hangs from it.
  // The foot of the rings is left free (the center's name is set there), and
  // the largest party sits at the top, the next ones to either side of it.
  const arranged: Link[] = [];
  shown.forEach((l, i) => (i % 2 ? arranged.unshift(l) : arranged.push(l)));
  const slots = arranged.map((l) => 1.4 + (children.get(other(l, center))?.length ?? 0));
  const stub = hidden.length ? 1.4 : 0;
  const all = slots.reduce((s, v) => s + v, 0) + stub;
  const FOOT = (76 * Math.PI) / 180;
  const round = Math.PI * 2 - FOOT;
  let cursor = Math.PI / 2 + FOOT / 2;
  if (arranged.length === 1 && !stub) cursor = -Math.PI / 2 - round / 2; // a lone party: straight up
  const at = new Map<string, StarNode>();
  arranged.forEach((l, i) => {
    const id = other(l, center);
    const sweep = (slots[i] / all) * round;
    const angle = cursor + sweep / 2;
    const node: StarNode = {
      id,
      ring: 1,
      kind: kindOf(id),
      label: label(id),
      x: r1(cx + Math.cos(angle) * ring1),
      y: r1(cy + Math.sin(angle) * ring1),
      r: kindOf(id) === "company" ? r1(4 + 5 * Math.sqrt(l.dollars / maxTie)) : 8,
      angle,
      dollars: l.dollars,
      awards: l.awards.length,
      labeled: true,
    };
    nodes.push(node);
    at.set(id, node);
    edges.push({
      key: l.key,
      source: center,
      target: id,
      ring: 1,
      dollars: l.dollars,
      awards: l.awards,
      width: r1(1 + 4.5 * Math.sqrt(l.dollars / maxTie)),
      // Drawn left to right, so a label set along it is never upside down.
      d: node.x <= cx ? quad(node.x, node.y, cx, cy, 0.1) : quad(cx, cy, node.x, node.y, 0.1),
    });
    const kids = children.get(id) ?? [];
    const top = Math.max(1, ...kids.map((k) => k.dollars));
    kids.forEach((k, j) => {
      const kid = other(k, id);
      const t = kids.length === 1 ? 0.5 : j / (kids.length - 1);
      const a = cursor + sweep * (0.12 + 0.76 * t);
      // Alternate two depths so neighbors' names do not sit on one line.
      const depth = j % 2 ? 0.9 : 1;
      const child: StarNode = {
        id: kid,
        ring: 2,
        kind: kindOf(kid),
        label: label(kid),
        x: r1(cx + Math.cos(a) * r2x * depth),
        y: r1(cy + Math.sin(a) * r2y * depth),
        r: r1(1.6 + 3.2 * Math.sqrt(k.dollars / top)),
        angle: a,
        dollars: k.dollars,
        awards: k.awards.length,
        via: id,
        // Named when there is room for a name: at least a line's height of arc
        // between it and its neighbor. The rest say theirs on hover.
        labeled: j < 2 || (sweep * 0.76 * Math.min(r2x, r2y)) / Math.max(1, kids.length - 1) >= 24,
      };
      nodes.push(child);
      at.set(kid, child);
      placed.add(kid);
      edges.push({
        key: k.key,
        source: id,
        target: kid,
        ring: 2,
        dollars: k.dollars,
        awards: k.awards,
        width: 0.7,
        d: quad(node.x, node.y, child.x, child.y, j % 2 ? 0.1 : -0.1),
      });
    });
    cursor += sweep;
  });
  if (hidden.length) {
    const sweep = (stub / all) * round;
    const angle = cursor + sweep / 2;
    nodes.push({
      id: `${center}+more`,
      ring: 1,
      kind: kindOf(other(hidden[0], center)),
      label: `+ ${hidden.length} more`,
      x: r1(cx + Math.cos(angle) * ring1),
      y: r1(cy + Math.sin(angle) * ring1),
      r: 3,
      angle,
      dollars: hidden.reduce((s, l) => s + l.dollars, 0),
      awards: hidden.reduce((s, l) => s + l.awards.length, 0),
      more: hidden.length,
      labeled: true,
    });
  }
  // A ring-2 party that also trades with another ring-1 party: a second, fainter tie.
  if (hops === 2)
    for (const n of nodes.filter((n) => n.ring === 2))
      for (const t of ties.get(n.id) ?? []) {
        const o = other(t, n.id);
        const p = at.get(o);
        if (!p || p.ring !== 1 || o === n.via) continue;
        edges.push({
          key: t.key,
          source: o,
          target: n.id,
          ring: 2,
          dollars: t.dollars,
          awards: t.awards,
          width: 0.5,
          d: quad(p.x, p.y, n.x, n.y, 0.06),
          extra: true,
        });
      }

  return { width, height, cx, cy, r1: ring1, r2x, r2y, center: centerNode, nodes, edges, ghosts: ghostsFor(placed) };
}

// ---- The timeline ----

/** A tick's height for an award's dollars: a log scale, since awards run from
 *  thousands to hundreds of millions and a linear one would flatten most. */
export function tickHeight(amount: number | null, max: number, tallest: number, least = 4): number {
  const a = Math.max(1e4, amount ?? 0);
  const top = Math.max(1e5, max);
  const t = (Math.log10(a) - 4) / (Math.log10(top) - 4);
  return r1(least + (tallest - least) * Math.min(1, Math.max(0, t)));
}
