import type { Stage } from "./runtime";
import { speechMs, SETTLE_MS } from "./speech";

const KEY = "canvas-teacher.voice";

/**
 * Voice-over that is glued to the clock, never in front of it. The clock already refuses to be shorter
 * than the line it carries (`cueMs` floors every narrated beat at what it takes to say it), so the
 * usual rate here is 1.0 — the squeeze is left for the rare beat the director stretched on purpose.
 * Nothing here feeds back into timing — mute it and the show is identical.
 */
export class Narrator {
  enabled: boolean;
  private stage: Stage;
  private line = "";
  private paused = false;
  private voice: SpeechSynthesisVoice | null = null;
  private unsub: (() => void) | null = null;

  constructor(stage: Stage) {
    this.stage = stage;
    this.enabled = localStorage.getItem(KEY) === "on";
    const pick = () => {
      const vs = speechSynthesis.getVoices();
      this.voice = vs.find((v) => /^zh[-_]cn/i.test(v.lang)) ?? vs.find((v) => /^zh/i.test(v.lang)) ?? null;
    };
    pick();
    speechSynthesis.addEventListener("voiceschanged", pick);
  }

  attach() {
    this.unsub ??= this.stage.subscribe(() => this.sync());
  }

  detach() {
    this.unsub?.();
    this.unsub = null;
    this.stop();
  }

  voiceName() {
    return this.voice?.name ?? "系统默认";
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    localStorage.setItem(KEY, on ? "on" : "off");
    if (on) this.sync();
    else this.stop();
  }

  private stop() {
    this.line = "";
    this.paused = false;
    speechSynthesis.cancel();
  }

  private sync() {
    if (!this.enabled) return;
    const s = this.stage.getSnapshot();
    const n = s.narration;
    const key = n ? `${Math.round(s.t - n.progress * n.duration)}|${n.text}` : "";
    if (key !== this.line) {
      speechSynthesis.cancel();
      this.line = key;
      this.paused = false;
      if (!n) return;
      const u = new SpeechSynthesisUtterance(n.text);
      if (this.voice) u.voice = this.voice;
      u.lang = this.voice?.lang ?? "zh-CN";
      // The last `SETTLE_MS` of the beat is silence by contract, so the voice gets the window minus it.
      // On a floored beat that lands the rate at exactly 1.0: the sentence ends, then the picture moves.
      const room = Math.max(n.duration - SETTLE_MS, 0) / 1000;
      const needs = speechMs(n.text) / 1000;
      u.rate = Math.max(0.8, needs / Math.max(room, 0.4));
      speechSynthesis.speak(u);
      return;
    }
    if (!s.playing && !this.paused) {
      speechSynthesis.pause();
      this.paused = true;
    } else if (s.playing && this.paused) {
      speechSynthesis.resume();
      this.paused = false;
    }
  }
}
