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

/** What `build`/`recall` fall back to when the tape carries no readable frame at all. */
const FALLBACK: Box = { x: 0, y: 0, w: 400, h: 300 };

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Exactly three finite numbers, else no vector — a half-filled pos is worse than none (interpreter falls back to origin). */
const VEC3 = (v: unknown): Vec3 | undefined =>
  Array.isArray(v) && v.length === 3 && v.every(isNum) ? [v[0], v[1], v[2]] : undefined;

const num = (v: unknown, dflt: number): number => (isNum(v) ? v : dflt);
const str = (v: unknown, dflt = ""): string => (typeof v === "string" ? v : dflt);
/** A duration the clock can be built out of: finite, and not negative enough to walk time backwards. */
const ms = (v: unknown, dflt: number): number => Math.max(num(v, dflt), 0);

/** Geometry the camera does arithmetic on: finite corners, and an extent that is never zero or negative. */
function geometry(v: unknown): Box {
  if (!v || typeof v !== "object") return { ...FALLBACK };
  const o = v as Record<string, unknown>;
  // Hand back the same object when it already satisfies the contract: `revise` decides whether to
  // copy by comparing fields, and a fresh object every time would make every op look corrected.
  if (isNum(o.x) && isNum(o.y) && isNum(o.w) && isNum(o.h) && (o.w as number) >= 1 && (o.h as number) >= 1) return v as Box;
  return {
    x: num(o.x, FALLBACK.x),
    y: num(o.y, FALLBACK.y),
    w: Math.max(num(o.w, FALLBACK.w), 1),
    h: Math.max(num(o.h, FALLBACK.h), 1),
  };
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
    if (isNum(p.size)) prim.size = p.size;
    if (isNum(p.radius)) prim.radius = p.radius;
    if (isNum(p.radius2)) prim.radius2 = p.radius2;
    if (isNum(p.height)) prim.height = p.height;
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

/** Markup a tape cannot render is markup that is not there: a wrong type is no drawing, not a crash. */
const text = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

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

/** Names the tape may not have written as strings; untouched when every element already is one. */
function names(list: unknown): string[] | undefined | null {
  if (typeof list === "string") return [list];
  if (!Array.isArray(list)) return list === undefined ? undefined : [];
  return list.every((x) => typeof x === "string") ? null : list.map((x) => str(x));
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
        id: str(op.id),
        label: str(op.label, str(op.id)),
        box: geometry(op.box),
        ...(op.scene !== undefined ? { scene: str(op.scene) } : {}),
        ...(op.note !== undefined ? { note: str(op.note) } : {}),
        svg: text(op.svg),
        html: text(op.html),
        css: text(op.css),
        scene3d: op.scene3d === undefined ? undefined : guardScene3(op.scene3d),
      });
    case "patch":
      return revise(op, {
        id: str(op.id),
        ...(op.scene !== undefined ? { scene: str(op.scene) } : {}),
        ...(op.box !== undefined ? { box: geometry(op.box) } : {}),
        ...(op.label !== undefined ? { label: str(op.label) } : {}),
        svg: text(op.svg),
        html: text(op.html),
        css: text(op.css),
        scene3d: op.scene3d === undefined ? undefined : guardScene3(op.scene3d),
      });
    case "recall":
      return revise(op, {
        id: str(op.id),
        // Left out, `recall` means "onto the board being stood on" — that is decided at compile time,
        // so a missing name stays missing rather than becoming the empty string.
        ...(op.scene !== undefined ? { scene: str(op.scene) } : {}),
        box: geometry(op.box),
      });
    case "discard":
      return revise(op, { id: str(op.id) });
    case "link":
      return revise(op, { from: str(op.from), to: str(op.to), relation: str(op.relation) });
    case "camera": {
      const target = names(op.target);
      return revise(op, {
        mode: oneOf(op.mode, CAMERA_MODES, "fit"),
        duration: ms(op.duration, 900),
        ...(target === null ? {} : { target: target as string[] | undefined }),
        region: op.region === undefined ? undefined : geometry(op.region),
        center: op.center === undefined ? undefined : fraction(op.center),
        zoom: isNum(op.zoom) ? op.zoom : undefined,
        follow: typeof op.follow === "string" ? op.follow : undefined,
        screens: isNum(op.screens) ? Math.min(4, Math.max(0.1, op.screens)) : undefined,
        at: op.at === undefined ? undefined : fraction(op.at),
        span: isNum(op.span) ? Math.min(1, Math.max(0.05, op.span)) : undefined,
      });
    }
    case "narrate":
      return revise(op, { text: str(op.text), duration: ms(op.duration, 2000) });
    case "transition":
      return revise(op, { to: str(op.to), duration: ms(op.duration, 1200) });
    case "highlight":
      return revise(op, { target: str(op.target), duration: ms(op.duration, 1500) });
    case "motion":
      return revise(op, {
        id: str(op.id),
        mode: oneOf(op.mode, MOTION_MODES, "oscillate"),
        axis: oneOf(op.axis, MOTION_AXES, "x"),
        amp: num(op.amp, 90),
        period: Math.max(ms(op.period, 1600), 60),
        radius: num(op.radius, 0),
        steps: num(op.steps, 4),
        decay: num(op.decay, 700),
        duration: ms(op.duration, 3000),
      });
    case "beat":
      return revise(op, { duration: ms(op.duration, 600) });
    case "quiz": {
      const list = Array.isArray(op.options) ? op.options : [];
      const kept = list.slice(0, MAX_OPTIONS);
      return revise(op, {
        prompt: str(op.prompt),
        options: kept.map((x) => str(x)),
        answer: Math.min(Math.max(Math.round(num(op.answer, 0)), 0), Math.max(kept.length - 1, 0)),
        ...(op.why !== undefined ? { why: str(op.why) } : {}),
        ...(op.concept !== undefined ? { concept: str(op.concept) } : {}),
      });
    }
    case "pause-for":
      return revise(op, { reason: str(op.reason) });
    default:
      // A verb the interpreter does not know stays as it is: it lands in no cue and no prop, so the
      // director hears about it from the tool layer rather than watching a blank board.
      return op;
  }
}
