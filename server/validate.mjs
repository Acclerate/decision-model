/**
 * System One 响应契约校验（fail-closed）。
 *
 * 本文件是 answers 契约的唯一权威源：上游（preview 阶段模型）返回的每个答案都必须
 * 通过这里才能到达调用方。无效答案逐问标记、不整体报废（对齐 jev-mcp 的
 * per-item fail-closed）；envelope 级失败（answers 缺失/非对象）直接抛错。
 *
 * 上游概率四舍五入到两位小数（实测），故概率和容差取 ±0.05 而非 0.01。
 * confidence 公式 (n·p_max−1)/(n−1) 是观察项不是契约，不在本文件强制。
 */

const PROB_SUM_TOLERANCE = 0.05;
const TIE_TOLERANCE = 1e-9;

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function describe(v) {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (typeof v === "object") return Array.isArray(v) ? "array" : "object";
  return typeof v;
}

/**
 * 校验单个答案是否满足请求契约。返回 problems 数组（空 = 有效）。
 * confidence 缺失不算无效（历史/部分上游不回传），但调用方应把策略降为 review
 * ——见 validateAnswers 返回的 confidenceMissing。
 */
export function validateAnswer(qid, q, a) {
  const problems = [];
  if (!isPlainObject(a)) return [`答案必须是对象，收到 ${describe(a)}`];
  if (a.type !== q.type) problems.push(`type 不匹配: 返回 ${a.type}，请求 ${q.type}`);

  if (q.type === "noul") {
    if (typeof a.noul !== "number" || !Number.isFinite(a.noul) || a.noul < 0 || a.noul > 1) {
      problems.push(`noul 必须是 [0,1] 内的数值，收到 ${a.noul}`);
    }
    return problems;
  }

  // choice / score 共有：probabilities 与 confidence
  const probs = a.probabilities;
  let probValues = null;
  if (!isPlainObject(probs) || Object.keys(probs).length === 0) {
    problems.push("probabilities 必须是非空对象");
  } else {
    probValues = Object.values(probs);
    if (probValues.some((p) => typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1)) {
      problems.push("probabilities 存在非 [0,1] 的数值");
    } else {
      const sum = probValues.reduce((s, p) => s + p, 0);
      if (Math.abs(sum - 1) > PROB_SUM_TOLERANCE) {
        problems.push(`probabilities 之和=${sum.toFixed(4)}，偏离 1 超过 ±${PROB_SUM_TOLERANCE}`);
      }
    }
  }
  if (a.confidence !== undefined) {
    if (typeof a.confidence !== "number" || !Number.isFinite(a.confidence) || a.confidence < 0 || a.confidence > 1) {
      problems.push(`confidence 越界: ${a.confidence}（合法 [0,1]）`);
    }
  }

  if (q.type === "choice") {
    const optionNames = Object.keys(q.criteria || {});
    if (typeof a.choice !== "string" || !optionNames.includes(a.choice)) {
      problems.push(`choice 不在请求选项集内: ${JSON.stringify(a.choice)}`);
    } else if (probValues && probValues.every((p) => typeof p === "number" && Number.isFinite(p))) {
      // choice 必须是（并列）最大概率项，防止"硬选一个低概率选项"
      const pmax = Math.max(...probValues);
      const pchoice = probs[a.choice];
      if (pmax - pchoice > TIE_TOLERANCE) {
        problems.push(`choice "${a.choice}" 的概率 ${pchoice} 不是最大项（max=${pmax}）`);
      }
    }
  } else {
    // score
    const max = (q.criteria?.length || 2) - 1;
    if (typeof a.score !== "number" || !Number.isFinite(a.score) || a.score < 0 || a.score > max) {
      problems.push(`score 越界: ${a.score}（合法 [0, ${max}]）`);
    }
  }
  return problems;
}

/**
 * 校验整份 answers。返回：
 *   valid             { qid: answer } 通过校验的答案（原样）
 *   invalid           { qid: { type, invalid_response: true, problems } } 未通过的
 *   confidenceMissing [qid]        有效但缺 confidence 的（choice/score，策略应强制 review）
 * answers 缺失/非对象 → 直接 throw（envelope 级失败）。
 */
export function validateAnswers(questions, answers) {
  if (!isPlainObject(answers)) {
    throw new Error(`响应缺少 answers 对象（收到 ${describe(answers)}）——上游协议失败`);
  }
  const valid = {};
  const invalid = {};
  const confidenceMissing = [];
  for (const [qid, q] of Object.entries(questions)) {
    const a = answers[qid];
    if (a === undefined || a === null) {
      invalid[qid] = { type: q.type, invalid_response: true, problems: ["上游未返回该问题的答案"] };
      continue;
    }
    const problems = validateAnswer(qid, q, a);
    if (problems.length > 0) invalid[qid] = { type: q.type, invalid_response: true, problems };
    else {
      valid[qid] = a;
      if (q.type !== "noul" && a.confidence === undefined) confidenceMissing.push(qid);
    }
  }
  return { valid, invalid, confidenceMissing };
}
