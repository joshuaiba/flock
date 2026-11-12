import { Art, ClassicArt } from "./Art";
import { HeroBoats } from "./HeroBoats";
import { HeroParallax } from "./HeroParallax";
import "./hero.css";

// The landing hero: the headline alone on the left, the engraved village and
// lake along the bottom, and the flock (the canvas in the root layout, z-10)
// between the two. The scene is one still picture. Two boats ride on its lake
// (HeroBoats.tsx): with the swallows, they are the page's only ambient motion.
// Layout is in hero.css.
//
// Classic has its own variant, chosen in CSS by the mode (hero.css, "Classic"):
// a painted sky behind everything, the painted village, lake and boats in the
// engravings' places, and a leafy frame in the two bottom corners, which
// sways and, with the sky, drifts a little on scroll (HeroParallax.tsx). The
// caption and legend sit under the buttons there, because the frame holds the
// corners. Both variants are in the markup; the one not shown is never fetched.

/** How wide the scene is drawn, for the browser's choice of file (see
 *  .hero-scene in hero.css). */
const SCENE_SIZES = "max(100vw, 900px)";
/** The same for a half of Classic's frame (.hero-frame). */
const FRAME_SIZES = "min(30vw, 560px)";

export function Hero({ children }: { children: React.ReactNode }) {
  return (
    <section id="hero" className="hero">
      <div className="hero-art" aria-hidden="true">
        <ClassicArt name="classic/hero/sky" sizes="100vw" className="hero-sky" />
        <div className="hero-scene">
          <Art name="hero/scene" classic="classic/hero/scene" sizes={SCENE_SIZES} className="hero-scene-art" />
          <HeroBoats />
          {/* Where the village is, for the flock: with motion off the frozen V
              is placed clear of it, in the open sky. Not drawn. */}
          <div className="hero-village" data-flock-village />
        </div>
        <ClassicArt
          name="classic/hero/frame-left"
          sizes={FRAME_SIZES}
          className="hero-frame hero-frame-left"
          imgClassName="hero-sway"
        />
        <ClassicArt
          name="classic/hero/frame-right"
          sizes={FRAME_SIZES}
          className="hero-frame hero-frame-right"
          imgClassName="hero-sway"
        />
        <HeroParallax />
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
            <span className="hero-dot hero-dot-open bg-ink" aria-hidden="true" />
            Open solicitation
          </li>
        </ul>
      </div>
    </section>
  );
}
