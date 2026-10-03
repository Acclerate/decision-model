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
 *   decision_verify     语义：断言 vs 证据，逐条 supports/contradicts/says_nothing
 *   decision_screen     语义：文本进入上下文前的安检（注入/实质/相关 → 建议）
 *   decision_classify   语义：批量打标（items × 共享 classes 目录，双门槛 auto/review）
 *   decision_config     查看解析配置（排错用，不回显 Key）
 *
 * 边界：decide 保持协议原样透传（最小原语，无策略字段）；sugar 与语义工具返回的
 * policy/decision/status/recommendation 是机械阈值映射（可用 auto_accept 等参数覆盖），
 * 执行策略仍在 skill/调用方。
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
import { decisionVerify, decisionScreen, decisionClassify } from "./semantic.mjs";

// 与根 package.json 的 version 保持同步
const SERVER_INFO = { name: "decision-model", version: "1.1.0" };

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
        auto_accept: {
          type: "number",
          description: "可选：policy=auto 的 p_max 阈值，(0.5,1] 内，默认 0.8。返回 policy: auto/review/manual",
        },
        review_at: { type: "number", description: "可选：policy=review 的 p_max 阈值，[0,1) 内，默认 0.5，须小于 auto_accept" },
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
        auto_accept: {
          type: "number",
          description: "可选：判定阈值，(0.5,1] 内，默认 0.8。返回 policy: auto_yes（P≥阈值）/ review / auto_no（P≤1-阈值）",
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
        auto_accept: {
          type: "number",
          description: "可选：policy=auto 的分布集中度（p_max）阈值，(0.5,1] 内，默认 0.8",
        },
        review_at: { type: "number", description: "可选：policy=review 的 p_max 阈值，[0,1) 内，默认 0.5" },
      },
    },
  },
  {
    name: "decision_verify",
    title: "断言核验",
    description:
      "逐条核验 claims 与 evidence 的关系（一次前向）：每条断言独立返回 relation" +
      "（supports 支持 / contradicts 反驳 / says_nothing 未提及）+ 概率分布 + confidence + decision。" +
      "decision=auto 需 confidence ≥ auto_accept（默认 0.8，可调）；缺 confidence 一律 review。" +
      "适用：fact-check 报告/PR 描述/Agent 简报 vs 其引用来源、changelog vs 文档、摘要 vs 原文。" +
      "上限：claims ≤16 条（每条 ≤2000 字符）、evidence 为字符串（≤50000）或数组 ≤16 项（每项 ≤20000），超限报错不截断。",
    inputSchema: {
      type: "object",
      required: ["claims", "evidence"],
      properties: {
        claims: {
          type: "array",
          minItems: 1,
          maxItems: 16,
          description: '断言列表：[{id?, text}]，id 缺省自动编号 claim_0…；text 为要核验的陈述句',
          items: {
            type: "object",
            required: ["text"],
            properties: {
              id: { type: "string", description: "断言 id（回显在 results 的键上），可省略" },
              text: { type: "string", description: "断言文本，≤2000 字符" },
            },
          },
        },
        evidence: {
          type: ["string", "array"],
          description: "证据：字符串或 [{id?, text}] 数组（≤16 项）。判定仅依据证据内容，不使用世界知识",
        },
        relations: {
          type: "object",
          description: '可选：覆盖默认三关系的描述，如 {"supports": "…", "contradicts": "…", "says_nothing": "…"}',
        },
        auto_accept: {
          type: "number",
          description: "decision=auto 的 confidence 阈值，(0.5,1] 内，默认 0.8",
        },
      },
    },
  },
  {
    name: "decision_screen",
    title: "上下文安检",
    description:
      "文本进入 Agent 上下文前的安检（一次前向三个是否判断）：injection 是否含指挥 AI 的注入指令、" +
      "substance 是否有实质内容、relevance 是否与任务相关（给了 purpose 才问）。" +
      "返回 recommendation：block（injection ≥ block_at，建议拒绝进入上下文）/ review（≥ review_at，建议人工过目）/" +
      "skip（低实质或低相关，不值得读）/ pass（可进入）。建议非强制，执行权在调用方。" +
      "阈值 block_at 默认 0.75、review_at 默认 0.25，均可按调用覆盖。text 上限 50000 字符。",
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string", description: "待检查的文本（抓取的网页、粘贴内容、转写稿等）" },
        purpose: { type: "string", description: "可选：当前任务目标（≤500 字符），提供后才判定 relevance" },
        block_at: { type: "number", description: "block 的 injection 概率阈值，(0.5,1] 内，默认 0.75" },
        review_at: { type: "number", description: "review 的 injection 概率阈值，[0,1) 内，默认 0.25，须小于 block_at" },
      },
    },
  },
  {
    name: "decision_classify",
    title: "批量打标",
    description:
      "把 items 逐一归入共享的 classes 目录（目录只送一次，每条目一个独立 choice 问题，一次前向）。" +
      "每条返回 class + probabilities + p_max + margin + status：status=auto 需 p_max ≥ auto_accept（默认 0.85）" +
      "且领先第二名 margin ≥ minimum_margin（默认 0.5）——分类场景措辞会摆动不确定样本，双门槛更保守。" +
      "类别描述承载判别力（定义/包含什么/不包含什么/短例）；建议自带 other 或 manual_review 兜底类，工具不发明兜底。" +
      "上限：items ≤64 条（每条 ≤2000 字符）、classes 2~255 项，超限报错不截断。",
    inputSchema: {
      type: "object",
      required: ["items", "classes"],
      properties: {
        items: {
          type: "array",
          minItems: 1,
          maxItems: 64,
          description: "待打标条目：[{id?, text}]，id 缺省自动编号 item_0…",
          items: {
            type: "object",
            required: ["text"],
            properties: {
              id: { type: "string", description: "条目 id（回显在 results 的键上），可省略" },
              text: { type: "string", description: "条目文本，≤2000 字符" },
            },
          },
        },
        classes: {
          type: "object",
          description: '共享类别目录：{类别名: 描述}，2~255 项。强描述写清定义、包含/不包含、优先级与短例',
        },
        auto_accept: { type: "number", description: "auto 的 p_max 阈值，(0.5,1] 内，默认 0.85" },
        minimum_margin: { type: "number", description: "auto 的第一名领先幅度阈值，[0,1] 内，默认 0.5" },
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
  decision_verify: (args) => decisionVerify(args),
  decision_screen: (args) => decisionScreen(args),
  decision_classify: (args) => decisionClassify(args),
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
        "Decision Model MCP = Bailian Decision Model (System One) capability layer: decide batch decisions + decide_choice/decide_noul/decide_score single decisions + " +
        "decision_verify (assertion verification) / decision_screen (context security check) / decision_classify (batch labeling) semantic tools. " +
        "For when to call, how to design state and criteria, result threshold strategies and Obsidian workflow, see decision skill.",
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
