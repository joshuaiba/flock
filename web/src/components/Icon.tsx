import { ICON_BOX, iconPath } from "@/lib/icons";
import { birdPath } from "@/lib/paint";

/** An engraved line icon in the current text color (sepia or cypress). */
export function Icon({
  name,
  fallback,
  size = 24,
  className,
  title,
  weight = 1.25,
}: {
  name: string | null | undefined;
  fallback?: string;
  size?: number;
  className?: string;
  title?: string;
  weight?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${ICON_BOX} ${ICON_BOX}`}
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      fill="none"
      stroke="currentColor"
      strokeWidth={weight}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={iconPath(name, fallback)} />
    </svg>
  );
}

/** One still painted swallow, from the same path as the live murmuration. */
export function PaintedBird({
  award = true,
  angle = 0,
  flap = 0.85,
  size = 44,
  className,
}: {
  award?: boolean;
  angle?: number;
  flap?: number;
  size?: number;
  className?: string;
}) {
  const d = birdPath(flap);
  const fill = award ? "var(--terracotta)" : "var(--pale-bird)";
  return (
    <svg width={size} height={size} viewBox="-16 -16 32 32" className={className} aria-hidden="true">
      <g transform={`rotate(${(angle * 180) / Math.PI})`}>
        <path d={d} fill={fill} opacity={0.9} />
        <path d={d} fill={fill} opacity={0.25} transform="translate(-0.9 0.5)" />
      </g>
    </svg>
  );
}
