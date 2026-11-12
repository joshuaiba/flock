import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  FogExp2,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  LineBasicMaterial,
  LineDashedMaterial,
  LineSegments,
  Matrix4,
  Spherical,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector2,
  Vector3,
  type InterleavedBufferAttribute,
  type PerspectiveCamera,
  type Scene as ThreeScene,
  type Texture,
  type WebGLRenderer,
} from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { day, money, plural, truncate } from "@/lib/format";
import type { L, N } from "@/lib/graphLayout";
import { readPalette, type Palette } from "@/lib/paint";
import { tagLabel } from "@/lib/tags";
import type { Scene3 } from "./Graph3DLayout";

// Everything the 3D view draws and every way it is handled, kept apart from
// React (Graph3D.tsx mounts it). react-force-graph-3d provides the WebGL
// renderer, the camera, the orbit controls and the render loop; this file puts
// the graph into that scene and runs once per rendered frame.
//
// Nodes are plain marks in the text color, the same three as the flat view: a
// filled dot for a company, a ring for an agency or office, a small diamond
// for a solicitation. Award edges are lines in the accent, weight by amount;
// every other edge is a faint dotted line in the text color.
//
// Drawing is kept cheap so a large graph stays fluid. All edges of a kind are
// one object (one draw call), not one object per edge. Each mark is a sprite
// sharing one of a few materials, and sprites are drawn grouped by material,
// not sorted by distance every frame: the depth buffer decides which mark is
// in front. Edges are drawn first and never cover a mark. Fog in the page
// color fades distant nodes into the page.
//
// The layout is frozen (Graph3DLayout.ts) and nothing moves by itself: there
// is no idle rotation and nothing travels along the edges. A node moves only
// while it is dragged, with its neighbors following on soft springs, and stays
// where it is left; the camera moves only when the reader turns it or a short
// flight answers a click. When nothing is moving the render loop is paused
// altogether.

/** The part of the react-force-graph-3d handle the stage uses. */
export type StageHost = {
  scene: () => ThreeScene;
  camera: () => unknown;
  renderer: () => unknown;
  controls: () => object;
  pauseAnimation: () => void;
  resumeAnimation: () => void;
};

export type StageOptions = {
  host: StageHost;
  /** the element around the canvas: pointer and key events are read here */
  wrap: HTMLElement;
  /** an empty overlay the stage fills with name labels */
  labels: HTMLElement;
  /** the small card that follows the pointer */
  tip: HTMLElement;
  onSelect: (id: string | null) => void;
};

export type Stage = {
  /** resolves once the stage can draw (the marks are drawn in code: at once) */
  ready: Promise<void>;
  setScene: (scene: Scene3 | null) => void;
  setHidden: (hidden: ReadonlySet<string>, tags: ReadonlySet<string>) => void;
  setSelected: (id: string | null) => void;
  setQuery: (query: string) => void;
  setMotion: (on: boolean) => void;
  /** the theme changed: read the palette again */
  retheme: () => void;
  /** pause while the tab is hidden or the graph is off screen */
  setBlocked: (blocked: boolean) => void;
  wake: () => void;
  fit: (animate: boolean) => void;
  focusOn: (id: string, fly: boolean) => void;
  zoom: (factor: number) => void;
  dispose: () => void;
};

// The three marks, and which one a node takes.
const SHAPES = ["dot", "ring", "diamond"] as const;
type Shape = (typeof SHAPES)[number];
const shapeOf = (n: N) => (n.kind === "company" ? 0 : n.kind === "opportunity" ? 2 : 1);

// Mark opacity by kind: everything else, open solicitations, closed ones.
// The same values as the flat view: opaque, so no edge shows through a dot.
const KIND_ALPHA = [1, 1, 0.5];
const FADED = 0.3; // what non-neighbors dim to while a node is hovered or selected

// Edge opacity at rest, and for the lit edges of a hovered or selected node.
const OTHER_EDGE_ALPHA = 0.36;
const AWARD_EDGE_ALPHA = 0.55;
const OTHER_LIT_ALPHA = 0.68;
const AWARD_LIT_ALPHA = 0.95;
/** Award edge widths in CSS pixels: under $2.5M, under $50M, larger. */
const AWARD_WIDTHS = [1.1, 1.8, 2.7];
/** The dotted line of an edge that is not an award, in world units. */
const DOT = 2;
const DOT_GAP = 7;

const FOV = 38; // degrees: a long lens, so the far side is not distorted
const FLY_MS = 600;
const MAX_LABELS = 72;
/** With more edges than this in view, detail is dropped while the camera moves fast. */
const HEAVY_EDGES = 1500;
const LIGHT_EDGES = 1200; // how many award edges are still drawn in that case

// Names over the canvas: a company in the display serif, an agency or office
// in the interface face, a category smaller and quieter.
const LABEL_BASE =
  "pointer-events-none absolute left-0 top-0 whitespace-nowrap leading-none opacity-0 transition-opacity duration-200 [text-shadow:0_0_3px_var(--bg),0_0_3px_var(--bg),0_0_5px_var(--bg)]";
const NAME_CLASS = `${LABEL_BASE} font-display text-[17px] font-medium text-ink`;
const ORG_CLASS = `${LABEL_BASE} font-sans text-[12.5px] text-muted`;
const ORG_LIT_CLASS = `${LABEL_BASE} font-sans text-[12.5px] text-ink`;
const REGION_CLASS = `${LABEL_BASE} font-sans text-[11px] text-muted`;

type Batch = {
  object: LineSegments | LineSegments2;
  fat: boolean;
  /** a dotted line: its dash distances are worked out again whenever its ends move */
  dotted: boolean;
  links: L[];
  /** six numbers per edge: both ends */
  array: Float32Array;
};
type Spring = {
  n: N;
  ox: number; oy: number; oz: number;
  tx: number; ty: number; tz: number;
  vx: number; vy: number; vz: number;
};
type Flight = {
  fromTarget: Vector3;
  toTarget: Vector3;
  from: Spherical;
  to: Spherical;
  turn: number;
  t: number;
  dur: number;
};
type Tag = { el: HTMLDivElement; key: string; x: number; y: number; alpha: number; kind: number; freeAt: number; seen: number };

const kindOf = (n: N) => (n.kind === "opportunity" ? (n.open ? 1 : 2) : 0);
const widthOf = (l: L) => (l.w < 1.4 ? 0 : l.w < 2.7 ? 1 : 2);
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** One mark as a texture, in the palette's own colors: a filled dot, a ring
 *  with a finer ring inside it, or a diamond. The outlines are filled with the
 *  page color, so no edge shows through them. */
function markTexture(shape: Shape, palette: Palette): Texture {
  const size = 128;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const mid = size / 2;
  g.fillStyle = shape === "dot" ? palette.text : palette.bg;
  g.strokeStyle = palette.text;
  g.lineJoin = "miter";
  if (shape === "diamond") {
    const w = 12;
    const r = mid - w;
    g.beginPath();
    g.moveTo(mid, mid - r);
    g.lineTo(mid + r, mid);
    g.lineTo(mid, mid + r);
    g.lineTo(mid - r, mid);
    g.closePath();
    g.fill();
    g.lineWidth = w;
    g.stroke();
  } else if (shape === "ring") {
    const w = 8;
    g.beginPath();
    g.arc(mid, mid, mid - w / 2 - 1, 0, Math.PI * 2);
    g.fill();
    g.lineWidth = w;
    g.stroke();
    g.beginPath();
    g.arc(mid, mid, (mid - 1) * 0.52, 0, Math.PI * 2);
    g.lineWidth = 5;
    g.stroke();
  } else {
    g.beginPath();
    g.arc(mid, mid, mid - 1, 0, Math.PI * 2);
    g.fill();
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  return t;
}

export function createStage({ host, wrap, labels: layer, tip, onSelect }: StageOptions): Stage {
  const world = host.scene();
  const camera = host.camera() as PerspectiveCamera;
  const renderer = host.renderer() as WebGLRenderer;
  const controls = host.controls() as OrbitControls;
  const canvas = renderer.domElement;
  // the rail and the panel live in the explorer around this view
  const root = wrap.closest<HTMLElement>("[data-graph-root]") ?? wrap;

  // A stage before this one may have left the render loop asleep.
  host.resumeAnimation();

  let alive = true;
  let palette = readPalette();
  let data: Scene3 | null = null;
  let hidden: ReadonlySet<string> = new Set();
  let tags: ReadonlySet<string> = new Set();
  let liveTags = new Set<string>(); // categories that still have a member on the map
  let selected: string | null = null;
  let hover: string | null = null;
  let query = "";
  let matches: Set<string> | null = null;
  let motion = true;
  let W = 0;
  let H = 0;

  // ---- Camera and controls ----

  camera.fov = FOV;
  camera.near = 4;
  camera.far = 20000;
  camera.updateProjectionMatrix();
  controls.enableDamping = true; // inertia: an orbit eases to a stop
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.55;
  controls.zoomSpeed = 0.9;
  controls.zoomToCursor = true;
  controls.screenSpacePanning = true;
  controls.minPolarAngle = 0.12; // never straight over a pole, where an orbit flips
  controls.maxPolarAngle = Math.PI - 0.12;
  controls.minDistance = 60;
  controls.maxDistance = 6000;
  controls.autoRotate = false; // the graph never turns by itself

  const fog = new FogExp2(palette.bg, 0.0004);
  world.fog = fog;

  // ---- What is drawn ----

  // Everything this stage adds to the library's scene. Without sorting, things
  // are drawn in the order they are added here: edges, lit edges, marks, rings.
  const group = new Group();
  const nodesGroup = new Group();
  world.add(group);
  const sorted = renderer.sortObjects;
  renderer.sortObjects = false;

  let textures: Texture[] = [];
  // [shape][kind]: `rest` materials fade when something is in focus, `lit` ones never do
  let rest: SpriteMaterial[][] = [];
  let lit: SpriteMaterial[][] = [];
  let sprites: Sprite[] = [];
  let slot = new Map<string, number>(); // node id -> index into data.nodes and sprites

  // A mark hides whatever is behind it (the corners of its square are cut away
  // by the alpha test). Closed solicitations are see-through, so they are
  // drawn after the rest and hide nothing.
  const spriteMaterial = (map: Texture, kind: number) =>
    new SpriteMaterial({ map, transparent: true, depthTest: true, depthWrite: kind < 2, alphaTest: 0.5, fog: true });

  /** Draw the three marks in the palette's colors. */
  const drawMarks = () =>
    SHAPES.map((shape) => {
      const t = markTexture(shape, palette);
      t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      t.needsUpdate = true;
      return t;
    });
  textures = drawMarks();
  rest = textures.map((t) => KIND_ALPHA.map((_, kind) => spriteMaterial(t, kind)));
  lit = textures.map((t) => KIND_ALPHA.map((_, kind) => spriteMaterial(t, kind)));
  const ready = Promise.resolve();

  const thinMaterial = (color: string) =>
    new LineBasicMaterial({ color, transparent: true, depthTest: false, depthWrite: false, fog: true });
  const dottedMaterial = (color: string) =>
    new LineDashedMaterial({ color, dashSize: DOT, gapSize: DOT_GAP, transparent: true, depthTest: false, depthWrite: false, fog: true });
  const fatMaterial = (color: string, linewidth: number, fogged = true) =>
    new LineMaterial({ color, linewidth, transparent: true, depthTest: false, depthWrite: false, fog: fogged });

  const batch = (material: LineBasicMaterial | LineDashedMaterial | LineMaterial, order: number): Batch => {
    const fat = material instanceof LineMaterial;
    const dotted = material instanceof LineDashedMaterial;
    const object = fat ? new LineSegments2(new LineSegmentsGeometry(), material) : new LineSegments(new BufferGeometry(), material);
    object.frustumCulled = false; // one object spans the whole graph
    object.renderOrder = order;
    object.visible = false;
    group.add(object);
    const b: Batch = { object, fat, dotted, links: [], array: new Float32Array(0) };
    return b;
  };

  /** Give a batch its edges: (re)allocate if it grew, then write the positions. */
  const load = (b: Batch, links: L[]) => {
    b.links = links;
    if (b.array.length < links.length * 6 || b.array.length === 0) {
      b.array = new Float32Array(Math.max(links.length, 1) * 6);
      b.object.geometry.dispose();
      (b.object as { geometry: BufferGeometry }).geometry = b.fat
        ? new LineSegmentsGeometry().setPositions(b.array)
        : new BufferGeometry().setAttribute("position", new BufferAttribute(b.array, 3));
    }
    write(b);
  };

  /** Copy the current node positions into a batch's buffer. */
  const write = (b: Batch) => {
    const a = b.array;
    let o = 0;
    for (const l of b.links) {
      a[o++] = l.source.x;
      a[o++] = l.source.y;
      a[o++] = l.source.z;
      a[o++] = l.target.x;
      a[o++] = l.target.y;
      a[o++] = l.target.z;
    }
    if (b.fat) {
      const g = b.object.geometry as LineSegmentsGeometry;
      g.instanceCount = b.links.length;
      (g.attributes.instanceStart as unknown as InterleavedBufferAttribute).data.needsUpdate = true;
    } else {
      const g = b.object.geometry as BufferGeometry;
      g.setDrawRange(0, b.links.length * 2);
      g.attributes.position.needsUpdate = true;
      if (b.dotted) (b.object as LineSegments).computeLineDistances();
    }
  };

  const ink = batch(dottedMaterial(palette.text), -4);
  const awardsThin = batch(thinMaterial(palette.accent), -4); // stands in for the strokes below while the camera rushes
  const awards = AWARD_WIDTHS.map((w) => batch(fatMaterial(palette.accent, w), -4));
  const inkLit = batch(dottedMaterial(palette.text), -3);
  const awardsLit = AWARD_WIDTHS.map((w) => batch(fatMaterial(palette.accent, w + 0.4), -3));
  const batches = [ink, awardsThin, ...awards, inkLit, ...awardsLit];
  let edgeCount = 0;
  group.add(nodesGroup);

  // The thin ring around the selected node, and around the hovered one.
  // A circle of line segments turned to face the camera, so its stroke keeps
  // the same width on screen at any distance.
  const circle = new Float32Array(72 * 6);
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2;
    const b = ((i + 1) / 72) * Math.PI * 2;
    circle.set([Math.cos(a), Math.sin(a), 0, Math.cos(b), Math.sin(b), 0], i * 6);
  }
  const ringGeometry = new LineSegmentsGeometry().setPositions(circle);
  const ringMaterial = fatMaterial(palette.text, 1.25, false);
  const rings = [0, 1].map(() => {
    const ring = new LineSegments2(ringGeometry, ringMaterial);
    ring.frustumCulled = false;
    ring.renderOrder = 2;
    ring.visible = false;
    group.add(ring);
    return ring;
  });

  // ---- Focus: what is lit, and how far the rest has faded ----

  let dim = 0; // 0..1: how far non-neighbors have faded
  let dimGoal = 0;
  let focusKey = ""; // what `litIds` was built for
  let litIds = new Set<string>();

  /** Set every opacity from the fade and how crowded the edges are. */
  const tone = () => {
    const faded = 1 - (1 - FADED) * dim;
    for (let m = 0; m < rest.length; m++) {
      for (let k = 0; k < KIND_ALPHA.length; k++) {
        rest[m][k].opacity = KIND_ALPHA[k] * faded;
        lit[m][k].opacity = KIND_ALPHA[k];
        // the cut follows the opacity, so a faded mark keeps its shape
        rest[m][k].alphaTest = rest[m][k].opacity * 0.5;
        lit[m][k].alphaTest = lit[m][k].opacity * 0.5;
      }
      // once faded, a mark no longer hides the lit ones behind it
      rest[m][0].depthWrite = rest[m][1].depthWrite = dim < 0.5;
    }
    // a great many edges are drawn fainter, so they read as a haze, not a tangle
    const crowd = Math.min(1, Math.sqrt(900 / Math.max(edgeCount, 1)));
    (ink.object.material as LineDashedMaterial).opacity = OTHER_EDGE_ALPHA * crowd * faded;
    (awardsThin.object.material as LineBasicMaterial).opacity = AWARD_EDGE_ALPHA * crowd * faded;
    for (const b of awards) (b.object.material as LineMaterial).opacity = AWARD_EDGE_ALPHA * crowd * faded;
    (inkLit.object.material as LineDashedMaterial).opacity = OTHER_LIT_ALPHA * dim;
    for (const b of awardsLit) (b.object.material as LineMaterial).opacity = AWARD_LIT_ALPHA * dim;
  };

  const dress = (id: string, on: boolean) => {
    const i = slot.get(id);
    if (i === undefined || !data) return;
    const n = data.nodes[i];
    sprites[i].material = (on ? lit : rest)[shapeOf(n)][kindOf(n)];
  };

  const shown = (l: L) => !hidden.has(l.source.id) && !hidden.has(l.target.id);

  /** Work out what is in focus (hovered, else selected, else the search
   *  matches), light it and its edges, and let everything else fade. */
  const relight = (force = false) => {
    if (!data) return;
    const fid = hover ?? selected;
    const key = fid ? `n:${fid}` : matches ? `q:${query}` : "";
    if (key === focusKey && !force) return;
    focusKey = key;
    dirty = true;
    if (!key) {
      // nothing in focus: the lit set stays lit until the rest has faded back in
      dimGoal = 0;
      return;
    }
    for (const id of litIds) dress(id, false);
    litIds = fid ? new Set([fid, ...(data.near.get(fid) ?? [])]) : new Set(matches);
    for (const id of litIds) dress(id, true);
    const edges = fid
      ? (data.linksOf.get(fid) ?? []).filter(shown)
      : data.links.filter((l) => shown(l) && (matches!.has(l.source.id) || matches!.has(l.target.id)));
    load(inkLit, edges.filter((l) => l.kind !== "award"));
    const won = edges.filter((l) => l.kind === "award");
    awardsLit.forEach((b, w) => load(b, won.filter((l) => widthOf(l) === w)));
    dimGoal = 1;
  };

  /** Drop the focus at once, without the fade. */
  const unlight = () => {
    for (const id of litIds) dress(id, false);
    litIds = new Set();
    focusKey = "";
    dim = dimGoal = 0;
    tone();
  };

  // ---- Filters ----

  const refilter = () => {
    if (!data) return;
    liveTags = new Set();
    data.nodes.forEach((n, i) => {
      const on = !hidden.has(n.id);
      sprites[i].visible = on;
      if (on && !n.org && n.tag) liveTags.add(n.tag);
    });
    const edges = data.links.filter(shown);
    edgeCount = edges.length;
    load(ink, edges.filter((l) => l.kind !== "award"));
    // largest first: when detail is dropped, the edges that go are the small ones
    const won = edges.filter((l) => l.kind === "award").sort((a, b) => b.amount - a.amount);
    load(awardsThin, won);
    awards.forEach((b, w) => load(b, won.filter((l) => widthOf(l) === w)));
    matches = query ? new Set(data.nodes.filter((n) => !hidden.has(n.id) && n.nameLower.includes(query)).map((n) => n.id)) : null;
    if (hover && hidden.has(hover)) hover = null;
    if (!focusKey && litIds.size) unlight(); // a fade that was still finishing
    relight(true);
    tone();
    measureSoon();
    dirty = true;
  };

  // ---- Screen positions (for picking and labels) ----

  const pv = new Matrix4();
  const pvWas = new Float64Array(16); // the same precision as the matrix, or it would never compare equal
  let px = new Float32Array(0);
  let py = new Float32Array(0);
  let pr = new Float32Array(0); // radius on screen, in CSS pixels
  let pw = new Float32Array(0); // distance in front of the camera; 0 when not on screen
  let perUnit = 1; // pixels per world unit at distance 1
  let dirty = true; // labels and screen positions need working out again

  const project = () => {
    if (!data) return;
    const e = pv.elements;
    const nodes = data.nodes;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (hidden.has(n.id)) {
        pw[i] = 0;
        continue;
      }
      const w = e[3] * n.x + e[7] * n.y + e[11] * n.z + e[15];
      if (w < camera.near) {
        pw[i] = 0; // behind the camera
        continue;
      }
      const x = ((e[0] * n.x + e[4] * n.y + e[8] * n.z + e[12]) / w) * 0.5 + 0.5;
      const y = 0.5 - ((e[1] * n.x + e[5] * n.y + e[9] * n.z + e[13]) / w) * 0.5;
      const r = (n.r * perUnit) / w;
      px[i] = x * W;
      py[i] = y * H;
      pr[i] = r;
      pw[i] = px[i] + r < 0 || px[i] - r > W || py[i] + r < 0 || py[i] - r > H ? 0 : w;
    }
  };

  /** The front-most node under a point of the canvas. */
  const nodeAt = (x: number, y: number): N | null => {
    if (!data) return null;
    let best = -1;
    for (let i = 0; i < pw.length; i++) {
      if (!pw[i]) continue;
      const d = Math.hypot(px[i] - x, py[i] - y) - Math.max(4, pr[i]);
      if (d < 4 && (best < 0 || pw[i] < pw[best])) best = i;
    }
    return best < 0 ? null : data.nodes[best];
  };

  // ---- Labels: HTML over the canvas ----
  //
  // Names are set in the display serif, only for the largest nodes and for the
  // node in focus and its neighbors. Each frame they are placed greedily by
  // importance, and a name is shown only where it overlaps nothing already
  // placed, the same rule as the flat view. The elements are pooled.

  const pool: Tag[] = Array.from({ length: MAX_LABELS }, () => {
    const el = document.createElement("div");
    el.className = NAME_CLASS;
    layer.appendChild(el);
    return { el, key: "", x: NaN, y: NaN, alpha: 0, kind: 0, freeAt: 0, seen: -1 };
  });
  const named = new Map<string, Tag>();
  let stamp = 0;
  const meter = document.createElement("canvas").getContext("2d")!;
  let fonts = { name: "500 17px Georgia", org: "12.5px sans-serif", region: "11px sans-serif" };
  let obstacles: number[] = [];
  const placed: number[] = [];

  const readFonts = () => {
    const s = getComputedStyle(document.documentElement);
    const sans = `${s.getPropertyValue("--font-inter").trim() || "system-ui"}, system-ui, sans-serif`;
    fonts = {
      name: `500 17px ${s.getPropertyValue("--font-cormorant").trim() || "Georgia"}, Georgia, serif`,
      org: `12.5px ${sans}`,
      region: `11px ${sans}`,
    };
    for (const n of data?.nodes ?? []) n.labelWidth = 0;
    dirty = true;
  };

  /** Rail and panel rectangles, so labels are never drawn underneath them. */
  const measure = () => {
    if (!alive) return;
    obstacles = [];
    const base = canvas.getBoundingClientRect();
    for (const el of root.querySelectorAll<HTMLElement>("[data-obstacle]")) {
      const r = el.getBoundingClientRect();
      obstacles.push(r.left - base.left - 6, r.top - base.top - 6, r.right - base.left + 6, r.bottom - base.top + 6);
    }
    dirty = true;
    wake();
  };
  let measureTimers: number[] = [];
  /** Soon, and again once the panel has finished sliding in. */
  const measureSoon = () => {
    measureTimers.forEach(clearTimeout);
    measureTimers = [window.setTimeout(measure, 60), window.setTimeout(measure, 520)];
  };

  const place = (x0: number, y0: number, x1: number, y1: number) => {
    // labels keep a margin from the edge of the view
    const edge = 16;
    if (x0 < edge || y0 < edge || x1 > W - edge || y1 > H - edge) return false;
    for (let i = 0; i < obstacles.length; i += 4)
      if (x0 < obstacles[i + 2] && x1 > obstacles[i] && y0 < obstacles[i + 3] && y1 > obstacles[i + 1]) return false;
    for (let i = 0; i < placed.length; i += 4)
      if (x0 < placed[i + 2] && x1 > placed[i] && y0 < placed[i + 3] && y1 > placed[i + 1]) return false;
    placed.push(x0, y0, x1, y1);
    return true;
  };

  /** Show a label this frame at (x, y), its top-left corner. kind: 0 company,
   *  1 the node in focus, 2 category, 3 agency or office. */
  const show = (key: string, text: string, x: number, y: number, alpha: number, kind: number, now: number) => {
    let t = named.get(key);
    if (!t) {
      // a label that has only just faded out is left to finish before it is reused
      t = pool.find((p) => !p.key && p.freeAt <= now);
      if (!t) return;
      t.key = key;
      t.kind = -1;
      t.x = NaN;
      t.el.textContent = text;
      named.set(key, t);
    }
    if (t.kind !== kind) {
      t.kind = kind;
      t.el.className = kind === 2 ? REGION_CLASS : kind === 3 ? ORG_CLASS : kind === 4 ? ORG_LIT_CLASS : NAME_CLASS;
    }
    x = Math.round(x * 2) / 2;
    y = Math.round(y * 2) / 2;
    if (t.x !== x || t.y !== y) {
      t.x = x;
      t.y = y;
      t.el.style.transform = `translate3d(${x}px,${y}px,0)`;
    }
    alpha = Math.round(alpha * 50) / 50;
    if (t.alpha !== alpha) {
      t.alpha = alpha;
      t.el.style.opacity = String(alpha);
    }
    t.seen = stamp;
  };

  const label = (now: number) => {
    stamp++;
    placed.length = 0;
    if (data && W) {
      const nodes = data.nodes;
      const fid = hover ?? selected;
      const around = fid ? data.near.get(fid) : null;
      const focused = !!fid || !!matches;
      const isLit = (n: N) => (fid ? n.id === fid || !!around?.has(n.id) : matches ? matches.has(n.id) : true);
      const faded = 1 - (1 - FADED) * dim;
      // distant names fade with their nodes, though never as far
      const haze = (w: number) => 1 - 0.55 * (1 - Math.exp(-((fog.density * w) ** 2)));

      // The hovered and the selected node are always named, wherever there is
      // room beside them: they are placed before anything else can be in the way.
      let budget = MAX_LABELS - 14;
      const name = (i: number, forced: boolean, alpha: number) => {
        if (budget <= 0) return;
        const n = nodes[i];
        // a company in the display serif, anything else in the interface face
        const plain = n.org || n.kind === "opportunity";
        meter.font = plain ? fonts.org : fonts.name;
        const tall = plain ? 15 : 18;
        const text = truncate(n.name, forced ? 60 : 34);
        if (!n.labelWidth) n.labelWidth = meter.measureText(truncate(n.name, 34)).width;
        const w = forced ? meter.measureText(text).width : n.labelWidth;
        const r = Math.max(2.5, pr[i]);
        // A company's name sits beside its dot (right, left, below, above); an
        // agency's sits under its ring (below, above, right, left). The first
        // spot that is free.
        const side = (dir: number): [number, number] => [px[i] + dir * (r + 9 + w / 2), py[i] - tall / 2];
        const spots: [number, number][] = n.org
          ? [[px[i], py[i] + r + 6], [px[i], py[i] - r - tall - 5], side(1), side(-1)]
          : [side(1), side(-1), [px[i], py[i] + r + 6], [px[i], py[i] - r - tall - 5]];
        const spot = spots.find(([x, y]) => place(x - w / 2 - 4, y - 1, x + w / 2 + 4, y + tall));
        if (!spot) return;
        budget--;
        const kind = plain ? (forced || alpha >= 1 ? 4 : 3) : forced ? 1 : 0;
        show(`${forced ? "f" : "n"}:${n.id}`, text, spot[0] - w / 2, spot[1], alpha, kind, now);
      };
      for (const id of hover === selected ? [selected] : [hover, selected]) {
        const i = id ? slot.get(id) : undefined;
        if (i !== undefined && pw[i]) name(i, true, 1);
      }

      // marks are obstacles too: no other name sits on top of a node
      for (let i = 0; i < nodes.length; i++) {
        if (!pw[i] || pr[i] < 3.5) continue;
        placed.push(px[i] - pr[i], py[i] - pr[i], px[i] + pr[i], py[i] + pr[i]);
      }

      // category names next, above their constellations
      meter.font = fonts.region;
      const e = pv.elements;
      for (const g of data.regions) {
        if (g.n < 2 || (tags.size && !tags.has(g.tag)) || !liveTags.has(g.tag)) continue;
        const w = e[3] * g.x + e[7] * g.y + e[11] * g.z + e[15];
        if (w < camera.near) continue;
        const x = (((e[0] * g.x + e[4] * g.y + e[8] * g.z + e[12]) / w) * 0.5 + 0.5) * W;
        const y = (0.5 - ((e[1] * g.x + e[5] * g.y + e[9] * g.z + e[13]) / w) * 0.5) * H - (g.radius * perUnit) / w - 22;
        const text = tagLabel(g.tag);
        const width = meter.measureText(text).width;
        if (!place(x - width / 2 - 6, y - 3, x + width / 2 + 6, y + 15)) continue;
        show(`g:${g.tag}`, text, x - width / 2, y, (0.8 - 0.45 * dim) * haze(w), 2, now);
      }

      // nodes are in order of dollars, so the largest claim their space first
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (!pw[i] || n.id === hover || n.id === selected || n.kind === "opportunity") continue;
        if (focused && isLit(n)) name(i, false, 1);
        else if (n.rank < 12 || pr[i] >= 10) name(i, false, (focused ? Math.max(faded, 0.45) : 0.98) * haze(pw[i]));
      }
    }
    for (const [key, t] of named) {
      if (t.seen === stamp) continue;
      t.el.style.opacity = "0";
      t.alpha = 0;
      t.key = "";
      t.freeAt = now + 220;
      named.delete(key);
    }
  };

  // ---- Camera moves ----

  const wide = () => W > 900;
  /** The part of the canvas not covered by the rail, nav or panel. */
  const room = (panel = !!selected) =>
    wide()
      ? { l: 304, t: 76, r: panel ? 356 : 48, b: 64 }
      : { l: 24, t: 170, r: 24, b: panel ? Math.min(H * 0.5, 380) : 30 };

  // The picture is shifted so the middle of the scene sits in the middle of
  // that room, not under the rail. The shift eases when the panel opens.
  const shift = { x: 0, y: 0 };
  let shifted = false; // the shift has been applied to the camera at this size
  const shiftGoal = () => {
    const p = room();
    return { x: p.l + (W - p.l - p.r) / 2 - W / 2, y: p.t + (H - p.t - p.b) / 2 - H / 2 };
  };

  /** How far out the camera may go: far enough to see the graph whole with room to spare. */
  const limits = () => {
    if (!data || !W) return;
    controls.maxDistance = Math.max(900, distanceFor(data.radius) * 1.9);
    camera.far = controls.maxDistance + data.radius * 2 + 500;
    camera.updateProjectionMatrix();
  };

  /** How far back the camera must be for a sphere of this radius to fit the room. */
  const distanceFor = (radius: number, panel = !!selected) => {
    const p = room(panel);
    const half = Math.tan((FOV * Math.PI) / 360) * Math.max(0.25, Math.min(W - p.l - p.r, H - p.t - p.b) / Math.max(H, 1));
    return radius / Math.sin(Math.atan(half));
  };

  let flight: Flight | null = null;
  let homed = false; // the camera has been placed for this graph
  const v1 = new Vector3();
  const v2 = new Vector3();
  const sph = new Spherical();

  /** Move the camera to look at `target` from `direction`, `distance` away. The
   *  path is an arc around the target (angles and distance are eased, not the
   *  position), so the camera never cuts through the middle of the graph. */
  const flyTo = (target: Vector3, direction: Vector3, distance: number, animate: boolean, ms = FLY_MS) => {
    const to = new Spherical().setFromVector3(direction);
    to.radius = Math.max(controls.minDistance, Math.min(controls.maxDistance, distance));
    to.phi = Math.max(controls.minPolarAngle, Math.min(controls.maxPolarAngle, to.phi));
    if (!animate || !motion) {
      flight = null;
      controls.target.copy(target);
      camera.position.setFromSpherical(to).add(target);
    } else {
      const from = new Spherical().setFromVector3(v1.subVectors(camera.position, controls.target));
      let turn = to.theta - from.theta;
      if (turn > Math.PI) turn -= Math.PI * 2;
      if (turn < -Math.PI) turn += Math.PI * 2;
      flight = { fromTarget: controls.target.clone(), toTarget: target.clone(), from, to, turn, t: 0, dur: ms / 1000 };
    }
    wake();
  };

  const fit = (animate: boolean) => {
    if (!data || !W) return;
    // the first view of a graph is from a little above and to one side; after
    // that, fitting keeps the direction the reader has chosen
    if (homed) v2.subVectors(camera.position, controls.target);
    else v2.set(0.42, 0.3, 1);
    homed = true;
    // a little inside the sphere that holds every node: only its outermost node touches the edge of the room
    flyTo(new Vector3(0, 0, 0), v2, distanceFor(data.radius) * 0.94, animate);
  };

  /** Fly to a node, ending far enough back that its neighbors are in view. */
  const focusOn = (id: string) => {
    const n = data?.byId.get(id);
    if (!data || !n || !W) return;
    selected = id; // the room is narrower with the panel open
    relight();
    // Mostly from where the camera already is, leaning toward the outside of
    // the graph, so the node is in front and what it connects to lies behind it.
    const direction = new Vector3().subVectors(camera.position, controls.target).normalize();
    const out = Math.hypot(n.x, n.y, n.z);
    const lean = Math.min(1, out / (data.radius * 0.5)) * 1.2;
    if (out > 1) direction.addScaledVector(v2.set(n.x, n.y, n.z).divideScalar(out), lean).normalize();
    // Close enough to read the node, and never closer than its neighbors
    // allow: one far to the side needs distance, one straight behind needs none.
    // camera distance needed per unit of sideways reach (on a phone the panel
    // leaves too little room to promise the neighbors a place beside it)
    const spread = distanceFor(1, wide());
    let distance = Math.max(220, Math.min(600, n.r * 22));
    for (const o of data.near.get(id) ?? []) {
      const q = data.byId.get(o);
      if (!q || hidden.has(o)) continue;
      v1.set(q.x - n.x, q.y - n.y, q.z - n.z);
      const toward = v1.dot(direction); // how far the neighbor is toward the camera
      const aside = Math.sqrt(Math.max(0, v1.lengthSq() - toward * toward));
      distance = Math.max(distance, (aside + q.r + 24) * spread + toward);
    }
    // a hub with neighbors on every side is seen from no farther than the whole graph
    distance = Math.min(distance, distanceFor(data.radius, wide()) * 1.03);
    flyTo(new Vector3(n.x, n.y, n.z), direction, distance, true);
  };

  const zoom = (factor: number) => {
    const offset = v2.subVectors(camera.position, controls.target);
    flyTo(controls.target.clone(), offset, offset.length() / factor, true, 260);
  };

  /** Orbit by a step, for the arrow keys. */
  const turnBy = (theta: number, phi: number) => {
    sph.setFromVector3(v1.subVectors(camera.position, controls.target));
    sph.theta += theta;
    sph.phi += phi;
    flyTo(controls.target.clone(), v2.setFromSpherical(sph), sph.radius, true, 220);
  };

  // ---- Pointer ----

  let pointer: null | {
    id: number;
    node: N | null;
    sx: number; sy: number;
    ox: number; oy: number; oz: number;
    /** distance of the dragged node in front of the camera */
    depth: number;
    grab: Vector3;
    moved: boolean;
  } = null;
  let springs: Spring[] = [];
  let inside = false; // the pointer is over the canvas
  const at = { x: 0, y: 0 }; // where it last was

  const local = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  /** The point under the pointer, `depth` in front of the camera. */
  const pointAt = (x: number, y: number, depth: number, out: Vector3) => {
    out.set((x / W) * 2 - 1, 1 - (y / H) * 2, 0.5).unproject(camera).sub(camera.position).normalize();
    const forward = camera.getWorldDirection(v2);
    return out.multiplyScalar(depth / Math.max(out.dot(forward), 1e-3)).add(camera.position);
  };

  const setHover = (n: N | null) => {
    const id = n?.id ?? null;
    canvas.style.cursor = n ? "pointer" : pointer ? "grabbing" : "grab";
    if (n) {
      tip.textContent =
        n.kind === "opportunity"
          ? `${n.open ? "Open" : "Closed"} solicitation · posted ${day(n.posted, true)}`
          : `${money(n.total)} · ${plural(n.awards, "award")}`;
      tip.style.transform = `translate(${Math.min(at.x + 16, W - 240)}px, ${Math.max(8, at.y - 34)}px)`;
    }
    tip.style.opacity = n ? "1" : "0";
    if (hover !== id) {
      hover = id;
      relight();
    }
  };

  const moveNode = (n: N, x: number, y: number, z: number) => {
    n.x = x;
    n.y = y;
    n.z = z;
    const s = sprites[slot.get(n.id)!];
    s.position.set(x, y, z);
    s.updateMatrix();
    s.updateMatrixWorld(true);
  };

  const onDown = (e: PointerEvent) => {
    if (pointer || e.button !== 0) return wake();
    at.x = local(e).x;
    at.y = local(e).y;
    const n = nodeAt(at.x, at.y);
    flight = null;
    pointer = { id: e.pointerId, node: n, sx: at.x, sy: at.y, ox: 0, oy: 0, oz: 0, depth: 0, grab: new Vector3(), moved: false };
    if (n) {
      // The node is being handled, so the orbit controls must not turn the
      // camera. This listener runs in the capture phase, before theirs.
      controls.enabled = false;
      canvas.setPointerCapture(e.pointerId);
      pointer.ox = n.x;
      pointer.oy = n.y;
      pointer.oz = n.z;
      pointer.depth = v1.set(n.x, n.y, n.z).sub(camera.position).dot(camera.getWorldDirection(v2));
      pointAt(at.x, at.y, pointer.depth, pointer.grab);
      // Direct neighbors will be pulled along on soft springs.
      springs = springs.filter((s) => s.n !== n);
      const held = new Set(springs.map((s) => s.n));
      for (const id of data?.near.get(n.id) ?? []) {
        const q = data!.byId.get(id);
        if (!q || held.has(q) || hidden.has(id) || springs.length > 60) continue;
        springs.push({ n: q, ox: q.x, oy: q.y, oz: q.z, tx: q.x, ty: q.y, tz: q.z, vx: 0, vy: 0, vz: 0 });
      }
    }
    canvas.style.cursor = "grabbing";
    wake();
  };

  const onMove = (e: PointerEvent) => {
    const p = local(e);
    at.x = p.x;
    at.y = p.y;
    inside = true;
    if (!pointer) {
      setHover(nodeAt(p.x, p.y));
      return wake();
    }
    if (e.pointerId !== pointer.id) return;
    if (Math.hypot(p.x - pointer.sx, p.y - pointer.sy) > 4) pointer.moved = true;
    if (pointer.moved) tip.style.opacity = "0";
    const n = pointer.node;
    if (n && pointer.moved) {
      // the node follows the pointer at the depth it was picked up at
      const to = pointAt(p.x, p.y, pointer.depth, v1);
      const dx = to.x - pointer.grab.x;
      const dy = to.y - pointer.grab.y;
      const dz = to.z - pointer.grab.z;
      moveNode(n, pointer.ox + dx, pointer.oy + dy, pointer.oz + dz);
      const around = data?.near.get(n.id);
      for (const s of springs) {
        if (!around?.has(s.n.id)) continue;
        s.tx = s.ox + dx * 0.55;
        s.ty = s.oy + dy * 0.55;
        s.tz = s.oz + dz * 0.55;
      }
      moved = true;
    }
    wake();
  };

  const onUp = (e: PointerEvent) => {
    const p = pointer;
    if (!p || e.pointerId !== p.id) return;
    pointer = null;
    canvas.style.cursor = "grab";
    const n = p.node;
    if (n) {
      controls.enabled = true;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    }
    if (e.type === "pointercancel") {
      // the browser took the gesture away: no click, and nothing is dropped
    } else if (n && !p.moved) {
      const next = selected === n.id ? null : n.id;
      selected = next;
      onSelect(next);
      relight();
      if (next) focusOn(next);
      tip.style.opacity = "0"; // the camera is about to move out from under it
    } else if (!n && !p.moved) {
      selected = null;
      onSelect(null);
      relight();
    }
    wake();
  };

  const onLeave = () => {
    inside = false;
    if (!pointer) setHover(null);
    wake();
  };
  const onWheel = () => {
    flight = null;
    wake();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.target !== wrap) return;
    if (e.key === "ArrowLeft") turnBy(-0.16, 0);
    else if (e.key === "ArrowRight") turnBy(0.16, 0);
    else if (e.key === "ArrowUp") turnBy(0, -0.12);
    else if (e.key === "ArrowDown") turnBy(0, 0.12);
    else if (e.key === "+" || e.key === "=") zoom(1.35);
    else if (e.key === "-") zoom(1 / 1.35);
    else if (e.key === "0") fit(true);
    else if (e.key === "Escape") {
      selected = null;
      onSelect(null);
      relight();
    } else return;
    e.preventDefault();
    wake();
  };
  /** The reader took hold of the camera: a flight in progress gives way. */
  const onGrab = () => {
    flight = null;
    wake();
  };

  // ---- The frame ----

  let last = performance.now();
  let moved = false; // a node moved since the last frame
  let light = false; // edge detail is dropped: a crowded graph seen from far out or in a rush
  let calmAt = 0;
  let paused = false; // the render loop is stopped
  let blocked = false; // the tab is hidden or the graph is off screen
  let lastWake = performance.now();
  let sleepTimer = 0;
  const size = new Vector2();
  const was = new Vector3(); // where the camera was a frame ago

  const wake = () => {
    lastWake = performance.now();
    if (!paused || blocked || !alive) return;
    paused = false;
    host.resumeAnimation();
  };

  /** Stop the render loop until something happens. */
  const sleep = () => {
    sleepTimer = 0;
    if (!alive || paused || performance.now() - lastWake < 400) return;
    paused = true;
    host.pauseAnimation();
  };

  const stepSprings = (dt: number) => {
    if (!springs.length) return;
    // Soft springs: neighbors of a dragged node follow it, then settle.
    let energy = 0;
    const sub = Math.min(dt, 0.033);
    for (const s of springs) {
      s.vx += ((s.tx - s.n.x) * 70 - s.vx * 13) * sub;
      s.vy += ((s.ty - s.n.y) * 70 - s.vy * 13) * sub;
      s.vz += ((s.tz - s.n.z) * 70 - s.vz * 13) * sub;
      moveNode(s.n, s.n.x + s.vx * sub, s.n.y + s.vy * sub, s.n.z + s.vz * sub);
      energy += Math.abs(s.vx) + Math.abs(s.vy) + Math.abs(s.vz);
      energy += Math.abs(s.tx - s.n.x) + Math.abs(s.ty - s.n.y) + Math.abs(s.tz - s.n.z);
    }
    if (!pointer?.node && energy < 0.5 * springs.length) {
      for (const s of springs) moveNode(s.n, s.tx, s.ty, s.tz);
      springs = []; // settled: frozen again
    }
    moved = true;
  };

  /** Runs inside every render, after the camera's matrices are current. */
  const frame = () => {
    if (!alive) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;
    let busy = now - lastWake < 400 || !!pointer;

    renderer.getSize(size);
    if (size.x !== W || size.y !== H) {
      W = size.x;
      H = size.y;
      shifted = false;
      dirty = true;
      limits();
      measureSoon();
    }
    if (!data || !W || !H) {
      if (!busy && !sleepTimer) sleepTimer = window.setTimeout(sleep, 0);
      return;
    }

    // 1. The picture's shift toward the free part of the canvas.
    const goal = shiftGoal();
    const off = Math.abs(goal.x - shift.x) + Math.abs(goal.y - shift.y);
    if (off > 0.5 || !shifted) {
      const a = motion && shifted ? 1 - Math.exp(-dt * 9) : 1;
      shift.x += (goal.x - shift.x) * a;
      shift.y += (goal.y - shift.y) * a;
      camera.setViewOffset(W, H, -shift.x, -shift.y, W, H);
      shifted = true;
      busy = true;
    }

    // 2. Nodes: springs, then every edge that follows them.
    stepSprings(dt);
    if (moved) {
      for (const b of batches) write(b);
      busy = true;
    }

    // 3. The fade of everything that is not in focus.
    if (Math.abs(dimGoal - dim) > 0.004) {
      dim = motion ? dim + (dimGoal - dim) * (1 - Math.exp(-dt * 11)) : dimGoal;
      tone();
      dirty = busy = true;
    } else if (dim !== dimGoal) {
      dim = dimGoal;
      tone();
      dirty = true;
    }
    if (!dim && !focusKey && litIds.size) unlight();
    inkLit.object.visible = dim > 0.01 && inkLit.links.length > 0;
    for (const b of awardsLit) b.object.visible = dim > 0.01 && b.links.length > 0;

    // 4. Atmosphere: the far side of the graph is always a little lost in the page.
    const away = camera.position.length();
    fog.density = 0.6 / (away + data.radius);

    // 5. Has the view changed? Screen positions and labels follow it.
    pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    let turned = false;
    for (let i = 0; i < 16; i++) {
      if (Math.abs(pv.elements[i] - pvWas[i]) > 1e-6) turned = true;
      pvWas[i] = pv.elements[i];
    }
    perUnit = 0.5 * H * camera.projectionMatrix.elements[5];
    if (turned) busy = true;

    // 6. Level of detail. While the camera rushes, or from far out, a crowded
    //    graph draws its award edges as plain lines and drops the other edges;
    //    all of it returns once the view settles.
    const reachOut = Math.max(camera.position.distanceTo(controls.target), 1);
    const speed = was.distanceTo(camera.position) / reachOut / dt; // about radians a second
    was.copy(camera.position);
    const far = away > distanceFor(data.radius) * 1.3;
    if (speed > 1.2) calmAt = now + 180;
    const rushing = now < calmAt;
    if (rushing) busy = true; // keep drawing until the detail is back
    light = edgeCount > HEAVY_EDGES && (far || rushing);
    ink.object.visible = !light && ink.links.length > 0;
    for (const b of awards) b.object.visible = !light && b.links.length > 0;
    awardsThin.object.visible = light && awardsThin.links.length > 0;
    (awardsThin.object.geometry as BufferGeometry).setDrawRange(0, Math.min(awardsThin.links.length, LIGHT_EDGES) * 2);

    // 7. Screen positions, the hover under a still pointer, labels and rings.
    if (turned || moved || dirty) {
      project();
      if (turned && inside && !pointer) setHover(nodeAt(at.x, at.y));
      label(now);
      [selected, hover === selected ? null : hover].forEach((id, k) => {
        const i = id ? slot.get(id) : undefined;
        const ring = rings[k];
        ring.visible = i !== undefined && !!pw[i];
        if (i === undefined || !pw[i]) return;
        const n = data!.nodes[i];
        ring.position.set(n.x, n.y, n.z);
        ring.quaternion.copy(camera.quaternion);
        ring.scale.setScalar(n.r + (5 * pw[i]) / perUnit); // five pixels clear of the mark
        ring.updateMatrixWorld(true);
      });
      dirty = false;
    }
    moved = false;

    // 8. The camera's own moves take effect on the next frame.
    if (flight) {
      const f = flight;
      f.t = Math.min(1, f.t + dt / f.dur);
      const e = ease(f.t);
      sph.radius = f.from.radius + (f.to.radius - f.from.radius) * e;
      sph.phi = f.from.phi + (f.to.phi - f.from.phi) * e;
      sph.theta = f.from.theta + f.turn * e;
      controls.target.lerpVectors(f.fromTarget, f.toTarget, e);
      camera.position.setFromSpherical(sph).add(controls.target);
      if (f.t >= 1) flight = null;
      busy = true;
    }
    if (springs.length) busy = true;

    // 9. Nothing moving: stop rendering until something does.
    if (!busy && !sleepTimer) sleepTimer = window.setTimeout(sleep, 0);
  };
  world.onBeforeRender = frame;

  // ---- Wiring ----

  wrap.addEventListener("pointerdown", onDown, true);
  wrap.addEventListener("pointermove", onMove, true);
  wrap.addEventListener("pointerup", onUp, true);
  wrap.addEventListener("pointercancel", onUp, true);
  wrap.addEventListener("pointerleave", onLeave);
  wrap.addEventListener("wheel", onWheel, { capture: true, passive: true });
  wrap.addEventListener("keydown", onKey);
  // The rail folded or the legend opened (GraphExplorer.tsx): measure again.
  window.addEventListener("graph:chrome", measureSoon);
  controls.addEventListener("start", onGrab);
  canvas.style.cursor = "grab";
  readFonts();
  document.fonts?.ready.then(() => alive && (readFonts(), wake()));

  const clearScene = () => {
    for (const s of sprites) nodesGroup.remove(s);
    sprites = [];
    slot = new Map();
    for (const b of batches) {
      b.links = [];
      b.object.visible = false;
    }
    springs = [];
    litIds = new Set();
    focusKey = "";
    dim = dimGoal = 0;
    hover = null;
    flight = null;
    for (const ring of rings) ring.visible = false;
  };

  return {
    ready,
    setScene(next) {
      clearScene();
      data = next;
      if (!next) return;
      next.nodes.forEach((n, i) => {
        const s = new Sprite(rest[shapeOf(n)][kindOf(n)]);
        s.scale.set(n.r * 2, n.r * 2, 1);
        s.position.set(n.x, n.y, n.z);
        s.matrixAutoUpdate = false; // it only moves when dragged
        s.updateMatrix();
        sprites.push(s);
        slot.set(n.id, i);
      });
      // Added grouped by material (solicitations last), so a frame changes
      // material a handful of times, not once per node.
      const order = next.nodes.map((n, i) => ({ i, key: kindOf(n) * SHAPES.length + shapeOf(n) }));
      order.sort((a, b) => a.key - b.key);
      for (const o of order) nodesGroup.add(sprites[o.i]);
      px = new Float32Array(next.nodes.length);
      py = new Float32Array(next.nodes.length);
      pr = new Float32Array(next.nodes.length);
      pw = new Float32Array(next.nodes.length);
      if (selected && !next.byId.has(selected)) selected = null;
      renderer.getSize(size);
      W = size.x;
      H = size.y;
      shifted = false;
      limits();
      homed = false;
      refilter();
      fit(false);
      wake();
    },
    setHidden(nextHidden, nextTags) {
      hidden = nextHidden;
      tags = nextTags;
      refilter();
      wake();
    },
    setSelected(id) {
      if (selected === id) return;
      selected = id;
      relight();
      measureSoon(); // the panel opens or closes
      wake();
    },
    setQuery(next) {
      if (query === next) return;
      query = next;
      refilter();
      wake();
    },
    setMotion(on) {
      motion = on;
      if (!on && flight) flight.dur = 0.001; // a flight in progress arrives at once
      wake();
    },
    retheme() {
      palette = readPalette();
      fog.color.set(palette.bg);
      for (const b of [ink, inkLit]) (b.object.material as LineDashedMaterial).color.set(palette.text);
      (awardsThin.object.material as LineBasicMaterial).color.set(palette.accent);
      for (const b of [...awards, ...awardsLit]) (b.object.material as LineMaterial).color.set(palette.accent);
      ringMaterial.color.set(palette.text);
      // The marks are drawn in the palette's colors: draw them again.
      const old = textures;
      textures = drawMarks();
      textures.forEach((t, m) => {
        for (const mat of [...rest[m], ...lit[m]]) {
          mat.map = t;
          mat.needsUpdate = true;
        }
      });
      for (const t of old) t.dispose();
      tone();
      wake();
    },
    setBlocked(next) {
      blocked = next;
      if (next) {
        clearTimeout(sleepTimer);
        sleepTimer = 0;
        paused = true;
        host.pauseAnimation();
      } else wake();
    },
    wake,
    fit,
    focusOn,
    zoom,
    dispose() {
      alive = false;
      clearTimeout(sleepTimer);
      measureTimers.forEach(clearTimeout);
      wrap.removeEventListener("pointerdown", onDown, true);
      wrap.removeEventListener("pointermove", onMove, true);
      wrap.removeEventListener("pointerup", onUp, true);
      wrap.removeEventListener("pointercancel", onUp, true);
      wrap.removeEventListener("pointerleave", onLeave);
      wrap.removeEventListener("wheel", onWheel, true);
      wrap.removeEventListener("keydown", onKey);
      window.removeEventListener("graph:chrome", measureSoon);
      controls.removeEventListener("start", onGrab);
      controls.enabled = true;
      world.onBeforeRender = () => {};
      world.fog = null;
      renderer.sortObjects = sorted;
      camera.clearViewOffset();
      clearScene();
      world.remove(group);
      for (const b of batches) {
        b.object.geometry.dispose();
        (b.object.material as LineBasicMaterial | LineMaterial).dispose();
      }
      ringGeometry.dispose();
      ringMaterial.dispose();
      for (const m of [...rest.flat(), ...lit.flat()]) m.dispose();
      for (const t of textures) t.dispose();
      layer.replaceChildren();
      tip.style.opacity = "0";
    },
  };
}
