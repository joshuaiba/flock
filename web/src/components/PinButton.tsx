"use client";

import { useState } from "react";
import { MAX_PINS, useStore, type Pin } from "@/lib/store";

/** "Add to watchlist": pins an entity to the watchlist (up to five), which the
 *  Forum's watchlist panel reads and the top bar counts.
 *  Pinned, the button stays pressed and says what pressing it again does. */
export function PinButton({ entity, small = false, className = "" }: { entity: Pin; small?: boolean; className?: string }) {
  const { pin, unpin, isPinned, pins } = useStore();
  const [note, setNote] = useState("");
  const pinned = isPinned(entity.id);
  const full = !pinned && pins.length >= MAX_PINS;
  return (
    <span className={`inline-flex flex-wrap items-center gap-3 ${className}`}>
      <button
        type="button"
        className={small ? "btn btn-sm" : "btn"}
        aria-pressed={pinned}
        onClick={() => {
          if (pinned) return unpin(entity.id);
          setNote(pin(entity) === "full" ? `The watchlist holds ${MAX_PINS}. Remove one first.` : "");
        }}
      >
        {pinned ? "Remove from watchlist" : "Add to watchlist"}
      </button>
      {full && note && (
        <span role="status" className="ui text-muted">
          {note}
        </span>
      )}
    </span>
  );
}
