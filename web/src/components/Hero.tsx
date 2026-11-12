import { preload } from "react-dom";
import { artSrcSet, artUrl, type ArtName } from "@/lib/art";
import { Art } from "./Art";
import { HeroMotion } from "./HeroMotion";
import "./hero.css";

// The landing hero: a painted lake in layers, from the pack's hero/ and props/
// files. Layout, stacking and all motion are in hero.css; scroll and mouse
// parallax and the water shimmer are driven by HeroMotion.tsx. The flock canvas
// (z 10, in the root layout) flies between the village and the leafy frame.

/** Water shimmer: true = the SVG displacement filter; false = the cheap
 *  fallback (a still lake that slides 2px). */
const LAKE_FILTER = true;

// Dusk darkening per layer (the multiply tint in <Art>). The brief asks for
// about 45% on the scene. The frame takes a little more so the pale wash around
// its leaves sinks into the evening; clouds take more still so they stay
// darker than the pale headline when they pass behind it.
const SCENE_TINT = 0.45;
const FRAME_TINT = 0.55;
const CLOUD_TINT = 0.7;

// How wide each picture is drawn, for the browser's choice of file. These
// mirror the sizes in hero.css (the 3:1 box is max(104vw, 150svh) wide).
const SCENE_SIZES = "(max-aspect-ratio: 144/100) 150vh, 104vw";
const SKY_SIZES = "(max-aspect-ratio: 171/100) 178vh, 104vw";
const SKY_DUSK_SIZES = "(max-aspect-ratio: 288/100) 300vh, 104vw";
const FRAME_SIZES = "(max-width: 615px) 640px, 104vw";

// Clouds, upper third. x, y: where the cloud rests when motion is off (vw from
// the left, % from the top). w: width in vw (never under minPx). seconds: one
// full crossing.
const CLOUDS: { name: ArtName; ratio: string; x: number; y: number; w: number; minPx: number; seconds: number }[] = [
  { name: "props/cloud-1", ratio: "629 / 243", x: 71, y: 8, w: 26, minPx: 170, seconds: 78 },
  { name: "props/cloud-2", ratio: "568 / 147", x: 30, y: 21, w: 19, minPx: 130, seconds: 56 },
  { name: "props/cloud-3", ratio: "531 / 150", x: 6, y: 13, w: 15, minPx: 110, seconds: 90 },
];

export function Hero({ children }: { children: React.ReactNode }) {
  // The first paint needs the sky and the midground; the flock needs its strip.
  // Only one sky is visible: the page opens in day or dusk after the system
  // setting (see BOOT in app/layout.tsx), so each sky is preloaded for its own.
  preload(artUrl("hero/sky"), {
    as: "image",
    imageSrcSet: artSrcSet("hero/sky"),
    imageSizes: SKY_SIZES,
    fetchPriority: "high",
    media: "(prefers-color-scheme: light)",
  });
  preload(artUrl("hero/sky-dusk"), {
    as: "image",
    imageSrcSet: artSrcSet("hero/sky-dusk"),
    imageSizes: SKY_DUSK_SIZES,
    media: "(prefers-color-scheme: dark)",
  });
  preload(artUrl("hero/midground"), {
    as: "image",
    imageSrcSet: artSrcSet("hero/midground"),
    imageSizes: SCENE_SIZES,
    fetchPriority: "high",
  });
  preload("/art/sprites/swallow-award-1040.webp", { as: "image" });

  return (
    <section id="hero" className="hero" data-shimmer={LAKE_FILTER ? "filter" : "sway"}>
      <div className="hero-sky" aria-hidden="true">
        <Art name="hero/sky" sizes={SKY_SIZES} tint={0} eager className="hero-sky-art hero-sky-day" />
        <Art name="hero/sky-dusk" sizes={SKY_DUSK_SIZES} tint={0} eager className="hero-sky-art hero-sky-dusk" />
      </div>

      <div className="hero-clouds" aria-hidden="true">
        {CLOUDS.map((c) => (
          <Art
            key={c.name}
            name={c.name}
            sizes={`max(${c.w}vw, ${c.minPx}px)`}
            tint={CLOUD_TINT}
            className="hero-cloud"
            style={
              {
                "--x": `${c.x}vw`,
                "--y": `${c.y}%`,
                "--w": `max(${c.w}vw, ${c.minPx}px)`,
                "--d": `${c.seconds}s`,
                // start the loop where the cloud rests
                "--delay": `${(-c.seconds * (c.x + c.w + 4)) / (108 + c.w)}s`,
                aspectRatio: c.ratio,
              } as React.CSSProperties
            }
          />
        ))}
      </div>

      {/* Lake, midground and boats share one 2170x725 coordinate system. */}
      <div className="hero-scene" aria-hidden="true">
        <div className="hero-glow" />
        {/* The lake lies behind the village, dropped to its shoreline (hero.css). */}
        <div className="hero-layer hero-lake">
          <div className="hero-lake-band">
            <Art name="hero/lake" sizes={SCENE_SIZES} tint={SCENE_TINT} eager maskFull className="hero-lake-art" />
          </div>
        </div>
        <Art name="hero/midground" sizes={SCENE_SIZES} tint={SCENE_TINT} eager maskFull className="hero-layer hero-mid" />
        {/* Where the village is, for the flock: with motion off the frozen V is
            placed clear of it, in open sky or over the far hills. Not drawn. */}
        <div className="hero-village" data-flock-village />
        <div className="hero-layer hero-boats">
          <Art
            name="props/sailboat"
            sizes="(max-aspect-ratio: 144/100) 9.3vh, 6.5vw"
            tint={SCENE_TINT}
            className="hero-sail"
          />
          <Art
            name="props/rowboat"
            sizes="(max-aspect-ratio: 144/100) 11.4vh, 7.9vw"
            tint={SCENE_TINT}
            className="hero-row"
          />
        </div>
      </div>

      {/* The frame is one picture shown twice, each clipped to its half, so the
          two sides can sway on their own. */}
      <div className="hero-fg hero-fg-l" aria-hidden="true">
        <Art name="hero/foreground" sizes={FRAME_SIZES} tint={FRAME_TINT} eager maskFull className="hero-fg-art" />
      </div>
      <div className="hero-fg hero-fg-r" aria-hidden="true">
        <Art name="hero/foreground" sizes={FRAME_SIZES} tint={FRAME_TINT} eager maskFull className="hero-fg-art" />
      </div>

      <div className="hero-light" aria-hidden="true" />
      <div className="hero-mist" aria-hidden="true" />

      <div className="hero-copy">
        <div className="hero-text" data-flock-avoid>
          {children}
        </div>
      </div>

      <HeroMotion shimmer={LAKE_FILTER} />
    </section>
  );
}
