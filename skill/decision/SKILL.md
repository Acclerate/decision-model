---
name: decision
description: 通过 decision-model MCP 调用百炼 Decision Model（System One 协议）做结构化决策：choice（封闭选项多选一）、noul（是否概率判断）、score（有序量表打分），一次前向返回概率分布与置信度、不生成文本。当需要把模糊判断变成可量化的决策时使用——Obsidian 笔记分诊、任务优先级、工单/内容分流、下一步行动选择、风险与严重度评估。不适用于：纯事实问答、开放式创作、无事实依据的主观偏好、能用确定性规则直接判断的情况。
---

# Decision Skill

**分层原则**：decision-model MCP 提供**能力**（怎么调百炼决策模型），本 Skill 定义**工作流**（什么时候调、state 和 criteria 怎么设计、结果怎么用、什么时候不要调）。MCP 返回原始概率，执行策略在这里。

## 1. 工具速查

| 工具 | 用途 | 返回关键字段 |
|---|---|---|
| `decide` | 批量决策（state + 多问题，一次前向） | `answers{<问题id>: ...}` |
| `decide_choice` | 单项：封闭选项多选一 | `choice` + `probabilities` + `confidence` + `policy` |
| `decide_noul` | 单项：是否判断 | `noul`(P(yes)∈[0,1]) + `verdict` + `policy` |
| `decide_score` | 单项：量表打分 | `score`(概率加权期望，可落两档之间) + `legend` + `probabilities` + `policy` |
| `decision_verify` | 断言核验：claims vs evidence，逐条独立判定 | `results{<断言id>: relation + decision}` + `summary` |
| `decision_screen` | 文本进上下文前安检（注入/实质/相关） | `probabilities` + `recommendation`(pass/review/block/skip) |
| `decision_classify` | 批量打标：items × 共享 classes，一次前向 | `results{<条目id>: class + p_max + margin + status}` |
| `decision_config` | 查看解析配置（排错） | endpoint / model / mock / api_key_set |

批量优先：同一个 state 上要问多件事时，用一次 `decide` 带 3~5 个问题，而不是连续调 3~5 次单项工具（延迟近线性，批量省往返）。

**原语 vs 语义工具**：`decide`/`decide_*` 是协议原语（你自己设计 questions/criteria）；`decision_verify/screen/classify` 是预设好的问题组合——断言核验、上下文安检、批量打标这类高频模式直接用语义工具，别用原语重复造。

## 2. 什么时候调用，什么时候不要

**适合调用**（三个条件同时满足）：
1. 问题能收敛为**封闭集合**：选一个选项 / 判断是否 / 在固定档位上打分；
2. 决策依据可以写成 **state 字段**（事实、数据、当前状态）；
3. 需要的是**判定**而不是文本——输出会是概率，后续动作明确。

**不要调用**：
- 选项无法穷举（开放式问题）→ 先让对话模型或用户收敛出选项集，再调；
- state 缺少关键事实 → 先去补事实（读笔记/查代码/问用户），拿"不知道"去问只会得到低置信噪声；
- 纯主观偏好、审美、创意取舍 → 没有客观依据，概率无意义；
- 能用确定性规则判断的（`deadline < today` → 已逾期）→ 写规则，不要浪费一次前向；
- 需要生成文本、推理过程或解释 → 用对话模型，决策模型不生成文本；
- 同一问题的定义（id/type/instructions/criteria）在同一业务里反复变更 → 问题定义即分布，改动会破坏概率校准。

## 3. 三种问题类型怎么选

| 场景 | 类型 | 设计要点 |
|---|---|---|
| 从几个明确动作/类别里选一个 | `choice` | 选项互斥（MECE），补一个 `other` 兜底 |
| 二分判断：要不要、是不是、值不值 | `noul` | 问题写成可验证的是非句；可选给 true/false 描述 |
| 程度、优先级、严重度、质量 | `score` | 档位 3~7 级，从低到高，每级可清晰区分 |

## 4. state 设计四原则

1. **客观**：放事实和当前状态，不放你的猜测和结论（猜测是模型该算的，不是输入）；
2. **当下**：反映此刻状态（`mastery`、`last_studied`、`deadline`），过期数据先更新再问；
3. **可量化**：能数字的用数字（难度 1~5、掌握度 0~1），比形容词可靠；
4. **够用就好**：与问题无关的字段不放；state 上限 65536 token，长正文只放摘要。

学习笔记示例 state：

```json
{
  "title": "Nginx upstream",
  "summary": "upstream 块定义后端服务器组，配合 proxy_pass 做负载均衡……",
  "difficulty": 4,
  "mastery": 0.35,
  "importance": 0.85,
  "last_studied": "2026-09-30",
  "note_age_days": 2
}
```

## 5. criteria 设计

- **choice**：选项名用小写下划线（`review`/`practice`），描述写"什么情况选它"。务必互斥、覆盖完整，最后加 `"other": "以上都不是"`。宁可多一个兜底项，不要让模型硬选。
- **score**：档位描述从低到高，写成可观察的行为/后果，而不是程度副词。差：`["低","中","高"]`；好：`["轻微，不影响功能", "部分受影响但有替代方案", "核心不可用且无替代", "严重业务或安全影响"]`。
- **noul**：默认可省略 criteria；判定标准有歧义时给 `{"true": "…的情况", "false": "…的情况"}`。

## 6. 结果解读与执行阈值

**工具已内置机械阈值映射**（可按调用覆盖）：单项工具返回 `policy` 字段，语义工具返回 `decision`/`status`/`recommendation`。默认值与本节一致，高风险场景可调严（如 `auto_accept: 0.9`）：

- `decide_choice` / `decide_score`：`auto_accept`（默认 0.8）、`review_at`（默认 0.5）→ `policy: auto / review / manual`；缺 confidence 一律 review
- `decide_noul`：`auto_accept`（默认 0.8）→ `policy: auto_yes / review / auto_no`
- `decision_verify`：`auto_accept`（默认 0.8，confidence 口径）→ 每条断言 `decision: auto / review`
- `decision_classify`：`auto_accept`（默认 0.85）+ `minimum_margin`（默认 0.5）→ 每条 `status: auto / review`
- `decision_screen`：`block_at`（默认 0.75）、`review_at`（默认 0.25）→ `recommendation`（建议，执行权在你）

对每个答案取**最高选项概率** `p_top`（score 取分布集中度）：

| p_top | confidence | 动作 |
|---|---|---|
| ≥ 0.8 | ≥ 0.6 | **直接执行**，记录决策到结果载体（如 YAML） |
| 0.5 ~ 0.8 | 任意 | **复核**：给出 top-2 及概率、一句话理由，请用户确认后再执行 |
| < 0.5 | 任意 | **不执行**。大概率是 state 不足或选项设计有问题——修输入，重问或转人工 |

- `noul`：P ≥ 0.8 视为"是"，P ≤ 0.2 视为"否"，中间 = 不确定（补 state 重问或人工）。
- `score` 的 `score` 是期望值，可以落在两档之间（如 2.25），不要强行取整理解；看 `probabilities` 判断分布是否集中。
- **低置信 ≠ 换个问法硬问**。低置信是信号：信息不够（补 state）或选项设计有歧义（改 criteria）。
- 多问题批量返回时逐问套用阈值，不要因为"大多数置信"就整体放行。

## 7. 工作流模板 A：Obsidian Inbox 学习笔记分诊

```
新笔记进入 Inbox/
  ↓ 1. 提取/补全 YAML 元数据（difficulty 1~5、mastery 0~1、importance 0~1、last_studied）
  ↓ 2. state = 元数据 + 正文摘要
  ↓ 3. 一次 decide 三问：
       next_action  choice: review(复习巩固)/practice(动手实践)/learn_more(补前置知识)/archive(归档)/other
       priority     score: ["可等，闲时处理","本周内安排","尽快安排","立即处理"]
       needs_prerequisite  noul: "当前掌握度是否不足以开始实践（需要先学前置知识）？"
  ↓ 4. 逐问套用第 6 节阈值 → 自动执行 / 复核 / 人工
  ↓ 5. 执行后把 decision 块写回 frontmatter，按 next_action 移动文件：
       review → Learning/；practice → 保留 Inbox 并生成行动清单或转 Projects/；
       learn_more → Learning/ 并在正文标注缺失的前置知识；archive → Archive/
```

写回的 YAML 格式：

```yaml
---
title: Nginx upstream
tags: [inbox, learning]
difficulty: 4
mastery: 0.35
importance: 0.85
last_studied: 2026-09-30
decision:
  at: 2026-10-02T21:00:00+08:00
  model: decision-model-preview
  next_action:
    value: practice
    probability: 0.82
    confidence: 0.9
    mode: auto          # auto=自动执行 / reviewed=复核后执行 / manual=人工决定
  priority:
    value: 2.1
    confidence: 0.87
  needs_prerequisite:
    p_yes: 0.31
---
```

复核场景（0.5~0.8）时 `mode` 写 `reviewed`，并把 top-2 选项与概率写进正文引用块，供用户确认。

## 8. 工作流模板 B：任务 / 需求优先级

```json
{
  "state": {
    "title": "订单导出超时",
    "description": "导出超过 1 万行时超时失败",
    "deadline": "2026-10-10",
    "estimated_hours": 8,
    "dependencies": ["需要运维配合扩容"],
    "requester": "客服团队",
    "affected_users": 200
  },
  "questions": {
    "priority": {
      "type": "score",
      "instructions": "这个需求的实现优先级",
      "criteria": ["P3 闲时处理", "P2 正常排期", "P1 本周内", "P0 立即插队"]
    },
    "blocked": { "type": "noul", "instructions": "是否被外部依赖阻塞、现在开工无意义？" },
    "auto_approvable": { "type": "noul", "instructions": "是否无需人工确认即可直接开工？" }
  }
}
```

用法：`priority` 套阈值决定是否进本周期；`blocked=true` 时即使 P0 也先去清依赖；`auto_approvable` 为否时创建任务并等确认。

## 9. 配置与排错

| 环境变量 | 说明 |
|---|---|
| `DASHSCOPE_API_KEY` | 百炼 API Key（必需） |
| `DECISION_WORKSPACE_ID` | **业务空间 ID**（必需，百炼控制台 → 业务空间管理页可查）。endpoint 为 `https://{ID}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone` |
| `DECISION_BASE_URL` | 完整覆盖 endpoint（两者给一个即可） |
| `DECISION_MODEL` | 模型名，默认 `decision-model-preview`；可指向微调产物 |
| `DECISION_REGION` | `cn`（默认）/ `intl`（新加坡站） |
| `DECISION_AUTH_STYLE` | `bearer`（默认）/ `raw`（不加 Bearer 前缀） |
| `DECISION_TIMEOUT_MS` | 每次尝试的请求超时毫秒，默认 60000 |
| `DECISION_MAX_ATTEMPTS` | 408/429/5xx 重试总次数（含首次），默认 3，范围 1~6；网络层错误不重试 |
| `DECISION_MOCK` | `1` = 离线 mock，不访问网络（响应结构与真实一致） |

排错顺序：先调 `decision_config` 看解析配置 → mock 通了再上真实 Key → 404 查 workspace id → 401/403 试 `DECISION_AUTH_STYLE=raw` 并确认 Key 已开通决策模型权限。

## 10. 参考

- System One 协议完整字段与限制：`references/systemone-api.md`
- 官方文档：https://help.aliyun.com/zh/model-studio/decision-model-api
