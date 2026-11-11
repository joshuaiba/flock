import Link from "next/link";
import { FRESCO_CREDIT } from "@/lib/art";
import { Art, GreekKey } from "./Art";
import "./footer.css";

// Strength of the dusk darkening on the terrace. Higher is darker, which helps
// the pale text; the dusk mask (--terrace-mask in globals.css) assumes 0.7 or more.
const TERRACE_TINT = 0.7;

/** Footer: a Greek-key rule, then the links in the empty sky of a painted
 *  terrace at dusk. The painting is full width, anchored to the bottom, and
 *  its top edge dissolves into the page. */
export function Footer({ sample }: { sample?: boolean }) {
  return (
    <footer className="site-footer mt-28">
      <div className="mx-auto max-w-[400px] px-4 sm:max-w-6xl sm:px-6">
        <GreekKey className="fade-sides" />
      </div>

      <Art
        name="footer/terrace"
        sizes="(max-width: 660px) 660px, 100vw"
        tint={TERRACE_TINT}
        className="site-footer-painting"
        imgClassName="object-cover object-bottom"
      />

      <div className="site-footer-copy relative z-20 mx-auto max-w-6xl px-4 sm:px-6">
        <div className="pt-10 sm:pt-12" data-flock-avoid>
          <div className="grid grid-cols-2 gap-x-8 gap-y-8 sm:grid-cols-[1.4fr_1fr_1fr] sm:gap-10">
            <div className="col-span-2 sm:col-span-1">
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
          {/* Centered, so it stays in the open middle of the sky, clear of the
              leaves at either edge of the painting. */}
          <div className="mt-8 text-center text-muted">
            <p className="fig">Public records, read nightly.{sample ? " Showing sample data." : ""}</p>
            <p className="mt-1 text-[0.875rem] leading-snug">{FRESCO_CREDIT}</p>
          </div>
        </div>
      </div>
    </footer>
  );
}
