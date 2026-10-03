---
title: Nginx upstream
tags:
  - inbox
  - learning
difficulty: 4
mastery: 0.35
importance: 0.85
last_studied: 2026-09-30
---

# Nginx upstream

upstream 块用于定义后端服务器组，配合 `proxy_pass` 实现负载均衡。支持轮询（默认）、`weight` 加权、`ip_hash` 会话保持、`least_conn` 最少连接等策略；`max_fails` / `fail_timeout` 控制被动健康检查……

## 决策记录（由 decision skill 写回）

```yaml
decision:
  at: 2026-10-02T21:00:00+08:00
  model: decision-model-preview
  next_action:
    value: practice
    probability: 0.82
    confidence: 0.9
    mode: auto
  priority:
    value: 2.1
    confidence: 0.87
  needs_prerequisite:
    p_yes: 0.31
```

判定：难度 4 / 掌握度 0.35 / 重要性 0.85，模型建议**动手实践**（练一个最小 upstream + 权重轮询配置），
优先级约 2.1（"尽快安排"与"本周内"之间），前置知识风险低（0.31）。
按阈值策略 P=0.82 ≥ 0.8 且 confidence ≥ 0.6，自动执行：本条移入 `Learning/` 并在今日行动清单生成实践任务。
