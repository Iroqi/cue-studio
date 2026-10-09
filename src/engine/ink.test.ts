// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { compile } from "./compile";
import type { Box, Op, OpEntry } from "./types";
import { inkBox, InkCache, MAX_CHARS, MAX_ENTRIES } from "./ink";

const tape = (...ops: Op[]): OpEntry[] => ops.map((op, i) => ({ seq: i, track: "main", turn: 0, op }));
const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">${body}</svg>`;
const WORLD: Box = { x: 1000, y: 400, w: 400, h: 300 };
const mid = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

describe("inkBox：道具真正画到的地方", () => {
  it("作者画布一角上的墨，换算成世界坐标", () => {
    const box = inkBox(svg('<rect x="10" y="10" width="40" height="40" fill="#fff"/>'), WORLD);
    expect(box?.x).toBeCloseTo(1065, 6);
    expect(box?.y).toBeCloseTo(415, 6);
    expect(box?.w).toBeCloseTo(60, 6);
    expect(box?.h).toBeCloseTo(60, 6);
  });

  it("塞满画布的墨，就等于声明的框", () => {
    const full = inkBox('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect width="200" height="100" fill="#fff"/></svg>', { x: 0, y: 0, w: 400, h: 200 });
    expect(full?.x).toBeCloseTo(0, 6);
    expect(full?.y).toBeCloseTo(0, 6);
    expect(full?.w).toBeCloseTo(400, 6);
    expect(full?.h).toBeCloseTo(200, 6);
  });

  it("viewBox 四个数按位读，错一位整幅画就偏移", () => {
    const off = inkBox('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect x="50" y="25" width="100" height="50" fill="#fff"/></svg>', { x: 0, y: 0, w: 400, h: 200 });
    expect(off).toEqual({ x: 100, y: 50, w: 200, h: 100 });
  });

  it("translate 之后的图形按落点算", () => {
    const moved = inkBox(svg('<g transform="translate(120,120)"><rect width="40" height="40" fill="#fff"/></g>'), WORLD);
    expect(moved?.x).toBeCloseTo(1230, 6);
    expect(moved?.y).toBeCloseTo(580, 6);
  });

  it("读不懂的变换与 <use> 退回声明的框，而不是给一个自信的错误", () => {
    expect(inkBox(svg('<g transform="rotate(30)"><rect width="40" height="40" fill="#fff"/></g>'), WORLD)).toBeUndefined();
    expect(inkBox(svg('<use href="#nothing"/>'), WORLD)).toBeUndefined();
    expect(inkBox(undefined, WORLD)).toBeUndefined();
  });

  it("fill=none 的空框不算墨", () => {
    expect(inkBox(svg('<rect width="200" height="200" fill="none" stroke="none"/>'), WORLD)).toBeUndefined();
  });
});

describe("镜头瞄准的是墨，不是道具被允许填满的那只框", () => {
  const corner = svg('<rect x="10" y="10" width="40" height="40" fill="#fff"/>');

  const focusOn = (markup: string | undefined) => {
    // build 只上板，不占时钟：这一条 tape 上唯一的 cue 就是那一刀 focus。
    const cues = compile(
      tape(
        { kind: "build", id: "a", box: WORLD, label: "a", svg: markup },
        { kind: "camera", mode: "focus", target: "a", duration: 800, easing: "ease" },
      ),
    ).cues;
    expect(cues).toHaveLength(1);
    return cues[0].to;
  };

  it("框的中心落在墨上", () => {
    const to = focusOn(corner);
    expect(Math.hypot(mid(to).x - 1095, mid(to).y - 445)).toBeLessThan(2);
  });

  it("这正是要修的那个错位：它离声明框的中心有一百多个单位", () => {
    const to = focusOn(corner);
    expect(Math.hypot(mid(to).x - 1200, mid(to).y - 550)).toBeGreaterThan(100);
  });

  it("量不到墨时，退回声明框的中心 —— 画面不能没有落点", () => {
    const to = focusOn(svg('<use href="#nothing"/>'));
    expect(mid(to).x).toBeCloseTo(1200, 6);
    expect(mid(to).y).toBeCloseTo(550, 6);
  });

  it("无论瞄哪里，取景框始终是屏幕的比例", () => {
    const filled = focusOn(svg('<rect width="200" height="200" fill="#fff"/>'));
    expect(focusOn(corner).w / focusOn(corner).h).toBeCloseTo(16 / 9, 6);
    expect(filled.w / filled.h).toBeCloseTo(16 / 9, 6);
  });

  it("特写不往人脸上怼：再小的墨也留着一个可读的框宽", () => {
    const dot = inkBox(svg('<circle cx="20" cy="30" r="4" fill="#fff"/>'), WORLD)!;
    expect(Math.max(dot.w, dot.h)).toBeLessThan(40);
    // 上面的下限是 450 世界单位，特写再近也不会超过它。
    expect(focusOn(corner).w).toBeGreaterThanOrEqual(450);
  });
});

/*
 * 下面两节钉的是「量墨这笔钱」，也就是 `ink.ts` 那本账。
 *
 * 数的是**解析次数**（把 `DOMParser.prototype.parseFromString` 包一层计数器），毫秒只作对照 —— 这一件
 * 要说的不是「快」，是「每一格一生最多付一次，重排不许再付」。改前在冷账上排同一卷带子两遍：81 格
 * 81 / 0、151 格 151 / 0（还没到那道 160，旧写法看起来没问题）、201 格 402 / 402、401 格 802 / 802；
 * 而导演一批一批落笔时这本账一直是热的，那才是他真正付的价钱（下面第二条量的就是这一场戏）。
 *
 * 反向验证（跑在改前的 `ink.ts` 上）：这一节六条里红的是那两条价钱 —— 冷账 200 格那条要 200、量到
 * 400；逐批落笔那条要 280、单独跑量到 1440（整节一起跑是 1528，前面那条已经把账问热过一轮，多出来的
 * 正是"热账"那笔）。其余四条本来就该绿（"同一幅画占两格只解析一次"、"只交 html 的不过这道门"、
 * "缓存不许改答案"、"按标记缓存之所以是精确的"），它们钉的是这一件不许弄坏的东西。
 * 带预算那一节走的是新导出的 `InkCache`，旧代码里根本没有这个名字 —— 它要说的是退出的次序，本来就不
 * 必在旧代码上证明什么。
 */

let parses = 0;
const realParse = DOMParser.prototype.parseFromString;
DOMParser.prototype.parseFromString = function (this: DOMParser, ...args: Parameters<DOMParser["parseFromString"]>) {
  if (args[1] === "image/svg+xml") parses++;
  return realParse.apply(this, args);
};
const counted = (f: () => unknown): number => {
  parses = 0;
  f();
  return parses;
};

// 每调一次给一段没见过的画：这一份账是整份文件共用的一本（模块级），前面的例子先来问过就会把
// 「第一遍」喂饱。用计数器当后缀，保证这一节每一次都是冷账开头。
let tag = 0;
const art = (): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 150" data-n="${tag++}"><rect x="10" y="10" width="80" height="60" fill="#fff"/></svg>`;

const CELL: Box = { x: 0, y: 0, w: 400, h: 300 };
/** 生产形状的带子：每格 build + 一刀镜头 + 一句旁白，和导演一轮一轮落笔时交出来的东西同形。 */
const lesson = (marks: string[]): OpEntry[] => {
  const out: OpEntry[] = [];
  const push = (op: Op) => out.push({ seq: out.length, track: "main", turn: 0, op });
  push({ kind: "narrate", text: "开场", duration: 1200 });
  marks.forEach((s, i) => {
    push({ kind: "build", id: `q${i}`, box: { ...CELL, x: (i % 8) * 2400 }, label: `q${i}`, svg: s });
    push({ kind: "camera", mode: "fit", target: `q${i}`, duration: 700, easing: "ease" });
    push({ kind: "narrate", text: `第 ${i} 句`, duration: 1500 });
  });
  return out;
};

describe("量墨这笔钱：每一格最多付一次，重排不许再付", () => {
  it("整卷 200 格排三遍：第一遍正好 200 次，其后两遍 0 次", () => {
    const t = lesson(Array.from({ length: 200 }, art));
    expect(counted(() => compile(t))).toBe(200);
    expect(counted(() => compile(t))).toBe(0);
    expect(counted(() => compile(t))).toBe(0);
  });

  it("一批一批落笔（每批 40 格，共七批）：全程只解析 280 次", () => {
    // 这一条才是那句「导演落一笔付一秒半」本体：每落一批把整卷重排一遍，于是前面那几百格每批都被重问
    // 一次。改前逐批量到的是 40 / 40 / 40 / 40 / 240 / 480 / 560 —— 前四批看着没问题，到第 161 格那一次
    // 整份抹掉，此后每一批把前面全部重量一遍，合计 1440 次；改后合计正好 280，每一格一生只付一次。
    const all = Array.from({ length: 280 }, art);
    let total = 0;
    for (let k = 1; k <= 7; k++) total += counted(() => compile(lesson(all.slice(0, 40 * k))));
    expect(total).toBe(280);
  });

  it("同一幅画占两格：只解析一次 —— 这一份账按标记记，不按格子记", () => {
    const shared = art();
    const t = lesson([shared, shared]);
    expect(counted(() => compile(t))).toBe(1);
  });

  it("只交 html 的带子不过这道门：400 格解析 0 次", () => {
    // 已知边界里那句「同规模的 html 带子一直是 1ms 量级」的根据：没有 svg 就没有墨可量。
    const t: OpEntry[] = [];
    const push = (op: Op) => t.push({ seq: t.length, track: "main", turn: 0, op });
    for (let i = 0; i < 400; i++) {
      push({ kind: "build", id: `h${i}`, box: { ...CELL, x: (i % 8) * 2400 }, label: `h${i}`, html: `<p data-n="${tag++}">句子 ${i}</p>` });
      push({ kind: "narrate", text: `第 ${i} 句`, duration: 1500 });
    }
    expect(counted(() => compile(t))).toBe(0);
  });

  it("缓存不许改答案：同一卷带子排两遍，逐格逐刀一模一样", () => {
    // 比的这一头必须是**刀**：`fit` 的落点走的是量过墨的那只框，所以每一刀都在问这一份账。格子里那
    // 只 box 是导演声明的那只，它不经过这道门，比它只比出"带子读得一样"。
    const t = lesson(Array.from({ length: 24 }, art));
    const a = compile(t);
    const b = compile(t);
    const cells = (c: typeof a) => [...c.props.values()].flatMap((p) => p.revisions.map((r) => `${p.id}:${r.t}:${r.box.x},${r.box.y},${r.box.w},${r.box.h}`));
    const cuts = (c: typeof a) => c.cues.filter((q) => q.op.kind === "camera").map((q) => `${q.t}:${q.from.x},${q.from.y},${q.to.x},${q.to.y},${q.from.w},${q.to.w}`);
    expect(cuts(b)).toEqual(cuts(a));
    expect(cells(b)).toEqual(cells(a));
    expect(cuts(a)).toHaveLength(24);
    // 落点确实不是声明框的中心：`art()` 那格把墨画在画布左上角，所以每一刀都得过这道门才算出落点。
    const first = a.cues.find((q) => q.op.kind === "camera")!;
    expect(Math.abs(first.to.x - first.from.x)).toBeGreaterThan(1);
  });

  it("按标记缓存之所以是精确的：账上记的是画布里的墨，世界框在外面另算", () => {
    const markup = art();
    const cell = { x: 0, y: 0, w: 800, h: 600 }; // 和 WORLD 同比例、边长正好两倍
    const one = inkBox(markup, WORLD)!;
    const two = inkBox(markup, cell)!;
    const centre = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
    const off = (box: Box, world: Box) => {
      const m = centre(box);
      const c = centre(world);
      return { x: m.x - c.x, y: m.y - c.y };
    };
    // 墨在作者画布里的位置，换到世界就是"框心 + 一段按框缩放过的偏移"。要是这一份记账的是**换算完
    // 的世界框**（键里没带上那只框），第二次问照样命中、照样给出第一只框的答案：z 就成了 a 而不是 2a。
    const a = off(one, WORLD);
    const z = off(two, cell);
    expect(Math.abs(a.x)).toBeGreaterThan(1);
    expect(Math.abs(a.y)).toBeGreaterThan(1);
    expect(z.x).toBeCloseTo(2 * a.x, 6);
    expect(z.y).toBeCloseTo(2 * a.y, 6);
    expect(two.w).toBeCloseTo(2 * one.w, 6);
    expect(two.h).toBeCloseTo(2 * one.h, 6);
  });
});

/*
 * 退出那一头要在**小预算**上钉：真要灌满 4096 条各不相同的画，光是解析就要十几秒，那一头量的是浏览器
 * 不是这一件。小预算上"谁被挤出去、谁留在账上"才是这一件要说的那句话。
 *
 * 每一段画都是现成的、互不相同的（`art()` 里那个计数器），所以"这条重问付不付钱"只由这一份账的次序决定。
 */
const A = art();
const B = art();
const C = art();
const D = art();
const E = art();
const BIG = 10_000_000;

describe("这一份账退出的次序：越界从最久没人问的那一头，一条条退", () => {
  it("问过就算最新：被挤出去的是最久没人问的那一条，不是最早落账的那一条", () => {
    const cache = new InkCache(2, BIG);
    cache.measure(A);
    cache.measure(B);
    expect(counted(() => cache.measure(A))).toBe(0); // 命中：A 换到最新那一头
    // 现在最久没人问的是 B，所以第三格进来挤掉的是 B。
    expect(counted(() => cache.measure(C))).toBe(1);
    expect(counted(() => cache.measure(A))).toBe(0);
    expect(counted(() => cache.measure(B))).toBe(1); // 它被挤过
    // 不"命中就挪"的那份写法：被挤掉的还是 A —— 上面这两条 0 / 1 会翻成 1 / 0。
  });

  it("越界一条条退，不是整份抹掉：留在账上的那几格仍然不付钱", () => {
    const cache = new InkCache(3, BIG);
    for (const m of [A, B, C, D, E]) cache.measure(m);
    expect(cache.size).toBe(3);
    // 挤出去的是最早那两条（A、B），留下的三条一分不付。
    expect(counted(() => cache.measure(C))).toBe(0);
    expect(counted(() => cache.measure(D))).toBe(0);
    expect(counted(() => cache.measure(E))).toBe(0);
    expect(counted(() => cache.measure(A))).toBe(1);
    expect(counted(() => cache.measure(B))).toBe(1);
    // 旧写法在这一处是把整份抹掉：那三条 0 会全变成 1。这里同时钉住"不许修过头"——
    // 越界只许**挤**走最久没人问的那一条，不许**清**。
  });

  it("字数那道才算得回来：握着的字不许越过预算，一条一条退到装得下", () => {
    const cache = new InkCache(10_000, A.length * 3);
    cache.measure(A);
    cache.measure(B);
    cache.measure(C);
    cache.measure(D);
    expect(cache.held).toBeLessThanOrEqual(A.length * 3);
    expect(cache.size).toBe(3); // 按字数挤掉一条，正好还剩三条的位置
    expect(cache.get(A)).toBeUndefined();
    expect(cache.get(B)).not.toBeUndefined();
    expect(cache.get(D)).not.toBeUndefined();
  });

  it("比整份预算还长的画不进这一份账：存进去就是当场全部退出，不如不存", () => {
    // 预算只够一条短画再加一截；那条长画进来谁也容不下，所以它当场把整份账退空 —— 这一件选择让它
    // 干脆不进账（解析照付，只是不占位置）。
    const small = svg('<rect width="8" height="8" fill="#fff"/>');
    const long = `${svg('<rect width="8" height="8" fill="#fff"/>')}<!--${"p".repeat(4000)}-->`;
    const cache = new InkCache(10_000, long.length - 1);
    cache.measure(small);
    expect(counted(() => cache.measure(long))).toBe(1); // 解析一次，不记账
    expect(cache.size).toBe(1);
    expect(cache.held).toBe(small.length);
    expect(counted(() => cache.measure(small))).toBe(0); // 它不许被这笔冤枉钱挤走
    // 少了"不存"那一句：long 进账 → 越界 → 从头一条条退，把 small 连同 long 自己一起退干净，于是
    // 上面那条 0 成了 1、`size` 成了 0。
    expect(cache.get(long)).toBeUndefined();
  });

  it("读不懂的画也记账：null 同样是一答，不许每批重解析一遍最冤枉的那笔钱", () => {
    const unreadable = svg('<use href="#nothing"/>');
    const cache = new InkCache(4, BIG);
    expect(counted(() => cache.measure(unreadable))).toBe(1);
    expect(cache.get(unreadable)).toBeNull(); // 是 null，不是"没问过"
    expect(counted(() => cache.measure(unreadable))).toBe(0);
    // `undefined` 和 `null` 混了，这一条就是那条冤枉钱的门。
  });

  it("对账：退来退去的答案，和当场重解析的答案逐条相同", () => {
    const rows = [
      svg('<rect x="10" y="10" width="40" height="40" fill="#fff"/>'),
      svg('<g transform="translate(120,120) scale(2,1)"><rect width="40" height="40" fill="#fff"/></g>'),
      svg('<path d="M10 20 L30 40 C50 60 70 80 90 100 Z" fill="#fff"/>'),
      svg('<circle cx="20" cy="30" r="0" fill="#fff"/>'), // 没有墨
      svg('<use href="#nothing"/>'), // 读不懂
      svg('<g transform="rotate(30)"><rect width="40" height="40" fill="#fff"/></g>'), // 认不得的变换
      "<p>不是 svg</p>",
      "<svg",
    ];
    // 预算 1 条：每一格进来都把上一格挤走，所以它问什么都是当场重解析 —— 那就是"没有缓存"的参照。
    const honest = new InkCache(1, BIG);
    const thrashed = new InkCache(3, A.length * 4);
    for (const round of [0, 1, 2]) {
      for (const markup of [...rows, art(), art()]) {
        const truth = honest.measure(markup);
        const cached = thrashed.measure(markup);
        expect(cached, `第 ${round} 轮：${markup.slice(0, 40)}`).toEqual(truth);
      }
      expect(thrashed.size).toBeLessThanOrEqual(3);
      expect(thrashed.held).toBeLessThanOrEqual(A.length * 4);
    }
  });

  it("默认的预算就是文中写的那两道：别把它们改回当年那道 160", () => {
    expect(MAX_ENTRIES).toBe(4096);
    expect(MAX_CHARS).toBe(8_000_000);
    // 一道按条数、一道按字：字数那道管的是剪带之后还替早已下台的画握着字符串。
    expect(MAX_ENTRIES).toBeGreaterThan(160);
  });
});
