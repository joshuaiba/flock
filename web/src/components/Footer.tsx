import Link from "next/link";
import { Landscape } from "./Landscape";

/** Footer: a plaster card with a fine frame, holding a painted lake scene that
 *  dissolves upward into the card. */
export function Footer({ sample }: { sample?: boolean }) {
  return (
    <footer className="relative z-20 mx-auto mt-28 w-full max-w-6xl px-4 pb-8 sm:px-6">
      <div className="paper-card relative overflow-hidden" data-flock-avoid>
        <div className="relative z-10 grid gap-10 p-8 sm:grid-cols-[1.4fr_1fr_1fr] sm:p-12">
          <div>
            <p className="font-display text-3xl">flock</p>
            <p className="mt-3 max-w-xs text-muted">
              Following the money on the frontier of autonomy, from solicitation to production.
            </p>
          </div>
          <div>
            <p className="label">Explore</p>
            <ul className="mt-3 space-y-1.5">
              <li>
                <Link href="/graph">The graph</Link>
              </li>
              <li>
                <Link href="/feed">Field report</Link>
              </li>
              <li>
                <Link href="/#about">About</Link>
              </li>
            </ul>
          </div>
          <div>
            <p className="label">Sources</p>
            <ul className="mt-3 space-y-1.5">
              <li>
                <a href="https://www.usaspending.gov/">USAspending.gov</a>
              </li>
              <li>
                <a href="https://www.war.gov/News/Contracts/">DoD contract announcements</a>
              </li>
              <li>
                <a href="https://sam.gov/">SAM.gov</a>
              </li>
            </ul>
          </div>
        </div>
        <div className="relative h-56 sm:h-72">
          <Landscape seed={11} height={520} horizon={0.5} trees={34} className="fade-top absolute inset-0 h-full w-full" />
          <p className="fig absolute bottom-4 left-8 z-10 text-muted sm:left-12">
            Public records, read nightly.{sample ? " Showing sample data." : ""}
          </p>
        </div>
      </div>
    </footer>
  );
}
