# 真实 Pi / HTTP 证据验收摘要

本摘要对应已记录的真实网页在线运行，复用历史证据；Stage 7B-1 没有创建新 Pi Session、请求模型或启动网页。本地复核结论与逐项检查以 `verification.json` 的实际执行结果为准。

- runId：`2026-10-16T06-25-59-472Z-92b4ec36-83c0-4df6-96dc-f8ae4bc72c7a`。
- 记录状态：PASS；`sessionCreated=true`；模型 `deepseek/deepseek-flash`；开放工具 `query_orders_by_date` 与 `audit_day`；`finalStopReason=stop`。
- 实际工具：`audit_day`；toolCallId：`call_00_VFrZkZJR8v9gX3TFZJjb6547`；原始 args：`{"date":"2026-10-15"}`。未传 `window_seconds`，结构化返回为默认 180 秒。
- 记录时间：2026-10-16 14:25:59.473–14:26:07.366 +08:00；核对业务日期为 2026-10-15。
- 四阶段共享同轮 runId/调用 ID/参数：sequence 1 `tool_execution_start`（14:26:00.281）、2 `execute_start`（14:26:00.282）、3 `execute_end`（14:26:00.294）、4 `tool_execution_end`（14:26:00.296），均为 +08:00；两个结束 `isError=false`。
- HTTP 关联：历史实际 `POST /api/audit`，请求日期 2026-10-15；HTTP 200，响应 PASS，同一 runId。HTTP 时间为 14:25:59.469–14:26:07.368 +08:00。
- 完整工具结果为 7 组：matched 1、field_mismatch 1、missing_recording 1、orphan_recording 1、needs_review 3。O002/R002 保留订单 75600 分、录音 79600 分及对应原文时间片段。三个复核候选为 O004/R004、O005+O006/R005、O007/R006+R007。

本地命令 `node --import tsx evidence/submission/verify.mjs` 实际调用现有 `src/agent/evidence.ts` 的 `collectAuditToolResults` 与 `scripts/smoke-audit-checks.ts` 的 `evaluateAuditSmoke`。原件和派生副本分别重建完整调用并执行 15 项检查；还核对 Runtime 文本 JSON、Runtime details、execute_end 和 summary.toolResults 全结果深度相等，以及 HTTP runId、日期、状态、结果数量、分布和历史日志哈希。命令仅读取并输出结果；首次生成报告使用相同命令加 `--write`。

来源为 `evidence/local/stage4/2026-10-16T06-25-59-472Z-92b4ec36-83c0-4df6-96dc-f8ae4bc72c7a/` 的 `summary.json`、`pi-events.jsonl`、`tool-executions.jsonl`，以及 `evidence/local/stage6-fix/http-audit-2026-10-15.json`。stage4 是共用 runner 的落盘目录，网页来源依据为关联 HTTP 制品。原件保持原位且不修改。

`run-summary.json` 仅省略 `prompt`、`evidenceDirectory`、`summaryPath` 三个字段；保留原始最终回答、全部业务结果、ID、参数、日期、时间与状态。两份 JSONL 和 HTTP 元信息经审查无须再脱敏，按字节原样复制；没有新增或改写业务原文。逐字段处理与源/派生 SHA-256 见 `provenance.json`。

| 原件（项目相对路径） | 原件 SHA-256 | 派生文件 | 派生 SHA-256 |
| --- | --- | --- | --- |
| `evidence/local/stage4/2026-10-16T06-25-59-472Z-92b4ec36-83c0-4df6-96dc-f8ae4bc72c7a/summary.json` | cbeea50cfc1d81a139c1ef3da050c49cc885f00c1f430c221d15ac8cb199fc40 | `run-summary.json` | 25d739d70ae906563eceb89fe11ba35fa6575c19bbafc595b2a83a4b5cba6844 |
| `evidence/local/stage4/2026-10-16T06-25-59-472Z-92b4ec36-83c0-4df6-96dc-f8ae4bc72c7a/pi-events.jsonl` | 5e1d350ae56013cf5e168fd6345716e985aa633d2e363fb6095d69ce8ca62a5e | `pi-events.jsonl` | 5e1d350ae56013cf5e168fd6345716e985aa633d2e363fb6095d69ce8ca62a5e |
| `evidence/local/stage4/2026-10-16T06-25-59-472Z-92b4ec36-83c0-4df6-96dc-f8ae4bc72c7a/tool-executions.jsonl` | 7f316504075a02150ec7e8cb04e0963188666539124574a16ae22643ffdb4aaf | `tool-executions.jsonl` | 7f316504075a02150ec7e8cb04e0963188666539124574a16ae22643ffdb4aaf |
| `evidence/local/stage6-fix/http-audit-2026-10-15.json` | f083aa4ed6a5618f7709ef468fbf19b7d8aeb7f7c9f69158b35e88945c51b6f4 | `http-acceptance.json` | f083aa4ed6a5618f7709ef468fbf19b7d8aeb7f7c9f69158b35e88945c51b6f4 |

HTTP 文件是当时保存的请求/响应元信息、关联断言与 body SHA-256，未留存完整原请求/响应体。因此本次只能复核元信息、日志与哈希关联，不能重新计算原 HTTP body 哈希或独立重做完整原响应比较；未补造响应体。

本地审查目录包含 8 个文件：`run-summary.json`、两份 JSONL、`http-acceptance.json`、`provenance.json`、`verification.json`、本摘要和 `verify.mjs`。面向外部学习的源码包仅收本摘要与 `verification.json`；不包含 JSONL、原始 summary、完整模型回答或 `evidence/local/`。外部摘要内的原始路径仅供来源辨识，不表示包内包含这些文件。
