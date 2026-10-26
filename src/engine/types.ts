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

/**
 * 舞台的气氛：布光与背景，不是内容。板还是那块板、道具还在原处、镜头一个字不用动——变的只是
 * 台下的光。`board` 是黑板本相；`study` 深夜书房、`space` 深空、`lab` 实验室是三副定好的灯。
 * 一场一个气氛，别中途换来换去（和换场是两回事：`transition` 换板，`scene` 只换灯）。
 */
export type Mood = "board" | "study" | "space" | "lab";

export interface SceneOp {
  kind: "scene";
  mood: Mood;
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
 * 一张"指认"卡：和 quiz 同一张停表的卡，但学习者不是读一串文字选项，而是**直接在台上点他说的那个图形**。
 *
 * 智能 UI（OpenAI，2026-10）把回答做成可点选的界面元素："理解一个概念，最好用一张可选中部件的交互图"。
 * 这门课的媒介本来就是一块无界的板 —— 问到"哪个是合力"时，让他读"箭头甲/箭头乙"再选一个，等于把板上
 * 明明摆在那里的箭头又抄成了文字。`probe` 于是把答案从卡里搬回台上：`targets` 是此刻站着的几件道具，
 * 时钟停住时它们在板上变成可点；学习者点中哪一件，哪一件的 id 就作为一句 `answer` 落在带上。
 *
 * 它和 quiz 共用同一本账（停表、`waitForGate`、作答落带可重放、按 `concept` 记反复错过），唯一的差别是
 * **答案是一个道具 id，不是选项下标**。所以 `answer` 是道具 id，不是数字；判分比的是 id。
 */
export interface ProbeOp {
  kind: "probe";
  prompt: string;
  /** The props on stage the learner may tap. 2..6; each must be standing when this lands. */
  targets: string[];
  /** The prop id that is correct — graded by id, not by option index. */
  answer: string;
  why?: string;
  concept?: string;
}

/**
 * 一张"拨杆"卡：和 quiz / probe 同一张停表的卡，但学习者既不读文字选项，也不在台上点一个现成的形状 ——
 * 他在一段 `[min, max]` 上**自己拨出一个数**。
 *
 * Intelligent UI（OpenAI，2026-10）把回答做成可拨的界面元素："一个解释，最好用一张能上手拨的交互图"、
 * 随附可操作的计算器。这门课里，凡是问"多重 / 多长 / 多快 / 多大角度"的题，选项（quiz）是让他认一个现成
 * 的答案，台上点形状（probe）是让他认一个现成的图形 —— 都在考"认得"。而"先拨一个你猜的值，再看答案"
 * 考的是**估**：那才是物理直觉真的所在。所以第三张卡是一根杆，不是第三串选项。
 *
 * 它和 quiz / probe 共用同一本账（停表、`waitForGate`、作答落带可重放、按 `concept` 记反复错过），唯一的
 * 差别是**答案是一个数，按距离判**：`|他拨的值 - value| <= tol` 算对。杆本身是舞台自己渲染的原生
 * `<input type="range">`（不是模型交的 markup，所以 DOMPurify 那道信任边界一个字都不用改）；他拨的那一下
 * 不进带子 —— 落带的只有他**按下确认**那一刻的那个数，和 probe 落带一个 id 是同一件事。
 */
export interface DialOp {
  kind: "dial";
  prompt: string;
  /** The range the learner may set. `min < max`; the door swaps / widens an inverted pair rather than printing a broken card. */
  min: number;
  max: number;
  /** The correct value, graded continuously by distance. Clamped into [min, max] by the door. */
  value: number;
  /** Absolute tolerance: `|his - value| <= tol` is correct. 0 means "exactly". */
  tol: number;
  /** Unit shown next to the readout, e.g. "Hz" / "m/s" / "°". Display only; the tape carries the bare number. */
  unit?: string;
  /** A short caption above the slider, e.g. "频率". Display only. */
  label?: string;
  why?: string;
  concept?: string;
}

/**
 * 一张"落字"卡：和 quiz / probe / dial 同一张停表的卡，但学习者要的不是选一项、指一物、拨一数 ——
 * 他要在一个空格里**打出那几个字**。
 *
 * Intelligent UI（OpenAI，2026-10）的界面元素里有一类是 forms：文本输入。前三张卡把"认得"考到头了
 * （读选项 quiz、指图形 probe、数量感 dial），但有些问题的答案不是一个能认的东西，而是**必须由他
 * 自己说出来的那个术语**："用一句话说清楚什么是导数""这两个力为什么不平衡"。他在底下 console 里
 * 自由打字，按仓库的老规矩那永远是"未分级的证据"——导演接得到他的话，却没有一句"这一句里有没有那个
 * 必须出现的词"。`type` 于是把这个空格搬到卡上：他打的那句话原样作为 `answer` 落带，判分比的是
 * **那句话里有没有 `accept` 要求的每一个词**（大小写无关）——不是改卷，是查"该出现的术语出现了没"。
 *
 * `avoid` 是这门课上反复出现的错词：他打的话里带了任何一个，导演就被点名"他栽在这个常见误解上"，
 * 而不是笼统的"答错了"。自由发挥、没打到要求的词，仍是他的原话递回导演，不替他宣布对错。
 */
export interface TypeOp {
  kind: "type";
  prompt: string;
  /** The words he MUST say, all of them, case-insensitively. A fill-in is one; a one-sentence explanation can be two or three. */
  accept: string[];
  /** Words/phrases whose presence flags a known misconception — surfaced to the director, not graded wrong by themselves. */
  avoid?: string[];
  /** Placeholder inside the input box. */
  placeholder?: string;
  why?: string;
  concept?: string;
}

/**
 * 一张"搬动"卡：和 quiz / probe / dial / type 同一张停表的卡，但学习者不读文字、不点现成形状、不拨一根
 * 杆、不打字 —— 他**亲手把台上的一件道具搬到某个位置**，落带的答案是他放下并确认的那个位置。
 *
 * Intelligent UI（OpenAI，2026-10）的界面元素清单里有一类是 charts / editable charts —— 能上手直接
 * 操纵的交互图，不只是可点选的部件（probe）或可拨的参数（dial）。这台仓库的媒介本来就是一块无界的板：
 * 问"把箭头 b 的头接到箭头 a 的头上""把这块石头滚到谷底"—— 选项、指物、拨数、打字都考不到"他会不会
 * 亲手做这件事"。`drag` 于是把答案从卡里搬回台上：时钟停住时，被点名的道具自己变成可搬的，他把它
 * 拖到目标位置、确认，**他确认的那一刻那个位置**作为一句 `answer` 落在带上（文本形如 "x,y"，世界单位、
 * 四舍五入到整数，指的是道具**中心**的位置）。
 *
 * 搬动过程中的位置是学习者状态，**不进带子** —— 和 3D `interactive` 的拖动角度是同一句（README 已知
 * 边界）；确认落带后，道具回到它的锚点（带子上唯一的位置），重放时它从头到尾没有动过。判分按距离：
 * `|他放的位置 - value| <= tol` 算对。
 */
export interface DragOp {
  kind: "drag";
  prompt: string;
  /** The prop he must move on the board — must be standing (on stage, not swept) when this lands. */
  prop: string;
  /** The target CENTRE position in world units — where his prop's centre should end up. */
  value: { x: number; y: number };
  /** Absolute tolerance in world units: distance(centre, value) <= tol counts as correct. 0 means "exactly". */
  tol: number;
  why?: string;
  concept?: string;
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

/**
 * The sixth interaction, and the one Intelligent UI calls "Actions / issueNewTurn": a button the
 * interface renders whose click sends a composed message, *stored exactly like a typed one, with
 * nothing marking it as coming from the interface*. Here the DIRECTOR authors the button: `label` is
 * what the learner reads, `phrase` is what gets sent down the same path as typing it in the console.
 *
 * It is deliberately NOT a gate: it never stops the clock, never opens a question, and is never graded.
 * It is a door the director opens with his own words — the escape hatches are the two fixed doors,
 * this is the director's own door. The audience renders it from the moment the playhead reaches it
 * (live: clickable; replay: a static chip, because a recording asks no one).
 */
export interface OfferOp {
  kind: "offer";
  /** The button text the learner reads, short, in his own voice. */
  label: string;
  /** Exactly what is sent when clicked — written as the learner's own words. */
  phrase: string;
  /** Why this door is here, for the director's own record. */
  why?: string;
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
  | ProbeOp
  | DialOp
  | TypeOp
  | DragOp
  | PauseOp
  | OfferOp
  | AnswerOp
  | SceneOp;

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

/**
 * 「台面的哪一格动过」的一笔，按发生的次序记进 `Compiled.touched`，只长尾巴。
 *
 * 一次外观的事实会在身后的刀上被改：落下新格时上一格的窗口收在这一刻（`layRevision`）、`discard` 给
 * 此刻站着的那一格补上结束时刻（`markOff`）、迟到的补画把最后一格**原地换掉**（`build` 的空框由 `patch`
 * 填上）。这三处都不加长道具表、也不加长那一列，只改躺在**那一列尾巴上**的一格 —— 除了最后一格，每一格
 * 的 `off` 早在它身后那一格落笔时就定下了。所以光读"道具表长出来的那一截"看不见它们，而"每批重扫整张
 * 道具表去找哪一格被改过"恰恰是要消掉的那笔价钱。
 *
 * 于是由**知道改动的那一方**记一笔：解释器走到哪一笔就接一笔，读台面那一头（`StandingIndex`）只吸收新
 * 接的尾巴。四种：
 *  - `prop`：这个名字刚进道具表（`build` 第一次落下的名字、`link` 只点了名）。层叠次序数的是道具在表里
 *    的位置，所以号由这一笔记下。
 *  - `lay`：落下新格（`build`、非占位的 `patch`、`recall`）。
 *  - `close`：某一格的窗口被身后那一刀收上了 `off`（`markOff` 那一笔、`layRevision` 顺手收上一格那一笔）。
 *  - `fill`：占位符被原地换掉 —— 落笔时刻与窗口都不变，换的是那一格的对象（内容、所在的板）。
 *
 * 为什么是"哪一格动了"而不是"现在的台面长什么样"：一笔动过的格子，它的时刻就是**这一笔落下的那一刻**
 * （`layRevision` 把上一格收在新格的落笔时刻、`markOff` 收在 `discard` 那一刻、`fill` 不带时刻），所以
 * 顺着这一列往下读，读到的时刻序列和不带这一列、每批重扫整张道具表算出来的序列同序。反过来若让续排去
 * **读那一格现在的 `off`**，同一批里身后那一刀补上的值会先被读到 —— 事件流当场不再单调，游标的前提破产。
 *
 * 一条规矩钉在这里：**会动台面事实的每一笔都得记**。新增一种改法忘了接上，续排的就读不到它 —— 逐批
 * 续排和"拿这一批为止的台面现建一本"对账钉的就是这句话。
 */
export type Touched =
  | { kind: "prop"; prop: Prop }
  | { kind: "lay"; prop: Prop; rev: Revision }
  | { kind: "close"; prop: Prop; rev: Revision }
  | { kind: "fill"; prop: Prop; old: Revision; rev: Revision };

export interface Cue {
  t: number;
  end: number;
  op: CameraOp | NarrateOp | TransitionOp | HighlightOp | MotionOp | BeatOp;
  from: Box;
  to: Box;
}

/** One door the director opened: the offer becomes available when the playhead reaches `t` and stays open until clicked (live) or for the whole replay (static). */
export interface OfferView {
  t: number;
  /** The op's own seq, so the audience can tell one door from another (and a clicked door from an unclicked one). */
  seq: number;
  label: string;
  phrase: string;
}

export interface Gate {
  t: number;
  seq: number;
  kind: "quiz" | "pause-for" | "probe" | "dial" | "type" | "drag";
  op: QuizOp | ProbeOp | DialOp | TypeOp | DragOp | PauseOp;
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
  /** Doors the director opened, in tape order: `{t, seq, label, phrase}` — see `OfferView`. */
  offers: OfferView[];
  /**
   * 换过几次灯，按落刀时刻只长尾巴：`{t, mood}`。`scene` 不定板、不占时钟，所以它不进 cue 表——
   * "这一刻台上是哪个气氛"这一问，读的就是这本账（`TapeIndex.moodAt`）。
   */
  moodFlips: { t: number; mood: Mood }[];
  duration: number;
  lastSeq: number;
  /**
   * 动过台面的那些道具，按发生的次序、只长尾巴。见 `Touched`。
   */
  touched: Touched[];
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
  /**
   * 带子尽头这一刻的节奏：问过几道题、上一问落在哪、最后一句话讲到哪。见 `engine/pace.ts`。
   *
   * 三个数都是**落笔时顺手记的游标**，不是每问一次扫一遍表得来的：问"两问之间有没有一句旁白"以前要从
   * 带子尽头往回走，走过多少张卡就付多少格，而它正是导演每问一句都要问一次的那一问。带子只增不改，
   * 这三个数也就只往前走 —— 和 `shotAt` 同一条理由：这一问在排好的那一刻就有答案。
   *
   * `pause_for` 不算题（和 `scoreOf` 同一句）：那是"继续"的门，不是考题。所以「问 → 让他按继续 →
   * 立刻再问」仍然是连问，而「问 → 讲一句 → 按继续 → 再问」不是。
   */
  asked: number;
  /** 上一道**题**落在哪一刻；-1 = 还没问过。 */
  lastAskAt: number;
  /** 最后一句旁白讲到哪一刻（带子尽头，不是播放头）；0 = 还没讲过一句。 */
  lastLineEnd: number;
}
