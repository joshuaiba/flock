"use client";

import Link from "next/link";
import { ViewTransition, useSyncExternalStore } from "react";
import { medallionFor } from "@/lib/art";
import { useStore } from "@/lib/store";
import { MedallionImg } from "./Art";

const never = () => () => {};

/** An entity's painted medallion, picked by its category and kind. `morph`
 *  gives it the shared name that lets a clicked medallion grow into the entity
 *  page header; one already on the chain owns that name, so it is skipped here
 *  to keep names unique. */
export function Medallion({
  id,
  tag,
  kind,
  size = 56,
  morph = false,
}: {
  id: number;
  tag: string | null;
  kind: string;
  size?: number;
  morph?: boolean | "always";
}) {
  const { isPinned } = useStore();
  // False while the server's HTML is being hydrated: the watchlist is not known
  // yet, and the chain may already be showing this same medallion under the
  // shared name. The name is taken only once this component knows the pins.
  const hydrated = useSyncExternalStore(never, () => true, () => false);
  // The shadow follows the round edge of the art and grows with the medallion.
  const drop = Math.max(3, Math.round(size * 0.06));
  const coin = (
    <span
      className="block shrink-0 rounded-full"
      style={{
        width: size,
        height: size,
        filter: `drop-shadow(0 ${drop}px ${Math.round(drop * 1.4)}px rgb(40 30 22 / 0.3))`,
      }}
    >
      <MedallionImg name={medallionFor(tag, kind)} size={size} />
    </span>
  );
  if (!morph || !hydrated || (morph !== "always" && isPinned(id))) return coin;
  return (
    <ViewTransition name={`coin-${id}`} share="coin-morph">
      {coin}
    </ViewTransition>
  );
}

/** Related entity: a small medallion with the name underneath. */
export function MedallionLink({
  id,
  name,
  tag,
  kind,
  note,
}: {
  id: number;
  name: string;
  tag: string | null;
  kind: string;
  note?: string;
}) {
  return (
    <Link href={`/entity/${id}`} className="group flex w-28 flex-col items-center gap-2 text-center no-underline">
      <span className="transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:-translate-y-1">
        <Medallion id={id} tag={tag} kind={kind} morph />
      </span>
      <span className="leading-tight text-ink">{name}</span>
      {note && <span className="fig text-muted">{note}</span>}
    </Link>
  );
}
