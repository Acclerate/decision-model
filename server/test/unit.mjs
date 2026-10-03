/**
 * 契约校验单元测试（离线，无需 API Key / 无需起 server）：
 *   node test/unit.mjs
 *
 * 直接测 validate.mjs（answers 契约的唯一权威源）+ mock 全链路下 decide() 的接线。
 */
import assert from "node:assert/strict";
import { validateAnswer, validateAnswers } from "../validate.mjs";
import { decide } from "../bailian.mjs";

const CHOICE_Q = {
  type: "choice",
  criteria: { review: "复习", practice: "实践", other: "都不是" },
};
const SCORE_Q = { type: "score", criteria: ["轻微", "部分受影响", "核心不可用"] };

let n = 0;
function ok(label, fn) {
  fn();
  n++;
  console.log(`  ✓ ${label}`);
}

console.log("[validateAnswer] 合法答案");

ok("choice：分布完整、choice 为最大项、confidence 在界内", () => {
  const problems = validateAnswer("q", CHOICE_Q, {
    type: "choice",
    choice: "practice",
    confidence: 0.9,
    probabilities: { review: 0.1, practice: 0.85, other: 0.05 },
  });
  assert.deepEqual(problems, []);
});

ok("choice：概率和 0.97（两位小数舍入容差内）仍有效", () => {
  const problems = validateAnswer("q", CHOICE_Q, {
    type: "choice",
    choice: "practice",
    confidence: 0.9,
    probabilities: { review: 0.12, practice: 0.85 }, // 和 0.97，偏差 0.03 < 0.05
  });
  assert.deepEqual(problems, []);
});

ok("noul：P(yes)=0.87 有效", () => {
  assert.deepEqual(
    validateAnswer("q", { type: "noul" }, { type: "noul", noul: 0.87 }),
    [],
  );
});

ok("score：期望值落在两档之间有效", () => {
  assert.deepEqual(
    validateAnswer("q", SCORE_Q, {
      type: "score",
      score: 1.43,
      confidence: 0.7,
      probabilities: { 0: 0.1, 1: 0.6, 2: 0.3 },
    }),
    [],
  );
});

console.log("[validateAnswer] 非法答案（每类一条）");

ok("choice：概率和偏离 1 超过 ±0.05", () => {
  const problems = validateAnswer("q", CHOICE_Q, {
    type: "choice",
    choice: "practice",
    confidence: 0.9,
    probabilities: { review: 0.4, practice: 0.85, other: 0.05 }, // 和 1.3
  });
  assert.ok(problems.some((p) => p.includes("之和")));
});

ok("choice：choice 不是最大概率项", () => {
  const problems = validateAnswer("q", CHOICE_Q, {
    type: "choice",
    choice: "review", // 0.1 < 0.85
    confidence: 0.9,
    probabilities: { review: 0.1, practice: 0.85, other: 0.05 },
  });
  assert.ok(problems.some((p) => p.includes("不是最大项")));
});

ok("choice：choice 不在请求选项集内", () => {
  const problems = validateAnswer("q", CHOICE_Q, {
    type: "choice",
    choice: "unknown",
    confidence: 0.9,
    probabilities: { review: 0.1, practice: 0.85, other: 0.05 },
  });
  assert.ok(problems.some((p) => p.includes("不在请求选项集")));
});

ok("noul：P(yes)=1.5 越界", () => {
  const problems = validateAnswer("q", { type: "noul" }, { type: "noul", noul: 1.5 });
  assert.ok(problems.some((p) => p.includes("[0,1]")));
});

ok("score：score=3 超出档位数-1", () => {
  const problems = validateAnswer("q", SCORE_Q, {
    type: "score",
    score: 3,
    confidence: 0.9,
    probabilities: { 0: 0, 1: 0, 2: 1 },
  });
  assert.ok(problems.some((p) => p.includes("score 越界")));
});

ok("confidence：1.2 越界", () => {
  const problems = validateAnswer("q", CHOICE_Q, {
    type: "choice",
    choice: "practice",
    confidence: 1.2,
    probabilities: { review: 0.1, practice: 0.85, other: 0.05 },
  });
  assert.ok(problems.some((p) => p.includes("confidence 越界")));
});

ok("type 与请求不一致", () => {
  const problems = validateAnswer("q", CHOICE_Q, {
    type: "noul",
    noul: 0.5,
  });
  assert.ok(problems.some((p) => p.includes("type 不匹配")));
});

console.log("[validateAnswers] 汇总语义");

ok("缺答案 → invalid 标记；有效答案保留；缺 confidence → confidenceMissing", () => {
  const { valid, invalid, confidenceMissing } = validateAnswers(
    { a: CHOICE_Q, b: { type: "noul" }, c: CHOICE_Q },
    {
      a: { type: "choice", choice: "practice", confidence: 0.9, probabilities: { review: 0.1, practice: 0.85, other: 0.05 } },
      b: { type: "noul", noul: 0.2 },
      c: { type: "choice", choice: "review", probabilities: { review: 0.9, practice: 0.07, other: 0.03 } }, // 无 confidence
    },
  );
  assert.ok(valid.a && valid.b && valid.c);
  assert.ok(invalid.a === undefined);
  assert.deepEqual(confidenceMissing, ["c"]);
});

ok("answers 缺失 → 抛 envelope 级错误", () => {
  assert.throws(() => validateAnswers({ a: CHOICE_Q }, undefined), /缺少 answers/);
  assert.throws(() => validateAnswers({ a: CHOICE_Q }, "nope"), /缺少 answers/);
});

console.log("[decide+mock] 校验接线");

ok("mock 全链路：合法响应不产生 invalid_questions", async () => {
  const resp = await decide(
    {
      state: "测试",
      questions: {
        a: { type: "choice", criteria: { x: "选x", y: "选y" } },
        b: { type: "noul", instructions: "是否" },
      },
    },
    { mock: true, model: "decision-model-preview" },
  );
  assert.equal(resp.invalid_questions, undefined);
  assert.equal(resp.confidence_missing, undefined);
  assert.ok(resp.answers.a.choice === "x");
});

ok("sugar 工具：mock 下正常返回（校验通过）", async () => {
  const { decideChoice } = await import("../bailian.mjs");
  const r = await decideChoice(
    { state: "s", question: "q?", options: { a: "甲", b: "乙" } },
    { mock: true, model: "decision-model-preview" },
  );
  assert.ok(r.choice);
  assert.equal(r.invalid_response, undefined);
});

console.log(`\nunit.mjs: ${n} assertions ALL PASS`);
