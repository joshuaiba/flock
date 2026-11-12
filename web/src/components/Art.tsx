import {
  ART,
  artSrcSet,
  artUrl,
  CLASSIC_ART,
  classicSrcSet,
  classicUrl,
  TONES,
  type ArtName,
  type ClassicArtName,
  type MedallionName,
} from "@/lib/art";

// Building blocks for the engraving pack. Every image here is decorative:
// alt="" and aria-hidden. Files are used as they are (resized and cropped
// only): never recolored or redrawn. None of it moves, except the two boats on
// the landing hero's lake (HeroBoats.tsx).

/** One engraving. Both tones are in the markup and the mode shows one (see
 *  .art in globals.css); the hidden one is never fetched, because both load
 *  lazily. Size it with `className` on the wrapper; the image fills the
 *  wrapper. It is drawn at the --art opacity unless `opacity` says otherwise;
 *  fade it toward the content with a mask on the wrapper.
 *
 *  `classic` names the picture's painted twin. In Classic the twin is shown
 *  in place of the engraving, in the same box and in full color; in Dark and
 *  Paper it is hidden like the unused tone, and never fetched. */
export function Art({
  name,
  classic,
  sizes,
  className = "",
  imgClassName = "",
  opacity,
  style,
}: {
  name: ArtName;
  classic?: ClassicArtName;
  /** the `sizes` attribute: how wide the image is drawn, e.g. "100vw" or "280px" */
  sizes: string;
  className?: string;
  imgClassName?: string;
  /** 0 to 1; defaults to the mode's --art */
  opacity?: number;
  style?: React.CSSProperties;
}) {
  const a = ART[name];
  return (
    <span
      className={`art ${classic ? "art-swap " : ""}${className}`}
      style={opacity == null ? style : { ...style, opacity }}
      aria-hidden="true"
    >
      {TONES.map((tone) => (
        <img
          key={tone}
          src={artUrl(name, tone)}
          srcSet={artSrcSet(name, tone)}
          sizes={sizes}
          width={a.w}
          height={a.h}
          alt=""
          className={`art-${tone} ${imgClassName}`}
          loading="lazy"
          decoding="async"
          draggable={false}
        />
      ))}
      {classic && <ClassicImg name={classic} sizes={sizes} className={`art-classic ${imgClassName}`} />}
    </span>
  );
}

function ClassicImg({ name, sizes, className }: { name: ClassicArtName; sizes: string; className: string }) {
  const a = CLASSIC_ART[name];
  return (
    <img
      src={classicUrl(name)}
      srcSet={classicSrcSet(name)}
      sizes={sizes}
      width={a.w}
      height={a.h}
      alt=""
      className={className}
      loading="lazy"
      decoding="async"
      draggable={false}
    />
  );
}

/** A painted picture that only Classic has (the hero's sky and leafy frame).
 *  Outside Classic it is not displayed, so it is never fetched. Size and
 *  place it with `className` on the wrapper; the image fills the wrapper's
 *  width unless `imgClassName` says otherwise. */
export function ClassicArt({
  name,
  sizes,
  className = "",
  imgClassName = "",
}: {
  name: ClassicArtName;
  sizes: string;
  className?: string;
  imgClassName?: string;
}) {
  return (
    <span className={`classic-only ${className}`} aria-hidden="true">
      <ClassicImg name={name} sizes={sizes} className={imgClassName} />
    </span>
  );
}

/** A medallion as a small category icon. */
export function MedallionImg({
  name,
  size,
  className = "",
}: {
  name: MedallionName;
  size: number;
  className?: string;
}) {
  return (
    <Art
      name={`medallions/${name}`}
      sizes={`${size}px`}
      opacity={0.8}
      className={`shrink-0 ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

/** Empty-state vignette: a swallow on a broken column, about 280px wide. */
export function SwallowVignette({ width = 280, className = "" }: { width?: number; className?: string }) {
  return (
    <Art
      name="vignettes/swallow-on-column"
      sizes={`${width}px`}
      className={`shrink-0 ${className}`}
      style={{ width, aspectRatio: "906 / 820" }}
    />
  );
}
