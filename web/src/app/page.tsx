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

const ABOUT = [
  {
    label: "01 · demand",
    title: "What the Pentagon asks for",
    body: "Solicitations, broad agency announcements and research topics say what the services want before a dollar moves. Flock sorts each one into an autonomy category: swarming, counter-drone, maritime, navigation without GPS, and the rest.",
  },
  {
    label: "02 · supply",
    title: "Who gets paid",
    body: "Contract awards from USAspending and the Department's daily announcements, tied to the companies behind them. When one company appears under several spellings, the records are merged, so the money adds up.",
  },
  {
    label: "03 · the path to production",
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
        <p className="mt-6">
          <Link href="/forum" className="marble pill">
            enter the forum →
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

        <div className="relative z-20 mx-auto mt-8 max-w-2xl px-6 text-center sm:px-0" data-flock-avoid>
          <p className="font-display text-[2rem] font-medium leading-[1.1] text-balance sm:text-[2.6rem]">
            A painted map of defense funding for drones and autonomy.
          </p>
          <p className="mt-5 text-lg text-muted">
            Flock is a knowledge graph. It connects what the Pentagon asks for to who gets paid, and
            watches whether the research turns into something built at scale.
          </p>
        </div>

        <Garland className="mt-14 sm:mt-20" />

        <div className="mt-14 grid gap-12 px-6 sm:mt-20 sm:px-0 md:grid-cols-3 md:gap-10">
          {ABOUT.map((a) => (
            <div key={a.label} className="relative z-20 mx-auto max-w-md md:max-w-none" data-flock-avoid>
              <p className="label">{a.label}</p>
              <h3 className="mt-2 text-3xl">{a.title}</h3>
              <p className="mt-3">{a.body}</p>
            </div>
          ))}
        </div>

        <div className="relative z-20 mt-14 flex flex-wrap justify-center gap-3 px-6 sm:mt-20 sm:px-0">
          {/* The Forum leads; the graph and the letter follow. */}
          <Link href="/forum" className="marble pill">
            enter the forum →
          </Link>
          <Link href="/graph" className="marble pill">
            open the graph
          </Link>
          <Link href="/feed" className="marble pill">
            read this week&rsquo;s field report
          </Link>
        </div>
      </section>

      <Suspense fallback={<Footer />}>
        <FooterWithData />
      </Suspense>
    </>
  );
}
