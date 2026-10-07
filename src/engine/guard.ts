import type { Box, Op, Prim3, Scene3DSpec, Vec3 } from "./types";

/*
 * The tape is the product: it is exported, compressed into a share URL, and re-performed. Every op
 * therefore reaches the interpreter over one of two paths — a director tool call, or somebody else's
 * recording. Only the first was ever whitelisted, so the rule the README states ("入参过白名单") held
 * for the model and not for the tape: a `#s=` link could hand the 3-D interpreter five thousand
 * primitives at size 1e9 — that melts the WebGL context, and the whole board dies with it — and a
 * single NaN in a box propagates through the camera arithmetic into a frame no learner can see.
 *
 * So the whitelist sits at the boundary the log owns, on the way in from either path. Nothing here
 * throws: a recording with one bad number still plays, with that field defaulted. A tape is a record
 * of a lesson, and the person opening the link did not make the mistake being corrected.
 *
 * Types were only half of it. The other half is *magnitude*, because the interpreter turns numbers into
 * a clock and a camera: `duration: 1e18` is that show's length and that timeline's max, a 200k-character
 * line is 10.7 hours of narration once `speechMs` gets it, a 1e12 box is a frame of 1.2e12, and DOMPurify
 * parses a 2.8 MB `<svg>` before dropping one node. The ceilings below come from what a lesson is made of
 * — a board is 1600x900 and a line is something a teacher says — not from the worst case they defend.
 */

const PRIMITIVE_SHAPES = new Set<Prim3["shape"]>([
  "box",
  "sphere",
  "cylinder",
  "cone",
  "torus",
  "plane",
  "line",
  "arrow",
]);

/** A model that dumps thousands of primitives would melt the WebGL context; a teaching object never needs that many. */
const MAX_PRIMS = 64;

/** A choice card the learner can actually read. Past this it is a wall of buttons. */
const MAX_OPTIONS = 12;

/** Framing more than a handful of named things is not a shot, it is the whole plane. */
const MAX_TARGETS = 64;

/**
 * What the clock can be built out of. `cueMs` floors a line at the time it takes to say it, so this is
 * a ceiling on what a tape may *ask for* — and the ceiling is what keeps a recording from ending the
 * lesson: an explicit `duration: 1e18` used to become the show's length, which is 317 years of stage
 * time and a timeline slider no one can move.
 */
const MAX_MS = 120_000;

/**
 * The plane is unbounded, but the camera does arithmetic on it in floats: a 1e12 box came out the other
 * side as a frame 1.2e12 wide, and precision is gone long before that. A board is 1600x900, so these
 * ceilings are already two orders of magnitude of room to place things by hand.
 */
const MAX_COORD = 200_000;
const MAX_EXTENT = 40_000;

/** Names and lines: a tape is a record of a lesson, not a file to be smuggled through one field. */
const MAX_NAME = 120;
const MAX_TEXT = 2000;
/** Markup a painter actually draws — a diagram, not a corpus — is tens of KB. */
const MAX_MARKUP = 200_000;

/** What `build`/`recall` fall back to when the tape carries no readable frame at all. */
const FALLBACK: Box = { x: 0, y: 0, w: 400, h: 300 };

/**
 * The 3-D window has its own units — the interpreter fits the camera to the primitives it is given, so
 * `size: 1e9` is not an invisible object but a far plane 6e10 out, and after that no surface in the
 * scene keeps a depth order. A default primitive is 2 units, so this is already room to spare.
 */
const MAX_WORLD = 1000;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A number inside the 3-D window's own units, or the field's default when the tape has nothing readable. */
const world = (n: number): number => Math.min(Math.max(n, -MAX_WORLD), MAX_WORLD);

/** Exactly three finite numbers, else no vector — a half-filled pos is worse than none (interpreter falls back to origin). */
const VEC3 = (v: unknown): Vec3 | undefined =>
  Array.isArray(v) && v.length === 3 && v.every(isNum) ? (v as number[]).map(world) as Vec3 : undefined;

const num = (v: unknown, dflt: number): number => (isNum(v) ? v : dflt);
const str = (v: unknown, dflt = ""): string => (typeof v === "string" ? v : dflt);
/** A name the interpreter keys maps on: capped, but never defaulted away — an empty id is still "no id". */
const name = (v: unknown): string => str(v).slice(0, MAX_NAME);
/** A line of speech, capped before `speechMs` gets to it: 200k characters is 10 hours of narration. */
const line = (v: unknown): string => str(v).slice(0, MAX_TEXT);
/** A duration the clock can be built out of: finite, not negative enough to walk time backwards, not endless. */
const ms = (v: unknown, dflt: number): number => Math.min(Math.max(num(v, dflt), 0), MAX_MS);
/** How far a prop may be pushed off its anchor by `motion`, in world units. */
const offset = (v: unknown, dflt: number): number => Math.min(Math.max(num(v, dflt), -MAX_EXTENT), MAX_EXTENT);

/** Geometry the camera does arithmetic on: finite corners, a readable extent, and never zero or negative. */
function geometry(v: unknown): Box {
  if (!v || typeof v !== "object") return { ...FALLBACK };
  const o = v as Record<string, unknown>;
  const fits = (n: unknown, limit: number) => isNum(n) && Math.abs(n) <= limit;
  // Hand back the same object when it already satisfies the contract: `revise` decides whether to
  // copy by comparing fields, and a fresh object every time would make every op look corrected.
  if (fits(o.x, MAX_COORD) && fits(o.y, MAX_COORD) && fits(o.w, MAX_EXTENT) && fits(o.h, MAX_EXTENT) && (o.w as number) >= 1 && (o.h as number) >= 1)
    return v as Box;
  const span = (n: unknown, dflt: number) => Math.min(Math.max(num(n, dflt), 1), MAX_EXTENT);
  const corner = (n: unknown, dflt: number) => Math.min(Math.max(num(n, dflt), -MAX_COORD), MAX_COORD);
  return { x: corner(o.x, FALLBACK.x), y: corner(o.y, FALLBACK.y), w: span(o.w, FALLBACK.w), h: span(o.h, FALLBACK.h) };
}

/** A point inside a prop's own box: out of 0..1 the close-up frames empty space next to the object. */
function fraction(v: unknown): { x: number; y: number } | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const f = (x: unknown) => Math.min(1, Math.max(0, num(x, 0.5)));
  if (isNum(o.x) && isNum(o.y) && o.x >= 0 && o.x <= 1 && o.y >= 0 && o.y <= 1) return v as { x: number; y: number };
  return { x: f(o.x), y: f(o.y) };
}

/**
 * A world point the camera pans its centre onto — the same coordinates `build` takes, so the same
 * ceiling, and deliberately *not* a fraction: `at` and `center` look alike in a tape and mean opposite
 * things (`at` is a fraction of the target's box, `center` is a place on the plane).
 */
function point(v: unknown): { x: number; y: number } | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  if (isNum(o.x) && isNum(o.y) && Math.abs(o.x as number) <= MAX_COORD && Math.abs(o.y as number) <= MAX_COORD) return v as { x: number; y: number };
  const c = (n: unknown) => Math.min(Math.max(num(n, 0), -MAX_COORD), MAX_COORD);
  return { x: c(o.x), y: c(o.y) };
}

/**
 * A "sky" as dark as the board is a painter sneaking a second board in through the 3-D window: the
 * stage is already the backdrop, so the field is dropped and the board shows through the glass.
 */
function isBoardDark(hex: string): boolean {
  const h = hex.slice(1);
  const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
  if (![r, g, b].every((v) => Number.isFinite(v))) return false;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.16;
}

/**
 * Coerce whatever arrived into a Scene3DSpec. This is untrusted data rendered by WebGL, so every
 * field is whitelisted and clamped: unknown shapes dropped, colours kept to short #hex, counts
 * capped. The 3-D interpreter never receives anything but the result of this function.
 */
export function guardScene3(v: unknown): Scene3DSpec | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const prims: Prim3[] = [];
  for (const r of Array.isArray(o.prims) ? o.prims : []) {
    if (!r || typeof r !== "object") continue;
    const p = r as Record<string, unknown>;
    if (typeof p.shape !== "string" || !PRIMITIVE_SHAPES.has(p.shape as Prim3["shape"])) continue;
    const prim: Prim3 = { shape: p.shape as Prim3["shape"] };
    // Sizes are world units the framing box3 is computed from: a 1e9 sphere does not fail to render, it
    // drags the camera's far plane with it, and then nothing else in the window has depth precision.
    const len = (n: unknown) => (isNum(n) ? world(n) : undefined);
    const size = len(p.size);
    if (size !== undefined) prim.size = size;
    const radius = len(p.radius);
    if (radius !== undefined) prim.radius = radius;
    const radius2 = len(p.radius2);
    if (radius2 !== undefined) prim.radius2 = radius2;
    const height = len(p.height);
    if (height !== undefined) prim.height = height;
    const from = VEC3(p.from);
    const to = VEC3(p.to);
    if (from) prim.from = from;
    if (to) prim.to = to;
    const pos = VEC3(p.pos);
    if (pos) prim.pos = pos;
    const rot = VEC3(p.rot);
    if (rot) prim.rot = rot;
    if (typeof p.color === "string" && /^#[0-9a-fA-F]{3,8}$/.test(p.color)) prim.color = p.color;
    if (p.wireframe === true) prim.wireframe = true;
    if (isNum(p.opacity)) prim.opacity = Math.min(1, Math.max(0, p.opacity));
    if (typeof p.label === "string") prim.label = p.label.slice(0, 120);
    prims.push(prim);
    if (prims.length >= MAX_PRIMS) break;
  }

  const spec: Scene3DSpec = { prims };
  if (o.camera && typeof o.camera === "object") {
    const c = o.camera as Record<string, unknown>;
    const cam: NonNullable<Scene3DSpec["camera"]> = {};
    const pos = VEC3(c.pos);
    const look = VEC3(c.look);
    if (pos) cam.pos = pos;
    if (look) cam.look = look;
    if (isNum(c.fov)) cam.fov = Math.min(120, Math.max(10, c.fov));
    if (cam.pos || cam.look || cam.fov) spec.camera = cam;
  }
  if (o.spin && typeof o.spin === "object") {
    const s = o.spin as Record<string, unknown>;
    const spin: NonNullable<Scene3DSpec["spin"]> = {};
    if (s.axis === "x" || s.axis === "y" || s.axis === "z") spin.axis = s.axis;
    if (isNum(s.degPerSec)) spin.degPerSec = Math.min(360, Math.max(-360, s.degPerSec));
    spec.spin = spin;
  } else if (o.spin === true) {
    spec.spin = { axis: "y", degPerSec: 24 };
  }
  if (o.interactive === true) spec.interactive = true;
  if (o.grid === true) spec.grid = true;
  if (o.axes === true) spec.axes = true;
  if (typeof o.background === "string" && /^#[0-9a-fA-F]{3,8}$/.test(o.background) && !isBoardDark(o.background)) spec.background = o.background;
  return spec;
}

/**
 * Markup a tape cannot render is markup that is not there: a wrong type is no drawing, not a crash.
 * A 2.8 MB `<svg>` used to ride through the door intact — DOMPurify parses the whole thing before it
 * drops a single node, and every re-render of that prop pays it again.
 */
const text = (v: unknown): string | undefined => (typeof v === "string" ? (v.length > MAX_MARKUP ? v.slice(0, MAX_MARKUP) : v) : undefined);

/**
 * The enums the interpreter switches on without a default branch. `motionOffset` returns `undefined`
 * for a mode it does not know, and `displaced` then throws — so one bad string from a recording takes
 * the whole board down. Everything else (easing, veil style) already has a fallback where it is read.
 */
const MOTION_MODES = new Set(["oscillate", "approach", "orbit", "iterate", "flow"]);
const MOTION_AXES = new Set(["x", "y", "both"]);
const CAMERA_MODES = new Set(["fit", "focus", "pan", "zoom", "track"]);

function oneOf<T extends string>(v: unknown, allowed: Set<string>, dflt: T): T {
  return typeof v === "string" && allowed.has(v) ? (v as T) : dflt;
}

/**
 * Apply corrections without replacing the object. Identity matters here: the show's own code compares
 * ops by reference (`loop.ts` finds the cue an op became so it can ask "was this name on stage when the
 * camera asked?"), and a guard that always re-wraps would silently break that lookup. So a well-formed
 * op goes back out as the same object it came in.
 */
function revise<T extends object>(op: T, changes: Partial<T>): T {
  for (const k of Object.keys(changes) as (keyof T)[]) {
    if (op[k] !== changes[k]) return { ...op, ...changes };
  }
  return op;
}

/**
 * Names the camera may frame. Capped because the union of the targets is computed with a spread
 * (`Math.min(...boxes)`), which is a stack argument list: a recording that named 130k targets did not
 * produce a bad shot, it produced a RangeError inside the compiler and a board that never loads.
 */
function names(list: unknown): string[] | undefined | null {
  if (typeof list === "string") return list.length <= MAX_NAME ? null : [list.slice(0, MAX_NAME)];
  if (!Array.isArray(list)) return list === undefined ? undefined : [];
  const ok = (x: unknown) => typeof x === "string" && x.length <= MAX_NAME;
  return list.length <= MAX_TARGETS && list.every(ok) ? null : list.slice(0, MAX_TARGETS).map((x) => name(x));
}

/**
 * The options of a choice card, or `null` when the tape's own array already satisfies the contract.
 * `null` means "leave it alone": mapping unconditionally hands back an equal-but-new array, and
 * `revise` compares by identity, so every quiz would look corrected — including on the director's own
 * path, where the reference the show keeps (`c.op === askedBy`) is the answer card itself.
 */
function choices(list: unknown, cap: number): string[] | null {
  if (!Array.isArray(list)) return [];
  const ok = (x: unknown) => typeof x === "string" && x.length <= MAX_TEXT;
  if (list.length <= cap && list.every(ok)) return null;
  return list.slice(0, cap).map((x) => line(x));
}

/**
 * One op as the interpreter needs it to be. Fields a tape cannot carry are defaulted or dropped;
 * everything else survives untouched, because the tape is the record of what was staged. Idempotent
 * and identity-preserving: an op that came out of a director tool already satisfies this.
 */
export function guardOp(op: Op): Op {
  switch (op.kind) {
    case "build":
      return revise(op, {
        id: name(op.id),
        label: name(op.label) || name(op.id),
        box: geometry(op.box),
        ...(op.scene !== undefined ? { scene: name(op.scene) } : {}),
        ...(op.note !== undefined ? { note: line(op.note) } : {}),
        svg: text(op.svg),
        html: text(op.html),
        css: text(op.css),
        scene3d: op.scene3d === undefined ? undefined : guardScene3(op.scene3d),
      });
    case "patch":
      return revise(op, {
        id: name(op.id),
        ...(op.scene !== undefined ? { scene: name(op.scene) } : {}),
        ...(op.box !== undefined ? { box: geometry(op.box) } : {}),
        ...(op.label !== undefined ? { label: name(op.label) } : {}),
        svg: text(op.svg),
        html: text(op.html),
        css: text(op.css),
        scene3d: op.scene3d === undefined ? undefined : guardScene3(op.scene3d),
      });
    case "recall":
      return revise(op, {
        id: name(op.id),
        // Left out, `recall` means "onto the board being stood on" — that is decided at compile time,
        // so a missing name stays missing rather than becoming the empty string.
        ...(op.scene !== undefined ? { scene: name(op.scene) } : {}),
        box: geometry(op.box),
      });
    case "discard":
      return revise(op, { id: name(op.id) });
    case "link":
      return revise(op, { from: name(op.from), to: name(op.to), relation: name(op.relation) });
    case "camera": {
      const target = names(op.target);
      return revise(op, {
        mode: oneOf(op.mode, CAMERA_MODES, "fit"),
        duration: ms(op.duration, 900),
        ...(target === null ? {} : { target: target as string[] | undefined }),
        region: op.region === undefined ? undefined : geometry(op.region),
        center: op.center === undefined ? undefined : point(op.center),
        zoom: isNum(op.zoom) ? Math.min(Math.max(op.zoom, 0.01), 100) : undefined,
        follow: typeof op.follow === "string" ? name(op.follow) : undefined,
        screens: isNum(op.screens) ? Math.min(4, Math.max(0.1, op.screens)) : undefined,
        at: op.at === undefined ? undefined : fraction(op.at),
        span: isNum(op.span) ? Math.min(1, Math.max(0.05, op.span)) : undefined,
      });
    }
    case "narrate":
      return revise(op, { text: line(op.text), duration: ms(op.duration, 2000) });
    case "transition":
      return revise(op, { to: name(op.to), duration: ms(op.duration, 1200) });
    case "highlight":
      return revise(op, { target: name(op.target), duration: ms(op.duration, 1500) });
    case "motion":
      return revise(op, {
        id: name(op.id),
        mode: oneOf(op.mode, MOTION_MODES, "oscillate"),
        axis: oneOf(op.axis, MOTION_AXES, "x"),
        amp: offset(op.amp, 90),
        period: Math.min(Math.max(ms(op.period, 1600), 60), MAX_MS),
        radius: Math.max(offset(op.radius, 0), 0),
        steps: Math.min(Math.max(Math.round(num(op.steps, 4)), 2), 64),
        decay: Math.max(offset(op.decay, 700), 200),
        duration: ms(op.duration, 3000),
      });
    case "beat":
      return revise(op, { duration: ms(op.duration, 600) });
    case "quiz": {
      const opts = choices(op.options, MAX_OPTIONS);
      const count = opts === null ? (op.options as string[]).length : opts.length;
      return revise(op, {
        prompt: line(op.prompt),
        ...(opts === null ? {} : { options: opts }),
        answer: Math.min(Math.max(Math.round(num(op.answer, 0)), 0), Math.max(count - 1, 0)),
        ...(op.why !== undefined ? { why: line(op.why) } : {}),
        ...(op.concept !== undefined ? { concept: name(op.concept) } : {}),
      });
    }
    case "pause-for":
      return revise(op, { reason: line(op.reason) });
    case "answer":
      // The learner's own words, and the card they answer. `gate` is looked up with `===` against the
      // sequence numbers the log handed out, so a non-number is not a sloppy number — it is an answer
      // that silently belongs to no card, leaving a `text` of any type to be written into `said`, whose
      // whole contract is "a string, or null while it is still an open question".
      return revise(op, {
        gate: Math.round(num(op.gate, -1)),
        text: line(op.text),
      });
    default:
      // A verb the interpreter does not know stays as it is: it lands in no cue and no prop, so the
      // director hears about it from the tool layer rather than watching a blank board.
      return op;
  }
}
