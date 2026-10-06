import { compile } from "./compile";
import { MAIN_TRACK, OpLog } from "./log";
import { displaced, motionOffset } from "./motion";
import type { Box, Compiled, Gate, MotionOp, Op, OpEntry, Revision, Scene3DSpec, TrackId } from "./types";

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
  highlight?: string;
}

export interface RenderState {
  t: number;
  duration: number;
  rect: Box;
  viewport: { w: number; h: number };
  props: VisibleProp[];
  narration: { text: string; progress: number; duration: number; style: string } | null;
  veil: { style: string; progress: number } | null;
  gate: Gate | null;
  gateAnswer: string | null;
  playing: boolean;
  finished: boolean;
  track: TrackId;
  live: boolean;
  /** Paints in flight right now. */
  pendingArt: number;
  /** The clock is standing still because the picture under it isn't there yet. */
  artWait: boolean;
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
  /** Paints the teacher has asked for and not yet got back. The clock waits on this count. */
  pendingArt = 0;
  private emptyFrame = false;
  private artWait = false;
  private gateAnswer: string | null = null;
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
    this.answered.clear();
    this.pending.clear();
    this.track = MAIN_TRACK;
    this.asideResume = null;
    this.t = 0;
    this.live = true;
    this.gateAnswer = null;
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

  append(ops: Op[], track: TrackId = this.track) {
    this.log.append(ops, track);
    this.recompile();
  }

  /** The tape head: transient partial visuals while the model is still emitting them. */
  setPreview(id: string, patch: Partial<{ box: Box; svg: string; html: string; css: string; label: string; scene: string }>) {
    const cur = this.preview.get(id) ?? { box: { x: 0, y: 0, w: 200, h: 200 }, label: id, scene: "default" };
    this.preview.set(id, { ...cur, ...patch } as typeof cur);
    this.emit();
  }

  clearPreview(id: string) {
    if (this.preview.delete(id)) this.emit();
  }

  /**
   * A paint has been asked for. `beginArt` must be matched by `endArt` on every path — the loop runs
   * it in a `finally` — because an unbalanced count is a clock that never starts again.
   */
  beginArt() {
    this.pendingArt++;
    this.emit();
  }

  endArt() {
    this.pendingArt = Math.max(0, this.pendingArt - 1);
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
   * track, unanswered gates become unasked, and the stage lands exactly where that op would
   * have appeared — so the director can re-perform the passage instead of appending to it.
   */
  rerollFrom(seq: number): number {
    this.log.cutFrom(seq);
    for (const s of [...this.answered]) if (s >= seq) this.answered.delete(s);
    this.preview.clear();
    this.gateAnswer = null;
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

  answerGate(value: string) {
    const gate = this.currentGate();
    if (!gate) return;
    this.answered.add(gate.seq);
    this.gateAnswer = value;
    this.pending.get(gate.seq)?.resolve(value);
    this.pending.delete(gate.seq);
    this.play();
    this.emit();
  }

  /** The director's turn blocks here until a real learner answers. */
  waitForGate(seq: number): Promise<string> {
    return new Promise((resolve) => this.pending.set(seq, { resolve }));
  }

  private pending = new Map<number, { resolve: (v: string) => void }>();

  openGateSeqs(): number[] {
    return this.compiled.gates.filter((g) => !this.answered.has(g.seq)).map((g) => g.seq);
  }

  private answered = new Set<number>();

  currentGate(): Gate | null {
    return this.compiled.gates.find((g) => g.t <= this.t && !this.answered.has(g.seq)) ?? null;
  }

  /** First gate not yet reached by the clock and not yet answered. */
  nextGate(): Gate | null {
    return this.compiled.gates.find((g) => !this.answered.has(g.seq)) ?? null;
  }

  /** The caption must not finish before the thing it describes exists. */
  private artBlocked(): boolean {
    return this.live && this.pendingArt > 0 && this.emptyFrame;
  }

  private tick(now: number) {
    const dt = (now - this.last) * this.speed;
    this.last = now;
    const dur = this.compiled.duration;
    // Standing still is not holding: `playing` stays on and the rAF keeps re-arming, so the frame
    // after the artwork lands the clock picks up by itself.
    if (!this.artBlocked()) {
      this.t = Math.min(this.t + dt, dur);
      const gate = this.currentGate();
      if (gate) this.hold();
      else if (!this.live && this.t >= dur) this.hold();
    }
    this.emit();
    if (this.playing) this.raf = requestAnimationFrame(this.tick);
  }

  private cameraAt(t: number): Box {
    const cues = this.compiled.cues.filter((c) => c.op.kind === "camera" || c.op.kind === "transition");
    let rect = this.rect;
    for (const c of cues) {
      if (c.end <= t) {
        rect = c.to;
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
      rect = lerpBox(from, c.to, (EASES[op.easing] ?? EASES.ease)(p));
      return rect;
    }
    return rect;
  }

  private visibleProps(t: number): VisibleProp[] {
    const out: VisibleProp[] = [];
    const highlights = this.compiled.cues.filter((c) => c.op.kind === "highlight" && c.t <= t && c.end > t);
    const motions = this.compiled.cues.filter((c) => c.op.kind === "motion" && c.t <= t && c.end > t);
    for (const p of this.compiled.props.values()) {
      const revs = p.revisions.filter((r) => r.t <= t);
      if (revs.length === 0) continue;
      if (p.discardedAt !== undefined && p.discardedAt <= t) continue;
      const rev: Revision = revs[revs.length - 1];
      const hl = highlights.find((h) => (h.op as { target: string }).target === p.id);
      const pv = this.preview.get(p.id);
      const mo = motions.filter((m) => (m.op as MotionOp).id === p.id).pop();
      const art = pv ? { svg: pv.svg, html: pv.html, scene3d: rev.scene3d } : rev;
      out.push({
        id: p.id,
        scene: p.scene,
        box: displaced(pv?.box ?? rev.box, mo ? motionOffset(mo.op as MotionOp, t - mo.t) : { dx: 0, dy: 0 }),
        svg: pv?.svg ?? rev.svg,
        html: pv?.html ?? rev.html,
        css: pv?.css ?? rev.css,
        scene3d: rev.scene3d,
        label: pv?.label ?? rev.label,
        note: rev.note,
        draft: !painted(art),
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
        label: pv.label,
        draft: !(pv.svg || pv.html),
      });
    }
    return out;
  }

  private render(): RenderState {
    const t = this.t;
    this.rect = this.cameraAt(t);
    const props = this.visibleProps(t);
    this.emptyFrame = props.some((p) => p.draft && overlaps(p.box, this.rect));
    this.artWait = this.playing && this.artBlocked();
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
            duration: Math.max(narr.end - narr.t, 1),
            style: (narr.op as { style?: string }).style ?? "caption",
          }
        : null,
      veil: veil ? { style: (veil.op as { style: string }).style, progress: (t - veil.t) / Math.max(veil.end - veil.t, 1) } : null,
      gate: this.currentGate(),
      gateAnswer: this.gateAnswer,
      playing: this.playing,
      finished: !this.playing && t >= this.compiled.duration && this.compiled.duration > 0,
      track: this.track,
      live: this.live,
      pendingArt: this.pendingArt,
      artWait: this.artWait,
    };
  }

  /** What the teacher model is allowed to see about the stage: geometry + identity, never SVG source. */
  agentSnapshot(): string {
    const c = this.compiled;
    const moving = new Map<string, string>();
    for (const q of c.cues) {
      if (q.op.kind === "motion" && q.t <= this.t && q.end > this.t) moving.set(q.op.id, q.op.mode);
    }
    const live = [...c.props.values()]
      .filter((p) => p.discardedAt === undefined || p.discardedAt > this.t)
      .map((p) => {
        const r = p.revisions[p.revisions.length - 1];
        return `  ${p.id} [${p.scene}] ${r.label} @(${Math.round(r.box.x)},${Math.round(r.box.y)} ${Math.round(r.box.w)}x${Math.round(r.box.h)})${r.scene3d ? ` [3D${r.scene3d.interactive ? "·可拖" : ""}]` : ""}${moving.has(p.id) ? ` moving:${moving.get(p.id)}(anchor stands)` : ""}${p.links.length ? ` links:${p.links.map((l) => l.relation + "->" + l.to).join(",")}` : ""}`;
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
      `scenes: ${scenes || "-"}`,
      `props on stage (source not shown; fetch_prop to recall it):`,
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
