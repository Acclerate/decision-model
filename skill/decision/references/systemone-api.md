# System One 协议参考（百炼 Decision Model）

> 来源：[决策模型API - 阿里云文档](https://help.aliyun.com/zh/model-studio/decision-model-api)、[决策模型微调最佳实践](https://help.aliyun.com/zh/model-studio/decision-model-tuning-guide)（2026-09 版）。以官方文档为准。

## Endpoint

决策模型走**业务空间网关**（`dashscope.aliyuncs.com` 主机不提供该路径，实测 404）：

```text
POST https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone   # 北京
POST https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/systemone # 新加坡
```

- `{WorkspaceId}`：业务空间 ID，百炼控制台「业务空间管理」页可查。
- Header：`Authorization: Bearer $DASHSCOPE_API_KEY`、`Content-Type: application/json`。
  （若网关返回 401，可尝试裸 Key 不加 Bearer 前缀，即 `DECISION_AUTH_STYLE=raw`。）

## 请求体

```json
{
  "model": "decision-model-preview",
  "state": { "...": "业务状态：字符串 / 对象 / 数组均可，对象会被序列化后送模型" },
  "questions": {
    "<自定义问题id>": {
      "type": "choice",
      "instructions": "问题描述或评判标准",
      "criteria": { "billing": "支付、退款和账单问题", "technical": "产品故障和集成问题" }
    }
  }
}
```

| 字段 | 必选 | 说明 |
|---|---|---|
| `model` | 是 | `decision-model-preview`（或微调产物名，如 `decision-model-preview-2026-09-24-ft-xxxx`） |
| `state` | 是 | 待决策业务状态（String / Object / Array） |
| `questions` | 是 | 问题表。key 为调用方自定义问题 id，value 见下 |

问题对象（`type` 必选，三选一）：

| type | criteria | 语义 |
|---|---|---|
| `choice` | 必选：选项名 → 描述 的对象（1~255 项，建议补 `other` 兜底） | 多选一 |
| `noul` | 可选：`{"true": "…", "false": "…"}` 描述 | 是否判断 |
| `score` | 必选：从低到高的档位描述数组（2~255 级，建议 3~7 级且每级可清晰区分） | 有序量表 |

## 响应体

```json
{
  "model": "decision-model-preview",
  "request_id": "7b986c65-b223-9341-b5f0-b988e27ecaac",
  "answers": {
    "department": {
      "type": "choice",
      "choice": "billing",
      "confidence": 0.88,
      "probabilities": { "billing": 0.94, "technical": 0.06 }
    },
    "escalate": { "type": "noul", "noul": 0.99 },
    "severity": {
      "type": "score",
      "score": 2.25,
      "confidence": 0.91,
      "legend": { "0": "轻微问题，不影响功能", "1": "部分功能受影响", "2": "核心功能不可用", "3": "严重业务或安全影响" },
      "probabilities": { "0": 0.0, "1": 0.01, "2": 0.73, "3": 0.26 }
    }
  },
  "usage": { "input_tokens": 125 },
  "latency_ms": 52.9
}
```

- `choice` → `choice`（选中项）+ `probabilities` + `confidence`
- `noul` → `noul`（P(yes)，0=否 1=是）
- `score` → `score`（概率加权期望，可落在两档之间）+ `legend`（档位索引→描述）+ `probabilities` + `confidence`

## 限制与建议

- 问题数不设上限（建议 ≤16，延迟随问题数近线性增长）；上下文上限 65536 token，超长 `state` 会被拒绝或截断。
- 不生成文本：延迟与成本与"输出长度"无关；不支持 Function Calling、system message、temperature 等采样参数。
- RPM 1200 / TPM 200万（北京与新加坡一致）。
- 问题定义（id / type / instructions / criteria）即分布：同一业务保持定义稳定，改动会破坏概率校准（微调场景尤其如此）。

## 微调

- 快照名 `decision-model-preview-2026-09-24`；微调用 `efficient_sft`（LoRA），产物部署后 `model` 传 `finetuned_output` 名，其余参数与基座调用相同。
- 训练数据为 JSONL，每条 = `state` + `questions`（含 `label` 硬标签、可选 `target` 软标签分布）。信息不足样本用 `target` 均匀分布（unknowable），专门压低模型在缺信息时的过度自信。
- 评估指标关注 Brier / ECE（校准）而不仅是准确率。

## curl 示例

```bash
curl -sS -X POST "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone" \
  -H "Authorization: Bearer $DASHSCOPE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "decision-model-preview",
    "state": {"content": "订单支付后超过 24 小时仍未到账，用户无法继续使用核心服务，要求立即处理。"},
    "questions": {
      "department": {"type": "choice", "instructions": "应该由哪个团队处理？",
                     "criteria": {"billing": "支付、退款和账单问题", "technical": "产品故障和集成问题"}},
      "escalate":  {"type": "noul", "instructions": "是否需要立即通知值班人员？"},
      "severity":  {"type": "score", "instructions": "这个问题有多严重？",
                    "criteria": ["轻微问题，不影响功能", "部分功能受影响，但存在替代方案",
                                 "核心功能不可用，没有替代方案", "造成严重业务或安全影响"]}
    }
  }'
```

## 本仓库环境变量对照

| 变量 | 对应 |
|---|---|
| `DASHSCOPE_API_KEY` / `BAILIAN_API_KEY` | API Key |
| `DECISION_WORKSPACE_ID` | `{WorkspaceId}`（拼入网关域名） |
| `DECISION_BASE_URL` | 完整覆盖 endpoint |
| `DECISION_MODEL` | `model`，默认 `decision-model-preview` |
| `DECISION_REGION` | `cn` / `intl`（选 maas 网关地域） |
| `DECISION_AUTH_STYLE` | `bearer`（默认）/ `raw` |
| `DECISION_TIMEOUT_MS` | 请求超时，默认 60000 |
| `DECISION_MOCK` | `1` = 离线 mock |
