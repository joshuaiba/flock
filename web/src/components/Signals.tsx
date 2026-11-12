import Link from "next/link";
import { medallionFor } from "@/lib/art";
import { day } from "@/lib/format";
import { change, pct, priorLabel, STAGE_LABEL, type Envelope, type SignalOrg, type StagePoint } from "@/lib/signals";
import { MedallionImg } from "./Art";

// Shared pieces of the Forum, the leaderboards and the entity page's signals.
// All of them render on the server; nothing here needs the browser.

/** One section of a dashboard: a hairline, a plain serif title, an optional
 *  line saying what is counted, an optional one-sentence reading, then the
 *  content. It is not a card: sections are told apart by the rule and by
 *  space. It sits above the paper grain (z-20), like everything with text. */
export function Panel({
  title,
  note,
  takeaway,
  more,
  className = "",
  id,
  children,
}: {
  title: string;
  /** a short line under the title: what is being counted */
  note?: React.ReactNode;
  /** one sentence read off the data, shown above a chart */
  takeaway?: React.ReactNode;
  /** a link beside the title, e.g. to the full leaderboard */
  more?: { href: string; label: string };
  className?: string;
  id?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className={`relative z-20 flex flex-col border-t border-frame pt-5 ${className}`}>
      <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h2 className="panel-title">{title}</h2>
        {more && (
          <Link href={more.href} className="ui-link">
            {more.label}
          </Link>
        )}
      </header>
      {takeaway && <p className="takeaway mt-2 max-w-[46rem]">{takeaway}</p>}
      {note && <p className="ui mt-2 max-w-[46rem] text-muted">{note}</p>}
      <div className="mt-4 min-w-0 flex-1">{children}</div>
    </section>
  );
}

/** Growth with its sign, for a change column: 0.41 -> "+41%", -0.12 -> "−12%".
 *  Tenfold growth and more is a multiple of the prior figure ("13×"), which
 *  needs no sign: a multiple is growth. */
export function signedPct(v: number): string {
  const t = pct(v);
  if (t.endsWith("×")) return t;
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return t === "under 1%" ? `${sign}<1%` : `${sign}${t}`;
}

/** Change against the prior period: "+41% vs the prior 90 days". The sign
 *  carries the direction, in tabular figures. Says so when there is nothing to
 *  compare with, never a made-up zero.
 *
 *  Pass `pct` when the API gives one for this figure: `null` there means the
 *  API withheld the percentage (the prior period is under its baseline), and
 *  this says so instead of working one out from the two amounts. */
export function Delta({
  cur,
  prev,
  env,
  pct: given,
  short = false,
}: {
  cur: number;
  prev: number;
  env: Pick<Envelope, "window_days" | "coverage">;
  pct?: number | null;
  /** just the signed figure, for tight rows */
  short?: boolean;
}) {
  const quiet = "ui text-muted";
  if (!env.coverage.prior_complete) return <span className={quiet}>no earlier period on record</span>;
  if (given === null && prev > 0)
    return <span className={quiet}>too little in {priorLabel(env.window_days)} for a percentage</span>;
  const c = change(cur, prev, true);
  if (!c) return <span className={quiet}>nothing in {priorLabel(env.window_days)}</span>;
  if (c.flat) return <span className={quiet}>level{!short && <> with {priorLabel(env.window_days)}</>}</span>;
  const text = signedPct((cur - prev) / prev);
  // "+41% vs the prior 90 days", but "13× the prior 90 days".
  const joiner = text.endsWith("×") ? "" : "vs ";
  return (
    <span className={quiet}>
      <span className="delta text-ink">{text}</span>
      {!short && (
        <>
          {" "}
          {joiner}
          {priorLabel(env.window_days)}
        </>
      )}
    </span>
  );
}

/** Movement in a ranking, as places gained or lost: "+3", "−1", "new", or a
 *  dash. `since` names what the earlier rank is from ("the prior period"
 *  unless said otherwise). When the earlier period is not fully on record,
 *  pass `complete={false}` and nothing is shown: a move against a partial
 *  period would be made up. */
export function RankChange({
  rank,
  prev,
  since = "the prior period",
  complete = true,
}: {
  rank: number | null;
  prev: number | null;
  since?: string;
  complete?: boolean;
}) {
  if (rank == null || !complete) return null;
  if (prev == null)
    return (
      <span className="delta text-muted" title={`not ranked in ${since}`}>
        new
      </span>
    );
  const d = prev - rank;
  if (d === 0)
    return (
      <span className="delta text-muted" title={`same place as in ${since}`}>
        <span aria-hidden="true">–</span>
        <span className="sr-only">no change</span>
      </span>
    );
  return (
    <span className="delta text-ink" title={`was ${prev} in ${since}`}>
      {d > 0 ? "+" : "−"}
      {Math.abs(d)}
      <span className="sr-only"> {Math.abs(d) === 1 ? "place" : "places"}</span>
    </span>
  );
}

/** An organization in a row: its medallion, its name linked to its page, and a
 *  small link that opens the graph on it. */
export function OrgLink({
  org,
  size = 30,
  graph = true,
  className = "",
}: {
  org: SignalOrg;
  size?: number;
  graph?: boolean;
  className?: string;
}) {
  return (
    <span className={`inline-flex min-w-0 items-center gap-2 ${className}`}>
      <MedallionImg name={medallionFor(org.tag, org.kind)} size={size} />
      <Link href={`/entity/${org.id}`} className="min-w-0 truncate">
        {org.name}
      </Link>
      {graph && <GraphLink id={org.id} name={org.name} />}
    </span>
  );
}

/** "Show in graph": opens the graph focused on one organization. */
export function GraphLink({ id, name, label = false }: { id: number; name: string; label?: boolean }) {
  return (
    <Link
      href={`/graph?focus=${encodeURIComponent(`org:${id}`)}`}
      className={label ? "ui-link" : "shrink-0 text-muted/70 no-underline transition-colors hover:text-ink"}
      aria-label={`Show ${name} in the graph`}
      title="Show in graph"
    >
      {label ? (
        "Show in graph"
      ) : (
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.1" aria-hidden="true">
          <circle cx="3.5" cy="11.5" r="1.9" />
          <circle cx="12.5" cy="12" r="1.9" />
          <circle cx="8.5" cy="3.5" r="1.9" />
          <path d="M4.6 10 7.5 5.2M9.6 5 11.8 10.2M5.4 11.6l5.2.3" />
        </svg>
      )}
    </Link>
  );
}

/** The four stages as dots on a line. A dot is filled only when our data shows
 *  the company at that stage; a skipped stage stays hollow. */
export function StageTrack({ path, className = "" }: { path: StagePoint[]; className?: string }) {
  const reached = path.filter((p) => p.day).map((p) => STAGE_LABEL[p.stage]);
  return (
    <span className={`inline-flex items-center ${className}`} role="img" aria-label={`Stages reached: ${reached.join(", ") || "none"}`}>
      {path.map((p, i) => (
        <span key={p.stage} className="inline-flex items-center" title={`${STAGE_LABEL[p.stage]}${p.day ? `: ${day(p.day)}` : ": not on record"}`}>
          {i > 0 && <span className={`h-px w-4 sm:w-5 ${p.day && path[i - 1].day ? "bg-cypress" : "bg-frame"}`} />}
          <span
            className={`block h-2.5 w-2.5 rounded-full border ${p.day ? "border-cypress bg-cypress" : "border-muted/60 bg-transparent"}`}
          />
        </span>
      ))}
    </span>
  );
}

/** "As of Nov 11, 2026 · sample data": the line every signals page carries. */
export function AsOf({ env, className = "" }: { env: Pick<Envelope, "as_of" | "sample">; className?: string }) {
  return (
    <p className={`ui text-muted ${className}`}>
      As of {day(env.as_of)}
      {env.sample && " · sample data"}
    </p>
  );
}

/** Loading rows for a ledger or a list: plaster blocks, no spinner. */
export function SkeletonRows({ rows = 6, className = "" }: { rows?: number; className?: string }) {
  return (
    <div className={className} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-10 items-center gap-3 border-b border-hair">
          <span className="skeleton h-[22px] w-[22px] shrink-0 rounded-full" />
          <span className="skeleton h-3.5" style={{ width: `${46 - ((i * 7) % 22)}%` }} />
          <span className="skeleton ml-auto h-3.5 w-16" />
        </div>
      ))}
    </div>
  );
}

/** A section-shaped placeholder while a signal loads. */
export function PanelSkeleton({ title, rows = 6, className = "" }: { title: string; rows?: number; className?: string }) {
  return (
    <section className={`relative z-20 border-t border-frame pt-5 ${className}`} aria-busy="true">
      <h2 className="panel-title">{title}</h2>
      <span className="sr-only">Loading</span>
      <span className="skeleton mt-3 h-3.5 w-full max-w-md" aria-hidden="true" />
      <SkeletonRows rows={rows} className="mt-5" />
    </section>
  );
}

/** A quiet line inside a panel when a signal has no rows behind it. */
export function NoRows({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-muted">{children}</p>;
}
