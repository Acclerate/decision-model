#!/usr/bin/env node
/**
 * Decision Model MCP server — 零依赖、stdio 传输（newline-delimited JSON-RPC 2.0）。
 *
 * 能力层定位：只封装百炼 Decision Model（System One 协议）调用与入参校验，
 * 不做决策策略；何时调用、criteria 设计、阈值策略见 decision skill。
 *
 * 工具：
 *   decide          批量决策（state + questions 问题表，一次前向返回全部答案）
 *   decide_choice   单项：封闭选项多选一 → choice + probabilities + confidence
 *   decide_noul     单项：是否判断 → P(yes) ∈ [0,1] + verdict
 *   decide_score    单项：量表打分 → score（概率加权期望）+ level + probabilities + confidence
 *   decision_config 查看解析配置（排错用，不回显 Key）
 */

import { createInterface } from "node:readline";
import {
  decide,
  decideChoice,
  decideNoul,
  decideScore,
  loadConfig,
  configSummary,
} from "./bailian.mjs";

const SERVER_INFO = { name: "decision-model", version: "1.0.0" };

const TOOLS = [
  {
    name: "decide",
    title: "批量结构化决策",
    description:
      "调用百炼 Decision Model 做一批结构化决策（System One 协议，一次前向，不生成文本）。" +
      "state 为业务状态（字符串/对象/数组）；questions 为问题表，key 是自定义问题 id，value 含 type/instructions/criteria：" +
      "type=choice 封闭选项多选一（criteria 为 选项名→描述 对象，1~255 项，建议补 other 兜底）；" +
      "type=noul 是否判断（返回 P(yes)∈[0,1]，0=否 1=是）；" +
      "type=score 有序量表打分（criteria 为从低到高的档位描述数组，2~255 项，建议 3~7 且每档可清晰区分）。" +
      "一次请求可混合多个问题（建议 ≤16，延迟随问题数近线性）。" +
      "执行阈值经验：最高选项概率 ≥0.8 且 confidence ≥0.6 才适合自动执行；0.5~0.8 建议复核；<0.5 不要自动执行。",
    inputSchema: {
      type: "object",
      required: ["state", "questions"],
      properties: {
        state: {
          type: ["string", "object", "array"],
          description: "待决策的业务状态：工单文本、对话或结构化对象（对象会被序列化后送模型）",
        },
        questions: {
          type: "object",
          description: '问题表：key=自定义问题 id；value={type, instructions?, criteria?}，如 {"next_action": {"type": "choice", "criteria": {"review": "复习", "practice": "实践"}}}',
          additionalProperties: {
            type: "object",
            required: ["type"],
            properties: {
              type: { type: "string", enum: ["choice", "noul", "score"], description: "choice 多选一 / noul 是否 / score 量表" },
              instructions: { type: "string", description: "问题描述或评判标准" },
              criteria: {
                description:
                  "choice: {选项名: 描述}；score: 从低到高的档位描述数组(2~255)；noul: 可省略或 {true: 描述, false: 描述}",
              },
            },
          },
        },
      },
    },
  },
  {
    name: "decide_choice",
    title: "单项选择决策",
    description:
      "单一 choice 决策：给 state 与互斥的封闭选项集，返回选中项 choice、各选项概率分布 probabilities 与 confidence。" +
      "选项务必互斥且覆盖完整（建议含 other 兜底）。概率 ≥0.8 才适合自动执行；0.5~0.8 建议给出 top-2 概率后请人确认。",
    inputSchema: {
      type: "object",
      required: ["state", "question", "options"],
      properties: {
        state: { type: ["string", "object", "array"], description: "业务状态" },
        question: { type: "string", description: "问题（如：下一步应该做什么？）" },
        options: {
          type: ["object", "array"],
          description: "{选项名: 描述} 或 选项名数组。互斥、覆盖完整，建议含 other 兜底",
        },
        instructions: { type: "string", description: "可选：补充评判标准" },
      },
    },
  },
  {
    name: "decide_noul",
    title: "单项是否决策",
    description:
      "单一 noul（是否）决策：返回 P(yes)∈[0,1]（0=否，1=是）与 verdict（P≥0.5 为 yes）。" +
      "适合二分判断：是否需要升级、是否重复、是否值得深入。经验阈值：P≥0.8 视为是；≤0.2 视为否；" +
      "两者之间视为不确定——先补充 state 再重问，或转人工，不要硬执行。",
    inputSchema: {
      type: "object",
      required: ["state", "question"],
      properties: {
        state: { type: ["string", "object", "array"], description: "业务状态" },
        question: { type: "string", description: "是否型问题（如：是否需要立即通知值班人员？）" },
        criteria: {
          type: ["object", "array"],
          description: "可选：{true: 判定为是的情况, false: 判定为否的情况} 或 [true描述, false描述]",
        },
      },
    },
  },
  {
    name: "decide_score",
    title: "单项量表评分",
    description:
      "单一 score（量表）决策：按 criteria 从低到高的档位描述打分，返回 score（概率加权期望，可落在两档之间，如 1.43）、" +
      "level（最接近档位的描述）、probabilities 与 confidence。档位 2~10 为宜，每档描述需可清晰区分。",
    inputSchema: {
      type: "object",
      required: ["state", "question", "criteria"],
      properties: {
        state: { type: ["string", "object", "array"], description: "业务状态" },
        question: { type: "string", description: "评分问题（如：这个问题有多严重？）" },
        criteria: {
          type: "array",
          items: { type: "string" },
          minItems: 2,
          maxItems: 255,
          description: "从低到高的档位描述，2~10 档为宜（如 [\"轻微\", \"部分受影响\", \"核心不可用\"]）",
        },
        instructions: { type: "string", description: "可选：补充评判标准" },
      },
    },
  },
  {
    name: "decision_config",
    title: "查看配置",
    description:
      "返回当前 Decision Model MCP 的解析配置（endpoint、模型、region、鉴权方式、mock、API Key 是否已设置；不含 Key 本身）。排错用。",
    inputSchema: { type: "object", properties: {} },
  },
];

const TOOL_IMPLS = {
  decide: (args) => decide(args),
  decide_choice: (args) => decideChoice(args),
  decide_noul: (args) => decideNoul(args),
  decide_score: (args) => decideScore(args),
  decision_config: () => configSummary(loadConfig()),
};

// ---------------------------------------------------------------------------
// JSON-RPC over stdio
// ---------------------------------------------------------------------------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function log(...parts) {
  console.error("[decision-model]", ...parts);
}

const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const err = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function dispatch(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    return ok(id, {
      protocolVersion: params?.protocolVersion || "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions:
        "Decision Model MCP = 百炼决策模型（System One）能力层：decide 批量决策 + decide_choice/decide_noul/decide_score 单项决策。" +
        "何时该调用、state 与 criteria 如何设计、结果阈值策略与 Obsidian 工作流见 decision skill。",
    });
  }

  // 通知（无 id）：不应答
  if (id == null) return null;

  switch (method) {
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: TOOLS });
    case "tools/call": {
      const name = params?.name;
      const impl = TOOL_IMPLS[name];
      if (!impl) {
        return ok(id, {
          content: [{ type: "text", text: `未知工具 "${name}"。可用工具: ${Object.keys(TOOL_IMPLS).join(", ")}` }],
          isError: true,
        });
      }
      try {
        const result = await impl(params.arguments || {});
        return ok(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } catch (e) {
        log("tools/call failed:", e.message);
        return ok(id, { content: [{ type: "text", text: `决策调用失败：${e.message}` }], isError: true });
      }
    }
    // 防御性应答：未声明的能力返回空列表，避免部分客户端探测时报错
    case "resources/list":
      return ok(id, { resources: [] });
    case "prompts/list":
      return ok(id, { prompts: [] });
    default:
      return err(id, -32601, `Method not found: ${method}`);
  }
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (raw) => {
  const line = raw.trim();
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    send(err(null, -32700, "Parse error: 收到非 JSON 行"));
    return;
  }
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    if (msg && msg.id != null) send(err(msg.id, -32600, "Invalid Request"));
    return;
  }
  dispatch(msg)
    .then((reply) => reply !== null && send(reply))
    .catch((e) => {
      log("internal error:", e.stack || e.message);
      if (msg.id != null) send(err(msg.id, -32603, `Internal error: ${e.message}`));
    });
});
rl.on("close", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

const cfg = loadConfig();
log(
  `started v${SERVER_INFO.version} | model=${cfg.model} | mock=${cfg.mock ? "on" : "off"} | ` +
    `endpoint=${cfg.baseUrl} | api_key=${cfg.apiKey ? "set" : "MISSING"}`,
);
