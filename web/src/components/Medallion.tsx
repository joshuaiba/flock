"use client";

import Link from "next/link";
import { ViewTransition } from "react";
import { entityIcon } from "@/lib/icons";
import { useStore } from "@/lib/store";
import { Icon } from "./Icon";

/** A marble medallion struck with an entity's engraved glyph. `morph` gives it
 *  the shared name that lets a clicked medallion grow into the entity page
 *  header; one already on the chain owns that name, so it is skipped here to
 *  keep names unique. */
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
  const coin = (
    <span className="marble coin" style={{ width: size, height: size }}>
      <Icon name={entityIcon(tag, kind)} size={Math.round(size * 0.5)} weight={size > 80 ? 0.9 : 1.2} />
    </span>
  );
  if (!morph || (morph !== "always" && isPinned(id))) return coin;
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
