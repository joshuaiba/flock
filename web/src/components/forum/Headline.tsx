import { Art } from "@/components/Art";
import { AsOf, Delta } from "@/components/Signals";
import { money } from "@/lib/format";
import { forSolicitations } from "@/lib/signals";
import { getDefinitions, getOverview } from "./data";
import type { PanelProps } from "./shared";

// The top of the Forum: the as-of line and the four headline figures, each
// written on a painted cartouche.

const GRID = "mt-10 grid grid-cols-2 gap-x-3 gap-y-8 sm:gap-x-6 lg:grid-cols-4";

/** "As of Nov 11, 2026 · sample data", under the page title. */
export async function AsOfLine({ days, tag }: PanelProps) {
  const o = await getOverview(days, tag);
  if (!o) return <p className="fig text-muted">The data service is not answering.</p>;
  return <AsOf env={o} />;
}

/** One headline figure. The plaque is art (it sits under the paper grain and
 *  the birds); the figure, its label and its change are text, at z-20. The
 *  figure scales with the plaque (container units), so "$3.2B" and "1,204"
 *  stay inside the plaque's writable middle at any column width. */
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
  /** the line under the label: the change, or why there is none */
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col items-center text-center">
      <dt className="label order-2 relative z-20 mt-2">{label}</dt>
      <dd className="order-1 relative grid w-full place-items-center" style={{ aspectRatio: "861 / 341" }}>
        <Art
          name="ornaments/cartouche"
          sizes="(min-width: 1024px) 270px, 46vw"
          tint={0.18}
          className="absolute! inset-0"
        />
        {/* The box the figure is sized against (container units) is as wide
            as the plaque, holds only the figure and is itself at z-20. Some
            browsers make a size container a stacking context; were it a
            wrapper around the whole stat, the figure would be held under the
            birds with the plaque. */}
        <span className="@container relative z-20 block w-full">
          {/* The plaque is pale in day and at dusk, so the writing on it keeps
              its daylight colors: sepia, or the day's Pompeian red for money
              (the dusk red is too light to read on pale plaster). */}
          <span
            className={`mx-auto block w-[64%] font-display text-[clamp(1.5rem,13cqw,2.5rem)] leading-none lining-nums tabular-nums ${isMoney ? "" : "on-art"}`}
            style={isMoney ? { color: "#b9655a" } : undefined}
          >
            {value}
          </span>
        </span>
      </dd>
      <dd className="order-3 relative z-20 mt-0.5 leading-tight">{children}</dd>
    </div>
  );
}

/** Total dollars awarded, awards, new entrants and open solicitations in the
 *  window, each against the prior period. */
export async function HeadlineStats({ days, tag }: PanelProps) {
  const [o, defs] = await Promise.all([getOverview(days, tag), getDefinitions()]);
  if (!o)
    return (
      <p className="relative z-20 mt-10 text-center text-muted" data-flock-avoid>
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
    <dl className={GRID} data-flock-avoid>
      <Stat label="Awarded" value={money(o.amount)} money>
        <Delta cur={o.amount} prev={o.prev_amount} pct={thinPrior ? null : undefined} env={o} />
      </Stat>
      <Stat label="Awards" value={o.awards.toLocaleString("en-US")}>
        <Delta cur={o.awards} prev={o.prev_awards} env={o} />
      </Stat>
      <Stat label="New entrants" value={o.new_entrants.toLocaleString("en-US")}>
        <Delta cur={o.new_entrants} prev={o.prev_new_entrants} env={o} />
        {/* "New" is new to this record, which starts when the sources do. */}
        <span className="fig block text-[0.8rem] text-muted">first award in this record</span>
      </Stat>
      {noSolicitations ? (
        <Stat label="Open solicitations" value="—">
          <span className="fig text-[0.86rem] text-muted">no solicitations on record</span>
        </Stat>
      ) : (
        <Stat label="Open solicitations" value={o.open_solicitations.toLocaleString("en-US")}>
          <Delta cur={o.open_solicitations} prev={o.prev_open_solicitations} env={forSolicitations(o)} />
        </Stat>
      )}
    </dl>
  );
}

/** Four plaster blocks the shape of the plaques, while the overview loads. */
export function StatsSkeleton() {
  return (
    <div className={GRID} aria-busy="true">
      <span className="sr-only">Loading the headline figures</span>
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="relative z-20 flex flex-col items-center gap-2" aria-hidden="true">
          <span className="skeleton w-full rounded-3xl" style={{ aspectRatio: "861 / 341" }} />
          <span className="skeleton h-3 w-24" />
          <span className="skeleton h-3 w-32" />
        </div>
      ))}
    </div>
  );
}
