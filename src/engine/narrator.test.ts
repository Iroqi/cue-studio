// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Narrator } from "./narrator";
import { Stage } from "./runtime";

/*
 * 旁白是挂在时钟上的装饰。没有 speechSynthesis 的环境（无 TTS 的 webview、隐私模式、headless 跑法）
 * 里，它过去会让整台 App 起不来：App 无条件 `new Narrator(stage)`，而构造器立刻读 `getVoices()` 并
 * 挂 `voiceschanged` 监听 —— 两者在无 TTS 环境都会抛。jsdom 不实现 Web Speech API，`speechSynthesis`
 * 正是 undefined，所以这里是那个环境本身。
 */
describe("Narrator：没有 TTS 的环境", () => {
  it("构造、开关、挂载、卸载都不抛异常，且默认静音", () => {
    expect((globalThis as { speechSynthesis?: unknown }).speechSynthesis).toBeUndefined();
    const n = new Narrator(new Stage());
    expect(n.enabled).toBe(false);
    expect(n.voiceName()).toBe("系统默认");
    n.setEnabled(true);
    n.setEnabled(false);
    n.attach();
    n.detach();
  });

  it("偏好里存着「开」也不真发声、不崩溃：环境不支持就保持静音", () => {
    localStorage.setItem("canvas-teacher.voice", "on");
    try {
      const n = new Narrator(new Stage());
      // 环境没有 TTS，偏好不生效：整件旁白是装饰，而不是一句会炸的话。
      expect(n.enabled).toBe(false);
      expect(n.voiceName()).toBe("系统默认");
      n.attach();
      n.detach();
    } finally {
      localStorage.removeItem("canvas-teacher.voice");
    }
  });
});
