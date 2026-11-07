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
  /**
   * No TTS in this environment (some webviews, privacy modes, headless runs): the whole narrator is
   * decoration there, and reading `speechSynthesis.getVoices()` or calling `speak()` would throw —
   * which used to take the entire app down with it, because the host constructs a Narrator
   * unconditionally. Every speech call is behind this flag; the preference still persists, and the
   * voice simply engages the day the environment has one.
   *
   * Probe the surface, not just the name: a webview can expose `speechSynthesis` with `speak` and
   * `cancel` but no `pause`/`resume`, and a partial stub is exactly how one learns that
   * `typeof x !== "undefined"` proves nothing about the methods this class calls (the same lesson
   * `typeof cancelAnimationFrame` taught in runtime.ts). A narrator missing one of these is not
   * decoration that works — it is one more place the host crashes on teardown, so it stays off.
   */
  private readonly supported =
    typeof speechSynthesis !== "undefined" &&
    typeof SpeechSynthesisUtterance !== "undefined" &&
    typeof speechSynthesis.getVoices === "function" &&
    typeof speechSynthesis.addEventListener === "function" &&
    typeof speechSynthesis.speak === "function" &&
    typeof speechSynthesis.cancel === "function" &&
    typeof speechSynthesis.pause === "function" &&
    typeof speechSynthesis.resume === "function";

  constructor(stage: Stage) {
    this.stage = stage;
    this.enabled = this.supported && localStorage.getItem(KEY) === "on";
    if (!this.supported) return;
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
    if (!this.supported) return;
    if (on) this.sync();
    else this.stop();
  }

  private stop() {
    this.line = "";
    this.paused = false;
    if (this.supported) {
      speechSynthesis.cancel();
      // `cancel()` clears the queue but not everywhere the engine's paused flag: leave it set and the
      // next utterance is handed to a paused engine and never speaks. Resume is a no-op when it isn't
      // paused, so this only puts the engine back in its resting state.
      speechSynthesis.resume();
    }
  }

  private sync() {
    if (!this.enabled || !this.supported) return;
    const s = this.stage.getSnapshot();
    const n = s.narration;
    const key = n ? `${Math.round(s.t - n.progress * n.duration)}|${n.text}` : "";
    if (key !== this.line) {
      speechSynthesis.cancel();
      this.line = key;
      // The new line waits iff the clock is stopped. This used to reset `paused` to false outright, so
      // a learner who paused and then dragged onto the next line left the engine paused while the
      // narrator believed it was playing — pressing play again resumed nothing, and that line was
      // silent for the rest of the lesson. Follow the clock instead, and clear any pause the engine
      // still carries from the previous line (resume is a no-op when it isn't paused).
      this.paused = !s.playing;
      if (!n) return;
      const u = new SpeechSynthesisUtterance(n.text);
      if (this.voice) u.voice = this.voice;
      u.lang = this.voice?.lang ?? "zh-CN";
      // The last `SETTLE_MS` of the beat is silence by contract, so the voice gets the window minus it.
      // On a floored beat that lands the rate at exactly 1.0: the sentence ends, then the picture moves.
      const room = Math.max(n.duration - SETTLE_MS, 0) / 1000;
      const needs = speechMs(n.text) / 1000;
      u.rate = Math.max(0.8, needs / Math.max(room, 0.4));
      if (!this.paused) speechSynthesis.resume();
      speechSynthesis.speak(u);
      if (this.paused) speechSynthesis.pause();
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
