// The autonomy categories (taxonomy slugs) and their plain-English names.

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
