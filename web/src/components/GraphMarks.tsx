import { TONES } from "@/lib/art";
import { nodeSpriteSrcSet, nodeSpriteUrl, type NodeSprite } from "@/lib/nodeSprites";

// The marks of the map, as small pictures: the legend's keys (GraphExplorer)
// and the rail's "Show" rows (GraphFilters), so the control that hides a kind
// of mark is drawn with that mark. Styles are in graph-rail.css
// (.graph-legend-sprite, .graph-legend-coin).

/** One node sprite as an 18px icon. Both tones are in the markup and the
 *  mode shows one (see .graph-legend-sprite in graph-rail.css), the way
 *  components/Art.tsx does it, so a theme change never flashes; the hidden
 *  tone is never fetched, because both load lazily. */
function Sprite({ name }: { name: NodeSprite }) {
  return (
    <>
      {TONES.map((tone) => (
        <img
          key={tone}
          src={nodeSpriteUrl(name, tone, 64)}
          srcSet={nodeSpriteSrcSet(name, tone)}
          sizes="18px"
          width={18}
          height={18}
          alt=""
          className={`art-${tone}`}
          loading="lazy"
          decoding="async"
          draggable={false}
        />
      ))}
    </>
  );
}

export type MarkKind = "company" | "org" | "opportunity" | "award";

/** The picture of each kind of mark, drawn the way the map draws it: a silver
 *  coin for a company (a text-colored disc with the coin's lines in the
 *  opposite tone on top), the laurel wreath for an agency, the open tablet
 *  for a solicitation, and the accent line for dollars awarded. */
export function Mark({ kind }: { kind: MarkKind }) {
  if (kind === "award") return <span className="block h-[2px] w-[16px] rounded-full bg-accent" />;
  if (kind === "company")
    return (
      <span className="graph-legend-coin graph-legend-sprite">
        <Sprite name="coin-aerial" />
      </span>
    );
  return (
    <span className="graph-legend-sprite">
      <Sprite name={kind === "org" ? "wreath-laurel" : "tablet-open"} />
    </span>
  );
}
