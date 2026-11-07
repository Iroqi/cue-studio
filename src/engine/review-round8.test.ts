// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Narrator } from "./narrator";
import { Stage } from "./runtime";
import { MAIN_TRACK } from "./log";

/*
 * 第八轮修复的回归钉：有 TTS 环境下的旁白状态机。
 *
 * `narrator.test.ts` 原本只测"没有 speechSynthesis 的环境"那两条，整个发声状态机零覆盖。
 * 实测：学习者暂停 → 拖时间轴到下一句 → 再按播放，这一句**永远念不出来**。切句分支在 `cancel()`
 * 之后把自己的 `paused` 复位成 false，而 `cancel()` 清队列不清引擎的 paused 标志；于是 Narrator
 * 认为"在播"、引擎认为"暂停"，恢复播放那一步的 `s.playing && this.paused` 再也不成立，永久静默。
 *
 * 修复：切句时 `paused` 跟时钟走（`!s.playing`），开演时在 speak 之前 resume 清掉引擎可能残留的
 * 暂停（未暂停时 resume 是 no-op），暂停中拿到的新句 speak 后立刻 pause；`stop()` 取消后也把引擎
 * 放回未暂停的静止态。
 */
function ttsStub() {
  const st = {
    paused: false,
    cancelN: 0,
    pauseN: 0,
    resumeN: 0,
    spoken: [] as string[],
  };
  const fake = {
    get paused() {
      return st.paused;
    },
    getVoices: () => [{ lang: "zh-CN", name: "StubVoice" }],
    addEventListener: () => {},
    removeEventListener: () => {},
    cancel: () => {
      st.cancelN++;
      // 规范：cancel 清队列，不改 paused 标志 —— 引擎侧残留正是本轮修复的那条路径
    },
    speak: (u: { text: string }) => {
      st.spoken.push(u.text);
    },
    pause: () => {
      st.pauseN++;
      st.paused = true;
    },
    resume: () => {
      st.resumeN++;
      st.paused = false;
    },
  };
  class Utterance {
    text: string;
    lang = "";
    rate = 1;
    voice: unknown = null;
    constructor(t: string) {
      this.text = t;
    }
  }
  return { st, fake, Utterance };
}

describe("round8: 有 TTS 时的旁白状态机", () => {
  beforeEach(() => {
    let raf = 0;
    let now = 0;
    vi.stubGlobal("requestAnimationFrame", () => ++raf);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("__clock", { set: (t: number) => (now = t) });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const step = (stage: Stage, to: number) => {
    (stage as unknown as { last: number }).last = to - 100;
    (stage as unknown as { tick: (n: number) => void }).tick(to);
  };

  const setup = () => {
    const { st, fake, Utterance } = ttsStub();
    vi.stubGlobal("speechSynthesis", fake);
    vi.stubGlobal("SpeechSynthesisUtterance", Utterance);
    const stage = new Stage();
    stage.append([{ kind: "narrate", text: "第一句", duration: 2000 }], MAIN_TRACK);
    stage.append([{ kind: "narrate", text: "第二句", duration: 2000 }], MAIN_TRACK);
    const n = new Narrator(stage);
    n.setEnabled(true);
    n.attach();
    stage.play();
    step(stage, 100);
    return { st, stage, n };
  };

  it("暂停中 seek 到下一句：新句等时钟，恢复播放后能念出来（本轮修复）", () => {
    const { st, stage } = setup();
    expect(st.spoken).toEqual(["第一句"]);

    stage.hold();
    step(stage, 200);
    const base = st.pauseN;
    expect(st.paused).toBe(true);

    stage.seek(2600);
    step(stage, 300);
    // 新句交给引擎，但时钟停着 —— 引擎的 paused 和 Narrator 的 paused 说的是同一件事
    expect(st.spoken).toEqual(["第一句", "第二句"]);
    expect(st.paused).toBe(true);
    // 新句 speak 之后按了一次暂停（基线计数来自开演前那次同步，所以只数增量）
    expect(st.pauseN).toBe(base + 1);

    // 恢复播放：resume 把引擎放出来，这一句终于走
    stage.play();
    step(stage, 400);
    expect(st.resumeN).toBeGreaterThan(0);
    expect(st.paused).toBe(false);
  });

  it("播放中 seek：引擎残留的暂停被清掉，新句直接开念", () => {
    const { st, stage } = setup();
    // 制造残留：先暂停再恢复，引擎侧留下 paused=true 的假象
    stage.hold();
    step(stage, 200);
    stage.play();
    step(stage, 300);
    // 在播放中 seek 到下一句：切句分支应先把引擎 resume 回来再 speak
    stage.seek(2600);
    step(stage, 400);
    expect(st.spoken).toEqual(["第一句", "第二句"]);
    expect(st.paused).toBe(false);
  });

  it("暂停期间不每帧重复 pause（一次暂停只发一次）", () => {
    const { st, stage } = setup();
    stage.hold();
    step(stage, 200);
    const base = st.pauseN;
    step(stage, 300);
    step(stage, 400);
    expect(st.pauseN).toBe(base);
  });

  it("detach 之后引擎回到未暂停的静止态（cancel + resume）", () => {
    const { st, stage, n } = setup();
    stage.hold();
    step(stage, 200);
    expect(st.paused).toBe(true);
    n.detach();
    expect(st.paused).toBe(false);
    expect(st.cancelN).toBeGreaterThan(0);
  });

  it("关掉再打开旁白：当前那句重新念", () => {
    const { st, stage, n } = setup();
    n.setEnabled(false);
    n.setEnabled(true);
    step(stage, 200);
    expect(st.spoken).toEqual(["第一句", "第一句"]);
  });

  it("残缺的 speechSynthesis（有 speak/cancel 缺 pause/resume）：不崩，整件旁白关掉", () => {
    // 真实 webview 可能只实现一半；`typeof speechSynthesis !== "undefined"` 证明不了方法齐全。
    const partial = {
      getVoices: () => [],
      addEventListener: () => {},
      removeEventListener: () => {},
      cancel: () => {},
      speak: () => {},
    };
    vi.stubGlobal("speechSynthesis", partial);
    vi.stubGlobal("SpeechSynthesisUtterance", class {});
    const n = new Narrator(new Stage());
    expect(n.enabled).toBe(false);
    expect(() => n.setEnabled(true)).not.toThrow();
    expect(() => n.attach()).not.toThrow();
    expect(() => n.detach()).not.toThrow();
  });
});
