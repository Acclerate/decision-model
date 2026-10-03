# decision-model — 百炼 Decision Model 的 Skill + MCP

把[百炼决策模型](https://help.aliyun.com/zh/model-studio/decision-model-api)（System One 协议：`choice` / `noul` / `score`，一次前向返回概率分布与置信度、不生成文本）接入你的 AI 工作流：

```text
                你的各种 AI Agent（Obsidian / Java / 脚本 / IDE…）
                                    │
                     ┌──────────────┴──────────────┐
                     ↓                             ↓
        Skill：decision（工作流层）        其他领域 Skill
        · 什么时候该调用、什么时候不要      · learning-decision…
        · state / criteria 怎么设计                │
        · 概率阈值策略（自动/复核/人工）            │
                     ↓                             ↓
        MCP：decision-model（能力层，本项目）
        · 协议原语：decide / decide_choice / decide_noul / decide_score
        · 语义工具：decision_verify / decision_screen / decision_classify
        · 契约校验（fail-closed）、重试与脱敏、API Key 管理、mock
                     ↓
        百炼 Decision Model（decision-model-preview）
```

> **MCP = "我能做什么"（能力），Skill = "我该什么时候、怎么做"（策略）。** 换 Provider（如换成同样实现 System One 协议的 Jev）、换模型、从免费转收费，只动 MCP 的环境变量，所有 Skill 与上层 Agent 不变。
>
> 📖 **完整使用文档（安装、工具详解、决策设计指南、场景手册、配置、排错、FAQ）：[docs/USAGE.md](docs/USAGE.md)**

## 目录结构

```text
decision-model/
├── server/                     # MCP server（零依赖 Node ≥18，stdio 传输）
│   ├── index.mjs               #   协议层：initialize / tools/list / tools/call
│   ├── bailian.mjs             #   System One 客户端：校验、调用、重试、mock、sugar 工具
│   ├── validate.mjs            #   answers 契约校验（fail-closed，唯一权威源）
│   ├── semantic.mjs            #   语义工具：verify / screen / classify
│   └── test/
│       ├── client.mjs          #   极简 MCP 测试客户端
│       ├── unit.mjs            #   契约校验单元测试（离线）
│       ├── retry.test.mjs      #   重试与错误脱敏测试（本地假网关，离线）
│       ├── smoke.mjs           #   冒烟测试（mock 全链路 + 可选真实调用）
│       ├── jev-cases.mjs       #   Jev 典型用例集 14 例（真实 API）
│       └── grill-scorecard.mjs #   grill-decision 评分卡协议参考实现（真实 API）
├── skill/decision/             # decision Skill（策略层，复制到 skills 目录即装）
│   ├── SKILL.md                #   何时调用 / 三类型选择 / state·criteria 设计 / 阈值 / 工作流模板
│   └── references/systemone-api.md  # 协议完整参考
├── skill/grill-decision/       # 选项评分卡 Skill：配合 grilling/grill-me 产出判别分数与统计分类
│   └── SKILL.md
├── examples/obsidian-note.md   # Obsidian 笔记 YAML 格式示例
├── docs/USAGE.md               # 使用文档（本仓库最全的操作手册）
├── tools/provision/            # AK/SK 自动接入（发现业务空间 + 建/复用 API Key）
│   └── provision.mjs
├── package.json                # npm 分发（bin: decision-model-mcp）
├── LICENSE                     # MIT
└── README.md
```

## 快速开始

**1. AK/SK 一键接入**（自动发现业务空间 + 建/复用百炼 API Key）

决策模型必须走业务空间网关，而空间 ID（形如 `llm-xxxx`）无法猜测——`tools/provision/provision.mjs` 通过 ModelStudio OpenAPI（RAM AK/SK 签名，官方 SDK）自动完成全部步骤：

```bash
cd tools/provision && npm install   # 首次：安装 @alicloud/modelstudio20260210
node provision.mjs                  # 可选参数：--csv <AK文件> --workspace-id <id> --region cn-beijing
```

脚本行为：解析 CSV 中的 AccessKey → `ListWorkspaces` 列出并选定业务空间 → `ListApiKeys` 复用可用 Key（没有才 `CreateApiKey`，幂等友好）→ 凭据明文写入 `tools/provision/credentials.local.json`（**勿提交仓库**），控制台输出全程打码。随后把 `DASHSCOPE_API_KEY` + `DECISION_WORKSPACE_ID` 写入客户端 MCP 配置的 `env`（见下一步）。

> ⚠️ 决策模型为预览版，部分账号需先开通权限（文档注明联系商务开通）。未开通时网关会返回 401/403。

<details><summary>手动获取两个配置值（替代方案）</summary>

| 值 | 来源 |
|---|---|
| `DASHSCOPE_API_KEY` | [百炼控制台 API-KEY 页](https://bailian.console.aliyun.com/) |
| `DECISION_WORKSPACE_ID` | 百炼控制台 → **业务空间管理** 页。网关：`https://{ID}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone`（实测 `dashscope.aliyuncs.com` 主机不提供该路径） |

</details>

**2. 注册 MCP**（npm 包 `decision-model-mcp`，任意支持 stdio 的客户端通用）

以 ZCode 为例，写进 `~/.zcode/cli/config.json` 的 `mcp.servers`：

```json
"decision-model": {
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "decision-model-mcp"],
  "enabled": true,
  "timeoutMs": 60000
}
```

`DASHSCOPE_API_KEY` 已在系统环境变量里则无需再配；否则加 `"env": { "DASHSCOPE_API_KEY": "...", "DECISION_WORKSPACE_ID": "..." }`（provision 脚本产出的两个值就填在这里；配置 env 优先于系统环境变量）。重启会话后，在 **Settings → MCP** 应看到 `decision-model` 已连接、8 个工具（`mcp__decision-model__*`）。

<details><summary>本地开发态：直接用仓库绝对路径注册（不经 npm）</summary>

```json
"decision-model": {
  "type": "stdio",
  "command": "node",
  "args": ["D:\\privategit\\github\\decision-model\\server\\index.mjs"],
  "enabled": true,
  "timeoutMs": 60000
}
```

</details>

**3. 验证链路**（无 Key / 无空间 ID 也能先跑通）

```bash
npm test                         # 离线全量：契约校验单测 + 重试脱敏 + mock 全链路
node server/test/smoke.mjs --real   # 追加真实百炼调用（需要上面两个环境变量）
```

也可以在任意会话里直接问 Agent：*"用 decision_config 查看决策模型配置"*。

**4. 安装 Skill**

```bash
# 仓库克隆用户
cp -r skill/decision ~/.zcode/skills/decision
# Claude Code（可选）
# cp -r skill/decision ~/.claude/skills/decision
```

npm 安装的用户：skill 已随包分发，`npm pack decision-model-mcp && tar -xzf decision-model-mcp-*.tgz` 后从 `package/skill/` 复制即可。

之后对 Agent 说"帮我分诊一下 Inbox 里今天新进的笔记"，它就会按 Skill 里的工作流调用 MCP。

## 工具一览

| 工具 | 入参要点 | 返回 |
|---|---|---|
| `decide` | `state`（字符串/对象/数组）+ `questions` 问题表（≤16 问，key 自定义） | 上游原始 `answers`（逐问：choice/noul/score + probabilities + confidence + legend；畸形答案标记 `invalid_response`） |
| `decide_choice` | `state` + `question` + `options`（`{名:描述}` 或数组）；可选 `auto_accept`/`review_at` | 选中项 + 概率分布 + confidence + `policy`（auto/review/manual） |
| `decide_noul` | `state` + `question`（可选 true/false 描述）；可选 `auto_accept` | P(yes)∈[0,1] + verdict + `policy`（auto_yes/review/auto_no） |
| `decide_score` | `state` + `question` + `criteria`（低→高档位描述数组，3~7 级为宜）；可选 `auto_accept`/`review_at` | 期望分值（可落两档间）+ legend + 概率 + confidence + `policy` |
| `decision_verify` | `claims`（≤16 断言）+ `evidence`（字符串或 ≤16 项） | 逐断言 `relation`（supports/contradicts/says_nothing）+ `decision`（auto/review）+ `summary` |
| `decision_screen` | `text` + 可选 `purpose`、`block_at`(0.75)/`review_at`(0.25) | injection/substance/relevance 概率 + `recommendation`（pass/review/block/skip） |
| `decision_classify` | `items`（≤64 条）+ `classes` 目录；可选 `auto_accept`(0.85)/`minimum_margin`(0.5) | 逐条 `class` + p_max + margin + `status`（auto/review，双门槛） |
| `decision_config` | 无 | 解析后的配置（不含 Key），排错用 |

前四个是**协议原语**（调用方自己设计 questions/criteria），后三个是**语义工具**（预设问题组合 + 确定性判定映射，断言核验/上下文安检/批量打标直接用，不必现场造 criteria）。工具描述里内嵌了阈值经验；完整策略与反例清单见 SKILL.md。

## 其他客户端接入

任何支持 stdio MCP 的客户端注册方式相同（路径换成绝对路径）：

<details>
<summary><b>Claude Desktop</b>（<code>%APPDATA%\Claude\claude_desktop_config.json</code>）</summary>

```json
{
  "mcpServers": {
    "decision-model": {
      "command": "node",
      "args": ["D:\\privategit\\github\\decision-model\\server\\index.mjs"],
      "env": { "DASHSCOPE_API_KEY": "sk-...", "DECISION_WORKSPACE_ID": "你的空间ID" }
    }
  }
}
```
</details>

<details>
<summary><b>Cursor</b>（<code>~/.cursor/mcp.json</code>）</summary>

```json
{
  "mcpServers": {
    "decision-model": {
      "command": "node",
      "args": ["D:\\privategit\\github\\decision-model\\server\\index.mjs"],
      "env": { "DASHSCOPE_API_KEY": "sk-...", "DECISION_WORKSPACE_ID": "你的空间ID" }
    }
  }
}
```
</details>

<details>
<summary><b>Java / 其他语言直连</b>（不经过 MCP）</summary>

System One 就是普通 HTTP JSON 接口，Java 用 HttpClient 直接调即可（字段详见 [skill/decision/references/systemone-api.md](skill/decision/references/systemone-api.md)）：

```java
HttpRequest req = HttpRequest.newBuilder()
    .uri(URI.create("https://" + WORKSPACE_ID + ".cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone"))
    .header("Authorization", "Bearer " + DASHSCOPE_API_KEY)
    .header("Content-Type", "application/json")
    .POST(BodyPublishers.ofString(payload))   // {"model":..., "state":..., "questions":{...}}
    .build();
// 响应 answers.<问题id> → choice / noul / score + probabilities + confidence
```
</details>

## 测试

```bash
npm run check                     # 语法
npm test                          # 离线全量：契约校验单测（unit）+ 重试/脱敏（retry）+ mock 全链路（smoke）
npm run test:real                 # 真实 API 冒烟（可选，需要凭据）
npm run test:jev                  # Jev 典型用例集 14 例（真实 API）：工单分流/风控/Agent 路由/LLM 质检/verify/screen/classify/unknowable 校准
```

已在 2026-10-02 用 `tools/provision` 产出的凭据完成真实链路验证：学习笔记 state（difficulty 4 / mastery 0.35 / importance 0.85）→ 真实返回 `choice: practice`（p=0.74, confidence=0.66, 42.5ms, `input_tokens=99`），语义符合预期。

## 已知事项

- **响应契约校验（fail-closed）**：每个上游答案必须通过 `server/validate.mjs` 的契约（概率分布完整且和为 1±0.05、choice 为最大概率项、数值在界内）。畸形答案逐问标记 `invalid_response` 并汇总到 `invalid_questions`，有效答案不受影响；单项工具遇到无效答案直接报错。
- **重试与脱敏**：重试白名单 408/409/429/500~599 自动重试（抖动指数退避，`DECISION_MAX_ATTEMPTS` 默认 3 次，600+ 视为协议噪音不重试）；网络层错误不重试（付费 POST 防双花）；响应体流式强制 1MB 上限、超限中止不重试；所有错误文本经脱敏（API Key 替换为 `***`）后才对调用方可见。对标用例见 `server/test/parity.mjs`。
- **阈值参数化**：单项与语义工具的 `auto_accept`/`review_at`/`minimum_margin` 可按调用覆盖，返回 `policy`/`decision`/`status`/`recommendation` 机械映射字段；默认值与 SKILL §6 一致，执行策略仍在 skill。
- **endpoint 必须显式配置**：`dashscope.aliyuncs.com/compatible-mode/v1/systemone` 实测 404，与微调指南 FAQ 的说法不一致，以实测与主文档（业务空间网关）为准。未配置 `DECISION_WORKSPACE_ID` 时工具会返回带修复指引的明确错误。
- **鉴权**默认 `Bearer <Key>`；若网关要求裸 Key，设 `DECISION_AUTH_STYLE=raw`。
- **mock 模式**（`DECISION_MOCK=1`）响应结构与真实一致并带 `mock: true` 标记，用于无 Key 跑通链路和客户端开发。
- **换 Provider**：任何实现 System One 协议的服务（如 TypeSafe Jev）改 `DECISION_BASE_URL` + `DECISION_MODEL` 即接入，上层不动。
- 模型为预览版（团队持续迭代），对稳定性要求高的场景可等正式版后再切换（只改 `DECISION_MODEL`）。
