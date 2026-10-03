# decision-model 使用文档

> 把百炼 Decision Model（System One 协议：`choice` / `noul` / `score`）变成你所有 AI Agent 共用的"决策基础设施"。
>
> - **MCP**（能力层）：封装 API 调用、鉴权、校验、mock——回答"我能做什么"
> - **Skill**（策略层）：什么时候调、state/criteria 怎么设计、概率阈值怎么执行——回答"我该怎么做"
>
> 本文面向**使用者**。协议细节见 [skill/decision/references/systemone-api.md](../skill/decision/references/systemone-api.md)；架构与快速开始见 [README](../README.md)。

---

## 目录

1. [五分钟上手](#1-五分钟上手)
2. [五个 MCP 工具详解](#2-五个-mcp-工具详解)
3. [决策设计指南](#3-决策设计指南)
4. [场景手册（Recipes）](#4-场景手册recipes)
5. [配置参考](#5-配置参考)
6. [测试与验证](#6-测试与验证)
7. [故障排查](#7-故障排查)
8. [FAQ 与实测结论](#8-faq-与实测结论)

---

## 1. 五分钟上手

### 1.1 前置条件

- Node.js ≥ 18（服务端零依赖，无需 `npm install` server 部分）
- 阿里云账号 + 百炼（Model Studio）开通
- 一个 MCP 客户端：ZCode / Claude Desktop / Cursor / 任意支持 stdio MCP 的 Agent

### 1.2 一键接入（AK/SK → 空间 ID + API Key）

决策模型必须走业务空间网关，空间 ID（形如 `llm-xxxxxxxx`）无法手填猜测，用接入脚本自动完成：

```bash
cd tools/provision
npm install          # 首次：安装 @alicloud/modelstudio20260210（仅此处需要联网装包）
node provision.mjs   # 默认读 D:/Documents/aliyun/aliyun_AccessKey.csv
```

可选参数：`--csv <AK文件路径>`、`--workspace-id <多空间时指定>`、`--region cn-beijing`（或 `intl`）。

脚本做四件事：

1. 从 CSV 解析 AccessKey（输出全程打码）；
2. `ListWorkspaces` 列出并选定业务空间；
3. `ListApiKeys` 复用已有可用 Key，没有才 `CreateApiKey`（幂等，可重复执行）；
4. 凭据明文写入 `tools/provision/credentials.local.json`（**勿提交仓库**；可随时在控制台删除重建 Key）。

### 1.3 注册 MCP

**ZCode**：编辑 `~/.zcode/cli/config.json`，在 `mcp.servers` 加入（provision 产出的两个值填进 `env`）：

```json
"decision-model": {
  "type": "stdio",
  "command": "node",
  "args": ["D:\\privategit\\github\\decision-model\\server\\index.mjs"],
  "enabled": true,
  "timeoutMs": 60000,
  "env": {
    "DASHSCOPE_API_KEY": "<provision 产出的 sk- Key>",
    "DECISION_WORKSPACE_ID": "<provision 发现的 llm- 空间ID>"
  }
}
```

配置里的 `env` 优先于系统环境变量。重启会话后，在 **Settings → MCP** 看到 `decision-model` 已连接、5 个工具即成功。

**Claude Desktop**（`%APPDATA%\Claude\claude_desktop_config.json`）/ **Cursor**（`~/.cursor/mcp.json`）：

```json
{ "mcpServers": { "decision-model": { "command": "node", "args": ["<绝对路径>/server/index.mjs"], "env": { "DASHSCOPE_API_KEY": "sk-...", "DECISION_WORKSPACE_ID": "llm-..." } } } }
```

### 1.4 安装 Skill（策略层）

```bash
cp -r skill/decision ~/.zcode/skills/decision    # ZCode
# cp -r skill/decision ~/.claude/skills/decision  # Claude Code
```

装好后，Agent 在遇到"从封闭选项选一个 / 判断是否 / 打分"类请求时会自动按 Skill 的工作流调用 MCP。

### 1.5 验证

```bash
node server/test/smoke.mjs        # mock 全链路（无需凭据）
node server/test/jev-cases.mjs    # 真实 API：11 个典型用例
```

或在会话里直接问 Agent：*"用 decision_config 查看决策模型配置"*。对话式调用示例：

> 帮我用决策模型判断：这条工单该给哪个团队——"客户反馈支付重复扣款，申请退款"（选项：billing / technical / sales）

---

## 2. 五个 MCP 工具详解

客户端里的完整工具名带前缀，如 `mcp__decision-model__decide`。

### 2.1 `decide` — 批量决策（推荐默认）

一次前向对**同一个 state** 问多个问题（实测几乎不增加耗时）。

| 参数 | 必填 | 说明 |
|---|---|---|
| `state` | ✓ | 业务状态：字符串 / 对象 / 数组（对象会被序列化后送模型，上限 65536 token） |
| `questions` | ✓ | 问题表：key 为自定义问题 id，value = `{ type, instructions?, criteria? }` |

`questions[*].type` 三选一：

| type | criteria | 语义 |
|---|---|---|
| `choice` | **必填**：`{选项名: 描述}`（1~255 项，建议补 `other` 兜底） | 多选一 |
| `noul` | 可选：`{"true": "…", "false": "…"}` | 是否判断 |
| `score` | **必填**：从低到高的档位描述数组（2~255 级，建议 3~7 级） | 有序量表 |

请求示例（工单分流三问）：

```json
{
  "state": { "ticket_id": "T-1001", "content": "订单支付后超过24小时仍未到账，要求立即处理。" },
  "questions": {
    "department": { "type": "choice", "instructions": "应该由哪个团队处理？",
      "criteria": { "billing": "支付、退款和账单问题", "technical": "产品故障和集成问题", "other": "以上都不是" } },
    "escalate":   { "type": "noul", "instructions": "是否需要立即通知值班人员？" },
    "severity":   { "type": "score", "instructions": "这个问题有多严重？",
      "criteria": ["轻微，不影响功能", "部分功能受影响但有替代方案", "核心功能不可用", "严重业务或安全影响"] }
  }
}
```

返回（上游原样透传）：

```json
{
  "model": "decision-model-preview",
  "request_id": "7b98…",
  "answers": {
    "department": { "type": "choice", "choice": "billing", "confidence": 0.53,
                    "probabilities": { "billing": 0.64, "technical": 0.22, "other": 0.13 } },
    "escalate":   { "type": "noul", "noul": 0.97 },
    "severity":   { "type": "score", "score": 2.25, "confidence": 0.91,
                    "legend": { "0": "轻微…", "1": "部分…", "2": "核心…", "3": "严重…" },
                    "probabilities": { "0": 0.0, "1": 0.01, "2": 0.73, "3": 0.26 } }
  },
  "usage": { "input_tokens": 125 },
  "latency_ms": 52.9
}
```

### 2.2 三个单项糖工具

不想手写问题表时用单项版，返回上游 answer + 派生字段（`verdict`、`level`）+ `usage/latency_ms/request_id`。

| 工具 | 必填参数 | 返回 |
|---|---|---|
| `decide_choice` | `state`、`question`、`options`（`{名:描述}` 或名称数组）；可选 `instructions` | `choice` + `probabilities` + `confidence` |
| `decide_noul` | `state`、`question`；可选 `criteria: {true, false}` | `noul`（P(yes)）+ `verdict`（P≥0.5 → yes） |
| `decide_score` | `state`、`question`、`criteria`（低→高档位数组）；可选 `instructions` | `score`（概率加权期望，可落两档之间）+ `legend` + `level`（最接近档位描述）+ `confidence` |

### 2.3 `decision_config` — 排错

无参数。返回解析后的配置（**不含 Key 本身**）：`base_url`、`model`、`region`、`workspace_id`、`auth_style`、`timeout_ms`、`mock`、`api_key_set`。

---

## 3. 决策设计指南

### 3.1 该不该调用（先问三个问题）

同时满足才调：① 问题能收敛为**封闭集合**；② 依据能写成 **state 字段**；③ 需要的是**判定**而非文本。

**不要调用**：选项无法穷举（先让对话模型收敛选项）；state 缺关键事实（先补事实）；纯主观偏好；能用确定性规则判断的（`deadline < today`）；需要生成文本/推理；问题定义频繁变更（问题定义即分布，改动破坏校准）。

### 3.2 state 四原则

1. **客观**：放事实与当前状态，不放猜测结论；
2. **当下**：`mastery`、`deadline` 等要反映此刻，过期先更新；
3. **可量化**：能数字的用数字（难度 1~5、掌握度 0~1）；
4. **够用就好**：无关字段不放；长正文只放摘要（上限 65536 token）。

实测提醒：**margin 依赖 state 质量**——同一问题，state 越完整 p_max 越高（详见 §8）。

### 3.3 结果解读与执行阈值（Skill 第 6 节）

对每个答案取最高选项概率 `p_top`：

| p_top | confidence | 动作 |
|---|---|---|
| ≥ 0.8 | ≥ 0.6 | **直接执行**，把决策写回结果载体 |
| 0.5 ~ 0.8 | 任意 | **复核**：给 top-2 与理由，请用户确认 |
| < 0.5 | 任意 | **不执行**：多半是 state 不足或选项有歧义——修输入重问 |

- `noul`：P≥0.8 是 / ≤0.2 否 / 中间=不确定（补 state 重问或转人工）；
- `score` 的分值是**期望**，可落在两档之间（如 2.25），不要强行取整；
- 低置信 ≠ 换个问法硬问，它是"信息不够或选项有歧义"的信号。

### 3.4 criteria 写法要点

- choice：选项名用小写下划线，描述写"什么情况选它"；互斥（MECE）+ `other` 兜底；
- score：档位写成可观察的后果，差：`["低","中","高"]`；好：`["轻微，不影响功能", "部分受影响但有替代方案", "核心不可用", "严重业务或安全影响"]`；
- noul：判定有歧义时给 `{"true": "…", "false": "…"}`。

---

## 4. 场景手册（Recipes）

> 以下 JSON 都可以直接贴给装了 decision skill 的 Agent，或通过 MCP 客户端调用。全部用例已在真实 API 验证（见 §8 数据）。

### 4.1 Obsidian Inbox 学习笔记分诊（本项目主场）

工作流：读 Inbox 笔记 → 提取 YAML 元数据 → 一次 decide 三问 → 按阈值执行 → 写回 `decision` 块 → 移动文件夹。

```json
{
  "state": { "title": "Nginx upstream",
             "summary": "upstream 块定义后端服务器组，配合 proxy_pass 做负载均衡；轮询/权重/ip_hash/least_conn。",
             "difficulty": 4, "mastery": 0.35, "importance": 0.85,
             "last_studied": "2026-09-30", "note_age_days": 2 },
  "questions": {
    "next_action": { "type": "choice", "instructions": "下一步应该做什么",
      "criteria": { "review": "复习巩固", "practice": "动手实践", "learn_more": "先补前置知识", "archive": "价值不足归档", "other": "以上都不是" } },
    "priority": { "type": "score", "instructions": "本次安排的优先级",
      "criteria": ["可等，闲时处理", "本周内安排", "尽快安排", "立即处理"] },
    "needs_prerequisite": { "type": "noul", "instructions": "当前掌握度是否不足以直接开始实践" }
  }
}
```

写回 frontmatter 的格式（复核场景 `mode` 写 `reviewed` 并附 top-2）：

```yaml
decision:
  at: 2026-10-02T21:00:00+08:00
  model: decision-model-preview
  next_action:  { value: practice, probability: 0.64, confidence: 0.55, mode: auto }
  priority:     { value: 1.22, confidence: 0.74 }
  needs_prerequisite: { p_yes: 0.53 }
```

移动规则：`review→Learning/`；`practice→Inbox 保留并生成行动清单（或转 Projects/）`；`learn_more→Learning/` 标注缺失前置；`archive→Archive/`。完整示例见 [examples/obsidian-note.md](../examples/obsidian-note.md)。

### 4.2 客服工单分流（官方示例）

见 §2.1 请求示例。用法：`department` 套阈值决定派单；`escalate=true` 触发值班通知；`severity` 进严重度统计。**实测**：p_max 偏低（0.64）时先补 state（账号信息、报错截图 OCR 文本），不要硬派单。

### 4.3 内容风控（批量审核）

```json
{
  "state": "加微信 xxx888 领取博彩网站内部渠道，日赚过万，稳赚不赔。",
  "questions": {
    "is_violating": { "type": "noul", "instructions": "这条评论是否违反平台内容规范（赌博/欺诈引流）" },
    "risk_level":   { "type": "score", "instructions": "风险等级",
                      "criteria": ["正常", "低风险（擦边）", "中风险（引流）", "高风险（欺诈/违法）"] }
  }
}
```

实测分离度：违规 0.98 / 正常 0.01。策略：≥0.8 自动拦截，0.5~0.8 进审核队列，≤0.2 放行。

### 4.4 Agent 工具路由（决策中间层）

Agent 每步动作前先问一次"调哪个工具 / 是否有风险"，只有需要生成文本时才叫大模型：

```json
{
  "state": "用户对 Agent 说：帮我查一下明天早上北京到上海的高铁班次和票价。",
  "questions": {
    "tool": { "type": "choice", "instructions": "下一步调用哪个工具",
      "criteria": { "flight_search": "查航班", "train_search": "查火车/高铁", "weather_check": "查天气",
                    "calendar": "改日程", "write_report": "写报告", "other": "以上都不是" } },
    "needs_confirmation": { "type": "noul", "instructions": "执行前是否需要用户确认" }
  }
}
```

实测：`train_search` p_max=1.0、conf=1.0——**选项描述写得具体（"查火车/高铁"）比笼统（"查出行信息"）margin 高得多**。

### 4.5 LLM 输出质检（廉价 AI 审核昂贵 AI）

用决策模型给大模型的回答做跑题/达标校验，成本几乎为零：

```json
{
  "state": "问题：如何在 Node.js 里读取环境变量？\n大模型回答：<待质检的回答全文>",
  "questions": {
    "is_offtopic": { "type": "noul", "instructions": "这个回答是否跑题（未回答用户的问题）" },
    "quality":     { "type": "score", "instructions": "回答质量",
                     "criteria": ["未回答问题", "答了但有明显错误", "基本正确但含糊", "正确且具体可执行"] }
  }
}
```

实测：跑题 0.83 / 贴题 0.09。策略：is_offtopic≥0.6 打回重答；quality<1 进人工抽检。

### 4.6 文档/知识库批量打标

对每篇文档一次 decide：`topic`(choice) + `difficulty`(score) + `is_actionable`(noul)。RPM 1200 / TPM 200万（官方限制），千篇文档分钟级完成；概率直接写回 frontmatter 或数据库。

### 4.7 grilling / grill-me 选项评分卡（grill-decision skill）

质询会话中某决策节点收敛出 ≥2 个候选选项、父节点证据已 settled 时，对**每个选项**做状态评估的统计分类与判别分数：

- **每选项 5 问**（可行性 / 致命缺陷 noul + 风险 / 成本 / 契合 score）+ 全局 `final_pick` choice，放进**同一次 `decide` 批量**（3 选项 = 16 问）；
- **判别分**：`D = 100×(0.30·P可行 + 0.25·(1−P致命) + 0.20·fit/3 + 0.15·(1−risk/3) + 0.10·(1−cost/3))`，权重会话内恒定；
- **统计分类**：D ≥ 75 推荐 / 60–74.9 可行·需复核 / 45–59.9 存疑 / <45 排除；`P致命 ≥ 0.8` 硬否决；
- **交叉校验**：全局 choice 与 D 最高项不一致 → 全表复核；低 margin（P 0.5~0.8）项反哺为下一轮质询问题。

协议与输出模板见 `skill/grill-decision/SKILL.md`（装入 `~/.zcode/skills/grill-decision/` 后，grilling 会话中说"给这轮的选项打分"即触发）。参考实现（登录态选型，3 选项 16 问，上游 108ms）：

```bash
node server/test/grill-scorecard.mjs
```

---

## 5. 配置参考

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `DASHSCOPE_API_KEY` / `BAILIAN_API_KEY` | — | 百炼 API Key（`sk-…`，来自 provision 或控制台） |
| `DECISION_WORKSPACE_ID` | — | **业务空间 ID**（`llm-…`）。endpoint = `https://{ID}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone` |
| `DECISION_BASE_URL` | — | 完整覆盖 endpoint（含路径）。换 Provider 时用 |
| `DECISION_MODEL` | `decision-model-preview` | 模型名；可指向微调产物 `decision-model-preview-2026-09-24-ft-xxxx` |
| `DECISION_REGION` | `cn` | `cn`（北京）/ `intl`（新加坡） |
| `DECISION_AUTH_STYLE` | `bearer` | `bearer`（`Authorization: Bearer <Key>`）/ `raw`（裸 Key，部分网关需要） |
| `DECISION_TIMEOUT_MS` | `60000` | 单请求超时 |
| `DECISION_MOCK` | 关闭 | `1` = 离线 mock（响应结构与真实一致，带 `mock: true` 标记），无 Key 跑通链路用 |

优先级：配置文件 `env` > 系统环境变量；`DECISION_BASE_URL` > `DECISION_WORKSPACE_ID` 拼接。

---

## 6. 测试与验证

| 命令 | 用途 |
|---|---|
| `node --check server/index.mjs && node --check server/bailian.mjs` | 语法自检 |
| `node server/test/smoke.mjs` | mock 全链路 8 步断言（无需凭据） |
| `node server/test/smoke.mjs --real` | 追加真实 API 冒烟（握手/工具表/单项/批量/错误处理） |
| `node server/test/jev-cases.mjs` | **真实 API 11 用例集**：工单分流/风控对照/Agent 路由/LLM 质检/批量打标/unknowable 校准 |
| `node server/test/grill-scorecard.mjs` | grill-decision 评分卡协议演示：3 选项 16 问批量 → 判别分/分类/交叉校验 |

用例集自动读 `tools/provision/credentials.local.json`；重跑 provision 即可轮换凭据（ListApiKeys 复用已有 Key，不会堆积）。

---

## 7. 故障排查

先调 `decision_config` 看解析结果（endpoint / mock / api_key_set），再对号入座：

| 症状 | 原因 | 解决 |
|---|---|---|
| 工具报"未设置百炼 API Key" | env 没配/没生效 | 把 Key 写进客户端配置的 `env`，重启会话；或设系统环境变量 |
| 工具报"缺少 endpoint" | 没配空间 ID | 设 `DECISION_WORKSPACE_ID`（provision 自动发现），或 `DECISION_BASE_URL` 整串覆盖 |
| HTTP 404（endpoint 不存在） | 空间 ID 错 / 用了 dashscope 主机 | 决策模型**只走业务空间网关**；核对 `decision_config.base_url` 的域名形态 |
| HTTP 401/403（鉴权问题） | Key 错误、未开通决策模型权限、网关要裸 Key | 确认 Key 归属与权限（预览版部分账号需商务开通）；试 `DECISION_AUTH_STYLE=raw` |
| 请求超时 | 网络/代理拦截 | 设 `DECISION_TIMEOUT_MS` 加大；检查代理对 `*.maas.aliyuncs.com` 的放行 |
| 结果像假的、带 `mock: true` | `DECISION_MOCK=1` 忘了关 | 去掉该变量重启 |
| Settings→MCP 里 server failed | 启动即崩 | 终端直接跑 `node server/index.mjs` 看 stderr；确认 Node ≥18 与绝对路径 |
| 工具返回 isError 文本 | 入参校验失败（如 choice 缺 criteria） | 按报错里的修复示例补参数 |

---

## 8. FAQ 与实测结论

**Q：一次能问多少个问题？**
官方不设上限，建议 ≤16（延迟随问题数近线性增长）。实测批量三问与单问耗时几乎相同（~58ms vs ~50ms），**优先批量**。

**Q：为什么 probabilities 加起来不是 1？**
上游把分布四舍五入到两位小数，和会落在 0.97~1.03。消费端做 ±0.05 容差即可（MCP 层已适配）。

**Q：confidence 怎么理解？能用公式算吗？**
实测：`choice` 严格符合 Jev 文档公式 `(n·p_max − 1)/(n − 1)`；**`score` 不符合**（另一套校准口径）。所以：choice 的 confidence 可用公式做二次校验；score 的 confidence 只作相对参考，档位判断以 `probabilities` 为准。

**Q：延迟和成本？**
实测上游 41~65ms/次（官方标称 70~500ms）；不生成文本，成本与"输出长度"无关。11 次真实调用合计约 900 input tokens。计费以官方页面为准。

**Q：state 会发到云端吗？**
会——决策模型是云端前向。涉密/敏感字段先脱敏再作为 state。

**Q：能换 Jev 或其他 System One Provider 吗？**
能，这正是分层的意义：改 `DECISION_BASE_URL`（如 `https://api.typesafe.ai/v1/systemone`）+ `DECISION_MODEL` + Key 三个变量，上层 Skill 和所有 Agent 不动。

**Q：能接微调产物吗？**
能。微调产物部署后把 `DECISION_MODEL` 指到 `decision-model-preview-2026-09-24-ft-xxxx` 即可。注意：**问题定义（id/type/instructions/criteria）必须与训练时一致**，改定义等于分布漂移。

**Q：模型会生成文字吗？**
不会。格式错误率数学保证为 0，但它不做推理、不解释、不写代码——需要"为什么"时用对话模型复盘。

**Q：高频自动执行安全吗？**
高风险链路（资金、风控、删除类操作）必须保留人工兜底：置信度低于阈值的流转复核，并把 `request_id` 与决策记录留痕（Obsidian 场景写回 YAML 的 `decision` 块就是留痕）。
