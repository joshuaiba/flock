import { describe, expect, it } from "vitest";
import {
  buildModel,
  filterAwards,
  headline,
  layoutConstellation,
  layoutSankey,
  names,
  NO_FILTERS,
  OTHERS,
  parseWindowKey,
  pct,
  type Award,
  type Flows,
} from "./flows";
import { layoutStarChart, R, SIZE } from "./starChart";

// A small record: three agencies, four missions, forty companies, awards
// spread over July and August. Amounts and pairings come from a fixed
// arithmetic pattern, so every run draws the same thing.
const AGENCIES = ["org:1", "org:2", "org:3", "org:4"];
const MISSIONS = ["uas", "counter-uas", "maritime", "swarming"];

function record(): Flows {
  const awards: Award[] = [];
  for (let i = 0; i < 120; i++) {
    const company = `org:${100 + (i % 40)}`;
    const agency = AGENCIES[i % 7 === 0 ? 3 : i % 3];
    const missions = i % 5 === 0 ? [MISSIONS[i % 4], MISSIONS[(i + 1) % 4]] : [MISSIONS[(i % 40) % 4]];
    awards.push({
      id: i + 1,
      day: `2026-0${7 + (i % 2)}-${String(1 + (i % 19)).padStart(2, "0")}`,
      amount: 100_000 * (1 + (i % 11)) * (company === "org:100" ? 40 : 1),
      agency,
      company,
      missions,
      url: `https://www.usaspending.gov/award/${i + 1}`,
      source: "usaspending",
      source_id: String(i + 1),
      description: null,
      opportunity: null,
    });
  }
  awards.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.id - b.id));
  const party = (id: string, kind: "agency" | "company") => ({
    id,
    org_id: Number(id.slice(4)),
    name: `${kind} ${id}`,
    display_name: `${kind === "agency" ? "Agency" : "Company"} ${id.slice(4)}`,
    kind,
    uei: null,
    dollars: awards.filter((a) => a.agency === id || a.company === id).reduce((s, a) => s + (a.amount ?? 0), 0),
    awards: awards.filter((a) => a.agency === id || a.company === id).length,
  });
  const companies = [...new Set(awards.map((a) => a.company))]
    .map((id) => ({ ...party(id, "company"), missions: [], first_award: "2026-07-01", first_award_id: 1 }))
    .sort((a, b) => b.dollars - a.dollars);
  const w = {
    key: "90d" as const,
    days: 90,
    start: "2026-05-22",
    end: "2026-08-19",
    latest_data_date: "2026-08-19",
    label: "90 days to Aug 19",
  };
  return {
    window: w,
    windows: [w],
    sample: true,
    max_award_id: 120,
    totals: { dollars: 0, awards: awards.length, companies: companies.length, agencies: 4 },
    agencies: AGENCIES.map((id) => party(id, "agency")).sort((a, b) => b.dollars - a.dollars),
    missions: MISSIONS.map((slug) => ({ id: `tag:${slug}`, slug, dollars: 0, awards: 0, companies: 0 })),
    companies,
    flows: [],
    awards,
    solicitations: [],
  };
}

const sum = (xs: Iterable<{ dollars: number }>) => [...xs].reduce((s, x) => s + x.dollars, 0);
const order = (data: Flows) => {
  const m = new Map<string, number>();
  data.agencies.forEach((a, i) => m.set(a.id, i));
  data.companies.forEach((c, i) => m.set(c.id, i));
  data.missions.forEach((x, i) => m.set(x.id, i));
  return m;
};
const SANKEY = { width: 1000, minHeight: 560, perMission: 4, maxNamed: 11, left: 172, right: 250 };

describe("window keys", () => {
  it("reads the four windows and the old name for 90 days", () => {
    expect(parseWindowKey("30d")).toBe("30d");
    expect(parseWindowKey("ALL")).toBe("all");
    expect(parseWindowKey("recent")).toBe("90d");
    expect(parseWindowKey(["1y", "30d"])).toBe("1y");
    expect(parseWindowKey("7d")).toBeNull();
    expect(parseWindowKey(undefined)).toBeNull();
  });
});

describe("filters", () => {
  const data = record();
  it("keeps both ends of the brushed days", () => {
    const got = filterAwards(data.awards, { ...NO_FILTERS, from: "2026-07-05", to: "2026-07-09" });
    expect(got.length).toBeGreaterThan(0);
    expect(got.every((a) => a.day >= "2026-07-05" && a.day <= "2026-07-09")).toBe(true);
    expect(got.some((a) => a.day === "2026-07-05")).toBe(true);
    expect(got.some((a) => a.day === "2026-07-09")).toBe(true);
  });
  it("filters by agency, least award, mission and what is new", () => {
    expect(filterAwards(data.awards, { ...NO_FILTERS, agency: "org:2" }).every((a) => a.agency === "org:2")).toBe(true);
    expect(filterAwards(data.awards, { ...NO_FILTERS, min: 1e6 }).every((a) => (a.amount ?? 0) >= 1e6)).toBe(true);
    const sea = filterAwards(data.awards, { ...NO_FILTERS, missions: new Set(["maritime"]) });
    expect(sea.length).toBeGreaterThan(0);
    expect(sea.every((a) => a.missions.includes("maritime"))).toBe(true);
    expect(
      filterAwards(data.awards, { ...NO_FILTERS, sinceId: 110 })
        .map((a) => a.id)
        .sort((a, b) => a - b),
    ).toEqual([111, 112, 113, 114, 115, 116, 117, 118, 119, 120]);
  });
});

describe("the tally", () => {
  const data = record();
  const total = data.awards.reduce((s, a) => s + (a.amount ?? 0), 0);
  it("adds up to the same dollars in every column", () => {
    const m = buildModel(data.awards);
    expect(m.total).toBeCloseTo(total, 3);
    for (const col of [m.agencies, m.missions, m.companies, m.am, m.mc, m.ac])
      expect(sum(col.values())).toBeCloseTo(total, 3);
  });
  it("splits a two-mission award evenly", () => {
    const one: Award = { ...data.awards[0], amount: 1000, missions: ["uas", "maritime"] };
    const m = buildModel([one]);
    expect(m.missions.get("tag:uas")!.dollars).toBe(500);
    expect(m.missions.get("tag:maritime")!.dollars).toBe(500);
    expect(m.ac.get(`${one.agency}>${one.company}`)!.dollars).toBe(1000);
  });
  it("counts only the shown missions' shares, in every column alike", () => {
    const shown = new Set(["maritime"]);
    const m = buildModel(filterAwards(data.awards, { ...NO_FILTERS, missions: shown }), shown);
    expect([...m.missions.keys()]).toEqual(["tag:maritime"]);
    for (const col of [m.agencies, m.companies, m.am, m.mc, m.ac]) expect(sum(col.values())).toBeCloseTo(m.total, 3);
    expect(m.total).toBeLessThan(total);
  });
  it("prints shares that never round to a lie", () => {
    expect(pct(999, 1000)).toBe("99%");
    expect(pct(1000, 1000)).toBe("100%");
    expect(pct(1, 1000)).toBe("<1%");
    expect(pct(0, 1000)).toBe("0%");
    expect(pct(474, 1000)).toBe("47%");
  });
  it("writes the headline from the three largest payers", () => {
    const m = buildModel(data.awards);
    const h = headline(m, names(data))!;
    expect(h.agencies).toHaveLength(3);
    expect(h.claim).toMatch(/^Agency \d, Agency \d and Agency \d paid \d+% of autonomy dollars$/);
    expect(h.share).toBeGreaterThan(0.5);
    expect(h.share).toBeLessThan(1);
    expect(h.leaders).toMatch(/^Company 100 and Company \d+ lead\.$/);
    expect(headline(buildModel([]), names(data))).toBeNull();
  });
});

describe("the Sankey", () => {
  const data = record();
  const who = names(data);
  const s = layoutSankey(buildModel(data.awards), who, order(data), SANKEY);
  it("draws the same picture twice", () => {
    expect(layoutSankey(buildModel(data.awards), who, order(data), SANKEY)).toEqual(s);
  });
  it("folds the tail into one node that says how many it holds", () => {
    const named = s.nodes.filter((n) => n.col === 2 && n.id !== OTHERS);
    const tail = s.nodes.find((n) => n.id === OTHERS)!;
    expect(named.length).toBeLessThanOrEqual(SANKEY.maxNamed);
    expect(tail.folded).toBe(40 - named.length);
    expect(tail.label).toBe(`All other companies (${tail.folded})`);
    expect(named.reduce((x, n) => x + n.dollars, 0) + tail.dollars).toBeCloseTo(buildModel(data.awards).total, 3);
  });
  it("keeps labels a line apart and inside the drawing", () => {
    for (const col of [0, 1, 2]) {
      const ns = s.nodes.filter((n) => n.col === col);
      for (let i = 1; i < ns.length; i++) expect(ns[i].y - ns[i - 1].y).toBeGreaterThanOrEqual(16.9);
      expect(ns[ns.length - 1].y + ns[ns.length - 1].h).toBeLessThanOrEqual(s.height);
    }
  });
  it("keeps the columns' order when a filter thins them", () => {
    const some = filterAwards(data.awards, { ...NO_FILTERS, from: "2026-08-01", to: "2026-08-19" });
    const t = layoutSankey(buildModel(some), who, order(data), SANKEY);
    for (const col of [0, 1]) {
      const before = s.nodes.filter((n) => n.col === col).map((n) => n.id);
      const after = t.nodes.filter((n) => n.col === col).map((n) => n.id);
      expect(after).toEqual(before.filter((id) => after.includes(id)));
    }
  });
  it("gives every band its awards", () => {
    expect(s.bands.length).toBeGreaterThan(8);
    expect(s.bands.every((b) => b.awards.length > 0 && b.h > 0 && b.d.startsWith("M"))).toBe(true);
  });
});

describe("the constellation", () => {
  const data = record();
  const who = names(data);
  const model = buildModel(data.awards);
  const opts = { width: 1000, height: 740 };
  it("is fixed: the same center draws the same rings", () => {
    expect(layoutConstellation(model, who, "org:100", 2, opts)).toEqual(
      layoutConstellation(model, who, "org:100", 2, opts),
    );
  });
  it("puts a company's payers on ring 1 and leaves the foot free for its name", () => {
    const c = layoutConstellation(model, who, "org:100", 2, opts);
    const ring1 = c.nodes.filter((n) => n.ring === 1);
    expect(ring1.length).toBeGreaterThan(0);
    expect(ring1.every((n) => n.kind !== "company")).toBe(true);
    // Straight down is +90 degrees; nothing on ring 1 sits within 38 of it.
    for (const n of ring1) {
      const fromDown = Math.abs(((((n.angle - Math.PI / 2) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
      expect(fromDown).toBeGreaterThan((37 * Math.PI) / 180);
    }
    expect(c.center?.id).toBe("org:100");
  });
  it("shows ring 2 only at two hops, and ghosts the rest", () => {
    const one = layoutConstellation(model, who, "org:100", 1, opts);
    const two = layoutConstellation(model, who, "org:100", 2, opts);
    expect(one.nodes.some((n) => n.ring === 2)).toBe(false);
    expect(two.nodes.some((n) => n.ring === 2)).toBe(true);
    const placed = new Set([two.center!.id, ...two.nodes.map((n) => n.id)]);
    expect(two.ghosts.length).toBeGreaterThan(0);
    expect(two.ghosts.every((g) => !placed.has(g.id))).toBe(true);
  });
  it("re-centers on an agency: its companies on ring 1", () => {
    const c = layoutConstellation(model, who, "org:1", 2, opts);
    expect(c.nodes.filter((n) => n.ring === 1 && !n.more).every((n) => n.kind === "company")).toBe(true);
    expect(c.nodes.some((n) => n.more)).toBe(true);
  });
});

describe("the star chart", () => {
  const data = record();
  const who = names(data);
  const model = buildModel(data.awards);
  const chart = layoutStarChart(data, model, who);
  it("is the same on every load", () => {
    expect(layoutStarChart(data, model, who)).toEqual(chart);
  });
  it("keeps every star between the hub and the limb, in its own sector", () => {
    const c = SIZE / 2;
    for (const s of chart.stars) {
      const r = Math.hypot(s.x - c, s.y - c);
      expect(r).toBeGreaterThanOrEqual(R.starMin - 1);
      expect(r).toBeLessThanOrEqual(R.starMax + 1);
      const sector = chart.sectors.find((x) => x.id === s.sector)!;
      const angle = (Math.atan2(s.x - c, -(s.y - c)) + 2 * Math.PI) % (2 * Math.PI);
      expect(angle).toBeGreaterThanOrEqual(sector.a0 - 0.01);
      expect(angle).toBeLessThanOrEqual(sector.a1 + 0.01);
    }
  });
  it("draws an arc for real flows only, and the newest awards as their own", () => {
    expect(chart.arcs.length).toBeGreaterThan(0);
    expect(chart.arcs.every((a) => model.ac.has(a.key))).toBe(true);
    expect(chart.live.length).toBe(14);
    const newest = [...data.awards].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : b.id - a.id)).slice(0, 14);
    expect(chart.live.map((l) => l.award.id)).toEqual(newest.map((a) => a.id));
  });
  it("puts the largest payer at the top of the ring and marks the three leaders", () => {
    expect(chart.agencies[0].angle).toBe(0);
    expect(chart.agencies.filter((a) => a.lead)).toHaveLength(3);
  });
});
