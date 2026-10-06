export type TrackId = string;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Ease = "linear" | "ease" | "ease-in" | "ease-out" | "spring";

export type Vec3 = [number, number, number];

/** One solid / drawing in the 3-D window. `shape` picks which of the numeric fields mean anything. */
export interface Prim3 {
  shape: "box" | "sphere" | "cylinder" | "cone" | "torus" | "plane" | "line" | "arrow";
  /** Half-extents for box; otherwise a single overall size the interpreter reads per shape. */
  size?: number;
  radius?: number;
  /** torus tube, or a cylinder/cone's top radius when it should taper. */
  radius2?: number;
  height?: number;
  /** line/arrow only: the segment endpoints, in the same units as `pos`. */
  from?: Vec3;
  to?: Vec3;
  pos?: Vec3;
  /** Euler angles in degrees, applied XYZ. */
  rot?: Vec3;
  color?: string;
  wireframe?: boolean;
  opacity?: number;
  /** A floating label rendered as a sprite at `pos`. The one text the 3-D window shows. */
  label?: string;
}

/** Where the eye sits inside the window. Absent → the interpreter frames the primitives itself. */
export interface Cam3 {
  pos?: Vec3;
  look?: Vec3;
  fov?: number;
}

/** Deterministic self-rotation: the angle is a pure function of stage time, so it replays. */
export interface Spin3 {
  axis?: "x" | "y" | "z";
  degPerSec?: number;
}

/**
 * A prop whose surface is a live 3-D scene instead of flat markup. It is data, not code: the
 * interpreter owns the three.js, the director only names primitives — so this keeps the no-JS-sandbox
 * rule and still serializes into the log (a shared/replayed lesson carries its own 3-D shot). The
 * one thing a shared tape cannot carry is `interactive`'s hand-dragged angle, which is learner state.
 */
export interface Scene3DSpec {
  prims: Prim3[];
  camera?: Cam3;
  spin?: Spin3;
  /** Opt-in: let the learner drag to orbit. Rotation then lives outside the log and is not replayed. */
  interactive?: boolean;
  grid?: boolean;
  axes?: boolean;
  background?: string;
}

export interface BuildOp {
  kind: "build";
  id: string;
  scene: string;
  box: Box;
  /** Asked for no coordinates: the interpreter centres it in whatever the camera sees (box x/y are placeholders then). */
  here?: boolean;
  label: string;
  note?: string;
  svg?: string;
  html?: string;
  css?: string;
  scene3d?: Scene3DSpec;
}

export interface PatchOp {
  kind: "patch";
  id: string;
  scene?: string;
  svg?: string;
  html?: string;
  css?: string;
  scene3d?: Scene3DSpec;
  box?: Box;
  label?: string;
}

export interface DiscardOp {
  kind: "discard";
  id: string;
}

export interface LinkOp {
  kind: "link";
  from: string;
  to: string;
  relation: string;
}

export interface RecallOp {
  kind: "recall";
  id: string;
  scene: string;
  box: Box;
  /** Same rule as build: no coordinates given, so land it inside the current frame. */
  here?: boolean;
}

export type CameraMode = "fit" | "focus" | "pan" | "zoom" | "track";

export interface CameraOp {
  kind: "camera";
  mode: CameraMode;
  target?: string | string[];
  region?: Box;
  center?: { x: number; y: number };
  zoom?: number;
  follow?: string;
  /** Slide without changing distance: the plane moves under the viewer, not the content. */
  dir?: "left" | "right" | "up" | "down";
  /** How far to slide, in fractions of the current frame. Defaults to 0.8 so old work stays half-visible. */
  screens?: number;
  /** A point inside the target's box as fractions (0..1), e.g. {x:1,y:0.5} is the right edge's middle. */
  at?: { x: number; y: number };
  /** Close-up width as a fraction of the target's longest side. Defaults to 0.35. */
  span?: number;
  duration: number;
  easing: Ease;
}

export interface BeatOp {
  kind: "beat";
  duration: number;
}

/** How the line shows while it is on the clock: typed caption, staged verse, or voice only. */
export type NarrationStyle = "caption" | "verse" | "voice";

export interface NarrateOp {
  kind: "narrate";
  text: string;
  duration: number;
  style?: NarrationStyle;
}

export type TransitionStyle = "dissolve" | "wipe" | "match-cut" | "split";

export interface TransitionOp {
  kind: "transition";
  style: TransitionStyle;
  to: string;
  duration: number;
}

export interface HighlightOp {
  kind: "highlight";
  target: string;
  style: "pulse" | "outline" | "dim-rest" | "shake";
  duration: number;
}

export type MotionMode = "oscillate" | "approach" | "orbit" | "iterate" | "flow";

/**
 * Motion the interpreter computes from stage time, not markup the model streams: a prop is
 * displaced as a pure function of `t`, so the movement replays identically and can be cut.
 */
export interface MotionOp {
  kind: "motion";
  id: string;
  mode: MotionMode;
  axis: "x" | "y" | "both";
  amp: number;
  period: number;
  radius: number;
  steps: number;
  decay: number;
  duration: number;
}

export interface QuizOp {
  kind: "quiz";
  prompt: string;
  options: string[];
  answer: number;
  why?: string;
  /** The one idea the question is really probing. The archive counts misses by it, so a misconception that survives three different wordings stops being three unrelated wrong answers. */
  concept?: string;
}

export interface PauseOp {
  kind: "pause-for";
  reason: string;
}

export type Op =
  | BuildOp
  | PatchOp
  | DiscardOp
  | LinkOp
  | RecallOp
  | CameraOp
  | BeatOp
  | NarrateOp
  | TransitionOp
  | HighlightOp
  | MotionOp
  | QuizOp
  | PauseOp;

export interface OpEntry {
  seq: number;
  track: TrackId;
  turn: number;
  op: Op;
}

export interface Revision {
  t: number;
  box: Box;
  svg?: string;
  html?: string;
  css?: string;
  scene3d?: Scene3DSpec;
  label: string;
  note?: string;
  partial: boolean;
}

export interface Prop {
  id: string;
  scene: string;
  revisions: Revision[];
  discardedAt?: number;
  links: { to: string; relation: string }[];
}

export interface Cue {
  t: number;
  end: number;
  op: CameraOp | NarrateOp | TransitionOp | HighlightOp | MotionOp | BeatOp;
  from: Box;
  to: Box;
}

export interface Gate {
  t: number;
  seq: number;
  kind: "quiz" | "pause-for";
  op: QuizOp | PauseOp;
}

export interface CameraPose {
  cx: number;
  cy: number;
  scale: number;
}

/** One director turn on the main track: the unit a re-performance starts from. */
export interface Beat {
  turn: number;
  start: number;
  end: number;
  headline: string;
  verbs: string[];
  seqs: number[];
  gate: boolean;
}

export interface Compiled {
  props: Map<string, Prop>;
  scenes: Map<string, Box>;
  cues: Cue[];
  gates: Gate[];
  beats: Beat[];
  duration: number;
  lastSeq: number;
}
