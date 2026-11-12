import { AsOf, Delta } from "@/components/Signals";
import { money } from "@/lib/format";
import { forSolicitations } from "@/lib/signals";
import { getDefinitions, getOverview } from "./data";
import type { PanelProps } from "./shared";
import "./forum.css";

// The top of the Forum: the as-of line and the summary row, four totals in
// plain figures, each with its change against the prior period.

/** "As of Nov 11, 2026 · sample data", under the page title. */
export async function AsOfLine({ days, tag }: PanelProps) {
  const o = await getOverview(days, tag);
  if (!o) return <p className="ui text-muted">The data service is not answering.</p>;
  return <AsOf env={o} />;
}

/** One total: what it counts, the figure, and the line under it (the change,
 *  or why there is none). */
function Stat({
  label,
  value,
  money: isMoney = false,
  children,
}: {
  label: string;
  value: string;
  /** Pompeian red: only for dollars awarded */
  money?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="forum-kpi">
      <dt className="label">{label}</dt>
      <dd className={`forum-kpi-value ${isMoney ? "text-accent" : ""}`}>{value}</dd>
      <dd className="forum-kpi-delta">{children}</dd>
    </div>
  );
}

/** Total dollars awarded, awards, new entrants and open solicitations in the
 *  window, each against the prior period. */
export async function HeadlineStats({ days, tag }: PanelProps) {
  const [o, defs] = await Promise.all([getOverview(days, tag), getDefinitions()]);
  if (!o)
    return (
      <p className="relative z-20 mt-6 border-y border-line2 py-6 text-muted">
        The data service is not answering, so there are no headline figures to show.
      </p>
    );
  // With no solicitation source loaded there is nothing to count: say so,
  // rather than print a zero that looks like a finding.
  const noSolicitations = defs != null && defs.opportunities === 0;
  // A change in dollars gets no percentage when the prior period is under the
  // baseline (see "About the numbers"); the overview carries no pct of its own.
  const thinPrior = defs != null && o.prev_amount > 0 && o.prev_amount < defs.min_baseline;
  return (
    <dl className="forum-kpis relative z-20 mt-6">
      <Stat label="Awarded" value={money(o.amount)} money>
        <Delta cur={o.amount} prev={o.prev_amount} pct={thinPrior ? null : undefined} env={o} />
      </Stat>
      <Stat label="Awards" value={o.awards.toLocaleString("en-US")}>
        <Delta cur={o.awards} prev={o.prev_awards} env={o} />
      </Stat>
      <Stat label="New entrants" value={o.new_entrants.toLocaleString("en-US")}>
        <Delta cur={o.new_entrants} prev={o.prev_new_entrants} env={o} />
        {/* "New" is new to this record, which starts when the sources do. */}
        <span className="ui block text-muted">first award in this record</span>
      </Stat>
      {noSolicitations ? (
        <Stat label="Open solicitations" value="—">
          <span className="ui text-muted">no solicitations on record</span>
        </Stat>
      ) : (
        <Stat label="Open solicitations" value={o.open_solicitations.toLocaleString("en-US")}>
          <Delta cur={o.open_solicitations} prev={o.prev_open_solicitations} env={forSolicitations(o)} />
        </Stat>
      )}
    </dl>
  );
}

/** The summary row as plaster blocks, while the overview loads. */
export function StatsSkeleton() {
  return (
    <div className="forum-kpis relative z-20 mt-6" aria-busy="true">
      <span className="sr-only">Loading the headline figures</span>
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="forum-kpi" aria-hidden="true">
          <span className="skeleton h-3 w-24" />
          <span className="skeleton mt-3 h-9 w-28" />
          <span className="skeleton mt-3 h-3 w-36 max-w-full" />
        </div>
      ))}
    </div>
  );
}
