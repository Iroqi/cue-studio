// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Stage } from "../engine/runtime";
import { DEFAULT_CONFIG, getModels, setScriptedResponses } from "../llm/llm";
import { Teacher } from "./loop";

/*
 * 第九轮修复的两条回归钉，都在「插播」那条路上。
 *
 * 插播（`interrupt`）不是另起一个导演：它用独立 transcript、独立轨，**与主线并排**跑
 * （`respond` 的注释把"两个导演同写一份 transcript"当成必须避免的事，aside 之所以敢并发，
 *  正是因为它不碰主线那份）。并排跑就有两个账要记清楚：
 *
 *  1. `busy` / `turnOpen` / `onBusy` 原先都是布尔。aside 通常比主线短，先收场的那个把舞台
 *     提前交还、把欠画冻结提前解除 —— 而主线还在演。那一刻 `continuesBoard()` 会说"可以接着说"，
 *     学习者的下一句于是开**第三个**导演写主线 transcript；`whenIdle()` 也会提前 resolve，
 *     让重排把 abort controller 从仍在等模型的回合底下换掉。
 *  2. `beginAside()` / `endAside()` 没有配对保护。插播里任何一个动词抛错，`endAside` 就被跳过，
 *     舞台留在 `aside:N` 且 t 归零 —— `render()` 按 `this.track` 出图，学习者眼前的主课
 *     直接被一场失败的插播顶掉。
 *
 * 探针口径两处都是"事件序列"，不是毫秒：一条钉 `onBusy(false)` 不许出现在"插播收场"与
 * "主线收场"之间；一条钉插播轨落笔抛错之后 `stage.track` 与 `stage.t` 都回到主线。
 */

const CFG = { ...DEFAULT_CONFIG, scripted: true };
const beat = (t: string, s = 0.9) =>
  fauxAssistantMessage([fauxToolCall("narrate", { text: t, seconds: s })], { stopReason: "toolUse" });
const stop = () => fauxAssistantMessage("（说完了。）", { stopReason: "stop" });

/** 在第 2 拍刚开始（导演本人 busy、主线已经落下第一笔）时把插播扔进去。 */
function interruptAtSecondBeat(onFire: () => void) {
  let fired = false;
  return {
    onStatus: (s: string) => {
      if (!fired && /第 2 拍/.test(s)) {
        fired = true;
        onFire();
      }
    },
  };
}

describe("round9: 插播与主线并排时的两份账", () => {
  it("插播收场时主线还在演：舞台不许交还，欠画冻结不许解除", async () => {
    getModels(CFG);
    const stage = new Stage();
    let teacher: Teacher;
    let aside: Promise<void> | null = null;
    let asideEnded = false;
    let mainDone = false;
    let badRelease = "";

    const ev = {
      onBusy: (b: boolean) => {
        if (!b && asideEnded && !mainDone) badRelease = "插播收拾完了，主线还在演，舞台却已经交还";
      },
      onStatus: (s: string) => {
        if (s === "插播结束") asideEnded = true;
        if (/这一段讲完了/.test(s)) mainDone = true;
        base.onStatus(s);
      },
    };
    const base = interruptAtSecondBeat(() => {
      aside = teacher.respond("等一下，这是为什么？");
    });
    teacher = new Teacher(stage, CFG, ev);

    setScriptedResponses([beat("第一句"), beat("第二句"), beat("插播一"), stop(), stop()], {});
    await teacher.say("讲一段");
    await (aside ?? Promise.resolve());

    expect(badRelease).toBe("");
    // 两条 spin 都收场之后，冻结与忙都必须是关着的（计数没有漏减）
    expect((stage as unknown as { turnOpen: boolean }).turnOpen).toBe(false);
    expect(teacher.busy).toBe(false);
  });

  it("插播轨上的落笔抛错：endAside 仍然执行，主线的时间轴与轨都回来", async () => {
    getModels(CFG);
    const stage = new Stage();
    let teacher: Teacher;
    let aside: Promise<void> | null = null;
    const base = interruptAtSecondBeat(() => {
      // 主线停在一个非零的时刻，插播结束后必须回到那儿才说得上"恢复了"
      stage.seek(900);
      aside = teacher.respond("等一下，这是为什么？");
    });
    teacher = new Teacher(stage, CFG, base);
    const real = stage.append.bind(stage);
    vi.spyOn(stage, "append").mockImplementation((ops, track, onNote) => {
      if (String(track ?? stage.track).startsWith("aside")) throw new Error("插播落笔时出错");
      return real(ops, track, onNote);
    });

    setScriptedResponses([beat("第一句"), beat("第二句"), beat("插播一"), stop(), stop()], {});
    await teacher.say("讲一段");
    await (aside ?? Promise.resolve());

    expect(stage.track).toBe("main");
    expect(stage.t).toBe(900);
    expect(teacher.busy).toBe(false);
  });
});
