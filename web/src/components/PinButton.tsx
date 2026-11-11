"use client";

import { useState } from "react";
import { MAX_PINS, useStore, type Pin } from "@/lib/store";

/** "Add to chain": pins an entity to the watchlist (up to five). */
export function PinButton({ entity, className = "" }: { entity: Pin; className?: string }) {
  const { pin, unpin, isPinned, pins } = useStore();
  const [note, setNote] = useState("");
  const pinned = isPinned(entity.id);
  const full = !pinned && pins.length >= MAX_PINS;
  return (
    <span className={`inline-flex flex-wrap items-center gap-3 ${className}`}>
      <button
        type="button"
        className="marble pill"
        aria-pressed={pinned}
        onClick={() => {
          if (pinned) return unpin(entity.id);
          setNote(pin(entity) === "full" ? `The chain holds ${MAX_PINS}. Remove one first.` : "");
        }}
      >
        {pinned ? "on the chain ✓" : "add to chain"}
      </button>
      {full && note && (
        <span role="status" className="italic text-muted">
          {note}
        </span>
      )}
    </span>
  );
}
