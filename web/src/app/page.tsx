import Link from "next/link";
import { Suspense } from "react";
import { Cartouche, Fresco, Garland } from "@/components/Art";
import { Footer } from "@/components/Footer";
import { Hero } from "@/components/Hero";
import { serverGet, type Summary } from "@/lib/api";
import { clockET, money, plural } from "@/lib/format";

async function Stats() {
  const s = await serverGet<Summary>("summary");
  if (!s) return <p className="fig mt-6 text-muted">The data service is not answering right now.</p>;
  return (
    <p className="fig mt-6 text-muted">
      {plural(s.awards_30d, "award")} tracked this month · <span className="text-pompeii">{money(s.amount_30d)}</span> · updated{" "}
      {clockET(s.updated_at)}
      {s.sample && " · sample data"}
    </p>
  );
}

async function FooterWithData() {
  const s = await serverGet<Summary>("summary");
  return <Footer sample={s?.sample} />;
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
      {/* Hero: the painted lake in layers; the same scene at evening in dusk mode. */}
      <Hero>
        <h1 className="hero-title">Following the money on the frontier of autonomy, from solicitation to production.</h1>
        <Suspense fallback={<p className="fig mt-6 text-muted">counting the flock…</p>}>
          <Stats />
        </Suspense>
        {/* The way in: the Forum is where a visit starts after the hero. */}
        <p className="mt-7 flex flex-wrap items-center gap-2.5">
          <Link href="/forum" className="btn btn-primary">
            Enter the Forum
          </Link>
          <Link href="/graph" className="btn">
            Open the graph
          </Link>
        </p>
      </Hero>

      <Garland className="mt-12 sm:mt-16" />

      <section id="about" className="mx-auto max-w-[1100px] scroll-mt-20 pt-12 sm:px-6 sm:pt-16">
        {/* Header panel: the Boscoreale wall. The words start below it, never on it. */}
        <Fresco variant="wall" className="h-[clamp(220px,42vw,460px)] sm:rounded-t-md" />
        <Cartouche width={340} className="relative z-20 -mt-10 px-6 sm:-mt-14">
          About
        </Cartouche>

        <div className="relative z-20 mx-auto mt-8 max-w-2xl px-6 text-center sm:px-0">
          <p className="font-display text-[2rem] font-medium leading-[1.1] text-balance sm:text-[2.6rem]">
            A painted map of defense funding for drones and autonomy.
          </p>
          <p className="mt-5 text-lg text-muted">
            Flock is a knowledge graph. It connects what the Pentagon asks for to who gets paid, and
            watches whether the research turns into something built at scale.
          </p>
        </div>

        <div className="relative z-20 mx-6 mt-16 grid border-t border-frame sm:mx-0 sm:mt-24 md:grid-cols-3">
          {ABOUT.map((a) => (
            <div
              key={a.title}
              className="border-b border-hair py-8 md:border-b-0 md:border-l md:px-8 md:py-10 md:first:border-l-0 md:first:pl-0 md:last:pr-0"
            >
              <h3 className="text-[1.75rem]">{a.title}</h3>
              <p className="mt-3 text-[1.0625rem] leading-[1.6] text-muted">{a.body}</p>
            </div>
          ))}
        </div>

        <div className="relative z-20 mt-12 flex flex-wrap items-center justify-center gap-2.5 px-6 sm:mt-16 sm:px-0">
          {/* The Forum leads; the graph and the letter follow. */}
          <Link href="/forum" className="btn btn-primary">
            Enter the Forum
          </Link>
          <Link href="/graph" className="btn">
            Open the graph
          </Link>
          <Link href="/feed" className="btn">
            Read this week&rsquo;s field report
          </Link>
        </div>
      </section>

      <Suspense fallback={<Footer />}>
        <FooterWithData />
      </Suspense>
    </>
  );
}
