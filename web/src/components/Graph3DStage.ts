import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Fog,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  LineBasicMaterial,
  LineDashedMaterial,
  LineSegments,
  Matrix4,
  NotEqualStencilFunc,
  ReplaceStencilOp,
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
import {
  bendPoint,
  CAPTION_RISE,
  curveEnds,
  EDGE_ALPHA_MAX,
  EDGE_ALPHA_MIN,
  INNER_RING,
  QUIET_ALPHA,
  type L,
  type N,
} from "@/lib/graphLayout";
import { readPalette, type Palette } from "@/lib/paint";
import type { Scene3 } from "./Graph3DLayout";
import { fitPad, readChrome, roomFor, type Chrome } from "./graphRoom";

// Everything the 3D view draws and every way it is handled, kept apart from
// React (Graph3D.tsx mounts it). react-force-graph-3d provides the WebGL
// renderer, the camera, the orbit controls and the render loop; this file puts
// the graph into that scene and runs once per rendered frame.
//
// It draws what the flat view draws, by the same rules (lib/graphLayout.ts):
// a company is a dot with its area in proportion to its dollars, an agency or
// office is a ring with a finer ring inside it, sized by what it paid out, and
// a solicitation is a small open diamond. Money edges are one curve per
// company and agency, in the accent, wider and stronger with the dollars they
// carry; every other edge is a faint dotted curve in the text color. Selecting
// or hovering a node fades everything it does not touch. Fog in the page color
// fades whatever lies farther back, so the depth reads at a glance.
//
// Drawing is kept cheap so a large graph stays fluid. All edges of a kind (and
// of a band of dollars) are one object, so one draw call, not one per edge.
// Each mark is a sprite sharing one of a few materials, and sprites are drawn
// grouped by material, not sorted by distance every frame: the depth buffer
// decides which mark is in front. Edges are drawn first and never cover a mark.
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

// ---- Node marks ----
//
// Each kind of node is drawn by its own pair of functions: makeCompany,
// makeAgency and makeSolicitation say which picture a node takes, and
// drawCompany, drawAgency and drawSolicitation paint that picture into a
// texture. A sprite is always 2r world units across, so it covers the node's
// mark exactly, and the stage shares one texture (and one pair of materials)
// among all nodes that take the same picture. Engraved art can replace a
// draw function without touching the layout, the hit testing or the fading;
// art that changes with the size on screen can keep several marks per kind
// and swap a sprite's material by its projected radius (`pr` in the stage).

/** One picture a node can take. `key` names it: nodes with the same key share it. */
export type Mark = {
  key: string;
  /** the texture's width and height in pixels */
  size: number;
  /** the strongest opacity painted into the texture, for the alpha cut */
  alpha: number;
  /** it hides what lies behind it (writes depth); an open outline does not */
  solid: boolean;
  /** paint the mark, filling a size-by-size canvas, in the palette's colors */
  paint: (g: CanvasRenderingContext2D, size: number, palette: Palette) => void;
};

/** A company's dot: text color, a hairline of page color around it so dots
 *  that overlap in depth stay apart, as in the flat view. Drawn for a radius,
 *  in world pixels: the dot then takes up the whole texture. */
export function drawCompany(g: CanvasRenderingContext2D, size: number, palette: Palette, r: number) {
  const mid = size / 2;
  const k = size / (2 * r); // texture pixels per world pixel
  g.fillStyle = palette.bg;
  g.beginPath();
  g.arc(mid, mid, mid, 0, Math.PI * 2);
  g.fill();
  g.globalAlpha = 0.9;
  g.fillStyle = palette.text;
  g.beginPath();
  g.arc(mid, mid, Math.max(mid * 0.6, mid - 0.7 * k), 0, Math.PI * 2);
  g.fill();
  g.globalAlpha = 1;
}

/** An agency's or office's two rings: the outer one at the node's radius, the
 *  inner one at INNER_RING of it and fainter, both filled with the page color
 *  so no edge shows through. */
export function drawAgency(g: CanvasRenderingContext2D, size: number, palette: Palette, r: number) {
  const mid = size / 2;
  const k = size / (2 * r);
  const outer = 1.3 * k;
  g.fillStyle = palette.bg;
  g.strokeStyle = palette.text;
  g.beginPath();
  g.arc(mid, mid, mid - outer / 2, 0, Math.PI * 2);
  g.fill();
  g.lineWidth = outer;
  g.stroke();
  g.globalAlpha = 0.6;
  g.beginPath();
  g.arc(mid, mid, mid * INNER_RING, 0, Math.PI * 2);
  g.lineWidth = k;
  g.stroke();
  g.globalAlpha = 1;
}

/** A solicitation's diamond: an outline only, fainter once it has closed. */
export function drawSolicitation(g: CanvasRenderingContext2D, size: number, palette: Palette, r: number, open: boolean) {
  const mid = size / 2;
  const k = size / (2 * r);
  const w = k; // one world pixel
  const d = mid - w / 2 - 1;
  g.globalAlpha = open ? 0.6 : 0.35;
  g.strokeStyle = palette.text;
  g.lineJoin = "miter";
  g.lineWidth = w;
  g.beginPath();
  g.moveTo(mid, mid - d);
  g.lineTo(mid + d, mid);
  g.lineTo(mid, mid + d);
  g.lineTo(mid - d, mid);
  g.closePath();
  g.stroke();
  g.globalAlpha = 1;
}

/** Company dots come in a few bands of size, so the hairline around a dot is
 *  about as thin on a small one as on a large one. Upper radius of each band. */
const COMPANY_BANDS = [5, 8, 12, 18, 26];

export function makeCompany(n: N): Mark {
  let b = COMPANY_BANDS.findIndex((top) => n.r <= top);
  if (b < 0) b = COMPANY_BANDS.length - 1;
  // drawn for the middle of the band
  const r = (COMPANY_BANDS[b] + (b ? COMPANY_BANDS[b - 1] : 3.5)) / 2;
  return { key: `company:${b}`, size: b < 2 ? 64 : 128, alpha: 1, solid: true, paint: (g, s, p) => drawCompany(g, s, p, r) };
}

export function makeAgency(n: N): Mark {
  // agencies are few: one picture per whole pixel of radius
  const r = Math.max(5, Math.round(n.r));
  return { key: `agency:${r}`, size: 256, alpha: 1, solid: true, paint: (g, s, p) => drawAgency(g, s, p, r) };
}

export function makeSolicitation(n: N): Mark {
  const open = !!n.open;
  return {
    key: `solicitation:${open ? "open" : "closed"}`,
    size: 64,
    alpha: open ? 0.6 : 0.35,
    solid: false,
    paint: (g, s, p) => drawSolicitation(g, s, p, n.r, open),
  };
}

const markOf = (n: N): Mark => (n.kind === "company" ? makeCompany(n) : n.org ? makeAgency(n) : makeSolicitation(n));

/** A mark as the stage keeps it: its texture, and a material for the node at
 *  rest (it fades when something else is in focus) and one for a lit node. */
type Look = { mark: Mark; texture: Texture; rest: SpriteMaterial; lit: SpriteMaterial };

// ---- Fading ----

/** What an unrelated node fades to while a node is selected. */
const FADED = 0.16;
/** What an unrelated edge fades to. */
const EDGE_FADED = 0.03;
/** The selected node's money edges: strong, and a little wider. */
const LIT_AWARD_ALPHA = 0.85;
const LIT_WIDTH = 1.25;
/** Hover previews the fade of a selection, not as far. */
const HOVER_DIM = 0.6;

// ---- Edges ----

/** Money edges are drawn in this many bands of dollars, each with its own width
 *  and opacity (one draw call each): a close match to the flat view's
 *  per-edge stroke, which WebGL lines cannot vary within one draw. Ten bands
 *  put every edge within a twentieth of the opacity range of its own. */
const BANDS = 10;
/** The dotted line of an edge that is not an award, in world pixels (the flat view's dash). */
const DOT = 1.5;
const DOT_GAP = 3;
/** Straight pieces per curved edge: fewer when there are many edges, where
 *  each curve is short on screen and the pieces would cost frame rate. */
const SEGMENTS = 10;
const SEGMENTS_SOME = 6; // over 800 edges
const SEGMENTS_MANY = 4; // over 2,500
/** Money edges drawn as plain lines while a crowded graph is in a rush, and their opacity. */
const THIN_ALPHA = 0.16;
/** Edge widths are in world pixels; on screen they follow the zoom, within these bounds. */
const MIN_LINE_PX = 0.6;
const MAX_LINE_PX = 7;

const FOV = 38; // degrees: a long lens, so the far side is not distorted
const FLY_MS = 600;
/** The first view of a graph: from the front, a little above and to the right. */
const HOME = new Vector3(0.16, 0.3, 1);
const MAX_LABELS = 72;
/** With more edges than this in view, detail is dropped while the camera moves fast. */
const HEAVY_EDGES = 1500;
const LIGHT_EDGES = 1200; // how many award edges are still drawn in that case

// ---- Labels ----
//
// Names over the canvas, in the flat view's faces: a company in the display
// serif at 16px, an agency or office in the interface face at 11.5px, and a
// category's caption in italic EB Garamond at 13.5px. Every one has a 5px halo
// of page color behind it (a text stroke painted under the fill).

const LABEL_BASE =
  "pointer-events-none absolute left-0 top-0 whitespace-nowrap leading-none opacity-0 transition-opacity duration-200 text-ink";
const COMPANY_CLASS = `${LABEL_BASE} font-display text-[16px]`;
const AGENCY_CLASS = `${LABEL_BASE} font-sans text-[11.5px]`;
const CAPTION_CLASS = `${LABEL_BASE} font-serif italic text-[13.5px]`;
const LABEL_SIZE = { company: 16, agency: 11.5, caption: 13.5 };
/** Where a line's baseline sits below the top of its box, as a share of the size. */
const BASELINE = 0.8;
/** Companies named without hovering: the largest few by dollars. */
const TOP_COMPANIES = 7;
/** Space between a mark and its name, in pixels. */
const LABEL_GAP = 6;
/** Opacity of each kind of name at rest and when faded. */
const AGENCY_ALPHA = 0.85;
const CAPTION_ALPHA = 0.55;
const CAPTION_FADED = 0.25;
const NAME_FADED = 0.22;
/** A grid of node rectangles on screen, for testing where a name may go. */
const CELL = 48;

type Batch = {
  object: LineSegments | LineSegments2;
  fat: boolean;
  /** a dotted line: its dash distances are worked out again whenever its ends move */
  dotted: boolean;
  links: L[];
  /** six numbers per straight piece: both ends */
  array: Float32Array;
  /** a money band's width in world pixels (fat batches) */
  width: number;
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
/** kind: 0 company, 1 agency or office (and a solicitation), 2 caption */
type Tag = { el: HTMLDivElement; key: string; x: number; y: number; alpha: number; kind: number; freeAt: number; seen: number };

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Which band of dollars a money edge is drawn in (its opacity is linear in log dollars). */
const bandOf = (l: L) =>
  Math.max(0, Math.min(BANDS - 1, Math.floor(((l.alpha - EDGE_ALPHA_MIN) / (EDGE_ALPHA_MAX - EDGE_ALPHA_MIN)) * BANDS)));

/** Write an edge's curve into `a` from offset `o` as `seg` straight pieces,
 *  and return the offset after it. The curve is the flat view's: a quadratic
 *  bowed BEND of its length, worked out on the y-down map (the scene is y-up),
 *  with its middle at the depth halfway between its ends. */
function writeCurve(l: L, a: Float32Array, o: number, seg: number): number {
  const [p, q] = curveEnds(l);
  const { cx, cy: down } = bendPoint(p.x, -p.y, q.x, -q.y);
  const cy = -down;
  const cz = (p.z + q.z) / 2;
  let x0 = p.x;
  let y0 = p.y;
  let z0 = p.z;
  for (let i = 1; i <= seg; i++) {
    const t = i / seg;
    const u = 1 - t;
    const x1 = u * u * p.x + 2 * u * t * cx + t * t * q.x;
    const y1 = u * u * p.y + 2 * u * t * cy + t * t * q.y;
    const z1 = u * u * p.z + 2 * u * t * cz + t * t * q.z;
    a[o++] = x0;
    a[o++] = y0;
    a[o++] = z0;
    a[o++] = x1;
    a[o++] = y1;
    a[o++] = z1;
    x0 = x1;
    y0 = y1;
    z0 = z1;
  }
  return o;
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
  let named7 = new Set<string>(); // the companies named without hovering
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

  // Linear fog in the page color, set each frame from where the camera is:
  // the near side of the graph is clear and the far side fades into the page.
  const fog = new Fog(palette.bg, 1, 10000);
  world.fog = fog;

  // ---- What is drawn ----

  // Everything this stage adds to the library's scene. Without sorting, things
  // are drawn in the order they are added here: edges, lit edges, marks, rings.
  const group = new Group();
  const nodesGroup = new Group();
  world.add(group);
  const sorted = renderer.sortObjects;
  renderer.sortObjects = false;

  const looks = new Map<string, Look>();
  let lookOf: Look[] = []; // per node, in the order of data.nodes
  let sprites: Sprite[] = [];
  let slot = new Map<string, number>(); // node id -> index into data.nodes and sprites
  const ready = Promise.resolve();

  const paintTexture = (mark: Mark): Texture => {
    const c = document.createElement("canvas");
    c.width = c.height = mark.size;
    mark.paint(c.getContext("2d")!, mark.size, palette);
    const t = new CanvasTexture(c);
    t.colorSpace = SRGBColorSpace;
    t.generateMipmaps = true;
    t.minFilter = LinearMipmapLinearFilter;
    t.magFilter = LinearFilter;
    t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    t.needsUpdate = true;
    return t;
  };

  // A solid mark hides whatever is behind it (the corners of its square are
  // cut away by the alpha test). An open outline is drawn after the rest and
  // hides nothing.
  const spriteMaterial = (map: Texture, solid: boolean) =>
    new SpriteMaterial({ map, transparent: true, depthTest: true, depthWrite: solid, alphaTest: 0.5, fog: true });

  /** The stage's copy of a mark: made on first use, then shared. */
  const lookFor = (mark: Mark): Look => {
    let look = looks.get(mark.key);
    if (!look) {
      const texture = paintTexture(mark);
      look = { mark, texture, rest: spriteMaterial(texture, mark.solid), lit: spriteMaterial(texture, mark.solid) };
      looks.set(mark.key, look);
    }
    return look;
  };

  // A curve is drawn as short straight pieces, and translucent pieces would
  // darken where they overlap at every joint, beading the line. So each kind
  // of line writes its own number into the stencil buffer and draws only
  // where that number is not yet written: within one batch every pixel is
  // blended once, while different batches (a strong band over a weak one, the
  // lit edges over the rest) still add up as they do on the flat map.
  let stencils = 0;
  const once = <M extends LineBasicMaterial | LineDashedMaterial | LineMaterial>(m: M): M => {
    m.stencilWrite = true;
    m.stencilRef = ++stencils;
    m.stencilFunc = NotEqualStencilFunc;
    m.stencilZPass = ReplaceStencilOp;
    return m;
  };
  const thinMaterial = (color: string) =>
    once(new LineBasicMaterial({ color, transparent: true, depthTest: false, depthWrite: false, fog: true }));
  const dottedMaterial = (color: string) =>
    once(new LineDashedMaterial({ color, dashSize: DOT, gapSize: DOT_GAP, transparent: true, depthTest: false, depthWrite: false, fog: true }));
  const fatMaterial = (color: string, linewidth: number, fogged = true) =>
    once(new LineMaterial({ color, linewidth, transparent: true, depthTest: false, depthWrite: false, fog: fogged }));

  const batch = (material: LineBasicMaterial | LineDashedMaterial | LineMaterial, order: number): Batch => {
    const fat = material instanceof LineMaterial;
    const dotted = material instanceof LineDashedMaterial;
    const object = fat ? new LineSegments2(new LineSegmentsGeometry(), material) : new LineSegments(new BufferGeometry(), material);
    object.frustumCulled = false; // one object spans the whole graph
    object.renderOrder = order;
    object.visible = false;
    group.add(object);
    return { object, fat, dotted, links: [], array: new Float32Array(0), width: 1 };
  };

  let seg = SEGMENTS; // straight pieces per curve, for this graph

  /** Give a batch its edges: (re)allocate if it grew, then write the positions. */
  const load = (b: Batch, links: L[]) => {
    b.links = links;
    const need = Math.max(links.length, 1) * seg * 6;
    if (b.array.length < need) {
      b.array = new Float32Array(need);
      b.object.geometry.dispose();
      (b.object as { geometry: BufferGeometry }).geometry = b.fat
        ? new LineSegmentsGeometry().setPositions(b.array)
        : new BufferGeometry().setAttribute("position", new BufferAttribute(b.array, 3));
    }
    write(b);
  };

  /** Copy the current node positions into a batch's buffer, as curves. */
  const write = (b: Batch) => {
    const a = b.array;
    let o = 0;
    for (const l of b.links) o = writeCurve(l, a, o, seg);
    const pieces = b.links.length * seg;
    if (b.fat) {
      const g = b.object.geometry as LineSegmentsGeometry;
      g.instanceCount = pieces;
      (g.attributes.instanceStart as unknown as InterleavedBufferAttribute).data.needsUpdate = true;
    } else {
      const g = b.object.geometry as BufferGeometry;
      g.setDrawRange(0, pieces * 2);
      g.attributes.position.needsUpdate = true;
      if (b.dotted) (b.object as LineSegments).computeLineDistances();
    }
  };

  const quiet = batch(dottedMaterial(palette.text), -4);
  const awardsThin = batch(thinMaterial(palette.accent), -4); // stands in for the bands below while the camera rushes
  const awards = Array.from({ length: BANDS }, () => batch(fatMaterial(palette.accent, 1), -4));
  const quietLit = batch(dottedMaterial(palette.text), -3);
  const awardsLit = Array.from({ length: BANDS }, () => batch(fatMaterial(palette.accent, 1), -3));
  const batches = [quiet, awardsThin, ...awards, quietLit, ...awardsLit];
  /** each money band's opacity at rest: the average of its edges' */
  const bandAlpha = new Array<number>(BANDS).fill(EDGE_ALPHA_MIN);
  let edgeCount = 0;
  let lineScale = 0; // screen pixels per world pixel the edge widths were last set for
  group.add(nodesGroup);

  // The thin ring around the selected node, and a fainter one around the
  // hovered one. A circle of line segments turned to face the camera, so its
  // stroke keeps the same width on screen at any distance.
  const circle = new Float32Array(72 * 6);
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2;
    const b = ((i + 1) / 72) * Math.PI * 2;
    circle.set([Math.cos(a), Math.sin(a), 0, Math.cos(b), Math.sin(b), 0], i * 6);
  }
  const ringGeometry = new LineSegmentsGeometry().setPositions(circle);
  const ringMaterials = [0.7, 0.35].map((opacity) => {
    const m = fatMaterial(palette.text, 1, false);
    m.opacity = opacity;
    return m;
  });
  const rings = ringMaterials.map((m) => {
    const ring = new LineSegments2(ringGeometry, m);
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

  /** Set every opacity from the fade. */
  const tone = () => {
    const faded = 1 - (1 - FADED) * dim;
    for (const { mark, rest, lit } of looks.values()) {
      rest.opacity = faded;
      lit.opacity = 1;
      // the cut follows the opacity, so a faded mark keeps its shape
      rest.alphaTest = mark.alpha * faded * 0.5;
      lit.alphaTest = mark.alpha * 0.5;
      // once faded, a mark no longer hides the lit ones behind it
      rest.depthWrite = mark.solid && dim < 0.5;
    }
    const toward = (rest: number) => rest + (EDGE_FADED - rest) * dim;
    (quiet.object.material as LineDashedMaterial).opacity = toward(QUIET_ALPHA);
    (awardsThin.object.material as LineBasicMaterial).opacity = toward(THIN_ALPHA);
    awards.forEach((b, i) => ((b.object.material as LineMaterial).opacity = toward(bandAlpha[i])));
    (quietLit.object.material as LineDashedMaterial).opacity = QUIET_ALPHA * dim;
    for (const b of awardsLit) (b.object.material as LineMaterial).opacity = LIT_AWARD_ALPHA * dim;
  };

  /** Edge widths follow the zoom, as they do on the flat map. */
  const widen = (scale: number) => {
    if (Math.abs(scale - lineScale) < lineScale * 0.02) return;
    lineScale = scale;
    const px = (w: number) => Math.max(MIN_LINE_PX, Math.min(MAX_LINE_PX, w * scale));
    for (const b of awards) (b.object.material as LineMaterial).linewidth = px(b.width);
    for (const b of awardsLit) (b.object.material as LineMaterial).linewidth = px(b.width) * LIT_WIDTH;
  };

  const dress = (id: string, on: boolean) => {
    const i = slot.get(id);
    if (i === undefined) return;
    sprites[i].material = on ? lookOf[i].lit : lookOf[i].rest;
  };

  const shown = (l: L) => !hidden.has(l.source.id) && !hidden.has(l.target.id);

  /** Work out what is in focus (hovered, else selected, else the search
   *  matches), light it and its edges, and let everything else fade. */
  const relight = (force = false) => {
    if (!data) return;
    const fid = hover ?? selected;
    const key = fid ? `n:${fid}:${!!selected}` : matches ? `q:${query}` : "";
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
    load(quietLit, edges.filter((l) => l.kind !== "award"));
    const won = edges.filter((l) => l.kind === "award");
    awardsLit.forEach((b, i) => load(b, won.filter((l) => bandOf(l) === i)));
    // a hover with nothing selected is a preview: the same fade, not as deep
    dimGoal = fid && fid === hover && !selected ? HOVER_DIM : 1;
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
    named7 = new Set();
    data.nodes.forEach((n, i) => {
      const on = !hidden.has(n.id);
      sprites[i].visible = on;
      if (!on) return;
      if (n.kind === "company" && n.tag) liveTags.add(n.tag);
      // nodes are in order of dollars
      if (n.kind === "company" && named7.size < TOP_COMPANIES) named7.add(n.id);
    });
    const edges = data.links.filter(shown);
    edgeCount = edges.length;
    load(quiet, edges.filter((l) => l.kind !== "award"));
    // largest first: when detail is dropped, the edges that go are the small ones
    const won = edges.filter((l) => l.kind === "award").sort((a, b) => b.amount - a.amount);
    load(awardsThin, won);
    awards.forEach((b, i) => load(b, won.filter((l) => bandOf(l) === i)));
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
  // Every agency and office is named, and the largest few companies; any
  // other node is named while hovered or selected, as on the flat map. Each
  // frame the names are placed in order of importance. A name tries eight
  // spots around its mark (right, left, above, below, then the four
  // diagonals; an agency tries below first, then right, left and above, the
  // same order as the flat map's) and takes the first that overlaps no other
  // mark, name or caption. A name with no free spot is not shown. The
  // elements are pooled.

  const pool: Tag[] = Array.from({ length: MAX_LABELS }, () => {
    const el = document.createElement("div");
    el.className = COMPANY_CLASS;
    // the halo: a stroke of page color painted under the letters
    el.style.setProperty("-webkit-text-stroke", "5px var(--bg)");
    el.style.setProperty("paint-order", "stroke fill");
    layer.appendChild(el);
    return { el, key: "", x: NaN, y: NaN, alpha: 0, kind: 0, freeAt: 0, seen: -1 };
  });
  const named = new Map<string, Tag>();
  let stamp = 0;
  const meter = document.createElement("canvas").getContext("2d")!;
  let fonts = { company: "400 16px Georgia", agency: "400 11.5px sans-serif", caption: "italic 400 13.5px Georgia" };
  let obstacles: number[] = [];
  /** the chrome over the canvas (graphRoom.ts), and the rooms it leaves with
   *  and without the side card, to tell when it has changed */
  let chrome: Chrome[] = [];
  let roomKey = "";
  /** the camera is where the last fit put it: the reader has not moved it */
  let fitted = false;
  /** the camera is where the last focusOn put it, for this node */
  let focusedOn: string | null = null;
  /** The selection was made without moving the camera, because the node and
   *  its neighbors were already in view clear of the card: the picture keeps
   *  the room it had without the card, so the map does not slide. */
  let steady = false;
  const placed: number[] = [];
  // node rectangles on screen, bucketed in a grid of CELL pixels; the cells
  // are kept and emptied each time, so placing names allocates almost nothing
  const grid = new Map<number, number[]>();

  const readFonts = () => {
    const s = getComputedStyle(document.documentElement);
    const family = (v: string, fallback: string) => `${s.getPropertyValue(v).trim() || fallback}, ${fallback}`;
    fonts = {
      company: `400 16px ${family("--font-cormorant", "Georgia")}`,
      agency: `400 11.5px ${family("--font-inter", "system-ui")}`,
      caption: `italic 400 13.5px ${family("--font-garamond", "Georgia")}`,
    };
    for (const n of data?.nodes ?? []) n.labelWidth = 0;
    dirty = true;
  };

  /** The chrome over the canvas (the rail, the side card, the takeaway line,
   *  the controls, the legend, the top bar), so names are never written under
   *  it and the fit keeps the map clear of it. When the room it leaves
   *  changes: a focus is checked against the card as it really is, or, with
   *  nothing selected and the camera where the last fit put it, the graph is
   *  fitted again. A selection made in place leaves the map where it is. */
  const measure = () => {
    if (!alive) return;
    chrome = readChrome(root, canvas);
    obstacles = [];
    for (const c of chrome) obstacles.push(c.x0 - 6, c.y0 - 6, c.x1 + 6, c.y1 + 6);
    const key = JSON.stringify([roomFor(chrome, W, H, false), roomFor(chrome, W, H, true)]);
    if (key !== roomKey) {
      roomKey = key;
      if (focusedOn && selected === focusedOn) {
        // checked once the camera has arrived, against where it ends up
        if (flight) {
          roomKey = "";
          window.setTimeout(measure, 200);
        } else focusOn(focusedOn);
      } else if (fitted && !selected) fit(false);
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

  /** Index every mark on screen by the grid cells its square touches. */
  const gridMarks = () => {
    for (const cell of grid.values()) cell.length = 0;
    for (let i = 0; i < pw.length; i++) {
      if (!pw[i]) continue;
      const r = Math.max(pr[i], 1.5);
      // only the cells on screen: a mark right in front of the camera may be huge
      const gx0 = Math.max(-1, Math.floor((px[i] - r) / CELL));
      const gx1 = Math.min(Math.ceil(W / CELL), Math.floor((px[i] + r) / CELL));
      const gy0 = Math.max(-1, Math.floor((py[i] - r) / CELL));
      const gy1 = Math.min(Math.ceil(H / CELL), Math.floor((py[i] + r) / CELL));
      for (let gx = gx0; gx <= gx1; gx++) {
        for (let gy = gy0; gy <= gy1; gy++) {
          const k = gx * 65536 + gy;
          const cell = grid.get(k);
          if (cell) cell.push(i);
          else grid.set(k, [i]);
        }
      }
    }
  };

  /** Whether a rectangle on screen touches any mark but `self`'s. With
   *  `litOnly`, the faded marks of a selection's background do not count. */
  const onMark = (x0: number, y0: number, x1: number, y1: number, self: number, litOnly: boolean) => {
    for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++) {
      for (let gy = Math.floor(y0 / CELL); gy <= Math.floor(y1 / CELL); gy++) {
        for (const i of grid.get(gx * 65536 + gy) ?? []) {
          if (i === self || (litOnly && !litIds.has(data!.nodes[i].id))) continue;
          // the nearest point of the rectangle to the mark's center
          const nx = Math.max(x0, Math.min(px[i], x1));
          const ny = Math.max(y0, Math.min(py[i], y1));
          const r = Math.max(pr[i], 1.5);
          if ((nx - px[i]) ** 2 + (ny - py[i]) ** 2 < r * r) return true;
        }
      }
    }
    return false;
  };

  /** Whether a rectangle is clear of the edge of the view, the chrome and
   *  every name placed so far. */
  const free = (x0: number, y0: number, x1: number, y1: number) => {
    // labels keep a margin from the edge of the view
    const edge = 8;
    if (x0 < edge || y0 < edge || x1 > W - edge || y1 > H - edge) return false;
    for (let i = 0; i < obstacles.length; i += 4)
      if (x0 < obstacles[i + 2] && x1 > obstacles[i] && y0 < obstacles[i + 3] && y1 > obstacles[i + 1]) return false;
    for (let i = 0; i < placed.length; i += 4)
      if (x0 < placed[i + 2] && x1 > placed[i] && y0 < placed[i + 3] && y1 > placed[i + 1]) return false;
    return true;
  };

  /** Show a label this frame with its top-left corner at (x, y). */
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
      t.el.className = kind === 2 ? CAPTION_CLASS : kind === 1 ? AGENCY_CLASS : COMPANY_CLASS;
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
      const faded = (lit: number, low: number) => lit + (low - lit) * dim;
      // distant names fade with their nodes, though never as far
      const haze = (w: number) => 1 - 0.55 * Math.max(0, Math.min(1, (w - fog.near) / Math.max(fog.far - fog.near, 1)));
      gridMarks();

      let budget = MAX_LABELS - 14;
      /** Name node i if one of its spots is free (or, when `forced`, at the
       *  first spot regardless). */
      const name = (i: number, forced: boolean, alpha: number) => {
        if (budget <= 0) return;
        const n = nodes[i];
        const company = n.kind === "company";
        meter.font = company ? fonts.company : fonts.agency;
        const h = company ? LABEL_SIZE.company : LABEL_SIZE.agency;
        const text = truncate(n.display, forced ? 60 : 34);
        if (!n.labelWidth) n.labelWidth = meter.measureText(truncate(n.display, 34)).width;
        const w = forced ? meter.measureText(text).width : n.labelWidth;
        const r = Math.max(2, pr[i]);
        const x = px[i];
        const y = py[i];
        // the selected node's ring sits five pixels out: its name clears it
        const g = LABEL_GAP + (n.id === selected ? 5 : 0);
        const litOnly = dim > 0.5 && litIds.has(n.id);
        const d = (r + g) * 0.72; // the diagonals sit off the mark's corner
        const right: [number, number] = [x + r + g, y - h / 2];
        const left: [number, number] = [x - r - g - w, y - h / 2];
        const above: [number, number] = [x - w / 2, y - r - g / 2 - h];
        const below: [number, number] = [x - w / 2, y + r + g / 2];
        const corners: [number, number][] = [
          [x + d, y - d - h],
          [x - d - w, y - d - h],
          [x + d, y + d],
          [x - d - w, y + d],
        ];
        const spots = n.org ? [below, right, left, above, ...corners] : [right, left, above, below, ...corners];
        let spot = spots.find(([sx, sy]) => free(sx - 2, sy - 1, sx + w + 2, sy + h + 1) && !onMark(sx - 2, sy, sx + w + 2, sy + h, i, litOnly));
        if (!spot && forced) spot = spots[0];
        if (!spot) return;
        placed.push(spot[0] - 2, spot[1] - 1, spot[0] + w + 2, spot[1] + h + 1);
        budget--;
        show(`${forced ? "f" : "n"}:${n.id}`, text, spot[0], spot[1], alpha, company ? 0 : 1, now);
      };

      // The hovered and the selected node are always named: they are placed
      // before anything else can be in the way.
      for (const id of hover === selected ? [selected] : [hover, selected]) {
        const i = id ? slot.get(id) : undefined;
        if (i !== undefined && pw[i]) name(i, true, 1);
      }

      // Captions next, over the top of their clusters.
      meter.font = fonts.caption;
      const e = pv.elements;
      const captionAlpha = faded(CAPTION_ALPHA, CAPTION_FADED);
      for (const g of data.regions) {
        if ((tags.size && !tags.has(g.tag)) || !liveTags.has(g.tag)) continue;
        const w = e[3] * g.x + e[7] * g.top + e[11] * g.z + e[15];
        if (w < camera.near) continue;
        const x = (((e[0] * g.x + e[4] * g.top + e[8] * g.z + e[12]) / w) * 0.5 + 0.5) * W;
        const base = (0.5 - ((e[1] * g.x + e[5] * g.top + e[9] * g.z + e[13]) / w) * 0.5) * H - (CAPTION_RISE * perUnit) / w;
        const width = meter.measureText(g.label).width;
        // over the cluster, else a line or two higher, as on the flat map
        const line = LABEL_SIZE.caption + 2;
        const top = base - LABEL_SIZE.caption * BASELINE;
        const y = [top, top - line, top - 2 * line].find((y) =>
          free(x - width / 2 - 2, y - 1, x + width / 2 + 2, y + LABEL_SIZE.caption + 1),
        );
        if (y === undefined) continue;
        placed.push(x - width / 2 - 2, y - 1, x + width / 2 + 2, y + LABEL_SIZE.caption + 1);
        show(`g:${g.tag}`, g.label, x - width / 2, y, captionAlpha * haze(w), 2, now);
      }

      // Then the names shown at rest: the lit ones first while something is
      // in focus, then the faded rest. Nodes are in order of dollars, so the
      // largest claim their space first.
      const always = (n: N) => n.org || named7.has(n.id);
      const passes: ((n: N) => boolean)[] = focused
        ? [(n) => always(n) && isLit(n), (n) => always(n) && !isLit(n)]
        : [always];
      for (const pass of passes) {
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i];
          if (!pw[i] || n.id === hover || n.id === selected || !pass(n)) continue;
          const lit = !focused || isLit(n);
          const rest = n.kind === "company" ? 1 : AGENCY_ALPHA;
          const alpha = lit ? rest : faded(rest, n.kind === "company" ? NAME_FADED : FADED);
          name(i, false, alpha * haze(pw[i]));
        }
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

  /** The side card stands at the right (from 768px), not across the bottom. */
  const wide = () => W >= 768;
  /** The card's room counts while something is selected, unless it was
   *  selected in place (`steady`). */
  const panelOpen = () => !!selected && !steady;
  /** The part of the canvas the map is fitted into (graphRoom.ts, shared with
   *  the flat view): clear of the rail, the top bar, the takeaway line, the
   *  controls and the legend, and of the side card with `panel`, by 48px. */
  const room = (panel = panelOpen()) => roomFor(chrome, W, H, panel);

  // The picture is shifted so the middle of the scene sits in the middle of
  // that room, not under the rail. The shift eases when the panel opens.
  const shift = { x: 0, y: 0 };
  let shifted = false; // the shift has been applied to the camera at this size
  /** whether the picture is shifted for the card's room, as last drawn */
  let shownPanel = false;
  const shiftGoal = () => {
    shownPanel = panelOpen();
    const p = room(shownPanel);
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
  const distanceFor = (radius: number, panel = panelOpen()) => {
    const p = room(panel);
    const half = Math.tan((FOV * Math.PI) / 360) * Math.max(0.25, Math.min(W - p.l - p.r, H - p.t - p.b) / Math.max(H, 1));
    return radius / Math.sin(Math.atan(half));
  };

  const center = () => (data ? new Vector3(data.center.x, data.center.y, data.center.z) : new Vector3());

  /** How far back along `dir` (from the center toward the camera) the camera
   *  must be for every shown mark and caption to fit the room. The map is
   *  much wider than it is deep, so this fits it far more snugly than the
   *  sphere around it would. */
  const fitDistance = (dir: Vector3, panel = panelOpen()) => {
    if (!data || !W || !H) return 1000;
    const p = room(panel);
    const perPx = Math.tan((FOV * Math.PI) / 360) / (H / 2); // tangent of the view angle per pixel
    const hw = Math.max(40, (W - p.l - p.r) / 2);
    const hh = Math.max(40, (H - p.t - p.b) / 2);
    const back = dir.clone().normalize();
    const right = new Vector3(0, 1, 0).cross(back).normalize();
    const up = new Vector3().crossVectors(back, right);
    const c = center();
    const rel = new Vector3();
    let d = 0;
    /** A point that must fit, reaching `ax` and `ay` world units to either
     *  side of it and a further fixed number of pixels left, right, up and
     *  down (names and captions keep their size at any distance). A side
     *  `lat` world units out fits at distance d when lat / (d - toward) is
     *  within the room's half less those pixels. */
    const need = (x: number, y: number, z: number, ax: number, ay: number, el: number, er: number, eu: number, ed: number) => {
      rel.set(x - c.x, y - c.y, z - c.z);
      const t = rel.dot(back);
      const lx = rel.dot(right);
      const ly = rel.dot(up);
      const side = (lat: number, e: number, half: number) => {
        d = Math.max(d, t + lat / (Math.max(10, half - e) * perPx));
      };
      side(lx + ax, er, hw);
      side(ax - lx, el, hw);
      side(ly + ay, eu, hh);
      side(ay - ly, ed, hh);
    };
    for (const n of data.nodes) {
      if (hidden.has(n.id)) continue;
      need(n.x, n.y, n.z, n.r, n.r, 0, 0, 0, 0);
      if (!n.org && !named7.has(n.id)) continue;
      // a name written at rest, in the first spot it tries (label())
      const company = n.kind === "company";
      meter.font = company ? fonts.company : fonts.agency;
      if (!n.labelWidth) n.labelWidth = meter.measureText(truncate(n.display, 34)).width;
      const w = n.labelWidth;
      const h = company ? LABEL_SIZE.company : LABEL_SIZE.agency;
      if (company) need(n.x, n.y, n.z, n.r, 0, 0, LABEL_GAP + w + 2, h / 2, h / 2);
      else need(n.x, n.y, n.z, 0, n.r, w / 2 + 2, w / 2 + 2, 0, LABEL_GAP / 2 + h + 1);
    }
    meter.font = fonts.caption;
    for (const g of data.regions) {
      if (!liveTags.has(g.tag) || (tags.size && !tags.has(g.tag))) continue;
      const half = meter.measureText(g.label).width / 2 + 2;
      need(g.x, g.top + CAPTION_RISE, g.z, 0, 0, half, half, LABEL_SIZE.caption + 1, 0);
    }
    return Math.max(d, 200);
  };

  /** How far, in screen pixels, the picture must pan for a node and its
   *  shown neighbors to sit inside the room with the side card (allowed half
   *  its padding, except along the card), as the camera sees them now: {0, 0}
   *  when they already do, null when they are not all on screen or would not
   *  fit at this distance, and the camera must fly. */
  const panFor = (id: string): { dx: number; dy: number } | null => {
    const i = slot.get(id);
    if (!data || i === undefined || !pw[i] || flight) return null;
    const p = room(true);
    const open = room(false);
    const slack = fitPad(W) / 2;
    for (const side of ["l", "r", "t", "b"] as const) if (p[side] <= open[side]) p[side] -= slack;
    let x0 = px[i] - pr[i], x1 = px[i] + pr[i], y0 = py[i] - pr[i], y1 = py[i] + pr[i];
    for (const o of data.near.get(id) ?? []) {
      if (hidden.has(o)) continue;
      const j = slot.get(o);
      if (j === undefined || !pw[j]) return null;
      x0 = Math.min(x0, px[j] - pr[j]);
      x1 = Math.max(x1, px[j] + pr[j]);
      y0 = Math.min(y0, py[j] - pr[j]);
      y1 = Math.max(y1, py[j] + pr[j]);
    }
    if (x1 - x0 > W - p.l - p.r || y1 - y0 > H - p.t - p.b) return null;
    const shove = (lo: number, hi: number, from: number, to: number) => (lo < from ? from - lo : hi > to ? to - hi : 0);
    return { dx: shove(x0, x1, p.l, W - p.r), dy: shove(y0, y1, p.t, H - p.b) };
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
    // the first view of a graph is from the front, a little above and to one
    // side; after that, fitting keeps the direction the reader has chosen
    const dir = homed ? new Vector3().subVectors(camera.position, controls.target) : HOME.clone();
    homed = true;
    steady = false;
    flyTo(center(), dir, fitDistance(dir), animate);
    fitted = true;
    focusedOn = null;
  };

  /** Fly to a node, ending far enough back that its neighbors are in view. */
  const focusOn = (id: string) => {
    const n = data?.byId.get(id);
    if (!data || !n || !W) return;
    selected = id; // the room is narrower with the panel open
    relight();
    focusedOn = id;
    // Already in view, clear of the card: only the focus changes. Nearly so:
    // the camera pans sideways by as little as brings it clear, at the
    // distance it has. Either way the picture keeps the room it is drawn
    // for, so nothing else slides.
    const pan = panFor(id);
    if (pan) {
      steady = !shownPanel;
      dirty = true;
      if (Math.abs(pan.dx) >= 1 || Math.abs(pan.dy) >= 1) {
        fitted = false;
        const offset = v2.subVectors(camera.position, controls.target);
        const back = offset.clone().normalize();
        const right = new Vector3(0, 1, 0).cross(back).normalize();
        const up = new Vector3().crossVectors(back, right);
        // world units per pixel at the node's depth: the camera moves the
        // other way from the way the picture must go
        const i = slot.get(id)!;
        const unit = pw[i] * (Math.tan((FOV * Math.PI) / 360) / (H / 2));
        const target = controls.target.clone().addScaledVector(right, -pan.dx * unit).addScaledVector(up, pan.dy * unit);
        flyTo(target, offset, offset.length(), true);
      }
      wake();
      return;
    }
    steady = false;
    fitted = false;
    // From where the camera already is: the map stays the right way round.
    const direction = new Vector3().subVectors(camera.position, controls.target).normalize();
    // Close enough to read the node, and never closer than its neighbors
    // allow: one far to the side needs distance, one straight behind needs none.
    // camera distance needed per unit of sideways reach (on a phone the panel
    // leaves too little room to promise the neighbors a place beside it)
    const spread = distanceFor(1, wide());
    let distance = Math.max(260, Math.min(700, n.r * 24));
    for (const o of data.near.get(id) ?? []) {
      const q = data.byId.get(o);
      if (!q || hidden.has(o)) continue;
      v1.set(q.x - n.x, q.y - n.y, q.z - n.z);
      const toward = v1.dot(direction); // how far the neighbor is toward the camera
      const aside = Math.sqrt(Math.max(0, v1.lengthSq() - toward * toward));
      distance = Math.max(distance, (aside + q.r + 24) * spread + toward);
    }
    // a hub with neighbors on every side is seen from no farther than the whole graph
    distance = Math.min(distance, fitDistance(direction, wide()) * 1.03);
    flyTo(new Vector3(n.x, n.y, n.z), direction, distance, true);
  };

  const zoom = (factor: number) => {
    fitted = false;
    focusedOn = null;
    const offset = v2.subVectors(camera.position, controls.target);
    flyTo(controls.target.clone(), offset, offset.length() / factor, true, 260);
  };

  /** Orbit by a step, for the arrow keys. */
  const turnBy = (theta: number, phi: number) => {
    fitted = false;
    focusedOn = null;
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
          : `${money(n.org ? n.paid : n.total)} · ${plural(n.awards, "award")}`;
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
    fitted = false;
    focusedOn = null;
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
    fitted = false;
    focusedOn = null;
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
    quietLit.object.visible = dim > 0.01 && quietLit.links.length > 0;
    for (const b of awardsLit) b.object.visible = dim > 0.01 && b.links.length > 0;

    // 4. Atmosphere: fog from just in front of the graph's middle to well
    //    behind its far side. Seen from the front the map is all about as far
    //    away and barely touched; turned, its far side fades into the page.
    const away = camera.position.distanceTo(v1.set(data.center.x, data.center.y, data.center.z));
    fog.near = Math.max(1, away - data.radius * 0.35);
    fog.far = away + data.radius * 2;

    // 5. Has the view changed? Screen positions and labels follow it.
    pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    let turned = false;
    for (let i = 0; i < 16; i++) {
      if (Math.abs(pv.elements[i] - pvWas[i]) > 1e-6) turned = true;
      pvWas[i] = pv.elements[i];
    }
    perUnit = 0.5 * H * camera.projectionMatrix.elements[5];
    if (turned) busy = true;
    // edge widths follow the zoom at the point the camera looks at
    const reachOut = Math.max(camera.position.distanceTo(controls.target), 1);
    widen(perUnit / reachOut);

    // 6. Level of detail. While the camera rushes, or from far out, a crowded
    //    graph draws its award edges as plain lines and drops the other edges;
    //    all of it returns once the view settles.
    const speed = was.distanceTo(camera.position) / reachOut / dt; // about radians a second
    was.copy(camera.position);
    const far = away > distanceFor(data.radius) * 1.3;
    if (speed > 1.2) calmAt = now + 180;
    const rushing = now < calmAt;
    if (rushing) busy = true; // keep drawing until the detail is back
    light = edgeCount > HEAVY_EDGES && (far || rushing);
    quiet.object.visible = !light && quiet.links.length > 0;
    for (const b of awards) b.object.visible = !light && b.links.length > 0;
    awardsThin.object.visible = light && awardsThin.links.length > 0;
    (awardsThin.object.geometry as BufferGeometry).setDrawRange(0, Math.min(awardsThin.links.length, LIGHT_EDGES) * seg * 2);

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
    lookOf = [];
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
      lookOf = next.nodes.map((n) => lookFor(markOf(n)));
      next.nodes.forEach((n, i) => {
        const s = new Sprite(lookOf[i].rest);
        s.scale.set(n.r * 2, n.r * 2, 1);
        s.position.set(n.x, n.y, n.z);
        s.matrixAutoUpdate = false; // it only moves when dragged
        s.updateMatrix();
        sprites.push(s);
        slot.set(n.id, i);
      });
      // Added grouped by mark, solid ones first and open outlines last, so a
      // frame changes material a handful of times, not once per node.
      const order = next.nodes.map((_, i) => i);
      const rank = (i: number) => `${lookOf[i].mark.solid ? 0 : 1}:${lookOf[i].mark.key}`;
      order.sort((a, b) => (rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0));
      for (const i of order) nodesGroup.add(sprites[i]);

      // Each money band's width and opacity: the average of the edges in it.
      const won = next.links.filter((l) => l.kind === "award");
      seg = next.links.length > 2500 ? SEGMENTS_MANY : next.links.length > 800 ? SEGMENTS_SOME : SEGMENTS;
      for (let i = 0; i < BANDS; i++) {
        const mine = won.filter((l) => bandOf(l) === i);
        const mid = EDGE_ALPHA_MIN + ((i + 0.5) / BANDS) * (EDGE_ALPHA_MAX - EDGE_ALPHA_MIN);
        bandAlpha[i] = mine.length ? mine.reduce((s, l) => s + l.alpha, 0) / mine.length : mid;
        const width = mine.length ? mine.reduce((s, l) => s + l.width, 0) / mine.length : 1;
        awards[i].width = awardsLit[i].width = width;
      }
      lineScale = 0;

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
      for (const b of [quiet, quietLit]) (b.object.material as LineDashedMaterial).color.set(palette.text);
      (awardsThin.object.material as LineBasicMaterial).color.set(palette.accent);
      for (const b of [...awards, ...awardsLit]) (b.object.material as LineMaterial).color.set(palette.accent);
      for (const m of ringMaterials) m.color.set(palette.text);
      // The marks are painted in the palette's colors: paint them again.
      for (const look of looks.values()) {
        const old = look.texture;
        look.texture = paintTexture(look.mark);
        for (const m of [look.rest, look.lit]) {
          m.map = look.texture;
          m.needsUpdate = true;
        }
        old.dispose();
      }
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
      for (const m of ringMaterials) m.dispose();
      for (const look of looks.values()) {
        look.rest.dispose();
        look.lit.dispose();
        look.texture.dispose();
      }
      looks.clear();
      layer.replaceChildren();
      tip.style.opacity = "0";
    },
  };
}
