import Link from "next/link";
import { dollars, moneyRound } from "@/lib/format";
import {
  buildModel,
  byDollars,
  dayNumber,
  layoutConstellation,
  layoutSankey,
  missionLabel,
  names,
  span,
  tickHeight,
  type Flows,
} from "@/lib/flows";

// The landing page under the hero: three ways into the tool, who leads, and
// how the entities spread across missions. Server components: the numbers are
// in the page's HTML. The three small drawings are not decoration: each is the
// real window, drawn the way its view draws it.

const focus = (id: string, view?: string) => `/graph?${view ? `view=${view}&` : ""}focus=${encodeURIComponent(id)}`;

function FlowThumb({ data }: { data: Flows }) {
  const who = names(data);
  const model = buildModel(data.awards);
  const order = new Map<string, number>();
  data.agencies.forEach((a, i) => order.set(a.id, i));
  data.companies.forEach((c, i) => order.set(c.id, i));
  [...data.missions].sort(byDollars).forEach((m, i) => order.set(m.id, i));
  const s = layoutSankey(model, who, order, {
    width: 300,
    minHeight: 180,
    perMission: 1,
    maxNamed: 5,
    left: 20,
    right: 20,
  });
  const lead = s.nodes.find((n) => n.col === 0)?.id;
  return (
    <svg viewBox={`0 26 300 ${s.height - 30}`} preserveAspectRatio="none" aria-hidden="true" className="ld-thumb">
      {s.bands.map((b) => (
        <path key={b.key} d={b.d} className={b.source === lead ? "ld-th-band ld-th-on" : "ld-th-band"} />
      ))}
      {s.nodes.map((n) => (
        <rect key={n.id} x={n.col === 0 ? n.x + 2 : n.x} y={n.y} width={6} height={n.h} className="ld-th-node" />
      ))}
    </svg>
  );
}

function ConstellationThumb({ data }: { data: Flows }) {
  const who = names(data);
  const model = buildModel(data.awards);
  const top = [...model.companies.values()].sort(byDollars)[0];
  if (!top) return null;
  const c = layoutConstellation(model, who, top.id, 2, {
    width: 300,
    height: 190,
    ghosts: 70,
    perParent: 3,
    ring1Max: 5,
    padX: 40,
    padY: 14,
  });
  return (
    <svg viewBox="0 0 300 190" aria-hidden="true" className="ld-thumb">
      {c.ghosts.map((g) => (
        <circle key={g.id} cx={g.x} cy={g.y} r={1} className="ld-th-ghost" />
      ))}
      {c.edges.map((e) => (
        <path
          key={`${e.key}${e.extra ? "x" : ""}`}
          d={e.d}
          className={e.ring === 1 ? "ld-th-edge1" : "ld-th-edge2"}
          style={e.ring === 1 ? { strokeWidth: Math.max(0.8, e.width * 0.55) } : undefined}
        />
      ))}
      {c.nodes.map((n) => (
        <circle
          key={n.id}
          cx={n.x}
          cy={n.y}
          r={n.ring === 1 ? 4.5 : 1.6}
          className={n.ring === 1 ? "ld-th-ring" : "ld-th-dot"}
        />
      ))}
      <circle cx={c.cx} cy={c.cy} r={10} className="ld-th-ring" />
      <circle cx={c.cx} cy={c.cy} r={4} className="ld-th-core" />
    </svg>
  );
}

function TimelineThumb({ data }: { data: Flows }) {
  const days = span(data.window, data.awards);
  if (!days) return null;
  const d0 = dayNumber(days.start);
  const d1 = dayNumber(days.end);
  const max = data.awards.reduce((m, a) => Math.max(m, a.amount ?? 0), 0);
  const x = (iso: string) => Math.round((10 + ((dayNumber(iso) - d0) / Math.max(1, d1 - d0)) * 280) * 10) / 10;
  const lead = data.agencies[0]?.id;
  // The newest third of the window, bracketed like a brush.
  const from = 10 + 280 * (2 / 3);
  return (
    <svg viewBox="0 0 300 190" aria-hidden="true" className="ld-thumb">
      <line x1="10" y1="150" x2="290" y2="150" className="ld-th-axis" />
      {data.awards.map((a) => (
        <line
          key={a.id}
          x1={x(a.day)}
          y1={150}
          x2={x(a.day)}
          y2={150 - tickHeight(a.amount, max, 110)}
          className={a.agency === lead ? "ld-th-tick ld-th-tick-on" : "ld-th-tick"}
        />
      ))}
      <rect x={from} y="26" width={290 - from} height="132" className="ld-th-brush" />
    </svg>
  );
}

const WAYS = [
  {
    n: "I.",
    title: "Flow",
    body: "Who pays whom. Agency to mission to company, with every band sized by dollars and traceable to its contracts.",
    href: "/graph",
    cta: "Open the flow",
    Thumb: FlowThumb,
  },
  {
    n: "II.",
    title: "Constellation",
    body: "Pick any company or agency and see its neighborhood: who funds it, who else they fund, and what it builds.",
    href: "/graph?view=constellation",
    cta: "Explore a company",
    Thumb: ConstellationThumb,
  },
  {
    n: "III.",
    title: "Timeline",
    body: "What changed and when. Every award as a tick across the window, a brush to narrow it, and what is new since you last looked.",
    href: "/graph?view=timeline",
    cta: "See what changed",
    Thumb: TimelineThumb,
  },
] as const;

export function ThreeWays({ data }: { data: Flows }) {
  return (
    <section className="ld-section">
      <div className="ld-section-head">
        <h2 className="ld-h2">Three ways into the money</h2>
        <p>Start from a flow, a single company or a date. Each view is drawn from the same contracts.</p>
      </div>
      <div className="ld-ways">
        {WAYS.map(({ n, title, body, href, cta, Thumb }) => (
          <article key={title} className="ld-way">
            <div className="ld-way-art">
              <Thumb data={data} />
            </div>
            <div className="ld-way-title">
              <span>{n}</span>
              <h3>{title}</h3>
            </div>
            <p>{body}</p>
            <Link href={href} className="ld-way-link">
              {cta} →
            </Link>
          </article>
        ))}
      </div>
    </section>
  );
}

export function Report({ data }: { data: Flows }) {
  const who = names(data);
  const leaders = data.companies.slice(0, 6);
  const top = leaders[0]?.dollars || 1;
  const missions = data.missions
    .filter((m) => m.companies > 0)
    .sort((a, b) => b.companies - a.companies || b.dollars - a.dollars);
  const most = missions[0]?.companies || 1;
  return (
    <section id="report" className="ld-section ld-report">
      <div>
        <h2 className="ld-h2 ld-h2-small">Who&rsquo;s getting paid</h2>
        <p className="ld-label">Top recipients · {data.window.label}</p>
        <ol className="ld-leaders">
          {leaders.map((c, i) => (
            <li key={c.id}>
              <span className="ld-rank">{String(i + 1).padStart(2, "0")}</span>
              <span className="ld-leader">
                <Link href={focus(c.id, "constellation")}>{who.get(c.id)?.label ?? c.name}</Link>
                <span className="ld-leader-sub">{c.missions.slice(0, 2).map(missionLabel).join(" · ")}</span>
                <span className="ld-bar" aria-hidden="true">
                  <span style={{ width: `${Math.max(1.5, (c.dollars / top) * 100)}%` }} />
                </span>
              </span>
              <Link
                href={`${focus(c.id, "flow")}#ex-records`}
                className="ld-amount"
                title={`${dollars(c.dollars)} across ${c.awards} ${c.awards === 1 ? "award" : "awards"} · see the records`}
              >
                {moneyRound(c.dollars)}
              </Link>
            </li>
          ))}
        </ol>
        <Link href="/forum/leaderboards" className="ld-way-link">
          Full leaderboard →
        </Link>
      </div>
      <div>
        <h2 className="ld-h2 ld-h2-small">Where the activity is</h2>
        <p className="ld-label">Companies by mission · {data.window.label}</p>
        <ul className="ld-missions">
          {missions.map((m) => (
            <li key={m.id}>
              <Link href={focus(m.id)}>{missionLabel(m.slug)}</Link>
              <span className="ld-bar" aria-hidden="true">
                <span
                  style={{
                    width: `${Math.max(1.5, (m.companies / most) * 100)}%`,
                    opacity: 0.45 + 0.55 * (m.companies / most),
                  }}
                />
              </span>
              <span className="ld-count" title={`${moneyRound(m.dollars)} awarded`}>
                {m.companies}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
