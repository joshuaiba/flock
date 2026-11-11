// Engraved line icons, one per autonomy category plus the three kinds of node.
// Each is SVG path data on a 24x24 grid, stroked in sepia, so the same glyph
// draws in the page (SVG) and on a graph medallion (canvas Path2D).

export const ICON_BOX = 24;

const ICONS: Record<string, string> = {
  // wing
  uas: "M3 15c5 1.2 11.5-1 18-9.5-.8 5.2-4 8.6-7.5 9.8M6.5 15.6c3 1.6 7.2 1.2 9.8-.9M5 17.6c2.6 1.6 5.8 1.5 8.4.4",
  // shield
  "counter-uas": "M12 3l7 2.5V11c0 4.6-3 8.1-7 10-4-1.9-7-5.4-7-10V5.5zM12 7v10.5M8 11h8",
  // three birds
  swarming: "M3 9.5q2.4-2.4 4 0q1.6-2.4 4 0M12.5 6q2.4-2.4 4 0q1.6-2.4 4 0M9 15.5q2.4-2.4 4 0q1.6-2.4 4 0",
  // compass
  "gps-denied-nav":
    "M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16zM12 7l2 5-2 5-2-5zM12 1.8V4M12 20v2.2M1.8 12H4M20 12h2.2",
  // anchor
  maritime:
    "M12 7v13M12 7a2 2 0 1 0 0-4a2 2 0 0 0 0 4zM8.5 10.5h7M5 14c0 4 3 6 7 6s7-2 7-6M5 14l-1.6 2M5 14l2 1.4M19 14l1.6 2M19 14l-2 1.4",
  // chariot wheel
  "ground-robotics":
    "M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16zM12 10.4a1.6 1.6 0 1 0 0 3.2a1.6 1.6 0 1 0 0-3.2zM12 4v6.4M12 13.6V20M4 12h6.4M13.6 12H20M6.3 6.3l4.6 4.6M13.1 13.1l4.6 4.6M17.7 6.3l-4.6 4.6M10.9 13.1l-4.6 4.6",
  // meander (Greek key)
  "autonomy-software": "M3 18V6h18v12H7v-8h10v4h-6",
  // a pair in formation
  "collaborative-combat-aircraft": "M4 6l10 3-10 3 2.5-3zM10 13l10 3-10 3 2.5-3z",
  // spiral
  "loitering-munitions": "M12 12a1.5 1.5 0 0 1 3 0a3.5 3.5 0 0 1-7 0a5.5 5.5 0 0 1 11 0a7.5 7.5 0 0 1-15 0",
  // rayed sun
  "uxs-c2":
    "M12 8.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7zM12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1",
  // laurel
  company:
    "M12 20.5c-5-1-8-5-8-10.5M12 20.5c5-1 8-5 8-10.5M4.5 13.5q-2.2-.6-2.5-3q2.3.3 2.5 3zM6 16.6q-2.4.2-3.6-1.8q2.4-.3 3.6 1.8zM8.6 19q-2.2 1-4-.5q2-1.2 4 .5zM4.2 10.2q-1.6-1.6-.8-3.9q1.8 1.6.8 3.9zM19.5 13.5q2.2-.6 2.5-3q-2.3.3-2.5 3zM18 16.6q2.4.2 3.6-1.8q-2.4-.3-3.6 1.8zM15.4 19q2.2 1 4-.5q-2-1.2-4 .5zM19.8 10.2q1.6-1.6.8-3.9q-1.8 1.6-.8 3.9z",
  // column
  agency: "M7 6h10M8 6V4h8v2M9.2 6v13M14.8 6v13M12 6v13M7 19h10M5.5 21h13",
  // scroll
  opportunity: "M6 4h11v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2zM17 7h2v11a2 2 0 0 1-2 2M9 8.5h5M9 11.5h5M9 14.5h3",
};

/** Path data for an icon. Unknown names fall back to the kind icon. */
export function iconPath(name: string | null | undefined, fallback = "company"): string {
  return ICONS[name ?? ""] ?? ICONS[fallback] ?? ICONS.company;
}

const LABELS: Record<string, string> = {
  uas: "Uncrewed aircraft",
  "counter-uas": "Counter-drone",
  swarming: "Swarming",
  "gps-denied-nav": "Navigation without GPS",
  maritime: "Maritime",
  "ground-robotics": "Ground robotics",
  "autonomy-software": "Autonomy software",
  "collaborative-combat-aircraft": "Collaborative combat aircraft",
  "loitering-munitions": "Loitering munitions",
  "uxs-c2": "Command and teaming",
};

export const TAGS = Object.keys(LABELS);

export function tagLabel(slug: string): string {
  return LABELS[slug] ?? slug.replace(/-/g, " ");
}

/** The label mid-sentence: "navigation without GPS". */
export function tagPhrase(slug: string): string {
  const l = tagLabel(slug);
  return l.charAt(0).toLowerCase() + l.slice(1);
}

/** The icon for an entity: its main category, or its kind when it has none. */
export function entityIcon(tag: string | null | undefined, kind: string): string {
  if (tag && ICONS[tag]) return tag;
  return kind === "opportunity" ? "opportunity" : kind === "company" ? "company" : "agency";
}

// Fresco pigments for the category regions on the graph, like an old painted
// map: sage for ground, lake for maritime, ochre for aircraft, and so on.
const WASH: Record<string, string> = {
  "ground-robotics": "#a8bfa0",
  maritime: "#b7d3cf",
  uas: "#d9b26f",
  "counter-uas": "#d08c6a",
  swarming: "#c8dbe3",
  "gps-denied-nav": "#c9bbd0",
  "autonomy-software": "#e3d59a",
  "collaborative-combat-aircraft": "#ddb3a6",
  "loitering-munitions": "#bfc08a",
  "uxs-c2": "#9fc3b4",
};

export function washColor(tag: string | null | undefined): string {
  return WASH[tag ?? ""] ?? "#d8cdb8";
}
