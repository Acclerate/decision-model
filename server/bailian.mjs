/**
 * 百炼 Decision Model（System One 协议）客户端层。
 *
 * 协议：POST {base}/compatible-mode/v1/systemone
 * 请求体：{ model, state, questions: { <问题id>: { type, instructions?, criteria? } } }
 *   - type: "choice"（多选一，criteria 为 选项名→描述 对象，1~255 项）
 *           "noul"  （是否判断，返回 P(yes)，criteria 可选 {true, false} 描述）
 *           "score" （有序量表，criteria 为从低到高的档位描述数组，2~255 项，建议 3~7）
 * 响应体：{ model, request_id, answers: { <问题id>: { type, choice|noul|score,
 *           probabilities?, confidence?, legend? } }, usage: { input_tokens }, latency_ms }
 *
 * 环境变量（除 API Key 外均可选）：
 *   DASHSCOPE_API_KEY / BAILIAN_API_KEY  百炼 API Key
 *   DECISION_MODEL        模型名，默认 decision-model-preview（可指向微调产物）
 *   DECISION_BASE_URL     完整覆盖 endpoint（含路径）
 *   DECISION_WORKSPACE_ID 业务空间 ID（走 https://{id}.cn-beijing.maas.aliyuncs.com 网关）
 *   DECISION_REGION       cn（默认）| intl（新加坡站）
 *   DECISION_AUTH_STYLE   bearer（默认）| raw（Authorization 只放 Key 不加 Bearer 前缀）
 *   DECISION_TIMEOUT_MS   请求超时毫秒，默认 60000
 *   DECISION_MOCK         "1" 时离线 mock，不访问网络（响应结构与真实一致）
 */

const DEFAULT_TIMEOUT_MS = 60_000;

export function loadConfig(env = process.env) {
  const workspace = (env.DECISION_WORKSPACE_ID || "").trim() || null;
  const region = env.DECISION_REGION === "intl" ? "intl" : "cn";
  // 官方主文档：决策模型走业务空间网关 https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone。
  // dashscope.aliyuncs.com 主机不提供该路径（实测 404），因此 endpoint 必须由
  // 业务空间 ID（DECISION_WORKSPACE_ID）或 DECISION_BASE_URL 显式给出。
  const explicit = (env.DECISION_BASE_URL || "").trim() || null;
  const baseUrl =
    explicit ||
    (workspace
      ? `https://${workspace}.${region === "intl" ? "ap-southeast-1" : "cn-beijing"}.maas.aliyuncs.com/compatible-mode/v1/systemone`
      : null);
  const timeout = Number(env.DECISION_TIMEOUT_MS);
  return {
    baseUrl,
    workspace,
    region,
    model: (env.DECISION_MODEL || "").trim() || "decision-model-preview",
    apiKey: (env.DASHSCOPE_API_KEY || env.BAILIAN_API_KEY || "").trim(),
    authStyle: env.DECISION_AUTH_STYLE === "raw" ? "raw" : "bearer",
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
    mock: env.DECISION_MOCK === "1" || env.DECISION_MOCK === "true",
  };
}

export function configSummary(cfg = loadConfig()) {
  return {
    base_url: cfg.baseUrl || "(未配置：需要 DECISION_WORKSPACE_ID 或 DECISION_BASE_URL)",
    model: cfg.model,
    region: cfg.region,
    workspace_id: cfg.workspace,
    auth_style: cfg.authStyle,
    timeout_ms: cfg.timeoutMs,
    mock: cfg.mock,
    api_key_set: Boolean(cfg.apiKey),
  };
}

// ---------------------------------------------------------------------------
// 入参校验：宽松接收、严格报错
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const TYPE_HINT = 'type 必须是 "choice"（多选一）/ "noul"（是否）/ "score"（量表）之一';

export function normalizeRequest(input, cfg) {
  if (!isPlainObject(input)) throw new Error("请求体必须是对象");

  const state = input.state;
  if (typeof state !== "string" && !isPlainObject(state) && !Array.isArray(state)) {
    throw new Error(
      "state 必填且应为字符串 / 对象 / 数组（业务状态：工单文本、对话或结构化对象），收到: " +
        describe(state),
    );
  }

  const questions = input.questions;
  if (!isPlainObject(questions) || Object.keys(questions).length === 0) {
    throw new Error(
      'questions 必填且非空，形如 { "next_action": { "type": "choice", "criteria": {"review": "复习", "practice": "实践"} } }',
    );
  }

  const normalized = {};
  for (const [id, q] of Object.entries(questions)) {
    if (id.length > 128) throw new Error(`问题 id 过长（>128 字符）: ${id}`);
    if (!isPlainObject(q)) throw new Error(`问题 "${id}" 必须是对象`);
    if (!["choice", "noul", "score"].includes(q.type)) {
      throw new Error(`问题 "${id}": ${TYPE_HINT}`);
    }
    const out = { type: q.type };
    if (q.instructions != null) {
      if (typeof q.instructions !== "string") throw new Error(`问题 "${id}": instructions 应为字符串`);
      out.instructions = q.instructions;
    }
    out.criteria = normalizeCriteria(id, q.type, q.criteria);
    normalized[id] = out;
  }
  return { model: cfg.model, state, questions: normalized };
}

function normalizeCriteria(id, type, criteria) {
  if (type === "choice") {
    if (criteria == null) {
      throw new Error(
        `问题 "${id}" 是 choice 类型，需要 criteria 选项表，如 {"review": "复习已有知识", "practice": "动手实践"}。建议补一个 other 兜底项`,
      );
    }
    let map = criteria;
    if (Array.isArray(criteria)) {
      map = Object.fromEntries(criteria.map((name) => [String(name), ""]));
    }
    if (!isPlainObject(map)) throw new Error(`问题 "${id}": choice 的 criteria 应为 选项名→描述 的对象`);
    const entries = Object.entries(map);
    if (entries.length < 1) throw new Error(`问题 "${id}": choice 至少需要 1 个选项`);
    if (entries.length > 255) throw new Error(`问题 "${id}": choice 选项数超过上限 255`);
    return map;
  }
  if (type === "noul") {
    if (criteria == null) return undefined;
    if (isPlainObject(criteria)) return criteria; // { "true": 描述, "false": 描述 }
    if (Array.isArray(criteria) && criteria.length === 2) {
      return { true: String(criteria[0]), false: String(criteria[1]) };
    }
    throw new Error(`问题 "${id}": noul 的 criteria 可省略，或为 {"true": "…", "false": "…"} 的对象/二元数组`);
  }
  // score
  if (!Array.isArray(criteria)) {
    throw new Error(
      `问题 "${id}" 是 score 类型，需要 criteria 为从低到高的档位描述数组，如 ["轻微，不影响功能", "部分受影响", "核心功能不可用"]`,
    );
  }
  if (criteria.length < 2) throw new Error(`问题 "${id}": score 至少需要 2 个等级`);
  if (criteria.length > 255) throw new Error(`问题 "${id}": score 等级数超过上限 255`);
  return criteria.map((c) => (typeof c === "string" ? c : String(c)));
}

function describe(v) {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  const t = typeof v;
  if (t === "object") return Array.isArray(v) ? "array" : t;
  return t;
}

// ---------------------------------------------------------------------------
// 调用
// ---------------------------------------------------------------------------

export async function decide(input, cfg = loadConfig()) {
  const payload = normalizeRequest(input, cfg);
  if (cfg.mock) return mockResponse(payload);
  if (!cfg.baseUrl) {
    throw new Error(
      "缺少 endpoint：决策模型走业务空间网关 https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone。" +
        "请设置 DECISION_WORKSPACE_ID（百炼控制台-业务空间管理页可查）或用 DECISION_BASE_URL 完整覆盖。" +
        "可先用 DECISION_MOCK=1 走离线 mock 验证链路，或用 decision_config 查看当前配置。",
    );
  }
  if (!cfg.apiKey) {
    throw new Error(
      "未设置百炼 API Key。请设置环境变量 DASHSCOPE_API_KEY（或在 MCP 配置的 env 中提供），" +
        "也可先用 DECISION_MOCK=1 走离线 mock 验证链路。可用 decision_config 工具查看当前配置。",
    );
  }
  return httpCall(cfg, payload);
}

async function httpCall(cfg, payload) {
  const auth = cfg.authStyle === "raw" ? cfg.apiKey : `Bearer ${cfg.apiKey}`;
  let res;
  try {
    res = await fetch(cfg.baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (e) {
    throw new Error(
      `请求百炼失败（${cfg.baseUrl}）：${e.cause?.message || e.message}。` +
        `请用 decision_config 检查 endpoint 与网络；业务空间接入需设置 DECISION_WORKSPACE_ID`,
    );
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 800);
    try {
      const j = JSON.parse(text);
      detail = j.message || j.error?.message || detail;
      if (j.request_id) detail += ` (request_id: ${j.request_id})`;
    } catch { /* 保留原文 */ }
    if (res.status === 404) {
      throw new Error(
        `百炼返回 HTTP 404（endpoint 不存在）: ${cfg.baseUrl}。` +
          "决策模型走业务空间网关，请检查 DECISION_WORKSPACE_ID（endpoint 形如 " +
          "https://{ID}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone）或直接设置 DECISION_BASE_URL。",
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `百炼返回 HTTP ${res.status}（鉴权问题）: ${detail}。` +
          "默认使用 Bearer 鉴权；若网关要求裸 Key（不加 Bearer 前缀），可设置 DECISION_AUTH_STYLE=raw 重试。" +
          "另请确认该 Key 已开通决策模型访问权限。",
      );
    }
    throw new Error(`百炼返回 HTTP ${res.status} ${res.statusText}: ${detail}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`百炼返回了非 JSON 响应: ${text.slice(0, 400)}`);
  }
}

// mock：结构 1:1 对齐真实响应，便于无 Key 时跑通整条链路。
function mockResponse(payload) {
  const started = Date.now();
  const answers = {};
  for (const [id, q] of Object.entries(payload.questions)) answers[id] = mockAnswer(q);
  return {
    model: payload.model,
    request_id: `mock-${started.toString(36)}`,
    mock: true,
    answers,
    usage: { input_tokens: Math.ceil(JSON.stringify(payload).length / 4) },
    latency_ms: Date.now() - started + 42,
  };
}

function mockAnswer(q) {
  if (q.type === "noul") return { type: "noul", noul: 0.87 };
  if (q.type === "choice") {
    const names = Object.keys(q.criteria);
    if (names.length === 1) {
      return { type: "choice", choice: names[0], confidence: 0.9, probabilities: { [names[0]]: 1 } };
    }
    const rest = names.length - 1;
    const probabilities = Object.fromEntries(
      names.map((n, i) => [n, i === 0 ? 0.86 : +(0.14 / rest).toFixed(4)]),
    );
    return { type: "choice", choice: names[0], confidence: 0.9, probabilities };
  }
  const n = q.criteria.length;
  const weights =
    n === 2 ? [0.2, 0.8] : n === 3 ? [0.05, 0.7, 0.25] : [0.05, 0.7, 0.2, ...Array(n - 3).fill(0)];
  weights[1] += 1 - weights.reduce((s, p) => s + p, 0); // 余量并入 1 档，保证概率和为 1
  const probabilities = Object.fromEntries(weights.map((p, i) => [String(i), p]));
  const score = weights.reduce((s, p, i) => s + p * i, 0);
  const legend = Object.fromEntries(q.criteria.map((c, i) => [String(i), c]));
  return { type: "score", score, confidence: 0.88, legend, probabilities };
}

// ---------------------------------------------------------------------------
// 便捷封装：单个问题。返回上游 answer + 常用派生字段（保持薄封装，不做策略）。
// ---------------------------------------------------------------------------

function attachMeta(answer, upstream) {
  return {
    ...answer,
    request_id: upstream.request_id,
    usage: upstream.usage,
    latency_ms: upstream.latency_ms,
  };
}

function combineInstructions(question, instructions) {
  return [question, instructions].filter(Boolean).join("\n");
}

export async function decideChoice({ state, question, options, instructions }, cfg = loadConfig()) {
  if (typeof question !== "string" || !question.trim()) throw new Error("question 必填（字符串）");
  if (instructions != null && typeof instructions !== "string") throw new Error("instructions 应为字符串");
  const upstream = await decide(
    {
      state,
      questions: {
        decision: { type: "choice", instructions: combineInstructions(question, instructions), criteria: options },
      },
    },
    cfg,
  );
  return attachMeta({ ...upstream.answers.decision, question }, upstream);
}

export async function decideNoul({ state, question, criteria }, cfg = loadConfig()) {
  if (typeof question !== "string" || !question.trim()) throw new Error("question 必填（字符串）");
  const upstream = await decide(
    { state, questions: { decision: { type: "noul", instructions: question, criteria } } },
    cfg,
  );
  const answer = upstream.answers.decision;
  const p = typeof answer.noul === "number" ? answer.noul : undefined;
  return attachMeta(
    { ...answer, question, verdict: p == null ? undefined : p >= 0.5 ? "yes" : "no" },
    upstream,
  );
}

export async function decideScore({ state, question, criteria, instructions }, cfg = loadConfig()) {
  if (typeof question !== "string" || !question.trim()) throw new Error("question 必填（字符串）");
  if (instructions != null && typeof instructions !== "string") throw new Error("instructions 应为字符串");
  const upstream = await decide(
    {
      state,
      questions: {
        decision: { type: "score", instructions: combineInstructions(question, instructions), criteria },
      },
    },
    cfg,
  );
  const answer = upstream.answers.decision;
  const legend = answer.legend || {};
  const idx = Number.isFinite(answer.score)
    ? Math.min(criteria.length - 1, Math.max(0, Math.round(answer.score)))
    : undefined;
  return attachMeta(
    { ...answer, question, level: idx == null ? undefined : legend[String(idx)] },
    upstream,
  );
}
