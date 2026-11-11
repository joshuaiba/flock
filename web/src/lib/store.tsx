"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";

// Preferences and the watchlist live in localStorage. They are read through
// useSyncExternalStore so server HTML and hydration always agree (day mode, no
// pins), and the stored values arrive in a normal re-render right after.

export type Pin = { id: number; name: string; tag: string | null; kind: string };
export const MAX_PINS = 5;

type Persisted = { theme: "day" | "night"; still: boolean; pins: Pin[] };
const SERVER: Persisted = { theme: "day", still: false, pins: [] };

let state = SERVER;
let loaded = false;
const listeners = new Set<() => void>();

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private window: preferences just don't persist */
  }
}
function snapshot(): Persisted {
  if (!loaded) {
    loaded = true;
    // The inline script in layout.tsx already applied theme and still to <html>.
    const root = document.documentElement;
    const pins = read<Pin[]>("flock.pins", []);
    state = {
      theme: root.dataset.theme === "night" ? "night" : "day",
      still: root.hasAttribute("data-still"),
      pins: Array.isArray(pins) ? pins.slice(0, MAX_PINS) : [],
    };
  }
  return state;
}
function set(patch: Partial<Persisted>): void {
  state = { ...snapshot(), ...patch };
  listeners.forEach((l) => l());
}
function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

const REDUCED = "(prefers-reduced-motion: reduce)";
function subscribeReduced(l: () => void): () => void {
  const mq = window.matchMedia(REDUCED);
  mq.addEventListener("change", l);
  return () => mq.removeEventListener("change", l);
}

function toggleTheme(): void {
  const root = document.documentElement;
  const next = snapshot().theme === "night" ? "day" : "night";
  const apply = () => {
    root.dataset.theme = next;
    write("flock.theme", next);
    set({ theme: next });
    window.dispatchEvent(new Event("flock:theme"));
  };
  const quiet = snapshot().still || window.matchMedia(REDUCED).matches;
  if (quiet || !document.startViewTransition) return apply();
  root.classList.add("theme-sweep");
  document.startViewTransition(apply).finished.finally(() => root.classList.remove("theme-sweep"));
}

function toggleStill(): void {
  const next = !snapshot().still;
  document.documentElement.toggleAttribute("data-still", next);
  write("flock.still", next);
  set({ still: next });
}

function pin(p: Pin): "added" | "full" | "exists" {
  const { pins } = snapshot();
  if (pins.some((x) => x.id === p.id)) return "exists";
  if (pins.length >= MAX_PINS) return "full";
  const next = [...pins, p];
  write("flock.pins", next);
  set({ pins: next });
  return "added";
}

function unpin(id: number): void {
  const next = snapshot().pins.filter((x) => x.id !== id);
  write("flock.pins", next);
  set({ pins: next });
}

export function useStore() {
  const s = useSyncExternalStore(subscribe, snapshot, () => SERVER);
  const reduced = useSyncExternalStore(
    subscribeReduced,
    () => window.matchMedia(REDUCED).matches,
    () => false,
  );
  const isPinned = useCallback((id: number) => s.pins.some((x) => x.id === id), [s.pins]);
  return useMemo(
    () => ({
      theme: s.theme,
      toggleTheme,
      /** user chose "still" (low-power): flock frozen, physics settled */
      still: s.still,
      toggleStill,
      /** false when the user or the OS asked for no motion */
      motion: !s.still && !reduced,
      pins: s.pins,
      pin,
      unpin,
      isPinned,
    }),
    [s, reduced, isPinned],
  );
}

/** Where the watchlist chain's ring hangs, in viewport pixels. The graph uses it
 *  as the drop target when a node is dragged onto the chain. */
export const chainRing = { x: 0, y: 0, ready: false };
