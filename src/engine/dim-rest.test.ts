// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { MAIN_TRACK } from "./log";
import { Stage } from "./runtime";
import { StageView } from "./StageView";
import type { Op } from "./types";

/*
 * dim-rest 在词表里、在工具的枚举里，唯独不在板上：旧的 CSS 是一条 `.dim-rest:has(~ .prop)`，
 * 而舞台打出的类名是 `hl-dim-rest`，规则从来没匹配过任何东西——这个动词一直是个空承诺。
 * 这里测的是"观众真的看得见的差别"，所以要把 show 渲染出来。
 */

const art = (id: string): Op => ({ kind: "build", id, box: { x: 0, y: 0, w: 200, h: 160 }, label: id, html: `<p>${id}</p>` });
const say = (text: string, duration = 1000): Op => ({ kind: "narrate", text, duration });
const mark = (target: string, style: string): Op => ({ kind: "highlight", target, style: style as "pulse", duration: 1500 });

// 舞台用 ResizeObserver 量自己的窗（dock 占多高就少画多高），jsdom 没有这个。
class NoResize {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = NoResize as unknown as typeof ResizeObserver;
// React 19 的 act() 要求宿主自己声明它在测试环境里，不然每次 render 都叫一声。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const render = (...ops: Op[]) => {
  const stage = new Stage();
  stage.append(ops, MAIN_TRACK);
  stage.seek(1000);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(createElement(StageView, { stage })));
  return { host, cleanup: () => act(() => root.unmount()) };
};

describe("highlight：dim-rest 在 DOM 上留得下痕迹", () => {
  /*
   * jsdom 不会去套 index.css，所以这里断言的是"标记打得对不对"——那正是旧版缺的那一环
   * （CSS 等的是 `.dim-rest`，舞台打的是 `hl-dim-rest`，两边永远碰不上）。规则本身在浏览器里核对。
   */
  it("点了名的那块被点名，板子被标成 dim-rest", () => {
    const { host, cleanup } = render(art("主角"), art("陪衬"), mark("主角", "dim-rest"), say("看这个"));
    const world = host.querySelector(".world");
    expect(world?.className).toContain("dim-rest");
    expect(world?.querySelector('[data-prop="主角"]')?.className).toContain("hl-dim-rest");
    // 陪衬不该带 hl-dim-rest——正是这一点让 CSS 能把别人压暗。
    expect(world?.querySelector('[data-prop="陪衬"]')?.className).not.toContain("hl-dim-rest");
    cleanup();
  });

  it("不是 dim-rest 的强调不会把整块板压暗", () => {
    const { host, cleanup } = render(art("主角"), art("陪衬"), mark("主角", "pulse"), say("看这个"));
    expect(host.querySelector(".world")?.className).not.toContain("dim-rest");
    cleanup();
  });

  it("这一拍过去之后，板子回到原来的亮度", () => {
    const stage = new Stage();
    stage.append([art("主角"), mark("主角", "dim-rest"), say("说一句", 500)], MAIN_TRACK);
    // 高亮是叠层：它到点就自己走。
    stage.seek(2500);
    const props = stage.getSnapshot().props;
    expect(props.every((p) => p.highlight === undefined)).toBe(true);
  });

  /*
   * 这条才是真正守门的一条。旧版的 bug 不在 JS 也不在 CSS，而在两边各叫各的：样式表等的是
   * `.dim-rest:has(~ .prop)`，渲染器打的是 `hl-dim-rest`，于是规则匹配零个元素、动词悄悄失效，
   * 而单元测试全都还是绿的。把"CSS 里写的类名"和"DOM 里挂出的类名"对上，是唯一能抓住它的检查。
   */
  it("index.css 里的 dim-rest 规则，选的确实是渲染器挂出来的那两个类名", () => {
    // jsdom 里 import.meta.url 是 http:，读不了盘；vitest 的工作目录就是项目根。
    const css = readFileSync("src/index.css", "utf8");
    const rule = css.match(/\.world\.dim-rest[^{]*\{([^}]*)\}/);
    expect(rule, "板上找不到 .world.dim-rest 的规则了").not.toBeNull();
    expect(rule![0]).toContain(".prop:not(.hl-dim-rest)");
    expect(rule![1]).toMatch(/opacity:\s*0?\.\d+/);
    // 压暗必须有渐变，不然强调切换是一次闪烁。
    expect(css).toMatch(/\.prop\s*\{[^}]*transition:\s*opacity/);
  });
});
