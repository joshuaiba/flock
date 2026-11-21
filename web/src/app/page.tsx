import Link from "next/link";
import { Suspense } from "react";
import { Art } from "@/components/Art";
import { Footer } from "@/components/Footer";
import { Report, ThreeWays } from "@/components/landing/Sections";
import { StarHero } from "@/components/landing/StarHero";
import { serverGet, type Summary } from "@/lib/api";
import { FRIEZE_CAPTION, FRIEZE_CREDIT } from "@/lib/art";
import { day } from "@/lib/format";
import type { Flows } from "@/lib/flows";
import "@/components/landing/landing.css";

async function FooterWithData() {
  const s = await serverGet<Summary>("summary");
  return <Footer terrace sources sample={s?.sample} />;
}

/** The top of the page, from the same answer the graph is drawn from: the
 *  default window (the first one with an award in it), so the headline, the
 *  chart, the feed and the lists below all describe the same days. Without
 *  the API there is only the headline and the two ways in. */
async function Top() {
  const data = await serverGet<Flows>("flows");
  if (!data || !data.awards.length) return <Fallback />;
  return (
    <>
      {/* The hero runs in the browser, so its data travels in the page: without
          the award descriptions, which it never prints. */}
      <StarHero data={{ ...data, awards: data.awards.map((a) => ({ ...a, description: null })) }} />
      <ThreeWays data={data} />
      <Report data={data} />
      <div className="ld-close">
        <p className="ld-close-line">Every connection is drawn from the public record.</p>
        <p className="ld-close-src">
          USAspending.gov · SAM.gov · DoD contract announcements. Data through {day(data.window.latest_data_date)}
          {data.sample ? " · sample data" : ""}
        </p>
      </div>
    </>
  );
}

function Fallback() {
  return (
    <section className="ld-hero">
      <div className="ld-copy">
        <p className="ld-eyebrow">Field report</p>
        <h1 className="ld-title">Following the money on the frontier of autonomy, from solicitation to production.</h1>
        <p className="ld-actions">
          <Link href="/graph" className="ld-btn ld-btn-primary">
            Open the graph
          </Link>
          <Link href="/forum" className="ld-btn">
            Open the Forum
          </Link>
        </p>
      </div>
    </section>
  );
}

// The three things Flock follows, in the order the money moves. The titles
// carry the structure; the columns are set apart by hairlines and nothing else.
const ABOUT = [
  {
    title: "What the Pentagon asks for",
    body: "Solicitations, broad agency announcements and research topics say what the services want before a dollar moves. Flock sorts each one into an autonomy category: swarming, counter-drone, maritime, navigation without GPS, and the rest.",
  },
  {
    title: "Who gets paid",
    body: "Contract awards from USAspending and the Department's daily announcements, tied to the companies behind them. When one company appears under several spellings, the records are merged, so the money adds up.",
  },
  {
    title: "Whether it reaches production",
    body: "Most research never leaves the lab. Flock follows each company from its first solicitation through Phase I and Phase II to a production contract, and shows where the trail goes cold.",
  },
];

export default function Home() {
  return (
    <>
      {/* The star chart and its headline, the feed, three ways in, who leads. */}
      <Suspense fallback={<Fallback />}>
        <Top />
      </Suspense>

      <section id="about" className="relative scroll-mt-16">
        {/* The page's one picture: the Pergamon Altar's frieze as a ghost in the
            top right corner, clear of the words, with its caption and the
            photographer's credit. Classic shows the same photograph in color. */}
        <figure className="about-fresco">
          <Art
            name="frieze/pergamon-athena"
            classic="classic/frieze/pergamon-athena"
            sizes="(min-width: 1024px) 600px, 60vw"
            opacity={0.5}
            className="aspect-[2164/1384] w-full"
          />
          <figcaption className="caption mt-3 pr-4 text-right sm:pr-10">
            {FRIEZE_CAPTION}
            <span className="about-credit">
              Photo: <a href={FRIEZE_CREDIT.photographer.href}>{FRIEZE_CREDIT.photographer.name}</a>,{" "}
              <a href={FRIEZE_CREDIT.license.href}>{FRIEZE_CREDIT.license.name}</a>, adapted.
            </span>
          </figcaption>
        </figure>

        {/* The column's own box lies over the figure, so it lets the pointer
            through to the credit's links; its two blocks take it back. */}
        <div className="pointer-events-none relative z-20 mx-auto max-w-[71.75rem] px-4 pt-20 sm:px-6 sm:pt-28 lg:pt-32">
          <div className="pointer-events-auto max-w-[30rem] lg:min-h-[21rem]">
            <h2 className="page-title text-balance">A map of defense funding for drones and autonomy.</h2>
            <p className="reading mt-6 text-muted">
              Flock is a knowledge graph. It connects what the Pentagon asks for to who gets paid, and watches whether
              the research turns into something built at scale.
            </p>
          </div>

          <div className="pointer-events-auto mt-14 grid border-t border-line2 md:mt-20 md:grid-cols-3">
            {ABOUT.map((a) => (
              <div
                key={a.title}
                className="border-b border-line py-8 md:border-b-0 md:border-l md:px-8 md:pb-2 md:pt-10 md:first:border-l-0 md:first:pl-0 md:last:pr-0"
              >
                <h3 className="text-[1.6875rem] leading-[1.15]">{a.title}</h3>
                <p className="reading mt-3 !text-[1.0625rem] !leading-[1.6] text-muted">{a.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <Suspense fallback={<Footer terrace sources />}>
        <FooterWithData />
      </Suspense>
    </>
  );
}
