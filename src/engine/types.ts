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
  /** Which board this belongs to. Left out, it lands on the board the show is standing in. */
  scene?: string;
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
  /** The board to bring it onto; the one being stood in when this is left out. */
  scene?: string;
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

/**
 * What the learner actually said, laid on the tape by the stage at the moment he says it.
 *
 * He is the only participant in a lesson whose words used to live outside it: the answer went into a
 * runtime field and vanished, so a shared tape carried every line the teacher spoke and none of what he
 * answered — which is the part a later lesson is staged around. Recording it as an op is what makes the
 * answer replayable, cuttable and re-performable like anything else on the board, and it is what lets a
 * replay know a card has already been answered.
 */
export interface AnswerOp {
  kind: "answer";
  /** `seq` of the gate this answers — the card the clock stopped on, not whichever one it reached first. */
  gate: number;
  text: string;
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
  | PauseOp
  | AnswerOp;

export interface OpEntry {
  seq: number;
  track: TrackId;
  turn: number;
  /**
   * 这一刀属于哪一批落下的一起排定的刀。`OpLog.append()` 每被调一次发一个新号，`turn` 是"导演的一
   * 轮"（一轮里可以有好几次工具调用），这个是"一次工具调用里排完的那一批"—— 解释器里唯一需要往后
   * 看的落点（`here`）只许在这一批里面看，见 `compile.ts` 的 `placementView`。
   *
   * 可以缺：旧版本的分享链接、以及测试里一次 `compile(tape(...))` 排完的带都没有它，缺了就当整卷是
   * 一批 —— 那正是它们当时的行为（一整批一起排，本来就还没有"观众已经看过"这一段）。
   */
  group?: number;
  op: Op;
}

export interface Revision {
  t: number;
  /**
   * 这一次外观被 `discard` 撤下的那一刻；`undefined` 就是到带子尽头还站着。
   *
   * 它和 `Cue.end` 是同一件东西：一次外观是一段窗口，不是一个会被后一刀覆盖的状态。以前道具身上只挂
   * 一个 `discardedAt` 数，所以"撤下 → 重画 → 再撤下"只剩最后那一刀，倒带回到第一刀之前的人看见一件
   * 早就撤掉的东西又站回台上。
   */
  off?: number;
  /** Which board this revision was laid down on. The prop's `scene` is where it ended up; this is where
   * it was at this moment — so a recall into a later scene cannot erase the prop from the scene before it. */
  scene: string;
  box: Box;
  svg?: string;
  html?: string;
  css?: string;
  scene3d?: Scene3DSpec;
  label: string;
  note?: string;
  partial: boolean;
}

/**
 * 一次 `link`：导演在带子上某一刀落下的关系。
 *
 * `at` 是它落下的那一刻。以前这一格只存 `to` 和 `relation`，于是 `link` 是这张表上唯一**没有时刻**
 * 的账：`agentSnapshot` 在任何 `t` 都把它读成"已经声明过了"。倒带回到那一刀之前，快照照样报出那条
 * 关系，而它指着的那个名字此刻还没上台。一次外观是一段窗口，一条 cue 是一段窗口，一条关系也是
 * 一个时刻 —— 词汇里不该有第四种说法。
 */
export interface Link {
  at: number;
  to: string;
  relation: string;
}

export interface Prop {
  id: string;
  scene: string;
  /** 落下顺序，也是层叠顺序。时间上单调：一次外观总在它身后那一次之前。 */
  revisions: Revision[];
  /** 带子上的次序，所以 `at` 递增："到这一刻为止声明了哪些关系"是这一列的一段前缀。 */
  links: Link[];
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
  /** What the learner actually said for this card, read off the tape; null while it is still an open question. */
  said: string | null;
  /** End of the beat that asked it. His words belong to that beat: shown while the playhead is inside it, and nothing after. */
  until: number;
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
  /**
   * 每一刀镜头落在哪一刻，按 op 引用问。
   *
   * 问这句的是"镜头点名的东西观众看不看得见"那一头：观众看不见时它要的是**找不到**，而以前那句写成
   * `cues.find((c) => c.op === askedBy)` —— 找不到就把整张 cue 表走完，每一刀付一次（128 000 条的带子
   * 点一次空名字 1.17ms，命中同一个数，而导演一轮要点几十次名）。带子只增不改，这一问在排好的那一刻
   * 就该有答案。按引用问靠的是 `guard.revise` 那条"改不动就不换对象"的规矩（`guard.ts`），所以只有
   * 真的被修过的那一刀才会换了它的 `t`。只记会点名的那一类刀：别的读者问的是时刻，不是刀。
   */
  shotAt: Map<CameraOp, number>;
}
