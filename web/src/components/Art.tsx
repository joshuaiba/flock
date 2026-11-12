import { ART, artSmall, artSrcSet, artUrl, medallionUrl, type ArtName, type MedallionName } from "@/lib/art";
import { Reveal } from "./Reveal";

// Building blocks for the illustration pack. Every image here is decorative:
// alt="" and aria-hidden. Files are used as-is (resized and cropped only).

/** One illustration, with responsive sources and its dusk tint. Size it with
 *  `className` on the wrapper; the image fills the wrapper. */
export function Art({
  name,
  sizes,
  className = "",
  imgClassName = "",
  tint = 0.45,
  eager = false,
  maskFull = false,
  style,
}: {
  name: ArtName;
  /** the `sizes` attribute: how wide the image is drawn, e.g. "100vw" or "280px" */
  sizes: string;
  className?: string;
  imgClassName?: string;
  /** strength of the dusk darkening, 0 to 1; 0 turns it off */
  tint?: number;
  /** load immediately (above the fold); otherwise lazy */
  eager?: boolean;
  /** mask the dusk tint with the largest file instead of the smallest: for big
   *  pictures whose image already loads that file, so it is fetched only once */
  maskFull?: boolean;
  style?: React.CSSProperties;
}) {
  const a = ART[name];
  const mask = a.alpha ? `url("${maskFull ? artUrl(name) : artSmall(name)}")` : undefined;
  return (
    <span className={`art ${className}`} style={style} aria-hidden="true">
      <img
        src={artUrl(name)}
        srcSet={artSrcSet(name)}
        sizes={sizes}
        width={a.w}
        height={a.h}
        alt=""
        className={imgClassName}
        loading={eager ? "eager" : "lazy"}
        decoding="async"
        draggable={false}
      />
      {tint > 0 && (
        <span
          className="art-tint"
          style={
            {
              "--tint-strength": tint,
              WebkitMaskImage: mask,
              maskImage: mask,
            } as React.CSSProperties
          }
        />
      )}
    </span>
  );
}

/** Laurel garland: a centered divider between major sections, at most 560px wide. */
export function Garland({ className = "" }: { className?: string }) {
  return (
    <Reveal className={`mx-auto w-full max-w-[560px] px-6 ${className}`}>
      <Art name="ornaments/laurel-garland" sizes="(min-width: 608px) 560px, 90vw" tint={0.3} className="aspect-[1966/189]" />
    </Reveal>
  );
}

/** Greek-key rule: above the footer and under the digest title. Tiles horizontally. */
export function GreekKey({ className = "" }: { className?: string }) {
  return <div className={`greek-key ${className}`} aria-hidden="true" />;
}

/** Corner vine for a card. The art is drawn for the bottom-left corner (its
 *  two stems meet there) and is flipped for the others. The parent must be
 *  `relative`. */
export function CornerVine({
  corner = "tl",
  size = 150,
  className = "",
}: {
  corner?: "tl" | "tr" | "bl" | "br";
  size?: number;
  className?: string;
}) {
  const flipX = corner === "tr" || corner === "br";
  const top = corner === "tl" || corner === "tr";
  const flipY = top;
  const inset = -Math.round(size * 0.16);
  return (
    <Art
      name="ornaments/corner-vine"
      sizes={`${size}px`}
      tint={0.3}
      className={`pointer-events-none absolute! z-10 ${className}`}
      style={{
        width: size,
        aspectRatio: "646 / 472",
        [flipX ? "right" : "left"]: inset,
        [top ? "top" : "bottom"]: inset,
        transform: `scale(${flipX ? -1 : 1}, ${flipY ? -1 : 1})`,
      }}
    />
  );
}

/** Cartouche: a painted plaque behind a title. The text sits centered in the
 *  plaque and is always sepia, because the plaque is always pale. It is kept
 *  for one place, the About header on the landing page, under the fresco.
 *  Page titles everywhere else use the line-art title plaque (.title-plaque
 *  in globals.css). */
export function Cartouche({
  children,
  as: Tag = "h2",
  width = 360,
  className = "",
}: {
  children: React.ReactNode;
  as?: "h1" | "h2" | "h3" | "p";
  /** drawn width in px; the plaque keeps its 861:341 shape */
  width?: number;
  className?: string;
}) {
  return (
    <Reveal className={`mx-auto max-w-full ${className}`}>
      <div className="relative mx-auto grid max-w-full place-items-center" style={{ width, aspectRatio: "861 / 341" }}>
        <Art name="ornaments/cartouche" sizes={`${width}px`} tint={0.18} className="absolute! inset-0" />
        {/* the writable area of the plaque is its middle: about 64% x 42% */}
        <Tag
          className="on-art relative z-10 w-[64%] text-center font-display leading-[1.05]"
          style={{ fontSize: Math.max(18, Math.round(width * 0.074)) }}
        >
          {children}
        </Tag>
      </div>
    </Reveal>
  );
}

/** The real fresco. `wall` is a header panel whose bottom edge fades into the
 *  parchment; `band` is a horizontal strip (the painted garland). It stays
 *  almost still: one soft highlight crosses it every 26 seconds. */
export function Fresco({
  variant,
  className = "",
  eager = false,
}: {
  variant: "wall" | "band";
  className?: string;
  eager?: boolean;
}) {
  return (
    <div className={`fresco ${variant === "wall" ? "fade-bottom" : ""} ${className}`} aria-hidden="true">
      <Art
        name={variant === "wall" ? "fresco/wall" : "fresco/garland-band"}
        // The band is a short strip cropped from a wide picture, so on a phone
        // it is drawn wider than the screen (about 582px).
        sizes={
          variant === "band"
            ? "(max-width: 582px) 582px, (min-width: 1100px) 1100px, 100vw"
            : "(min-width: 1100px) 1100px, 100vw"
        }
        className="h-full w-full"
        imgClassName="object-cover object-center"
        tint={0.4}
        eager={eager}
      />
    </div>
  );
}

/** A medallion as a plain image (entity headers, filters, the watchlist). */
export function MedallionImg({
  name,
  size,
  className = "",
}: {
  name: MedallionName;
  size: number;
  className?: string;
}) {
  const src = size <= 64 ? 128 : size <= 128 ? 256 : 512;
  return (
    <img
      src={medallionUrl(name, src)}
      srcSet={`${medallionUrl(name, src)} 1x, ${medallionUrl(name, src === 512 ? 512 : ((src * 2) as 256 | 512))} 2x`}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={`block shrink-0 rounded-full ${className}`}
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
      tint={0.3}
      className={`shrink-0 ${className}`}
      style={{ width, aspectRatio: "906 / 820" }}
    />
  );
}
