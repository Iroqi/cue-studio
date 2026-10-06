// Minimal OpenAI-compatible SSE endpoint used to verify the browser-side model
// wiring (adapter, streaming tool calls, CORS). Not part of the product.
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 5599);
let calls = 0;
let paints = 0;
let rerolls = 0;
let trunc = 0;
let throttled = 0;

const BASE_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

function cors(req) {
  // pi-ai drives the official OpenAI SDK, which sends x-stainless-* headers we cannot enumerate.
  const requested = req.headers["access-control-request-headers"];
  return { ...BASE_CORS, ...(requested ? { "Access-Control-Allow-Headers": requested } : {}) };
}

function chunk(o) {
  return `data: ${JSON.stringify(o)}\n\n`;
}

function streamToolCall(res, name, argsJson, idBase) {
  const parts = argsJson.match(/.{1,24}/gs) ?? [];
  res.write(chunk({ id: "id", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta: { role: "assistant" } }] }));
  parts.forEach((p, i) => {
    res.write(
      chunk({
        id: "id",
        object: "chat.completion.chunk",
        created: 0,
        model: "mock",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: i === 0 ? `${idBase || "call"}_${calls}` : undefined,
                  type: "function",
                  function: { name: i === 0 ? name : undefined, arguments: p },
                },
              ],
            },
          },
        ],
      }),
    );
  });
  res.write(chunk({ id: "id", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
  res.write("data: [DONE]\n\n");
  res.end();
}

function streamText(res, text) {
  for (const p of text.match(/.{1,40}/gs) ?? []) {
    res.write(chunk({ id: "id", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta: { content: p } }] }));
  }
  res.write(chunk({ id: "id", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
  res.write("data: [DONE]\n\n");
  res.end();
}

/**
 * The shape a reasoning model produces when the output ceiling is spent inside its own head:
 * reasoning chunks and nothing else, cut off with `length`. Used to check that the wire format
 * reaches the loop as a thinking-only assistant message, which is what the retry branch keys on.
 */
function streamReasoningOnly(res, text) {
  for (const p of text.match(/.{1,40}/gs) ?? []) {
    res.write(chunk({ id: "id", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta: { reasoning_content: p } }] }));
  }
  res.write(chunk({ id: "id", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "length" }] }));
  res.write("data: [DONE]\n\n");
  res.end();
}

const SVG = (label, color) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 310"><g stroke-linecap="round"><line x1="40" y1="270" x2="460" y2="50" stroke="${color}" stroke-width="10"/><polygon points="470,45 440,55 465,80" fill="${color}"/><text x="150" y="200" fill="#e8e6f0" font-family="system-ui" font-size="48">${label}</text></g></svg>`;

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors(req));
    return res.end();
  }
  const CORS = cors(req);
  const url = req.url ?? "";
  if (url.endsWith("/models")) {
    res.writeHead(200, { ...CORS, "content-type": "application/json" });
    return res.end(JSON.stringify({ data: [{ id: "mock-director" }, { id: "mock-painter" }] }));
  }
  if (!url.endsWith("/chat/completions")) {
    res.writeHead(404, CORS);
    return res.end("nope");
  }
  const body = await new Promise((r) => {
    let s = "";
    req.on("data", (d) => (s += d));
    req.on("end", () => r(JSON.parse(s || "{}")));
  });
  const sys = JSON.stringify(body.messages?.[0] ?? "");
  const isPainter = sys.includes("舞台美术");

  // MOCK_429=painter:2 — answer that role's next N calls with a hard rate limit. Both roles draw on the
  // same tokens-per-minute budget, so the backoff has to be measurable over real HTTP, not only in the
  // director's path. The log line below is the record of what actually went on the wire.
  const throttle = /^(\w+):(\d+)$/.exec(process.env.MOCK_429 ?? "");
  if (throttle && throttle[1] === (isPainter ? "painter" : "director") && throttled < Number(throttle[2])) {
    throttled += 1;
    console.log(`→ ${isPainter ? "painter" : "director"} call (model=${body.model}, msgs=${body.messages?.length ?? 0})`);
    console.log(`  ↳ 429 for ${throttle[1]} attempt ${throttled}/${throttle[2]}`);
    res.writeHead(429, { ...CORS, "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { type: "rate_limit_error", message: `Rate limit exceeded (mock ${throttled})` } }));
  }

  res.writeHead(200, { ...CORS, "content-type": "text/event-stream" });

  console.log(`→ ${isPainter ? "painter" : "director"} call (model=${body.model}, msgs=${body.messages?.length ?? 0})`);
  if (isPainter) {
    paints += 1;
    return streamText(res, SVG(paints === 1 ? "a" : "b", paints === 1 ? "#7dd3fc" : "#f0abfc"));
  }

  // A re-performance request: prove the tape can be cut and re-staged, not only appended to.
  const users = (body.messages ?? []).filter((m) => m.role === "user");
  const lastUser = String(users[users.length - 1]?.content ?? "");
  if (lastUser.includes("撤下来重排")) {
    rerolls += 1;
    console.log(`  ↳ reroll pass ${rerolls}`);
    if (rerolls === 1) return streamToolCall(res, "narrate", JSON.stringify({ text: "重排版：先看终点，再回头看走过的那两条路。", seconds: 5 }));
    if (rerolls === 2) return streamToolCall(res, "highlight", JSON.stringify({ target: "va", style: "outline", seconds: 2 }));
    return streamText(res, "这一版我把重点挪到终点了 —— 够了，往下走。");
  }

  calls += 1;
  // MOCK_HOLD=ms: stall the first director answer so the cold-start window is long enough to measure.
  if (calls === 1 && process.env.MOCK_HOLD) {
    console.log(`  ↳ holding the first answer for ${process.env.MOCK_HOLD}ms`);
    await new Promise((r) => setTimeout(r, Number(process.env.MOCK_HOLD)));
  }
  // `MOCK-TRUNC-N` in the topic: answer the first N director calls with nothing but reasoning,
  // cut off at the ceiling. The console line below is the record of what actually went on the wire.
  const wantTrunc = Number(/MOCK-TRUNC-(\d+)/.exec(String(body.messages?.map((m) => m.content).join(" ")))?.[1] ?? 0);
  if (trunc < wantTrunc) {
    trunc += 1;
    console.log(`  ↳ truncated thinking-only pass ${trunc}/${wantTrunc} (sent finish_reason=length)`);
    return streamReasoningOnly(res, `先把这一场在脑中推演一遍：原点、旋转、90 度、复平面上的一段弧……${trunc}`);
  }
  if (calls === 1) {
    return streamToolCall(
      res,
      "stage_script",
      JSON.stringify({
        title: "mock",
        beats: [
          { scene: "S1", say: "看这条 a —— 它从左下角出发，指向右上。", seconds: 6, props: [{ id: "va", label: "向量 a", scene: "S1", x: 200, y: 500, w: 520, h: 310 }], camera: { mode: "fit", target: ["va"], duration: 900 } },
          { scene: "S1", say: "再接上 b，起点必须咬住 a 的终点。", seconds: 6, props: [{ id: "vb", label: "向量 b", scene: "S1", x: 720, y: 250, w: 520, h: 310 }] },
        ],
      }),
    );
  }
  if (calls <= 3) {
    return streamToolCall(res, "paint", JSON.stringify({ id: calls === 2 ? "va" : "vb", brief: "一条向量箭头", scene: "S1" }));
  }
  if (calls === 4) {
    return streamToolCall(res, "ask_learner", JSON.stringify({ prompt: "a 的终点和 b 的起点重合了吗？", options: ["重合了", "没重合"], answer: 0 }));
  }
  if (calls === 5) {
    return streamToolCall(res, "motion", JSON.stringify({ id: "vb", mode: "approach", axis: "both", amp: 240, decay: 900, seconds: 4 }));
  }
  return streamText(res, "b 是从 a 的终点长出去的 —— 记住这个方向感就够了。");
});

server.listen(PORT, () => console.log(`mock openai-compatible on http://localhost:${PORT}/v1`));
