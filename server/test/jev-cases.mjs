/**
 * Jev/System One 常见用例集 —— 对已配置的百炼 Decision Model 做真实调试。
 *
 *   node test/jev-cases.mjs            # 读 tools/provision/credentials.local.json 或环境变量
 *
 * 用例来源：阿里云开发者社区《Jev 模型实战测评》与 Jev 101 指南的典型场景——
 * 工单分流（批量）、紧急度、内容风控、Agent 工具路由、"廉价AI审核昂贵AI"、
 * 文档批量打标、学习笔记分诊（Obsidian）、信息不足时的校准（unknowable）。
 *
 * 判定分级：
 *   FAIL = 结构性错误（字段缺失/越界/不在选项集）——链路或协议问题
 *   WARN = 质量预期未达（如对照组没分开、置信度公式偏差）——模型表现观察
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpClient } from "./client.mjs";

const SERVER = fileURLToPath(new URL("../index.mjs", import.meta.url));
const CRED = fileURLToPath(
  new URL("../../tools/provision/credentials.local.json", import.meta.url),
);

let env = {};
if (fs.existsSync(CRED)) {
  const cred = JSON.parse(fs.readFileSync(CRED, "utf8"));
  env = { DASHSCOPE_API_KEY: cred.api_key, DECISION_WORKSPACE_ID: cred.workspace_id };
} else if (process.env.DASHSCOPE_API_KEY && process.env.DECISION_WORKSPACE_ID) {
  env = { DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY, DECISION_WORKSPACE_ID: process.env.DECISION_WORKSPACE_ID };
} else {
  console.error("缺少凭据：先运行 tools/provision/provision.mjs，或设置环境变量。");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 用例集
// ---------------------------------------------------------------------------

const DOC_CRIT = [
  "科普级，无需任何背景",
  "入门教程，需要基础概念",
  "进阶，需要实践经验",
  "高级，需要系统学习领域知识",
  "研究级，面向领域专家",
];

const CASES = [
  {
    name: "工单分流·批量（官方示例：重复扣款）",
    tool: "decide",
    args: {
      state: "客户反馈支付重复扣款，申请订单退款，语气焦急，要求尽快处理。",
      questions: {
        department: {
          type: "choice",
          instructions: "工单分配至对应业务团队",
          criteria: {
            billing: "付款、发票、退款相关问题",
            technical: "Bug、系统故障、集成问题",
            sales: "定价、账户咨询",
            other: "以上都不是",
          },
        },
        is_urgent: { type: "noul", instructions: "这条消息是否传达了紧急性或时效性" },
        frustration: {
          type: "score",
          instructions: "评估客户沮丧程度",
          criteria: ["冷静，只是在陈述事实", "不满但还算礼貌", "非常愤怒，言辞激烈"],
        },
      },
    },
    expect: (r) => [
      ["department = billing", r.answers.department.choice === "billing", "expect"],
      ["is_urgent > 0.5", r.answers.is_urgent.noul > 0.5, "expect"],
      ["frustration > 0.5（超出“冷静陈述”档）", r.answers.frustration.score > 0.5, "expect"],
    ],
  },
  {
    name: "紧急度·noul（连续宕机丢销售额）",
    tool: "decide_noul",
    args: {
      state: "我连续3天无法连接账户，正在丢失销售额，请尽快处理！",
      question: "这条消息是否传达了紧急性或时效性",
    },
    expect: (r) => [["is_urgent ≥ 0.8（自动告警档）", r.noul >= 0.8, "expect"]],
  },
  {
    name: "内容风控·违规评论（应拦截）",
    tool: "decide_noul",
    args: {
      state: "加微信 xxx888 领取博彩网站内部渠道，日赚过万，稳赚不赔。",
      question: "这条评论是否违反平台内容规范（赌博/欺诈引流）",
    },
    expect: (r) => [["is_violating ≥ 0.8（自动拦截档）", r.noul >= 0.8, "expect"]],
  },
  {
    name: "内容风控·正常评论（对照组，应放行）",
    tool: "decide_noul",
    args: {
      state: "这家店的咖啡不错，环境也安静，适合办公，推荐。",
      question: "这条评论是否违反平台内容规范（赌博/欺诈引流）",
    },
    expect: (r) => [["is_violating ≤ 0.2（自动放行档）", r.noul <= 0.2, "expect"]],
  },
  {
    name: "Agent 工具路由·choice",
    tool: "decide_choice",
    args: {
      state: "用户对 Agent 说：帮我查一下明天早上北京到上海的高铁班次和票价。",
      question: "Agent 下一步应该调用哪个工具？",
      options: {
        flight_search: "查询航班信息",
        train_search: "查询火车/高铁班次与票价",
        weather_check: "查询天气预报",
        calendar: "创建或修改日程",
        write_report: "撰写报告或文档",
        other: "以上都不是",
      },
    },
    expect: (r) => [["choice = train_search", r.choice === "train_search", "expect"]],
  },
  {
    name: "LLM 输出质检·跑题回答（廉价AI审核昂贵AI）",
    tool: "decide_noul",
    args: {
      state:
        '问题：如何在 Node.js 里读取环境变量？\n大模型回答：Node.js 是基于 Chrome V8 引擎的 JavaScript 运行时，采用事件驱动、非阻塞 I/O 模型，由 Ryan Dahl 于 2009 年发布，npm 是它的包管理器，生态非常繁荣。',
      question: "这个回答是否跑题（未回答用户的问题）",
    },
    expect: (r) => [["is_offtopic ≥ 0.6（应标记复核）", r.noul >= 0.6, "expect"]],
  },
  {
    name: "LLM 输出质检·贴题回答（对照组）",
    tool: "decide_noul",
    args: {
      state:
        '问题：如何在 Node.js 里读取环境变量？\n大模型回答：使用 process.env 对象，例如 process.env.HOME 读取 HOME 变量；启动时设置 MY_VAR=xxx node app.js 即可在代码里读到。',
      question: "这个回答是否跑题（未回答用户的问题）",
    },
    expect: (r) => [["is_offtopic ≤ 0.4（应放行）", r.noul <= 0.4, "expect"]],
  },
  {
    name: "文档难度打标·量子场论（应高难）",
    tool: "decide_score",
    args: {
      state: "本文在标准模型框架下讨论了规范对称性的自发破缺，通过路径积分量子化推导了 Yang-Mills 场的 Ward-Takahashi 恒等式，并给出重整化群流方程的单圈解。",
      question: "这篇文档的阅读难度",
      criteria: DOC_CRIT,
    },
    expect: (r) => [["difficulty ≥ 3（高级及以上）", r.score >= 3, "expect"]],
  },
  {
    name: "文档难度打标·小学生日记（对照组，应低难）",
    tool: "decide_score",
    args: {
      state: "今天我和爸爸妈妈去公园放风筝，风很大，风筝飞得特别高，我玩得开心极了，回家还写了这篇日记。",
      question: "这篇文档的阅读难度",
      criteria: DOC_CRIT,
    },
    expect: (r) => [["difficulty ≤ 2（科普/入门）", r.score <= 2, "expect"]],
  },
  {
    name: "Obsidian 学习笔记分诊·批量（本项目场景）",
    tool: "decide",
    args: {
      state: {
        title: "Nginx upstream",
        summary: "upstream 块定义后端服务器组，配合 proxy_pass 做负载均衡；轮询/权重/ip_hash/least_conn。",
        difficulty: 4,
        mastery: 0.35,
        importance: 0.85,
        last_studied: "2026-09-30",
        note_age_days: 2,
      },
      questions: {
        next_action: {
          type: "choice",
          instructions: "下一步应该做什么",
          criteria: {
            review: "复习巩固已有内容",
            practice: "动手实践（写配置实验）",
            learn_more: "先补前置知识再实践",
            archive: "价值不足，归档",
            other: "以上都不是",
          },
        },
        priority: {
          type: "score",
          instructions: "本次安排的优先级",
          criteria: ["可等，闲时处理", "本周内安排", "尽快安排", "立即处理"],
        },
        needs_prerequisite: {
          type: "noul",
          instructions: "当前掌握度是否不足以直接开始实践（需要先学前置知识）",
        },
      },
    },
    expect: (r) => [
      ["next_action ∈ {review, practice, learn_more}", ["review", "practice", "learn_more"].includes(r.answers.next_action.choice), "expect"],
      ["priority ≥ 1（至少本周内）", r.answers.priority.score >= 1, "expect"],
    ],
  },
  {
    name: "信息不足校准·unknowable（不应过度自信）",
    tool: "decide_noul",
    args: {
      state: "帮我看下我的工单。",
      question: "仅凭这条消息能否判断该工单是否为退款类请求",
    },
    expect: (r) => [
      ["p ≤ 0.7（缺信息不应高置信）", r.noul <= 0.7, "expect"],
    ],
  },
];

// ---------------------------------------------------------------------------
// 校验逻辑
// ---------------------------------------------------------------------------

const sum = (obj) => Object.values(obj || {}).reduce((s, p) => s + p, 0);

/** 结构校验：FAIL 级。返回错误列表。 */
function validateAnswer(qid, q, a) {
  const errs = [];
  if (a.type !== q.type) errs.push(`FAIL type 不匹配: 返回 ${a.type}, 请求 ${q.type}`);
  if (q.type === "noul") {
    if (typeof a.noul !== "number" || a.noul < 0 || a.noul > 1) errs.push(`FAIL noul 越界: ${a.noul}`);
  } else {
    const probs = a.probabilities || {};
    const values = Object.values(probs);
    const pmax = Math.max(0, ...values);
    const n = values.length;
    if (typeof a.confidence !== "number" || a.confidence < 0 || a.confidence > 1) {
      errs.push(`FAIL confidence 越界: ${a.confidence}`);
    } else if (n > 1 && q.type === "choice") {
      // Jev 文档公式 (n·p_max − 1)/(n − 1)：实测对 choice 成立，对 score 不适用（另一套校准口径）
      const formula = (n * pmax - 1) / (n - 1);
      if (Math.abs(formula - a.confidence) > 0.05) {
        errs.push(`WARN confidence 公式偏差: (n·p_max−1)/(n−1)=${formula.toFixed(3)}, 返回=${a.confidence}`);
      }
    }
    // 上游把概率四舍五入到两位小数，和会落在 0.97~1.03 之间
    if (Math.abs(sum(probs) - 1) > 0.05) errs.push(`FAIL probabilities 和=${sum(probs).toFixed(4)}`);
    if (q.type === "choice") {
      if (!Object.keys(q.criteria).includes(a.choice)) errs.push(`FAIL choice 不在选项集: ${a.choice}`);
    } else {
      if (typeof a.score !== "number" || a.score < 0 || a.score > q.criteria.length - 1) {
        errs.push(`FAIL score 越界: ${a.score}（合法 [0, ${q.criteria.length - 1}]）`);
      }
    }
  }
  return errs;
}

/** 阈值策略带（与 decision skill 第 6 节一致） */
function policyBand(a) {
  if (a.type === "noul") {
    return a.noul >= 0.8 ? "auto=yes" : a.noul <= 0.2 ? "auto=no" : "review";
  }
  const pmax = Math.max(0, ...Object.values(a.probabilities || { x: 0 }));
  return pmax >= 0.8 ? "auto" : pmax >= 0.5 ? "review" : "manual";
}

function fmt(v) {
  return typeof v === "number" ? v.toFixed(3) : String(v);
}

/** 每种工具的问题规格表（sugar 工具从入参派生，用于统一校验） */
function questionsOf(c) {
  if (c.tool === "decide") return c.args.questions;
  if (c.tool === "decide_noul") return { decision: { type: "noul" } };
  if (c.tool === "decide_choice") return { decision: { type: "choice", criteria: c.args.options } };
  if (c.tool === "decide_score") return { decision: { type: "score", criteria: c.args.criteria } };
  throw new Error(`未知工具: ${c.tool}`);
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

const client = new McpClient({ args: [SERVER], env });
const results = [];
let failCount = 0;
let warnCount = 0;

try {
  // 0) 配置自检：确认跑的是真实 endpoint 而非 mock
  const cfgRes = await client.request("tools/call", { name: "decision_config", arguments: {} });
  const cfg = JSON.parse(cfgRes.content[0].text);
  assert.equal(cfg.mock, false, "应处于真实模式（mock=false）");
  assert.ok(cfg.base_url.includes("maas.aliyuncs.com"), `endpoint 应为业务空间网关: ${cfg.base_url}`);
  console.log(
    `配置自检 OK: endpoint=${cfg.base_url}\n  model=${cfg.model} | region=${cfg.region} | api_key_set=${cfg.api_key_set}\n`,
  );

  for (const c of CASES) {
    const t0 = Date.now();
    const res = await client.request("tools/call", { name: c.tool, arguments: c.args }, 90_000);
    const ms = Date.now() - t0;
    if (res.isError) {
      failCount++;
      results.push({ name: c.name, status: "FAIL", ms, lines: [`  └ 调用报错: ${res.content[0].text}`] });
      continue;
    }
    const r = JSON.parse(res.content[0].text);
    const answers = r.answers ?? { decision: r };
    const lines = [];
    let caseFail = false;

    for (const [qid, q] of Object.entries(questionsOf(c))) {
      const a = answers[qid];
      if (!a) {
        caseFail = true;
        lines.push(`  ├ ${qid}: FAIL 缺少答案`);
        continue;
      }
      for (const e of validateAnswer(qid, q, a)) {
        e.startsWith("WARN") ? warnCount++ : (caseFail = true, failCount++);
        lines.push(`  ├ ${qid}: ${e}`);
      }
      const summary =
        a.type === "noul"
          ? `P(yes)=${fmt(a.noul)} → ${a.verdict ?? (a.noul >= 0.5 ? "yes" : "no")}`
          : a.type === "choice"
            ? `${a.choice} (p_max=${fmt(Math.max(...Object.values(a.probabilities)))}, conf=${fmt(a.confidence)})`
            : `score=${fmt(a.score)} (conf=${fmt(a.confidence)})`;
      lines.push(`  ├ ${qid}(${a.type}): ${summary} [策略:${policyBand(a)}]`);
    }

    for (const [label, pass, level] of c.expect(r)) {
      if (pass) lines.push(`  ├ ✓ ${label}`);
      else {
        level === "warn" ? (warnCount++, lines.push(`  ├ ⚠ ${label}（未达，仅观察）`)) : (caseFail = true, failCount++, lines.push(`  ├ ✗ ${label}`));
      }
    }

    const inTok = r.usage?.input_tokens;
    lines.push(`  └ 上游 ${r.latency_ms ?? "?"}ms | 客户端往返 ${ms}ms${inTok != null ? ` | input_tokens=${inTok}` : ""} | request_id=${r.request_id}`);
    results.push({ name: c.name, status: caseFail ? "FAIL" : "PASS", ms, lines });
  }
} finally {
  client.close();
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

console.log("═".repeat(78));
for (const r of results) {
  console.log(`[${r.status}] ${r.name}（${r.ms}ms）`);
  for (const l of r.lines) console.log(l);
  console.log("");
}
console.log("═".repeat(78));
const pass = results.filter((r) => r.status === "PASS").length;
console.log(`用例: ${pass}/${results.length} PASS | 结构性 FAIL=${failCount} | 质量观察 WARN=${warnCount}`);
console.log(
  `延迟: 平均 ${Math.round(results.reduce((s, r) => s + r.ms, 0) / results.length)}ms/请求（客户端往返，含 MCP stdio 开销）`,
);
process.exit(failCount > 0 ? 1 : 0);
