/**
 * HTTP 传输韧性测试（离线，本地 node:http 假网关，无需 API Key）：
 *   node test/retry.test.mjs
 *
 * 场景：
 *   A. 429×2 → 200：重试后成功，恰好 3 次尝试
 *   B. 恒 500：重试到 maxAttempts 后报错
 *   C. 假网关回显 Authorization：错误文本不得含 Key 明文（脱敏）
 *   D. 400：非重试状态码立即失败，只有 1 次尝试
 */
import assert from "node:assert/strict";
import http from "node:http";
import { decide } from "../bailian.mjs";

const KEY = "sk-test-SECRET-0123456789";
const OK_BODY = {
  model: "test",
  request_id: "req-fake-1",
  answers: {
    q1: { type: "choice", choice: "a", confidence: 0.9, probabilities: { a: 0.9, b: 0.1 } },
  },
  usage: { input_tokens: 10 },
  latency_ms: 5,
};
const INPUT = { state: "测试", questions: { q1: { type: "choice", criteria: { a: "甲", b: "乙" } } } };

/** script: 依序返回的状态码（最后一项之后恒重复）；错误体回显 Authorization 头以测脱敏。 */
function startGateway(script) {
  let hits = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits++;
      const status = script[Math.min(hits - 1, script.length - 1)];
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(
        status === 200
          ? JSON.stringify(OK_BODY)
          : JSON.stringify({ error: { message: `gateway echo: ${req.headers.authorization}` } }),
      );
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, get hits() { return hits; } })),
  );
}

const cfgFor = (port) => ({
  baseUrl: `http://127.0.0.1:${port}/v1/systemone`,
  apiKey: KEY,
  model: "test",
  timeoutMs: 5_000,
  maxAttempts: 3,
  mock: false,
});

// A. 429×2 → 200
{
  const gw = await startGateway([429, 429, 200]);
  const resp = await decide(INPUT, cfgFor(gw.server.address().port));
  assert.equal(resp.answers.q1.choice, "a");
  assert.equal(resp.invalid_questions, undefined, "成功响应不应有 invalid_questions");
  assert.equal(gw.hits, 3, `应有 3 次尝试，实际 ${gw.hits}`);
  gw.server.close();
  console.log("  ✓ A. 429×2 → 200：第 3 次尝试成功");
}

// B. 恒 500 → maxAttempts 次后失败
{
  const gw = await startGateway([500]);
  await assert.rejects(
    () => decide(INPUT, cfgFor(gw.server.address().port)),
    (e) => /HTTP 500/.test(e.message) && /重试/.test(e.message),
  );
  assert.equal(gw.hits, 3, `应重试满 3 次，实际 ${gw.hits}`);
  gw.server.close();
  console.log("  ✓ B. 恒 500：3 次尝试后报错，错误含重试说明");
}

// C. 回显 Authorization 的 500 → 错误文本不含 Key 明文
{
  const gw = await startGateway([500]);
  let err;
  await assert.rejects(() => decide(INPUT, cfgFor(gw.server.address().port)), (e) => (err = e, true));
  assert.ok(!err.message.includes(KEY), "错误文本泄漏了 API Key 明文！");
  assert.ok(err.message.includes("***"), "脱敏占位符未出现");
  gw.server.close();
  console.log("  ✓ C. 错误脱敏：Key 明文未出现，替换为 ***");
}

// D. 400 非重试状态码 → 立即失败
{
  const gw = await startGateway([400]);
  await assert.rejects(() => decide(INPUT, cfgFor(gw.server.address().port)), /HTTP 400/);
  assert.equal(gw.hits, 1, `非重试状态码不应重试，实际 ${gw.hits} 次`);
  gw.server.close();
  console.log("  ✓ D. HTTP 400：立即失败，仅 1 次尝试");
}

console.log("\nretry.test.mjs: 4 scenarios ALL PASS");
