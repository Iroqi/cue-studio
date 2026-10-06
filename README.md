# Cue Studio

一个 LLM 驱动的教师代理。它的媒介不是幻灯片，是一块无界的二维舞台平面（backstage）和一架摄影机 —— 知识被**演**出来，不是被列出来。

## 为什么它不是一个 artifact

常见的 AI artifact 是编译型的：模型一次生成一个成品。这里相反。

模型每次调用只发出一条 `op`（"说这句话，12 秒"、"把这支向量放到板上"、"镜头推到箭头尖"），追加进一条**只增不删的日志**。解释器把日志演化成舞台：道具表、时钟、镜头轨迹、门（gate）。成品不存在，只有过程 —— 这是"解释型"和"编译型"的区别。

推论：一堂课 = 一段磁带。所以分享（日志 deflate 后塞进 URL hash）、重放、从任意一拍截断重排，全都是日志的副产品，没有一个是单独实现的功能。

## 词汇

代码、提示词、UI 用的是同一套词，没有第二套命名。

| 词 | 是什么 |
| --- | --- |
| backstage | 无界二维平面。一场戏约 1600×900 单位，场景之间相隔 2000~3000 |
| prop 道具 | 平面上有身份的对象。**id 跨场景持续** —— 第三幕那个箭头仍然是第一幕那一个 |
| revision | 同一道具的一次外观变更（画错了重画、补细节），带自己的时间和 `box` |
| cue | 一次工具调用 = 一个 cue，落在舞台时间轴上 |
| beat | 刻意的静默，让画面自己站住 |
| gate | 停时钟等学习者的地方：`ask_learner` / `pause_for` |
| tape | 日志本身，可导出、可分享、可重演 |

## 时间规则（最要紧的一条设计）

只有 `narrate` / `beat` / `transition` **占时钟**。`camera`、`highlight`、`motion` 是叠在旁白之上的覆盖层，不推进时间。

所以"这一段讲多久"由旁白决定，运镜不能把课拖长。`motion` 的位移是**舞台时间的纯函数**（oscillate / approach / orbit / iterate / flow）—— cue 一结束道具回到它的锚点，倒带回去它也在那个位置。

道具的坐标是它的**锚点**，不是某一帧。想让一个东西自己动，是发一个 motion cue，不是一帧帧重画。

## 导演能说什么（18 个动词）

- 编排：`stage_script`（一次调用铺好整场骨架：每拍说什么、多长、镜头怎么动、道具落在哪）
- 立道具：`build` `draw`（`draw` 把图形交给美工模型生成）`move` `discard` `recall` `link` `fetch_prop`
- 观看：`camera`（fit / focus / pan / zoom / track，特写取道具自身的一个部位分数点）`transition`（dissolve / wipe / match-cut / split）`highlight`（pulse / outline / dim-rest / shake）`motion`
- 时钟：`narrate`（三种上屏方式：caption 底下一行字 / verse 整句落在板心 / voice 只出声不上字）`beat`
- 回路：`ask_learner`（带 `concept`，答完才继续，答案作为工具结果回来，导演据此分叉）`pause_for`
- 状态：`note_progress` `stage_state`

道具的 SVG 源码默认**不在模型上下文里**，要看就 `fetch_prop`。上下文按预算裁剪。

## 两个角色

导演负责编排，美工（`PAINTER`）只画图不说话，产出一个内联 `<svg>`。你会看到它在舞台上逐笔长出来。两条路径共用同一个 `Teacher.ask()`，所以服务商限流的退避对两个角色一视同仁 —— 美工失败不再是"把错误文本回给导演、让他再烧一次限流窗口"。

## 3D 是数据，不是代码

`scene3d` 是一份声明式图元表（box / sphere / cylinder / cone / torus / plane / line / arrow + camera / spin / grid / axes），由 `engine/Scene3D.tsx` 里我们自己的解释器编译成 three.js 对象。入参过白名单：形状枚举、fov 夹在 10..120、颜色必须是 `#hex`、图元数量截到 64。

一支 3D 道具是**二维板上的一扇内嵌窗**：它仍然持有一个二维 `box`，平板摄影机负责框它、平移它，三维相机只往窗里看。两把相机分层，永不打架。所以 3D 能进日志、能分享、能重放。

`spin` 是 t 的纯函数（可重放）；`interactive` 的拖动角度是**学习者状态，不入带** —— 遥测条会明说这一点。

## 没有 JS 沙箱（明确的取舍）

模型只能交 markup，不能交代码。`sanitize()` 剥掉 `script` / `iframe` / `object` / `embed` / `link` / `meta` 六类标签、所有 `on*=` 内联事件、以及 `javascript:` 伪协议；道具在 shadow root 里渲染（作用域隔离，模型写的 CSS 动不到外壳）。

代价：板上的东西不会自己跑逻辑。收益：日志可信、可重放、可分享，且不用担心任意代码执行。

## 跑起来

```bash
npm install
npm run dev            # http://localhost:5173
```

**排练模式（不花一个 token）**：配置抽屉顶部勾"本地排练模式（不联网，用固定谱子驱动同一套舞台）"，走 pi-ai 的 faux provider（进程内 yield 一份固定谱子：向量加法 / 力的分解）。引擎语义、运镜、转场、gate、打断回卷、录像重放都在这一层验。

**接真模型**：打开配置抽屉的"模型接入"，加一个 provider。支持两种形状：`openai-completions`（OpenAI 兼容 `/chat/completions`）和 `anthropic-messages`。密钥存在 `localStorage`（`canvas-teacher.credential.<id>`），配置行为 `canvas-teacher.llm`。

纯浏览器直连、无后端网关、无账号 —— 所以 key 在 DevTools 里可见。这是 grilling 阶段定下并**已接受**的架构代价，不是 bug。

旁白用浏览器自己的 `speechSynthesis`，不接外部 TTS 服务。

```bash
npm run build          # tsc -b && vite build
npm run lint           # oxlint
```

## 验证分三层

别拿 fixture 的绿灯当服务商链路的绿灯。

1. **排练模式（faux）**：只证明"我自己的代码自洽"。
2. **mock OpenAI 兼容服务**（`scripts/mock-openai.mjs`，自己的 Node 进程）：验传输适配器形状。开关：`MOCK_PORT`、`MOCK_HOLD=<ms>`（拖住首拍以量冷启动窗口）、`MOCK_429=<role>:<N>`（该角色前 N 次返回真 HTTP 429）、话题里写 `MOCK-TRUNC-N`（前 N 次导演调用只回 reasoning + `finish_reason=length`）。计数器是进程全局的，换场景要重启 mock。
3. **真实服务商**：端到端跑完整堂课才算证。

双端对账是唯一免疫观察通道污染的办法：mock 的 stdout 记"发出了几条什么形状"，页面 transcript 记"收到几条 / 推了几条 nudge"，两边对上才算。

服务商限流通常是 **tokens-per-minute**：单场长课能吃到十几万 tokens。测完一轮要算代价，别为验证反复开真课。

## 目录

```
src/engine/   日志、解释器、编译、相机、运动、旁白时钟、分享、3D 解释器、舞台渲染
src/agent/    主循环、上下文预算、提示词、学习者档案、排练谱子
src/tools/    导演工具面（动词 schema + 入参白名单）
src/llm/      传输适配（两种 api 形状、凭据存储、限流退避）
src/ui/       模型配置、节拍条、学习者档案
```

## 已知边界

- 密钥在 localStorage，DevTools 可见（见上）。
- 3D 的拖动角度不进分享链接（设计决定：那是学习者状态，不是演出）。
- `build` 的 `here`（"落在当前镜头正中"）目前只有 mock/faux 覆盖过 —— 真实模型每次都报了坐标。不是缺陷，但也别当成真机验证过的东西。
