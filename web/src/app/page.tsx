import Link from "next/link";
import { Suspense } from "react";
import { Footer } from "@/components/Footer";
import { Landscape } from "@/components/Landscape";
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
    scene: { seed: 3, horizon: 0.5, trees: 10, water: false },
  },
  {
    label: "02 · supply",
    title: "Who gets paid",
    body: "Contract awards from USAspending and the Department's daily announcements, tied to the companies behind them. When one company appears under several spellings, the records are merged, so the money adds up.",
    scene: { seed: 5, horizon: 0.46, trees: 16 },
  },
  {
    label: "03 · the path to production",
    title: "Whether it reaches production",
    body: "Most research never leaves the lab. Flock follows each company from its first solicitation through Phase I and Phase II to a production contract, and shows where the trail goes cold.",
    scene: { seed: 8, horizon: 0.52, trees: 22, mountains: false },
  },
];

export default function Home() {
  return (
    <>
      {/* Hero: a full-bleed painted lake by day, the same scene lamp-lit at dusk. */}
      <section className="relative min-h-svh">
        <Landscape seed={2} trees={30} className="fade-bottom absolute inset-0 z-0 h-full w-full" />
        <p className="note absolute right-[12%] top-[24%] z-20 hidden -rotate-3 md:block">
          each bird is one award
        </p>
        <div className="relative z-20 flex min-h-svh flex-col justify-end px-6 pb-14 sm:px-12 sm:pb-20">
          <div data-flock-avoid className="max-w-4xl">
            <h1 className="text-[2.6rem] sm:text-6xl lg:text-7xl">
              Following the money on the frontier of autonomy, from solicitation to production.
            </h1>
            <Suspense fallback={<p className="fig mt-6 text-muted">counting the flock…</p>}>
              <Stats />
            </Suspense>
          </div>
        </div>
      </section>

      <section id="about" className="mx-auto max-w-5xl scroll-mt-24 px-6 pt-20 sm:px-10">
        <div className="relative z-20 max-w-2xl" data-flock-avoid>
          <p className="label">About</p>
          <h2 className="mt-3 text-4xl sm:text-5xl">A painted map of defense funding for drones and autonomy.</h2>
          <p className="mt-5 text-lg text-muted">
            Flock is a knowledge graph. It connects what the Pentagon asks for to who gets paid, and
            watches whether the research turns into something built at scale.
          </p>
        </div>

        <div className="mt-16 space-y-20">
          {ABOUT.map((a, i) => (
            <div
              key={a.label}
              className={`flex flex-col items-center gap-8 sm:gap-14 ${i % 2 ? "sm:flex-row-reverse" : "sm:flex-row"}`}
            >
              <div className="relative h-52 w-72 shrink-0">
                <Landscape {...a.scene} width={720} height={520} className="fade-round absolute inset-0 z-0 h-full w-full" />
              </div>
              <div className="relative z-20 max-w-md" data-flock-avoid>
                <p className="label">{a.label}</p>
                <h3 className="mt-2 text-3xl">{a.title}</h3>
                <p className="mt-3">{a.body}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="relative z-20 mt-20 flex flex-wrap gap-3">
          <Link href="/graph" className="marble pill">
            open the graph →
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
