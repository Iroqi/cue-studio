import { compile, ownsTime } from "./compile";
import { MAIN_TRACK, OpLog } from "./log";
import { displaced, motionOffset } from "./motion";
import { SETTLE_MS } from "./speech";
import type { Box, Compiled, Cue, Gate, MotionOp, Op, OpEntry, Prop, Revision, Scene3DSpec, TrackId } from "./types";

/** A cut the clock has already walked through the veil of. */
type Cut = { flip: number; board: string };

export interface VisibleProp {
  id: string;
  scene: string;
  box: Box;
  svg?: string;
  html?: string;
  css?: string;
  scene3d?: Scene3DSpec;
  label: string;
  note?: string;
  /** Nothing has been drawn into this frame yet — an empty frame, not a half-finished picture. */
  draft: boolean;
  /** A paint for this frame is in flight and it still shows nothing: the one frame worth marking. */
  awaiting: boolean;
  highlight?: string;
}

export interface RenderState {
  t: number;
  duration: number;
  rect: Box;
  viewport: { w: number; h: number };
  props: VisibleProp[];
  narration: { text: string; progress: number; reveal: number; duration: number; style: string } | null;
  veil: { style: string; progress: number } | null;
  gate: Gate | null;
  /** His own words for the card the playhead is standing in. On the tape, so a shared or replayed lesson carries the dialogue and not only the lecture. */
  said: string | null;
  playing: boolean;
  finished: boolean;
  track: TrackId;
  live: boolean;
  /** Frames the current beat promised and the models have not handed over yet. */
  artOwed: number;
  /** The clock is standing still because the picture under it isn't there yet. */
  artWait: boolean;
  /** A question a director turn is blocked on, even if the clock has not reached its card yet. */
  askedGate: number | null;
}

const EASES: Record<string, (p: number) => number> = {
  linear: (p) => p,
  ease: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
  "ease-in": (p) => p * p,
  "ease-out": (p) => 1 - (1 - p) * (1 - p),
  spring: (p) => 1 - Math.pow(1 - p, 3) * Math.cos(p * Math.PI * 1.2),
};

function lerpBox(a: Box, b: Box, p: number): Box {
  return {
    x: a.x + (b.x - a.x) * p,
    y: a.y + (b.y - a.y) * p,
    w: a.w + (b.w - a.w) * p,
    h: a.h + (b.h - a.h) * p,
  };
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Anything a shadow root or a WebGL window can paint. A box with only a label and a css block is an empty frame. */
function painted(r: { svg?: string; html?: string; scene3d?: Scene3DSpec }): boolean {
  return !!(r.svg || r.html || r.scene3d);
}

export class Stage {
  readonly log = new OpLog();
  private compiledMain: Compiled = compile([]);
  private compiledAside: Compiled | null = null;
  private preview = new Map<string, { box: Box; svg?: string; html?: string; css?: string; label: string; scene: string }>();
  private listeners = new Set<() => void>();
  private snapshot: RenderState;
  private raf = 0;
  private last = 0;
  private speed = 1;

  t = 0;
  playing = false;
  live = true;
  track: TrackId = MAIN_TRACK;
  asideResume: { track: TrackId; t: number } | null = null;
  /** Frames a paint is in flight for. A frame they will fill is not delivered until it lands. */
  private artFor = new Set<string>();
  /** Paints dispatched to run in the background. Their frames are owed even once the turn has moved on. */
  private painting = new Set<string>();
  /** A director or painter turn is in flight: the empty frames it scheduled are still expected. */
  private turnOpen = false;
  /** Parked on a learner gate: nothing on the tape is owed, or the card the turn waits on is unreachable. */
  private debtSuspended = false;
  private owed = 0;
  /** Debt that refused the last step: the clock parks a frame short of a beat edge, where the beat under the playhead reads nothing. */
  private blockedBy = 0;
  private artWait = false;
  private rect: Box = { x: 0, y: 0, w: 1600, h: 900 };
  private camFrom: Box | null = null;
  private camFromAt = -1;

  constructor() {
    this.snapshot = this.render();
    this.tick = this.tick.bind(this);
  }

  subscribe = (cb: () => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getSnapshot = () => this.snapshot;

  private emit() {
    this.snapshot = this.render();
    for (const l of this.listeners) l();
  }

  recompile() {
    this.compiledMain = compile(this.log.ofTrack(MAIN_TRACK));
    const aside = this.log.asides()[this.log.asides().length - 1];
    this.compiledAside = aside ? compile(this.log.ofTrack(aside)) : null;
    this.emit();
  }

  reset() {
    this.log.clear();
    this.preview.clear();
    this.pending.clear();
    this.track = MAIN_TRACK;
    this.asideResume = null;
    this.t = 0;
    this.live = true;
    this.artFor.clear();
    this.painting.clear();
    this.turnOpen = false;
    this.blockedBy = 0;
    this.recompile();
  }

  load(entries: OpEntry[]) {
    this.reset();
    this.log.restore(entries);
    this.t = 0;
    this.live = false;
    this.hold();
    this.recompile();
  }

  get compiled(): Compiled {
    return this.track === MAIN_TRACK || !this.compiledAside ? this.compiledMain : this.compiledAside;
  }

  append(ops: Op[], track: TrackId = this.track): OpEntry[] {
    const added = this.log.append(ops, track);
    this.recompile();
    return added;
  }

  /** The tape head: transient partial visuals while the model is still emitting them. */
  setPreview(id: string, patch: Partial<{ box: Box; svg: string; html: string; css: string; label: string; scene: string }>) {
    const cur = this.preview.get(id) ?? { box: { x: 0, y: 0, w: 200, h: 200 }, label: id, scene: "default" };
    this.preview.set(id, { ...cur, ...patch } as typeof cur);
    this.beginArt(id);
  }

  clearPreview(id: string) {
    const had = this.preview.delete(id);
    const flying = this.artFor.delete(id);
    if (had || flying) this.emit();
  }

  /**
   * A paint has been asked for. `beginArt` must be matched by `endArt` on every path — the loop runs
   * it in a `finally` — because an id left in flight is a clock that waits on a paint forever.
   */
  beginArt(id: string) {
    this.artFor.add(id);
    this.emit();
  }

  endArt(id: string) {
    if (this.artFor.delete(id)) this.emit();
  }

  /**
   * A paint dispatched to run in the background: its frame is owed until it lands, whoever is
   * working on the tape head when it does. `beginPaint` must be matched by `endPaint` on every
   * path out — delivered, failed, or cancelled — for the same reason `beginArt` must be.
   */
  beginPaint(id: string) {
    this.painting.add(id);
    this.emit();
  }

  endPaint(id: string) {
    if (this.painting.delete(id)) this.emit();
  }

  /** The teacher's turn owns the debt: while it is open, an empty frame is a frame still expected. */
  setTurnOpen(on: boolean) {
    if (this.turnOpen === on) return;
    this.turnOpen = on;
    this.emit();
  }

  /**
   * Called in every debt a turn holds — including background paints, which outlive the turn that
   * dispatched them. A director parked on a question cannot pay art debt, and a beat that owes a
   * frame would hold the clock short of the very card it is waiting for. Nothing is abandoned by
   * this: the debt is re-billed on resume, and delivered art lands on the tape regardless.
   */
  setDebtSuspended(on: boolean) {
    if (this.debtSuspended === on) return;
    this.debtSuspended = on;
    this.emit();
  }

  play() {
    if (this.playing) return;
    this.playing = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
    this.emit();
  }

  hold() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.emit();
  }

  toggle() {
    if (this.playing) this.hold();
    else this.play();
  }

  setSpeed(x: number) {
    this.speed = x;
    this.emit();
  }

  getRate() {
    return this.speed;
  }

  seek(t: number) {
    this.t = Math.max(0, Math.min(t, this.compiled.duration));
    this.camFrom = null;
    this.blockedBy = 0;
    this.live = false;
    this.emit();
  }

  goLive() {
    this.live = true;
    this.t = this.compiled.duration;
    this.emit();
  }

  /** Rewind to the previous beat boundary so an interrupted passage can be re-played. */
  rewindToBeatStart(within = 4000) {
    const beats = this.compiled.cues.filter((c) => c.op.kind === "narrate" || c.op.kind === "beat");
    const prev = [...beats].reverse().find((c) => c.t < this.t - 200 && this.t - c.t <= within);
    this.seek(prev ? prev.t : Math.max(0, this.t - within));
    this.play();
  }

  /**
   * Stand the clock at the edge of a cut. Everything from `seq` onward is forgotten on every
   * track, and the stage lands exactly where that op would have appeared — so the director can
   * re-perform the passage instead of appending to it. His answers on the cut passage go back with it:
   * they are ops now, not bookkeeping, so there is nothing here to keep in step.
   */
  rerollFrom(seq: number): number {
    this.log.cutFrom(seq);
    this.preview.clear();
    this.track = MAIN_TRACK;
    this.asideResume = null;
    this.camFrom = null;
    this.live = true;
    this.recompile();
    this.t = this.compiledMain.duration;
    this.play();
    return this.t;
  }

  beginAside() {
    this.asideResume = { track: MAIN_TRACK, t: this.t };
    this.track = `aside:${this.log.asides().length + 1}`;
    this.t = 0;
    this.camFrom = null;
    this.live = true;
    this.playing = false;
    this.emit();
    return this.track;
  }

  endAside() {
    const resume = this.asideResume;
    this.track = MAIN_TRACK;
    this.asideResume = null;
    this.recompile();
    if (resume) {
      this.t = resume.t;
      this.camFrom = null;
      this.live = false;
    }
    this.play();
    this.emit();
  }

  /**
   * Take the learner's answer and put it on the tape.
   *
   * `seq` names the card the director's turn is blocked on; the card under the playhead is the fallback
   * for a learner who answers without a turn waiting. The parked card has to win, because the clock can
   * still be walking toward it — a director who queued two questions in one turn is parked on the second
   * while the first sits open under the playhead, and answering whichever arrived first strands the
   * promise the turn is actually waiting on.
   */
  answerGate(value: string, seq?: number) {
    const parked = seq !== undefined ? this.compiled.gates.find((g) => g.seq === seq && g.said === null) : undefined;
    const gate = parked ?? this.currentGate() ?? undefined;
    if (!gate) return;
    this.append([{ kind: "answer", gate: gate.seq, text: value }]);
    this.pending.get(gate.seq)?.resolve(value);
    this.pending.delete(gate.seq);
    this.play();
    this.emit();
  }

  /** The director's turn blocks here until a real learner answers. */
  waitForGate(seq: number): Promise<string> {
    const waiting = new Promise<string>((resolve) => this.pending.set(seq, { resolve }));
    // The host builds its button out of this snapshot, so a question a turn is blocked on has to be in
    // it even before the clock reaches the card — otherwise the button promises an interruption and
    // delivers an answer.
    this.emit();
    return waiting;
  }

  private pending = new Map<number, { resolve: (v: string) => void }>();

  openGateSeqs(): number[] {
    return this.compiled.gates.filter((g) => g.said === null).map((g) => g.seq);
  }

  /**
   * The card the playhead is standing in. An open question wins; otherwise the card whose own beat is
   * still on screen — his answer shows for that beat and then goes away, because it belonged to the
   * moment he was asked, not to the rest of the lesson.
   */
  private cardAt(t: number): Gate | null {
    const reached = this.compiled.gates.filter((g) => g.t <= t);
    return reached.find((g) => g.said === null) ?? [...reached].reverse().find((g) => g.said !== null && t < g.until) ?? null;
  }

  /**
   * The question to stop the clock on, if the show is performing live.
   *
   * A recording never asks again. The answer is on the tape or it isn't, and either way the person
   * opening the link is watching, not learning: holding the clock on a card whose learner is elsewhere
   * turns a replay into a lesson with nobody in it. Press 接着说 and the board goes live from there,
   * which is the way to actually take the course.
   */
  currentGate(): Gate | null {
    if (!this.live) return null;
    const card = this.cardAt(this.t);
    return card && card.said === null ? card : null;
  }

  /** First gate not yet reached by the clock and not yet answered. */
  nextGate(): Gate | null {
    return this.compiled.gates.find((g) => g.said === null) ?? null;
  }

  /**
   * How many pictures the beat under the playhead is owed: an empty frame scheduled inside it, or a
   * paint still in flight for a frame of it. A streaming drawing is NOT delivery — the tape head has
   * to finish before the line that describes it can start, which is what let captions run ahead.
   * An empty frame from a beat already read is not owed any more: a frame the director walked away
   * from must not park the clock forever — unless a paint was dispatched for it, which is owed no
   * matter whose turn is open, because it is the background pipeline that keeps the clock running.
   */
  private owedAt(t: number): number {
    if (!this.live || this.debtSuspended) return 0;
    if (!this.turnOpen && this.artFor.size === 0 && this.painting.size === 0) return 0;
    let start = t;
    let end = t;
    for (const c of this.compiled.cues) {
      if (c.t > t) break;
      if (!ownsTime(c.op) || c.end <= t) continue;
      start = c.t;
      end = c.end;
    }
    // Half-open: a frame laid down at the exact millisecond this beat ends belongs to the NEXT beat,
    // so it must not bill the line still being spoken. Inclusive here parked a caption mid-sentence.
    const inThisBeat = (at: number) => at >= start && at < end;
    // A frame is only owed to the beat the clock is standing in: one pre-staged on the board the show
    // is walking onto belongs to the beats after the cut, not to the line being spoken now.
    const cut = this.cutAt(t);
    let n = 0;
    for (const p of this.compiled.props.values()) {
      if (p.discardedAt !== undefined && p.discardedAt <= t) continue;
      const onStage = p.revisions.filter((r) => r.t <= t);
      if (onStage.length === 0) continue;
      const rev = onStage[onStage.length - 1];
      if (this.swept(rev, cut)) continue;
      if (!painted(rev) && inThisBeat(rev.t) && (this.turnOpen || !this.painting.has(p.id))) n++;
    }
    for (const id of this.artFor) {
      const p = this.compiled.props.get(id);
      const rev = p?.revisions[p.revisions.length - 1];
      // A frame being drawn that has not reached the tape is being made for right now.
      if (!rev || inThisBeat(rev.t)) n++;
    }
    for (const id of this.painting) {
      if (this.turnOpen || this.artFor.has(id)) continue; // already billed by the loops above
      const p = this.compiled.props.get(id);
      const rev = p?.revisions[p.revisions.length - 1];
      // A background paint is owed to the beat it was placed in; a beat not reached yet bills
      // nothing here, or the clock would stand still for art belonging to a later line.
      if (!rev || (inThisBeat(rev.t) && !painted(rev))) n++;
    }
    return n;
  }

  private tick(now: number) {
    const dt = (now - this.last) * this.speed;
    this.last = now;
    const dur = this.compiled.duration;
    const next = Math.min(this.t + dt, dur);
    // Standing still is not holding: `playing` stays on and the rAF keeps re-arming, so the frame
    // after the artwork lands the clock picks up by itself.
    const owedNext = this.owedAt(next);
    if (owedNext === 0) {
      this.t = next;
      this.blockedBy = 0;
      const gate = this.currentGate();
      if (gate) this.hold();
      else if (!this.live && this.t >= dur) this.hold();
    } else this.blockedBy = owedNext;
    this.emit();
    if (this.playing) this.raf = requestAnimationFrame(this.tick);
  }

  /**
   * How far a prop has been displaced from its anchor by the motion running under it. A `track` shot
   * aims at the anchor when it is compiled, so without this the camera sits still while the artwork it
   * is following slides out of the frame.
   */
  private followOffset(id: string, t: number): { dx: number; dy: number } {
    const mo = this.compiled.cues.filter((c) => c.op.kind === "motion" && (c.op as MotionOp).id === id && c.t <= t && c.end > t).pop();
    return mo ? motionOffset(mo.op as MotionOp, t - mo.t) : { dx: 0, dy: 0 };
  }

  /** The prop a settled `track` shot is still following, if the cue the camera last landed on is one. */
  private followed(cue: Cue | undefined): string | null {
    return cue?.op.kind === "camera" && cue.op.mode === "track" && cue.op.follow ? cue.op.follow : null;
  }

  private cameraAt(t: number): Box {
    const cues = this.compiled.cues.filter((c) => c.op.kind === "camera" || c.op.kind === "transition");
    let rect = this.rect;
    let follow: string | null = null;
    for (const c of cues) {
      if (c.end <= t) {
        rect = c.to;
        follow = this.followed(c);
        continue;
      }
      if (c.t > t) break;
      const op = c.op as { duration: number; easing: string };
      const p = Math.min(1, Math.max(0, (t - c.t) / Math.max(c.end - c.t, 1)));
      const from = this.live && this.camFrom && this.camFromAt <= c.t ? this.camFrom : c.from;
      if (!this.camFrom || this.camFromAt !== c.t) {
        this.camFrom = from;
        this.camFromAt = c.t;
      }
      follow = this.followed(c) ?? follow;
      const glide = lerpBox(from, c.to, (EASES[op.easing] ?? EASES.ease)(p));
      return this.ride(glide, follow, t);
    }
    return this.ride(rect, follow, t);
  }

  private ride(rect: Box, follow: string | null, t: number): Box {
    if (!follow) return rect;
    const { dx, dy } = this.followOffset(follow, t);
    return dx === 0 && dy === 0 ? rect : { ...rect, x: rect.x + dx, y: rect.y + dy };
  }

  /**
   * The last transition the clock has walked through the veil of, if any: `flip` is the instant it
   * swept (the veil's midpoint, where the figure covers the frame, so nothing pops out from under a
   * transparent wipe) and `board` is where it landed.
   */
  private cutAt(t: number): Cut | null {
    let cut: Cut | null = null;
    for (const c of this.compiled.cues) {
      if (c.op.kind !== "transition") continue;
      const flip = c.t + (c.end - c.t) / 2;
      if (flip > t) break;
      cut = { flip, board: c.op.to };
    }
    return cut;
  }

  /**
   * Has a cut swept this artwork off the board? A transition wipes what was standing when it landed;
   * only what the director re-placed onto the destination board (`recall` stamps the board) or laid
   * down afterwards survives. Before the first cut everything shares one board, because panning into
   * empty space to open a new line of thought is not a scene change and art must not vanish from it.
   */
  private swept(rev: Revision, cut: Cut | null): boolean {
    return !!cut && rev.t < cut.flip && rev.scene !== cut.board;
  }

  /**
   * Can the audience see this name at `t` — a prop painted by then and not swept off, or a board with
   * such a prop on it. Read off the revisions standing at `t`, exactly as `visibleProps` paints them.
   */
  visibleName(id: string, t: number): boolean {
    const cut = this.cutAt(t);
    const standing = (p: Prop): Revision | undefined => {
      const onStage = p.revisions.filter((r) => r.t <= t);
      const rev = onStage[onStage.length - 1];
      return rev && !this.swept(rev, cut) ? rev : undefined;
    };
    const named = this.compiled.props.get(id);
    if (named && standing(named)) return true;
    return [...this.compiled.props.values()].some((p) => p.id !== id && standing(p)?.scene === id);
  }

  /** The board the show is standing on at `t`, or null before its first cut. */
  boardAt(t: number): string | null {
    return this.cutAt(t)?.board ?? null;
  }

  private visibleProps(t: number): VisibleProp[] {
    const out: VisibleProp[] = [];
    const cut = this.cutAt(t);
    const highlights = this.compiled.cues.filter((c) => c.op.kind === "highlight" && c.t <= t && c.end > t);
    const motions = this.compiled.cues.filter((c) => c.op.kind === "motion" && c.t <= t && c.end > t);
    for (const p of this.compiled.props.values()) {
      const revs = p.revisions.filter((r) => r.t <= t);
      if (revs.length === 0) continue;
      if (p.discardedAt !== undefined && p.discardedAt <= t) continue;
      const rev: Revision = revs[revs.length - 1];
      if (this.swept(rev, cut)) continue;
      const hl = highlights.find((h) => (h.op as { target: string }).target === p.id);
      const pv = this.preview.get(p.id);
      const mo = motions.filter((m) => (m.op as MotionOp).id === p.id).pop();
      const box = displaced(pv?.box ?? rev.box, mo ? motionOffset(mo.op as MotionOp, t - mo.t) : { dx: 0, dy: 0 });
      // Delivery is read off the tape, never off the tape head: a drawing still streaming in is a
      // promise, so the caption for it waits. The outline below is the other question — is anything
      // visible here at all yet — and a streaming stroke answers that one.
      const streaming = pv ? { svg: pv.svg, html: pv.html, scene3d: rev.scene3d } : rev;
      out.push({
        id: p.id,
        scene: p.scene,
        box,
        svg: pv?.svg ?? rev.svg,
        html: pv?.html ?? rev.html,
        css: pv?.css ?? rev.css,
        scene3d: rev.scene3d,
        label: pv?.label ?? rev.label,
        note: rev.note,
        draft: !painted(rev),
        awaiting: this.artFor.has(p.id) && !painted(streaming) && overlaps(box, this.rect),
        highlight: hl ? (hl.op as { style: string }).style : undefined,
      });
    }
    for (const [id, pv] of this.preview) {
      if (this.compiled.props.has(id)) continue;
      out.push({
        id,
        scene: pv.scene,
        box: pv.box,
        svg: pv.svg,
        html: pv.html,
        css: pv.css,
        draft: true,
        awaiting: !painted(pv) && overlaps(pv.box, this.rect),
        label: pv.label,
      });
    }
    return out;
  }

  private render(): RenderState {
    const t = this.t;
    this.rect = this.cameraAt(t);
    const props = this.visibleProps(t);
    this.owed = this.owedAt(t) || (this.playing ? this.blockedBy : 0);
    this.artWait = this.playing && this.owed > 0;
    const narr = this.compiled.cues.filter((c) => c.op.kind === "narrate" && c.t <= t && c.end > t).pop();
    const veil = this.compiled.cues.filter((c) => c.op.kind === "transition" && c.t <= t && c.end > t).pop();
    return {
      t,
      duration: this.compiled.duration,
      rect: this.rect,
      viewport: { w: 1600, h: 900 },
      props,
      narration: narr
        ? {
            text: (narr.op as { text: string }).text,
            progress: Math.min(1, (t - narr.t) / Math.max(narr.end - narr.t, 1)),
            // The line is finished on screen `SETTLE_MS` before the beat ends: the last characters must
            // not be appearing at the very instant the camera moves, or the settle buys nothing.
            reveal: Math.min(1, (t - narr.t) / Math.max(narr.end - narr.t - SETTLE_MS, 1)),
            duration: Math.max(narr.end - narr.t, 1),
            style: (narr.op as { style?: string }).style ?? "caption",
          }
        : null,
      veil: veil ? { style: (veil.op as { style: string }).style, progress: (t - veil.t) / Math.max(veil.end - veil.t, 1) } : null,
      gate: this.currentGate(),
      said: this.cardAt(t)?.said ?? null,
      askedGate: this.pending.size ? Math.min(...this.pending.keys()) : null,
      playing: this.playing,
      finished: !this.playing && t >= this.compiled.duration && this.compiled.duration > 0,
      track: this.track,
      live: this.live,
      artOwed: this.owed,
      artWait: this.artWait,
    };
  }

  /** What the teacher model is allowed to see about the stage: geometry + identity, never SVG source. */
  agentSnapshot(): string {
    const c = this.compiled;
    const cut = this.cutAt(this.t);
    const board = cut?.board ?? null;
    const moving = new Map<string, string>();
    for (const q of c.cues) {
      if (q.op.kind === "motion" && q.t <= this.t && q.end > this.t) moving.set(q.op.id, q.op.mode);
    }
    const live = [...c.props.values()]
      .filter((p) => p.discardedAt === undefined || p.discardedAt > this.t)
      .map((p) => {
        const r = p.revisions[p.revisions.length - 1];
        const off = this.swept(r, cut) ? "·已被换场扫走（recall 才带得回来）" : "";
        return `  ${p.id} [${p.scene}${off}] ${r.label} @(${Math.round(r.box.x)},${Math.round(r.box.y)} ${Math.round(r.box.w)}x${Math.round(r.box.h)})${r.scene3d ? ` [3D${r.scene3d.interactive ? "·可拖" : ""}]` : ""}${moving.has(p.id) ? ` moving:${moving.get(p.id)}(anchor stands)` : ""}${p.links.length ? ` links:${p.links.map((l) => l.relation + "->" + l.to).join(",")}` : ""}`;
      })
      .join("\n");
    const scenes = [...c.scenes.entries()].map(([s, b]) => `${s}=(${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.w)}x${Math.round(b.h)})`).join(" ");
    const gate = this.currentGate();
    const staged = c.beats
      .map((b, i) => ({ b, i }))
      .filter(({ b }) => b.headline)
      .map(({ b, i }) => `  ${i + 1}. ${b.headline.slice(0, 46)} (${Math.round(b.start)}–${Math.round(b.end)}ms)`)
      .join("\n");
    return [
      // The rect, not just its centre: to build in the empty space the camera just slid to, the
      // director has to know what is inside the frame, and a centre point alone can't be placed in.
      `stage clock: ${Math.round(this.t)}ms / ${Math.round(c.duration)}ms, camera sees=(${Math.round(this.rect.x)},${Math.round(this.rect.y)} ${Math.round(this.rect.w)}x${Math.round(this.rect.h)}) zoom=${(1600 / this.rect.w).toFixed(2)}`,
      board
        ? `standing on board「${board}」— 换场会扫板：这一刀之前落下的东西，只有属于这块板的观众还看得见。要用别的板上的道具只有 recall 带过来；不写 scene 的 build 就落在脚下这块板，写了 scene 是把它挪到那块板上。接着讲同一块板用 pan，别用 transition。`
        : "还没换过场：台上就是一整张无限画布，换场前的东西全都还在眼前。不写 scene 的 build 落在脚下。要开新思路就 pan 一屏到空白处落笔，那不算是换场。",
      `scenes: ${scenes || "-"}`,
      `props on file (source not shown; fetch_prop to recall it):`,
      live || "  (empty)",
      c.beats.length > 1
        ? `beats already on the tape — these lines have been spoken, do not re-lay them, continue from where they stop:\n${staged}`
        : "",
      gate ? `WAITING ON LEARNER: ${JSON.stringify(gate.op)}` : "no open question",
    ]
      .filter(Boolean)
      .join("\n");
  }
}
