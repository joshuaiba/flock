import Link from "next/link";
import { Art } from "./Art";
import "./footer.css";

/** The footer: one quiet line under a hairline. On the left the wordmark and
 *  the ways around the site; on the right where the data comes from (the
 *  landing page) or that it is sample data.
 *
 *  `width` matches the page's column: 1100px, or the Field Report's 620px
 *  reading column (which keeps only the wordmark). `terrace` puts the terrace
 *  engraving behind the foot of a long page: full width, anchored to the
 *  bottom, fading out toward its own top edge. */
export function Footer({
  sample,
  terrace = false,
  sources = false,
  width = "wide",
}: {
  sample?: boolean;
  terrace?: boolean;
  /** name the sources at the right, in place of the sample-data mark */
  sources?: boolean;
  width?: "wide" | "reading";
}) {
  const reading = width === "reading";
  return (
    <footer className={`site-footer ${terrace ? "site-footer-terrace" : ""}`}>
      {terrace && (
        <Art
          name="footer/terrace"
          sizes="(max-width: 660px) 660px, 100vw"
          opacity={0.3}
          className="site-footer-art"
          imgClassName="object-cover object-bottom"
        />
      )}
      <div className={`site-footer-row mx-auto px-4 sm:px-6 ${reading ? "max-w-[41.75rem]" : "max-w-[71.75rem]"}`}>
        <div className="site-footer-line">
          <p>
            <Link href="/">flock</Link>
            {!reading && (
              <>
                {" · "}
                <Link href="/forum">Forum</Link>
                {" · "}
                <Link href="/graph">Graph</Link>
                {" · "}
                <Link href="/feed">Field Report</Link>
                {" · "}
                <Link href="/about/numbers">How the numbers are counted</Link>
              </>
            )}
          </p>
          {sources ? (
            <p>
              Sources: <a href="https://www.usaspending.gov/">USAspending</a>, <a href="https://sam.gov/">SAM.gov</a>,{" "}
              <a href="https://www.war.gov/News/Contracts/">daily contract announcements</a>
              {sample && " · Sample data"}
            </p>
          ) : (
            sample && <p>Sample data</p>
          )}
        </div>
      </div>
    </footer>
  );
}
