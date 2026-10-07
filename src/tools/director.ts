import { Type } from "@earendil-works/pi-ai";
import type { Tool } from "@earendil-works/pi-ai";
import type { Box, MotionMode, NarrateOp, Op, Prim3, Scene3DSpec, Vec3 } from "../engine/types";
import type { Stage } from "../engine/runtime";
import { cueMs } from "../engine/compile";

const MOTION_MODES = new Set(["oscillate", "approach", "orbit", "iterate", "flow"]);

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

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** Exactly three finite numbers, else no vector — a half-filled pos is worse than none (interpreter falls back to origin). */
const VEC3 = (v: unknown): Vec3 | undefined =>
  Array.isArray(v) && v.length === 3 && v.every(isNum) ? [v[0], v[1], v[2]] : undefined;

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
 * Coerce whatever the director emitted into a Scene3DSpec. This is untrusted model output rendered by
 * WebGL, so every field is whitelisted and clamped: unknown shapes dropped, colors kept to short
 * #hex/named-safe strings, counts capped. The interpreter never receives raw markup here — only data.
 */
export function scene3(v: unknown): Scene3DSpec | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const rawPrims = Array.isArray(o.prims) ? o.prims : [];
  const prims: Prim3[] = [];
  for (const r of rawPrims) {
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
    const pos = VEC3(c.pos);
    const look = VEC3(c.look);
    const cam: NonNullable<Scene3DSpec["camera"]> = {};
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


const num = (d: string) => Type.Number({ description: d });
const str = (d: string) => Type.String({ description: d });
const box = {
  x: num("world x of the prop's top-left corner"),
  y: num("world y of the prop's top-left corner"),
  w: num("width in world units (the backstage plane is unbounded; a scene is roughly 1600x900)"),
  h: num("height in world units"),
};
/** The loose half of `box`: an object placed without x/y lands where the camera is pointing. */
const boxPlaced = {
  x: Type.Optional(num("world x of the top-left corner — leave x and y out to place it in the middle of the current frame")),
  y: Type.Optional(num("world y of the top-left corner")),
  w: box.w,
  h: box.h,
};

const VEC3T = Type.Array(num("one axis"), { minItems: 3, maxItems: 3 });
const PRIM3_T = Type.Object(
  {
    shape: Type.Enum({ box: "box", sphere: "sphere", cylinder: "cylinder", cone: "cone", torus: "torus", plane: "plane", line: "line", arrow: "arrow" }),
    size: Type.Optional(num("overall edge length for box (half-extents); a good default size for the curved shapes")),
    radius: Type.Optional(num("sphere/cylinder/cone base/torus ring radius; for arrow the shaft radius")),
    radius2: Type.Optional(num("torus tube radius, or a cylinder's top radius to make it a frustum")),
    height: Type.Optional(num("cylinder/cone/plane length; line/arrow use from/to instead")),
    from: Type.Optional(VEC3T),
    to: Type.Optional(VEC3T),
    pos: Type.Optional(VEC3T),
    rot: Type.Optional(VEC3T),
    color: Type.Optional(str("#rrggbb or #rrggbbaa; omit for the default material")),
    wireframe: Type.Optional(Type.Boolean({ description: "draw edges only" })),
    opacity: Type.Optional(num("0..1, 1 = solid")),
    label: Type.Optional(str("floating text sprite at this primitive's pos — the only text the 3-D window shows")),
  },
  { description: "one 3-D primitive. It is DATA, not code: name shapes, never emit JavaScript." },
);
const SCENE3D_T = Type.Object(
  {
    prims: Type.Array(PRIM3_T, { description: "the solids/drawings that make up this object" }),
    camera: Type.Optional(
      Type.Object({
        pos: Type.Optional(VEC3T),
        look: Type.Optional(VEC3T),
        fov: Type.Optional(num("vertical degrees 10..120")),
      }),
    ),
    spin: Type.Optional(
      Type.Object({
        axis: Type.Optional(Type.Enum({ x: "x", y: "y", z: "z" })),
        degPerSec: Type.Optional(num("rotation speed; angle is a pure function of stage time so it replays")),
      }),
    ),
    interactive: Type.Optional(Type.Boolean({ description: "let the learner drag to orbit — this rotation lives outside the log and is NOT captured in a shared/replayed lesson" })),
    grid: Type.Optional(Type.Boolean({ description: "show a ground grid" })),
    axes: Type.Optional(Type.Boolean({ description: "show an XYZ axis triad" })),
    background: Type.Optional(str("#rrggbb clear colour, or omit for the board showing through")),
  },
  { description: "a 3-D window on the board (three.js). Use ONLY when the idea is genuinely three-dimensional." },
);

export interface TeachingState {
  title: string;
  concepts: string[];
  learner: string;
  beatsDone: number;
}

export interface DirectorResult {
  ops: Op[];
  /** Text returned to the model. */
  result: string;
  isError?: boolean;
}

export function directorTools(
  stage: Stage,
  teaching: TeachingState,
): { tools: Tool[]; run: (name: string, args: Record<string, unknown>) => DirectorResult } {
  const S = (v: unknown, d = "") => (typeof v === "string" ? v : d);
  const N = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const A = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
  const B = (o: Record<string, unknown>): Box => ({ x: N(o.x), y: N(o.y), w: Math.max(N(o.w, 200), 1), h: Math.max(N(o.h, 200), 1) });
  /** Asking for an object without naming coordinates means "where the audience is looking". */
  const HERE = (o: Record<string, unknown>) => (o.x === undefined && o.y === undefined ? true : undefined);
  /** Models write `target` as either one id or a list; both mean the same framing. */
  const T = (v: unknown): string[] | undefined =>
    typeof v === "string" ? [v] : Array.isArray(v) && v.length ? v.map((t) => S(t)) : undefined;
  /** The skeleton's camera and a standalone camera call describe the same move: one builder keeps them identical. */
  const CAM = (o: Record<string, unknown>) => ({
    kind: "camera" as const,
    mode: S(o.mode, "fit") as never,
    target: T(o.target),
    region: o.region ? B(o.region as Record<string, unknown>) : undefined,
    center: o.center ? { x: N((o.center as Record<string, unknown>).x), y: N((o.center as Record<string, unknown>).y) } : undefined,
    zoom: o.zoom !== undefined ? N(o.zoom, 1) : undefined,
    follow: o.follow ? S(o.follow) : undefined,
    dir: o.dir ? (S(o.dir) as never) : undefined,
    screens: o.screens !== undefined ? N(o.screens, 0.8) : undefined,
    at: o.at ? { x: N((o.at as Record<string, unknown>).x, 0.5), y: N((o.at as Record<string, unknown>).y, 0.5) } : undefined,
    span: o.span !== undefined ? N(o.span, 0.45) : undefined,
    duration: N(o.duration, 900),
    easing: S(o.easing, "ease") as never,
  });

  const run = (name: string, args: Record<string, unknown>): DirectorResult => {
    const ops: Op[] = [];
    switch (name) {
      case "stage_script": {
        for (const beat of A(args.beats)) {
          for (const p of A(beat.props)) {
            ops.push({
              kind: "build",
              id: S(p.id),
              // No name, no scene: the engine puts it on the board the show is standing in. Inventing
              // a name here would be the tool deciding where the lesson is, and a prop on a board the
              // show never walked onto is a prop nobody sees.
              scene: S(p.scene, S(beat.scene)) || undefined,
              label: S(p.label, S(p.id)),
              note: p.note ? S(p.note) : undefined,
              box: B(p),
              here: HERE(p),
            });
          }
          const cam = (beat.camera ?? {}) as Record<string, unknown>;
          if (cam.mode) ops.push(CAM(cam));
          ops.push({ kind: "narrate", text: S(beat.say), duration: N(beat.seconds, 6) * 1000, style: beat.style ? (S(beat.style) as NarrateOp["style"]) : undefined });
          if (beat.hold) ops.push({ kind: "beat", duration: N(beat.hold, 600) });
        }
        const narr = ops.filter((o) => o.kind === "narrate") as NarrateOp[];
        const secs = narr.reduce((a, o) => a + cueMs(o), 0) / 1000;
        return { ops, result: `skeleton scheduled: ${narr.length} narrated beats, ~${secs.toFixed(0)}s of stage time. Each prop is an empty frame until paint() fills it — and the clock parks at the edge of the beat whose frame is still empty, so paint them in beat order.` };
      }
      case "build":
        ops.push({
          kind: "build",
          id: S(args.id),
          scene: S(args.scene) || undefined,
          label: S(args.label, S(args.id)),
          note: args.note ? S(args.note) : undefined,
          here: HERE(args),
          box: B(args),
          svg: args.svg ? S(args.svg) : undefined,
          html: args.html ? S(args.html) : undefined,
          css: args.css ? S(args.css) : undefined,
          scene3d: scene3(args.scene3d),
        });
        return { ops, result: `built ${S(args.id)}` };
      case "draw":
        ops.push({
          kind: "patch",
          id: S(args.id),
          svg: args.svg ? S(args.svg) : undefined,
          html: args.html ? S(args.html) : undefined,
          css: args.css ? S(args.css) : undefined,
          scene3d: scene3(args.scene3d),
          label: args.label ? S(args.label) : undefined,
        });
        return { ops, result: `drew ${S(args.id)}` };
      case "move":
        ops.push({ kind: "patch", id: S(args.id), box: B(args) });
        return { ops, result: `moved ${S(args.id)} to (${N(args.x)},${N(args.y)})` };
      case "discard":
        ops.push({ kind: "discard", id: S(args.id) });
        return { ops, result: `discarded ${S(args.id)}` };
      case "link":
        ops.push({ kind: "link", from: S(args.from), to: S(args.to), relation: S(args.relation) });
        return { ops, result: `linked ${S(args.from)} ${S(args.relation)} ${S(args.to)}` };
      case "fetch_prop": {
        const p = stage.compiled.props.get(S(args.id));
        if (!p) return { ops, result: `no prop named ${S(args.id)}`, isError: true };
        const r = p.revisions[p.revisions.length - 1];
        return {
          ops,
          result: JSON.stringify({
            id: p.id,
            scene: p.scene,
            label: r.label,
            note: r.note,
            box: r.box,
            links: p.links,
            svg: r.svg,
            html: r.html,
            css: r.css,
            scene3d: r.scene3d,
          }),
        };
      }
      case "recall":
        ops.push({ kind: "recall", id: S(args.id), scene: S(args.scene), box: B(args), here: HERE(args) });
        return { ops, result: `reused ${S(args.id)} in ${S(args.scene)} — same object identity, previous screen position remembered` };
      case "camera":
        ops.push(CAM(args));
        return { ops, result: `camera ${S(args.mode)} over ${N(args.duration, 900)}ms` };
      case "narrate": {
        const line: NarrateOp = { kind: "narrate", text: S(args.text), duration: N(args.seconds, 6) * 1000, style: args.style ? (S(args.style) as NarrateOp["style"]) : undefined };
        ops.push(line);
        const got = cueMs(line) / 1000;
        const rushed = got > line.duration / 1000 + 0.05;
        return { ops, result: `narrated ${line.text.length} chars — this beat runs ${got.toFixed(1)}s${rushed ? " (longer than you asked: the clock will not rush a sentence, and the cut after it waits for the voice)" : ""}` };
      }
      case "beat":
        ops.push({ kind: "beat", duration: N(args.seconds, 1) * 1000 });
        return { ops, result: `silence ${N(args.seconds, 1)}s` };
      case "transition":
        ops.push({ kind: "transition", style: S(args.style, "dissolve") as never, to: S(args.to), duration: N(args.seconds, 1.2) * 1000 });
        return { ops, result: `transition ${S(args.style)} -> ${S(args.to)}` };
      case "highlight":
        ops.push({ kind: "highlight", target: S(args.target), style: S(args.style, "pulse") as never, duration: N(args.seconds, 1.5) * 1000 });
        return { ops, result: `highlighted ${S(args.target)}` };
      case "motion": {
        const mode = MOTION_MODES.has(S(args.mode)) ? S(args.mode) : "oscillate";
        ops.push({
          kind: "motion",
          id: S(args.id),
          mode: mode as MotionMode,
          axis: args.axis === "y" || args.axis === "both" ? args.axis : "x",
          amp: N(args.amp, 90),
          period: N(args.period, 1600),
          radius: N(args.radius, 0),
          steps: N(args.steps, 4),
          decay: N(args.decay, 700),
          duration: N(args.seconds, 3) * 1000,
        });
        return { ops, result: `${mode} ${S(args.id)} for ${N(args.seconds, 3)}s — displaced by the interpreter, its anchor position is untouched` };
      }
      case "ask_learner":
        ops.push({ kind: "quiz", prompt: S(args.prompt), options: A(args.options).map((o) => S(o)), answer: N(args.answer, 0), why: args.why ? S(args.why) : undefined, concept: args.concept ? S(args.concept) : undefined });
        return { ops, result: "question queued; the stage clock stops until the learner answers" };
      case "pause_for":
        ops.push({ kind: "pause-for", reason: S(args.reason) });
        return { ops, result: "stage clock will stop and wait for the learner" };
      case "note_progress": {
        teaching.concepts = [...new Set([...teaching.concepts, ...A(args.concepts_covered).map((c) => S(c))])];
        if (args.learner_state) teaching.learner = S(args.learner_state);
        teaching.beatsDone += N(args.beats_advanced, 0);
        return { ops, result: `progress noted: ${teaching.concepts.join(", ") || "none"} | learner: ${teaching.learner}` };
      }
      case "stage_state":
        return { ops, result: stage.agentSnapshot() };
      default:
        return { ops, result: `unknown verb ${name}`, isError: true };
    }
  };

  const tools: Tool[] = [
    {
      name: "stage_script",
      description:
        "Lay the skeleton first, in one call: beats of narration with prop placeholders (id, label, box) and camera moves. The clock starts running, but it parks at the edge of a beat whose artwork has not landed — a picture still streaming in does not count as landed, so the line about it cannot start ahead of the thing it describes. Paint each placeholder before the narration reaches it; one nobody paints stays an empty frame until your turn ends and the caption plays over it. Call this at the start of every scene.",
      parameters: Type.Object({
        title: str("what this scene teaches"),
        beats: Type.Array(
          Type.Object({
            scene: Type.Optional(str("scene name; props placed here belong to it")),
            say: str("the narration line spoken during this beat"),
            seconds: num("seconds this beat lasts — a floor, not a cap: a line you cannot say in this time makes the beat longer, never the voice faster"),
            style: Type.Optional(
              Type.Enum({ caption: "caption", verse: "verse", voice: "voice" }, { description: "how the line shows: caption types along the bottom, verse stages the line as a big centre-frame statement, voice speaks it without putting text on the board" }),
            ),
            hold: Type.Optional(num("extra silence after the line, milliseconds, default 600")),
            props: Type.Optional(
              Type.Array(
                Type.Object({
                  id: str("stable id, reused across scenes for prop continuity"),
                  label: str("one line: what this object IS"),
                  scene: Type.Optional(str("scene to place it in")),
                  ...boxPlaced,
                  note: Type.Optional(str("teaching role of this prop")),
                }),
              ),
            ),
            camera: Type.Optional(
              Type.Object({
                mode: Type.Enum({ fit: "fit", focus: "focus", pan: "pan", zoom: "zoom", track: "track" }),
                target: Type.Optional(Type.Array(str("prop or scene ids to frame"))),
                dir: Type.Optional(Type.Enum({ left: "left", right: "right", up: "up", down: "down" }, { description: "for pan: slide the frame this way instead of naming coordinates" })),
                screens: Type.Optional(num("for pan: fraction of the frame to slide, default 0.8")),
                at: Type.Optional(Type.Object({ x: num("0..1 across the target's box"), y: num("0..1 down the target's box") }, { description: "close-up on a part of the target, e.g. an arrowhead" })),
                span: Type.Optional(num("close-up coverage of the target's longest side, default 0.45")),
                duration: Type.Optional(num("move length, milliseconds, default 900")),
                easing: Type.Optional(str("linear|ease|ease-in|ease-out|spring")),
              }),
            ),
          }),
        ),
      }),
    },
    {
      name: "build",
      description:
        "Place a prop on the backstage plane with finished artwork. Omit x/y and it is put in the middle of whatever the camera currently sees — say where it goes only when you mean a specific corner of the plane. For anything with more than a few shapes prefer stage_script + draw so the clock is not blocked. Pass svg/html/css for a flat drawing, or scene3d to open a live 3-D window on the board (only when the idea is genuinely three-dimensional).",
      parameters: Type.Object({ id: str("stable id"), scene: Type.Optional(str("which board this belongs to; leave it out to keep the prop on the board the show is standing in")), label: str("one line: what this object IS"), ...boxPlaced, note: Type.Optional(str("teaching role")), svg: Type.Optional(str('inline <svg> markup, viewBox fitted to w/h; a <text class="tex"> holding LaTeX is typeset by the stage')), html: Type.Optional(str("HTML/CSS markup")), css: Type.Optional(str("CSS scoped to this prop")), scene3d: Type.Optional(SCENE3D_T) }),
    },
    {
      name: "draw",
      description: "Replace the artwork of an existing prop while keeping its identity, position and history. The partial markup streams onto the stage as you emit it, so draw the important strokes first. Pass svg/html to redraw flat art, or scene3d to give it (or swap) a 3-D window.",
      parameters: Type.Object({ id: str("prop id"), svg: Type.Optional(str('inline <svg>; a <text class="tex"> holding LaTeX is typeset as a real formula by the stage — a hand-written <foreignObject> is dropped as foreign markup')), html: Type.Optional(str("HTML")), css: Type.Optional(str("scoped CSS")), scene3d: Type.Optional(SCENE3D_T) }),
    },
    { name: "move", description: "Change a prop's position or size on the plane (keeps artwork).", parameters: Type.Object({ id: str("prop id"), ...box }) },
    { name: "discard", description: "Take a prop off the stage. It stays in the log and can be recalled.", parameters: Type.Object({ id: str("prop id") }) },
    {
      name: "recall",
      description: "Bring an earlier prop into the current scene WITHOUT redrawing it. This is cross-scene continuity: the learner sees the same object, not a similar one. Use it whenever a previously established object matters again. Without x/y it is placed in the middle of the frame the camera is on.",
      parameters: Type.Object({ id: str("prop id from an earlier scene"), scene: str("destination scene"), ...boxPlaced }),
    },
    { name: "link", description: "Declare a semantic relation between two props. Relations are surfaced to you in stage_state and are what lets a later beat reference an earlier idea.", parameters: Type.Object({ from: str("prop id"), to: str("prop id"), relation: str("e.g. decomposes-into, resultant-of, points-to, contradicts") }) },
    { name: "fetch_prop", description: "Read back a prop's stored artwork and geometry. Prop sources are NOT in your context by default: fetch only what you need.", parameters: Type.Object({ id: str("prop id") }) },
    {
      name: "camera",
      description:
        "Move the viewpoint. You never move the learner's eye by moving artwork — you move the camera. fit frames a set of props/scenes, focus tightens on one, pan slides without zooming, zoom scales, track follows a prop. The plane is unbounded: to open a new line of thought, pan one screen into empty space and build there, leaving the old work half-visible at the edge of the frame — that is what makes this an infinite board instead of a stack of slides.",
      parameters: Type.Object({
        mode: Type.Enum({ fit: "fit", focus: "focus", pan: "pan", zoom: "zoom", track: "track" }),
        target: Type.Optional(Type.Array(str("prop or scene ids"))),
        region: Type.Optional(Type.Object(box, { description: "explicit rect to frame instead of ids" })),
        center: Type.Optional(Type.Object({ x: num("world x"), y: num("world y") }, { description: "for pan" })),
        zoom: Type.Optional(num("for zoom: absolute scale, 1 = the 1600x900 default frame; about 3.5x is as far in as text stays readable, so the board stops there")),
        follow: Type.Optional(str("prop id to keep centred, for track")),
        dir: Type.Optional(Type.Enum({ left: "left", right: "right", up: "up", down: "down" }, { description: "for pan without coordinates: slide the frame this way" })),
        screens: Type.Optional(num("for pan+dir: how far to slide, in fractions of the current frame, default 0.8")),
        at: Type.Optional(
          Type.Object(
            { x: num("0=left edge, 1=right edge of the target's own box"), y: num("0=top, 1=bottom") },
            { description: "close-up on a PART of the target instead of the whole of it: the arrowhead is at x=1 for a rightward arrow, the joint where two vectors meet is their shared corner" },
          ),
        ),
        span: Type.Optional(num("how much of the target's longest side the close-up covers, 0.05..1, default 0.45; no camera closes in past 450 world units of frame width (~3.5x), in any mode, so a tiny prop gets a margin instead of a blow-up")),
        duration: Type.Optional(num("ms, default 900")),
        easing: Type.Optional(str("linear|ease|ease-in|ease-out|spring")),
      }),
    },
    { name: "narrate", description: "Voice-over for a stretch of stage time. Narration is the clock: everything else runs on top of it. Pick how the line shows — caption types along the bottom, verse stages it as a statement in the middle of the board, voice says it and leaves the picture alone.", parameters: Type.Object({ text: str("the line, in the teacher's voice, no stage directions"), seconds: num("duration of this beat — a floor: say the line at a normal pace and if it does not fit, the beat grows instead of the voice"), style: Type.Optional(Type.Enum({ caption: "caption", verse: "verse", voice: "voice" }, { description: "default caption; verse for the one line you want staged, voice when the board already carries the idea and the ear should not be shown text" })) }), },
    { name: "beat", description: "Deliberate silence so a visual lands. Nothing moves.", parameters: Type.Object({ seconds: num("hold duration") }) },
    { name: "transition", description: "Move between scenes with a visible figure. The camera travels to the destination scene's bounds while the veil runs. Props you recalled appear on both sides of it.", parameters: Type.Object({ style: Type.Enum({ dissolve: "dissolve", wipe: "wipe", "match-cut": "match-cut", split: "split" }), to: str("destination scene name"), seconds: Type.Optional(num("default 1.2")) }) },
    { name: "highlight", description: "Draw attention without moving anything: pulse, outline, dim-rest, shake.", parameters: Type.Object({ target: str("prop id"), style: Type.Enum({ pulse: "pulse", outline: "outline", "dim-rest": "dim-rest", shake: "shake" }), seconds: Type.Optional(num("default 1.5")) }) },
    {
      name: "motion",
      description:
        "Make a prop move by itself, for as long as a line is being spoken. The interpreter computes the displacement from stage time and the prop returns to its anchor when the cue ends — you are not relocating it, so the movement replays exactly on rewind and disappears cleanly if the passage is re-performed. oscillate: shakes in place (tension, two forces fighting); approach: starts off-position and settles onto its anchor (arrival, convergence); orbit: circles the anchor (rotation, circular dependence); iterate: hops across `steps` slots then walks back (counting off, enumerating cases); flow: drifts out and back once (a sweep past a range). Prefer this over redrawing frames of an animation.",
      parameters: Type.Object({
        id: str("prop id"),
        mode: Type.Enum({ oscillate: "oscillate", approach: "approach", orbit: "orbit", iterate: "iterate", flow: "flow" }),
        axis: Type.Optional(str("x|y|both, ignored by orbit")),
        amp: Type.Optional(num("displacement in world units, default 90")),
        period: Type.Optional(num("ms per cycle for oscillate/orbit/iterate/flow, default 1600")),
        radius: Type.Optional(num("orbit radius, defaults from amp")),
        steps: Type.Optional(num("iterate: how many slots to visit, default 4")),
        decay: Type.Optional(num("approach: ms to settle, default 700")),
        seconds: Type.Optional(num("default 3")),
      }),
    },
    { name: "ask_learner", description: "Stop the clock and put a real question to the learner. Execution continues only after they answer; the tool result carries their choice, so you branch from it. A learner who types instead of choosing answers in their own words, and you are told that ungraded.", parameters: Type.Object({ prompt: str("the question"), options: Type.Array(str("at least 2 choices")), answer: num("index of the correct choice"), why: Type.Optional(str("said only after they answer")), concept: Type.Optional(str("the single idea this question probes, e.g. 分量只依赖终点。用同样措辞重复它，跨课的反复错过才认得出来")) }) },
    { name: "pause_for", description: "Stop the clock until the learner presses continue. Use after a loaded idea, not after every sentence.", parameters: Type.Object({ reason: str("what the learner should do with this pause") }) },
    { name: "note_progress", description: "Record teaching state (concepts genuinely covered, learner condition). This is written into the system prompt sections, so history stays cache-stable. Call it whenever a concept is actually understood.", parameters: Type.Object({ concepts_covered: Type.Optional(Type.Array(str("short concept names"))), learner_state: Type.Optional(str("one line: where the learner is now")), beats_advanced: Type.Optional(num("how many beats of the plan this turn completed")) }) },
    { name: "stage_state", description: "Read the current stage: clock, camera, scenes, live props with geometry, open questions.", parameters: Type.Object({}) },
  ];

  return { tools, run };
}

export const ART_VERBS = new Set(["build", "draw"]);
