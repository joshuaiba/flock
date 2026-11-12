import { Art } from "./Art";
import { HeroBoats } from "./HeroBoats";
import "./hero.css";

// The landing hero: the headline alone on the left, the engraved village and
// lake along the bottom, and the flock (the canvas in the root layout, z-10)
// between the two. The scene is one still picture. Two boats ride on its lake
// (HeroBoats.tsx): with the swallows, they are the page's only ambient motion.
// Layout is in hero.css.

/** How wide the scene is drawn, for the browser's choice of file (see
 *  .hero-scene in hero.css). */
const SCENE_SIZES = "max(100vw, 900px)";

export function Hero({ children }: { children: React.ReactNode }) {
  return (
    <section id="hero" className="hero">
      <div className="hero-art" aria-hidden="true">
        <div className="hero-scene">
          <Art name="hero/scene" sizes={SCENE_SIZES} className="hero-scene-art" />
          <HeroBoats />
          {/* Where the village is, for the flock: with motion off the frozen V
              is placed clear of it, in the open sky. Not drawn. */}
          <div className="hero-village" data-flock-village />
        </div>
      </div>

      <div className="hero-copy">
        <div className="hero-text" data-flock-avoid>
          {children}
        </div>
      </div>

      {/* What the birds are, said once, the way a plate carries its caption. */}
      <div className="hero-key" data-flock-avoid>
        <p className="caption">Each swallow is an award or an open solicitation from the last 30 days.</p>
        <ul className="hero-legend">
          <li>
            <span className="hero-dot bg-accent" aria-hidden="true" />
            Award
          </li>
          <li>
            <span className="hero-dot bg-ink" aria-hidden="true" />
            Open solicitation
          </li>
        </ul>
      </div>
    </section>
  );
}
