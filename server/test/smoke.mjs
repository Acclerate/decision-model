/**
 * 冒烟测试：
 *   node test/smoke.mjs          —— mock 模式（无需 API Key，验证整条 MCP 链路）
 *   node test/smoke.mjs --real   —— 追加真实百炼调用（需要 DASHSCOPE_API_KEY）
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { McpClient } from "./client.mjs";

const SERVER = fileURLToPath(new URL("../index.mjs", import.meta.url));
const REAL = process.argv.includes("--real");

async function callJson(c, name, args) {
  const res = await c.request("tools/call", { name, arguments: args }, 90_000);
  if (res.isError) throw new Error(`${name} 返回工具错误: ${res.content?.[0]?.text || "(空)"}`);
  assert.ok(res.content?.[0]?.text, `${name}: 无文本内容`);
  return JSON.parse(res.content[0].text);
}

async function runPass({ mock }) {
  const c = new McpClient({ args: [SERVER], env: mock ? { DECISION_MOCK: "1" } : {} });
  try {
    // 1) initialize
    const init = await c.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "smoke", version: "0.0.1" },
    });
    assert.equal(init.serverInfo.name, "decision-model");
    assert.ok(init.capabilities.tools, "capabilities.tools missing");
    c.notify("notifications/initialized");

    // 2) tools/list
    const list = await c.request("tools/list");
    const names = list.tools.map((t) => t.name);
    for (const expected of ["decide", "decide_choice", "decide_noul", "decide_score", "decision_config"]) {
      assert.ok(names.includes(expected), `缺少工具: ${expected}`);
    }

    // 3) decision_config
    const cfg = await callJson(c, "decision_config", {});
    assert.equal(typeof cfg.api_key_set, "boolean");
    assert.ok(!/sk-[A-Za-z0-9]{8}/.test(JSON.stringify(cfg)), "config 泄漏了 Key");

    // 4) decide_choice
    const choice = await callJson(c, "decide_choice", {
      state: { title: "Nginx upstream", difficulty: 4, mastery: 0.35, importance: 0.85, last_studied: "2026-09-30" },
      question: "下一步应该做什么？",
      options: {
        review: "复习已有知识",
        practice: "动手实践",
        learn_more: "继续学习前置知识",
        archive: "暂时归档",
      },
    });
    assert.ok(choice.choice, "choice 缺少 choice 字段");
    assert.ok(choice.probabilities, "choice 缺少 probabilities");

    // 5) decide_noul
    const noul = await callJson(c, "decide_noul", {
      state: "用户反馈：订单支付后超过 24 小时仍未到账，要求立即处理。",
      question: "是否需要立即通知值班人员？",
    });
    assert.ok(typeof noul.noul === "number", "noul 缺少 noul 字段");
    assert.ok(["yes", "no"].includes(noul.verdict), "noul 缺少 verdict");

    // 6) decide_score
    const score = await callJson(c, "decide_score", {
      state: "订单支付后超过 24 小时仍未到账，核心功能不可用，无替代方案。",
      question: "这个问题有多严重？",
      criteria: ["轻微，不影响功能", "部分功能受影响但有替代方案", "核心功能不可用", "严重业务或安全影响"],
    });
    assert.ok(typeof score.score === "number", "score 缺少 score 字段");
    assert.ok(score.legend, "score 缺少 legend");

    // 7) decide 批量
    const batch = await callJson(c, "decide", {
      state: { ticket_id: "T-1001", content: "发票抬头写错了，请帮忙重新开票。产品功能正常，没有其他异常。" },
      questions: {
        department: {
          type: "choice",
          instructions: "应该由哪个团队处理？",
          criteria: { billing: "支付、退款和账单问题", technical: "产品故障和集成问题" },
        },
        escalate: { type: "noul", instructions: "是否需要立即通知值班人员？" },
        severity: { type: "score", instructions: "严重程度", criteria: ["轻微", "部分受影响", "核心不可用", "严重业务影响"] },
      },
    });
    assert.ok(batch.answers?.department && batch.answers?.escalate && batch.answers?.severity, "批量 answers 不完整");

    // 8) 错误处理：choice 缺 options 应报工具错误而非崩溃
    const bad = await c.request("tools/call", { name: "decide_choice", arguments: { state: "x", question: "选哪个？" } });
    assert.equal(bad.isError, true, "缺少 options 应返回 isError");

    return {
      choice, noul, score, batch,
      config: cfg,
    };
  } finally {
    c.close();
  }
}

console.log("[1/2] mock 模式...");
const mockResult = await runPass({ mock: true });
console.log("[1/2] mock 模式: PASS");
console.log("  mock 示例 answers.decision(choice):", JSON.stringify(mockResult.choice));

if (REAL && process.env.DASHSCOPE_API_KEY) {
  console.log("[2/2] 真实百炼 API...");
  try {
    const real = await runPass({ mock: false });
    console.log("[2/2] 真实百炼 API: PASS");
    console.log("  真实 answers.decision(choice):", JSON.stringify(real.choice));
    console.log("  真实 usage:", JSON.stringify(real.batch.usage ?? real.choice.usage));
  } catch (e) {
    if (/缺少 endpoint/.test(e.message)) {
      console.log("[2/2] 真实百炼 API: 跳过 ——", e.message);
    } else {
      throw e;
    }
  }
} else {
  console.log("[2/2] 真实百炼 API: 跳过（未传 --real 或未设置 DASHSCOPE_API_KEY）");
}

console.log("ALL PASS");
