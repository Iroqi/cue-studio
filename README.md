# Cue Studio

一个 LLM 驱动的教师agent。它的媒介不是幻灯片，是一块无界的二维舞台平面（backstage）和一架摄影机 —— 知识被**演**出来，不是被列出来。

## 为什么它不是一个 artifact

常见的 AI artifact 是编译型的：模型一次生成一个成品。这里相反。

模型每次调用只发出一条 `op`（"说这句话，12 秒"、"把这支向量放到板上"、"镜头推到箭头尖"），追加进一条**只增不删的日志**。解释器把日志演化成舞台：道具表、时钟、镜头轨迹、门（gate）。成品不存在，只有过程 —— 这是"解释型"和"编译型"的区别。

推论：一堂课 = 一段磁带。所以分享（日志 deflate 后塞进 URL hash）、重放、从任意一拍截断重排，全都是日志的副产品，没有一个是单独实现的功能。

## 词汇

代码、提示词、UI 用的是同一套词，没有第二套命名。

| 词 | 是什么 |
| --- | --- |
| backstage | 无界二维平面。一场戏约 1600×900 单位，场景之间相隔 2000~3000。**一块被命名过的板就有位置**，哪怕它还是空的（`BOARD_SPACING = 2400`，按演出走上它的顺序排开）—— 否则切过去的那一刀没有地方可去 |
| prop 道具 | 平面上有身份的对象。**id 跨场景持续** —— 第三幕那个箭头仍然是第一幕那一个 |
| revision | 同一道具的一次外观变更（画错了重画、补细节），带自己的时间和 `box` |
| cue | 一次工具调用 = 一个 cue，落在舞台时间轴上 |
| beat | 刻意的静默，让画面自己站住 |
| gate | 停时钟等学习者的地方：`ask_learner` / `pause_for` |
| tape | 日志本身，可导出、可分享、可重演 |

## 时间规则（最要紧的一条设计）

只有 `narrate` / `beat` / `transition` **占时钟**。`camera`、`highlight`、`motion` 是叠在旁白之上的覆盖层，不推进时间。

覆盖层到点就走，不留痕：`highlight` 的四种里，`dim-rest` 是唯一打在**板子**而不是打在道具上的强调 —— 被点名的那块保住亮度，其余的退到后面（类名挂在 `.world` 上，因为"其余的"没法写进一条道具选择器里）。

所以"这一段讲多久"由旁白决定，运镜不能把课拖长。`motion` 的位移是**舞台时间的纯函数**（oscillate / approach / orbit / iterate / flow）—— cue 一结束道具回到它的锚点，倒带回去它也在那个位置。

道具的坐标是它的**锚点**，不是某一帧。想让一个东西自己动，是发一个 motion cue，不是一帧帧重画。

第二条规则：**时钟不许跑在画面前面**。首次演出时，只要镜头框住一个还没有任何图形的空框、而它的 `paint` 正在进行，`tick()` 就不推进 `t`（`playing` 保持 true，rAF 继续转，所以美工一交图它自己接上走）。美工开始流式吐线的那一刻就放行 —— 3b1b 的节奏是"边画边讲"，毛病出在"讲完了画还没出现"。重放时 `live=false`，画面早就在日志里，不需要等。

第三条规则，和第二条同一条：**也不许跑在没有观众的房间里**。时钟读的是墙上的表，而隐藏标签页的 rAF 被浏览器 throttled 成一秒一格 —— 学习者切出去两分钟再回来，看到的可能是一堂已经演完的课，旁白还对着空房间念完了全程。所以 `visibilitychange` 一到就把时钟停住，回到前台自己接上；学习者自己按下的暂停不会被我们替他续上，`tick()` 也拒绝在 `playing=false` 时推进（那一格迟到的回调不是走钟的理由）。

## 导演能说什么（19 个动词）

- 编排：`stage_script`（一次调用铺好整场骨架：每拍说什么、多长、镜头怎么动、道具落在哪）
- 立道具：`build` `draw`（导演自己给 svg/html/scene3d）`move` `discard` `recall` `link` `fetch_prop`
- 交给美工：`paint`（只描述"它是什么、要表达什么关系"，图形由第二个模型生成，逐笔长在舞台上；画坏了就把这个刚立起来的空框撤掉）
- 观看：`camera`（fit / focus / pan / zoom / track，特写取道具自身的一个部位分数点）`transition`（dissolve / wipe / match-cut / split）`highlight`（pulse / outline / dim-rest / shake）`motion`
- 时钟：`narrate`（三种上屏方式：caption 底下一行字 / verse 整句落在板心 / voice 只出声不上字）`beat`
- 回路：`ask_learner`（带 `concept`，答完才继续，答案作为工具结果回来，导演据此分叉）`pause_for`
- 状态：`note_progress` `stage_state`

道具的 SVG 源码默认**不在模型上下文里**，要看就 `fetch_prop`。（历史本身**还没有**按预算裁剪 —— 见"已知边界"。）

## 两个角色

导演负责编排，美工（`PAINTER`）只画图不说话，产出一个内联 `<svg>`。你会看到它在舞台上逐笔长出来。两条路径共用同一个 `Teacher.ask()`，所以服务商限流的退避对两个角色一视同仁 —— 美工失败不再是"把错误文本回给导演、让他再烧一次限流窗口"。

美工的契约是**透明背景**：舞台本身就是一块深色黑板（带底色和网格），道具是直接画在它上面的，所以不许交满幅矩形、不许写 `background`。契约之外还有兜底：`StageView` 在注入 shadow root 之后，把 svg 的**第一个直接子 `<rect>`** 剥掉 —— 条件是它不透明（含 SVG 默认的"无 fill = 黑"）、无边框、起点在画面角上且盖住 90% 以上 viewBox。带 `fill-opacity`、留了边距的托底块、`fill="none"` 的边框框都原样保留。

取景有下限：部位特写（`camera` 的 `at`/`span`，默认 span 0.45）、`zoom`、`focus`、单道具 `fit` 都不再把画面框收进 **450** 世界单位以内（`MIN_CLOSEUP_W`）—— 美工的最小字号是 28 单位，450 单位约 3.5 倍放大，字仍然是一个字；旧下限 260 是六倍多，标签被吹成一面墙。

## 3D 是数据，不是代码

`scene3d` 是一份声明式图元表（box / sphere / cylinder / cone / torus / plane / line / arrow + camera / spin / grid / axes），由 `engine/Scene3D.tsx` 里我们自己的解释器编译成 three.js 对象。入参过白名单：形状枚举、fov 夹在 10..120、颜色必须是 `#hex`、图元数量截到 64、和板同色的 `background` 被丢掉（那是从 3D 窗里偷渡进来的第二块板）。

白名单住在 `engine/guard.ts`，不在导演工具里 —— 因为能站到解释器面前的有两条路：一次工具调用，和**别人录的一段带**（`#s=` 链接、导入）。以前只有第一条有门。

一支 3D 道具是**二维板上的一扇内嵌窗**：它仍然持有一个二维 `box`，平板摄影机负责框它、平移它，三维相机只往窗里看。两把相机分层，永不打架。所以 3D 能进日志、能分享、能重放。

`spin` 是 t 的纯函数（可重放）；`interactive` 的拖动角度是**学习者状态，不入带** —— 遥测条会明说这一点。

## 没有 JS 沙箱（明确的取舍）

模型只能交 markup，不能交代码。`sanitize()` 剥掉 `script` / `iframe` / `object` / `embed` / `link` / `meta` 六类标签、所有 `on*=` 内联事件、以及 `javascript:` 伪协议；道具在 shadow root 里渲染（作用域隔离，模型写的 CSS 动不到外壳）。

代价：板上的东西不会自己跑逻辑。收益：日志可信、可重放、可分享，且不用担心任意代码执行。

"日志可信"有一句前提：**可信是因为它过了门**。分享链接把整段日志 deflate 进 URL，重放时没有任何模型在场，所以 `#s=` 里的那些 op 也是输入。门在 `engine/log.ts` 的 `append()` 和 `restore()` 上，两条路共用 `guardOp()`：坏字段被默认，不被整卷拒绝 —— 磁带是别人上的一节课，点链接的人没有犯错。

## 公式是排版的，不是手画的

道具 markup 里任何带 `class="tex"` 的元素，它的文本内容会被 KaTeX 排成 **MathML**，浏览器自己完成排版。契约就一条：给一个 `<text>` 挂上 `class="tex"`，内容写 LaTeX（`<text class="tex" x="40" y="90" font-size="48" fill="#fde68a">\vec r=\vec a+\vec b</text>`）—— `y` 是基线，窗口的位置和宽高由舞台算。模型自己写的 `<foreignObject>` 不算入口：DOMPurify 把它列进 svg 禁用表（那是 mutation-XSS 的门），净化器会把这扇窗连同里面的公式一起删掉，所以只有 `class="tex"` 这一条路。

只取 `output: 'mathml'`：不引 KaTeX 的 CSS，不搬它的 woff2，不改写任何 `url()`。日志里存的仍是那串 LaTeX 源码 —— 所以公式进得了分享链接、重放和重排，而且它跟着画面一起被特写放大，和一条笔画同样缩放。

代价：MathML 的渲染细节由浏览器决定（Chrome/Safari/Firefox 原生，旧浏览器会退化成一行普通文本）。这是换来的：真分数、根号、下标、矩阵，零样式注入。

## 哪些轮子是借的，哪些是自己造的

借的：`@earendil-works/pi-ai`（模型传输、流式、凭据、faux provider）、`three`（3D 图形栈）、浏览器自己的 SVG/HTML/CSS 引擎（2D 表达面就是标准 DOM，没有再包一层）、`speechSynthesis`（配音）、`katex`（只做 LaTeX→MathML 的字符串转换，排版交给浏览器，见上）。

自己造的只有三样，且都有理由：**op 日志 + 解释器**（没有任何库把"只增不删的指令带"当唯一真相，从而让分享、重放、重排都是副产品）；**时钟归旁白**（GSAP / Motion Canvas 这类 tween 库要夺走时间的所有权，而这里 `t` 必须是纯函数，倒带和分享才可能字节一致）；**二维板 + 摄影机**（Pixi/Konva 这类保留模式画布吃的是解析好的图元，接不住"模型边吐 markup 边长出来"的磁带头，也没有 shadow root 的作用域隔离）。

结论：表达层没有重造轮子 —— 它就是 DOM；重造的是**时间的所有权**，那是这个产品区别于"一段渲染好的视频"的地方。

## 跑起来

```bash
npm install
npm run dev            # http://localhost:5173
```

**排练模式（不花一个 token）**：只在 `npm run dev` 下出现——配置抽屉顶部会多一个"本地排练模式（不联网，用固定谱子驱动同一套舞台）"的勾，勾上即走 pi-ai 的 faux provider（进程内 yield 一份固定谱子：向量加法 / 力的分解）。生产构建里这个勾根本不渲染，`DEFAULT_CONFIG.scripted = false`。引擎语义、运镜、转场、gate、打断回卷、录像重放都在这一层验。

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
src/engine/   日志、解释器、编译、相机、运动、旁白时钟、分享、3D 解释器、公式排版、舞台渲染、磁带白名单（guard）
src/agent/    主循环、上下文预算、提示词、学习者档案、排练谱子
src/tools/    导演工具面（动词 schema；入参白名单在 engine/guard，两条进门的路共用）
src/llm/      传输适配（两种 api 形状、凭据存储、限流退避）
src/ui/       模型配置、节拍条、学习者档案
```

## 已知边界

- 密钥在 localStorage，DevTools 可见（见上）。
- 3D 的拖动角度不进分享链接（设计决定：那是学习者状态，不是演出）。
- `build` 的 `here`（"落在当前镜头正中"）由 `compile.test.ts` 钉住了语义（同帧让位、跟着本拍的 pan 走、命名别的板就落到那块板的地皮上），但真机上仍只有 mock/faux 触发过 —— 真实模型每次都自己报了坐标。
- **对话历史不按预算裁剪。** `ModelConfig` 里存着 `contextWindow`，但 `Teacher.messages` 只增不减，没有读过那个数。一部长课（加上美工流回来的整幅 SVG）迟早撞到服务商的窗口上限。目前唯一真正省下上下文的东西是"道具源码默认不在上下文里，要就 `fetch_prop`"。
- `inkBox` 只测平移和缩放两种变换，遇到 rotate/skew 就明说"这 estimate 不可信"并退回声明的 box —— 宁可瞄框，不瞄一个算错的墨迹位置。
- `guardOp` 只兜解释器会算错的东西（数字、枚举、数量上限）。它不判断语义：一段把三板堆在同一个坐标上的带照样能过门，那是编课的问题，不是安全的问题。
