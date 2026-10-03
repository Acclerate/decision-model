/**
 * grill-decision skill 评分协议的参考实现（真实 API 演示）。
 *
 * 演示一个 grilling 决策节点（登录态方案选型，3 选项）：
 *   每选项 5 问（viability/fatal_flaw noul + risk/cost/fit score）+ 全局 final_pick choice
 *   = 16 问放进同一次 decide 调用 → 按 skill 公式计算判别分 D → 统计分类 → 交叉校验 → 输出评分卡。
 *
 *   node test/grill-scorecard.mjs
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { McpClient } from "./client.mjs";

const SERVER = fileURLToPath(new URL("../index.mjs", import.meta.url));
const CRED = fileURLToPath(new URL("../../tools/provision/credentials.local.json", import.meta.url));

let env = {};
if (fs.existsSync(CRED)) {
  const cred = JSON.parse(fs.readFileSync(CRED, "utf8"));
  env = { DASHSCOPE_API_KEY: cred.api_key, DECISION_WORKSPACE_ID: cred.workspace_id };
} else if (process.env.DASHSCOPE_API_KEY && process.env.DECISION_WORKSPACE_ID) {
  env = { DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY, DECISION_WORKSPACE_ID: process.env.DECISION_WORKSPACE_ID };
} else {
  console.error("缺少凭据：先运行 tools/provision/provision.mjs。");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 决策节点定义（可替换为任意 grilling 会话中的节点）
// ---------------------------------------------------------------------------

const NODE_ = {
  name: "登录态方案选型（多端微服务）",
  state: {
    decision: "为多端（Web/iOS/Android）微服务系统选择登录态方案",
    constraints: [
      "必须支持服务端主动踢人下线（会话可撤销）",
      "已有 Redis 集群可复用",
      "团队以 Java 为主，对无状态方案经验一般",
      "日活约 5 万，峰值 QPS 约 500",
    ],
    facts: [
      "现有系统为单体 Spring Boot，正在拆分微服务",
      "历史上发生过一次 token 泄露事故，需要快速吊销能力",
      "移动端存在弱网重连场景",
    ],
  },
  options: {
    jwt: "JWT 无状态令牌：服务端不存会话，靠过期时间与刷新令牌兜底",
    redis_session: "Redis 集中会话：每个请求经网关查 Redis 校验会话",
    hybrid: "短有效期 JWT + Redis 黑名单：正常请求本地校验，吊销走黑名单",
  },
};

const RISK = ["低风险，成熟方案", "可控风险，需注意边界", "较高风险，需额外投入缓解", "高风险，已知会出问题"];
const COST = ["几乎零改造", "小改造，人天内", "中等改造，周级", "大改造，多周或架构级"];
const FIT = ["不契合核心约束", "部分契合", "大部分契合", "完全契合"];

const questions = {};
for (const [id, desc] of Object.entries(NODE_.options)) {
  questions[`viability__${id}`] = { type: "noul", instructions: `选项「${desc}」在上述约束与事实下是否可行` };
  questions[`fatal_flaw__${id}`] = { type: "noul", instructions: `选项「${desc}」是否存在足以否决它的致命缺陷` };
  questions[`risk__${id}`] = { type: "score", instructions: `选项「${desc}」的风险程度`, criteria: RISK };
  questions[`cost__${id}`] = { type: "score", instructions: `选项「${desc}」的改造成本`, criteria: COST };
  questions[`fit__${id}`] = { type: "score", instructions: `选项「${desc}」与核心约束（可撤销、多端、团队现状）的契合度`, criteria: FIT };
}
questions.final_pick = {
  type: "choice",
  instructions: "综合全部证据与约束，应该选择哪个选项",
  criteria: { ...Object.fromEntries(Object.entries(NODE_.options).map(([id, d]) => [id, d])), other: "以上都不是" },
};

// 判别分权重（skill 默认值，同一决策内必须恒定）
const W = { viability: 0.3, health: 0.25, fit: 0.2, risk: 0.15, cost: 0.1 };
const band = (d) => (d >= 75 ? "推荐" : d >= 60 ? "可行·需复核" : d >= 45 ? "存疑" : "排除");
const fmt = (v) => (typeof v === "number" ? v.toFixed(2) : String(v));

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

const client = new McpClient({ args: [SERVER], env });
try {
  const t0 = Date.now();
  const res = await client.request(
    "tools/call",
    { name: "decide", arguments: { state: NODE_.state, questions } },
    90_000,
  );
  const ms = Date.now() - t0;
  if (res.isError) throw new Error(res.content[0].text);
  const r = JSON.parse(res.content[0].text);
  const a = r.answers;

  // 结构校验（FAIL 级）
  for (const [qid, q] of Object.entries(questions)) {
    const ans = a[qid];
    if (!ans) throw new Error(`缺少答案: ${qid}`);
    if (ans.type !== q.type) throw new Error(`${qid} type 不匹配: ${ans.type}`);
    if (q.type === "noul" && (typeof ans.noul !== "number" || ans.noul < 0 || ans.noul > 1)) {
      throw new Error(`${qid} noul 越界: ${ans.noul}`);
    }
    if (q.type === "score" && (typeof ans.score !== "number" || ans.score < 0 || ans.score > 3)) {
      throw new Error(`${qid} score 越界: ${ans.score}`);
    }
    if (q.type === "choice" && !Object.keys(q.criteria).includes(ans.choice)) {
      throw new Error(`${qid} choice 不在选项集: ${ans.choice}`);
    }
  }

  // 判别分 + 统计分类
  const rows = Object.keys(NODE_.options)
    .map((id) => {
      const P = a[`viability__${id}`].noul;
      const F = a[`fatal_flaw__${id}`].noul;
      const risk = a[`risk__${id}`].score;
      const cost = a[`cost__${id}`].score;
      const fit = a[`fit__${id}`].score;
      const D = 100 * (W.viability * P + W.health * (1 - F) + W.fit * (fit / 3) + W.risk * (1 - risk / 3) + W.cost * (1 - cost / 3));
      const veto = F >= 0.8;
      const strategy = veto ? "排除" : (P > 0.5 && P < 0.8) || F > 0.5 ? "复核" : "自动";
      return { id, P, F, risk, cost, fit, D, category: veto ? "建议排除（硬否决）" : band(D), strategy };
    })
    .sort((x, y) => y.D - x.D);

  const best = rows[0];
  const pick = a.final_pick.choice;
  const consistent = pick === best.id;
  const reviewTargets = rows.filter((x) => x.strategy === "复核");

  // 输出（skill 输出模板）
  console.log(`\n## 决策节点：${NODE_.name}`);
  console.log(
    `state 摘要：约束 ${NODE_.state.constraints.length} 条 / 事实 ${NODE_.state.facts.length} 条 | ${Object.keys(questions).length} 问一次批量`,
  );
  console.log("");
  console.log("| 选项 | 可行性 P | 致命缺陷 P | 风险 | 成本 | 契合 | 判别分 D | 分类 | 策略 |");
  console.log("|---|---|---|---|---|---|---|---|---|");
  for (const row of rows) {
    console.log(
      `| ${row.id} | ${fmt(row.P)} | ${fmt(row.F)} | ${fmt(row.risk)} | ${fmt(row.cost)} | ${fmt(row.fit)} | ${fmt(row.D)} | ${row.category} | ${row.strategy} |`,
    );
  }
  console.log("");
  console.log(`交叉校验：final_pick = ${pick}（与 D 最高项${consistent ? "一致" : "不一致 → 全表复核"}）`);
  console.log(`上游 ${r.latency_ms}ms | 客户端往返 ${ms}ms | input_tokens=${r.usage.input_tokens} | request_id=${r.request_id}`);
  console.log(
    `➡️ 建议：${best.id}（D=${fmt(best.D)}）| 下一轮质询：${
      reviewTargets.length ? `针对 ${reviewTargets.map((x) => `${x.id}(P=${fmt(x.P)})`).join("、")} 补证据拉开 margin` : "无（margin 已拉开）"
    }`,
  );
  process.exit(0);
} finally {
  client.close();
}
