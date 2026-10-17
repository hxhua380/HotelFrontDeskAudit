# Pi Agent 集成说明

当前 HTTP 层已复用本页的真实 runner，既有两日网页核对成功；用户已接受并冻结新版前端。本页保留 Stage 4 实现过程的历史记录，其中初轮 BLOCKED 仅描述当时缺少凭据的运行。当前可共享的 10-15 真实网页证据见[脱敏验收摘要](../evidence/submission/acceptance.md)，本轮没有新增模型调用。

## 设计与实施计划

目标：复用真实 Pi SDK 1.3.0 和现有业务函数，让模型通过 `audit_day` 取得结构化核对事实，再解释结果。

保持 `createHotelSession` 默认单工具配置，保证 Stage 1 原 smoke 与测试语义不变。新增 `auditEnabled: true` 模式只注册并开放 `query_orders_by_date`、`audit_day`。不开放通用文件或终端工具，不改变领域算法和正式数据。

调用链：`runAuditAgent → createHotelSession → session.subscribe/prompt → audit_day.execute → 两种 repository 查询 → auditDay → 工具结构化结果 → 模型解释`。Agent 返回值的 `toolResults` 只来自当前 runId 中四个阶段可关联的真实工具执行，`finalAnswer` 独立保存。没有成功审计调用时不补造结果。

Stage 4 日志独立保存到 `evidence/local/stage4/<runId>/`，排他创建新文件，保留原 Stage 1 日志。全局递增 sequence 补充事件顺序；按 runId、toolCallId、工具名、参数和返回值校验，不依赖并发事件相邻。

Stage 4 初轮检查时进程无 `DEEPSEEK_API_KEY` 且项目无 `.env`。当时完成离线实现与检查后，实际运行 smoke 写入 BLOCKED 证据；不要求粘贴密钥，不将离线结果计为在线成功。后续成功运行使用各自独立 runId 保存，未改写初轮日志。

- [x] 阅读指定文件、核验本机 SDK 签名并保存 76 文件及历史日志哈希。
- [x] 测试先行实现 audit_day，验证字段、日期、窗口、警告和动态重读。
- [x] 注册双工具模式，添加真实 Session runner、结构化返回与日志。
- [x] 实现独立的十五项在线证据检查和两个 CLI。
- [x] Stage 4 初轮运行离线全量验收及一次主 smoke，独立复审。当次在线结果为 BLOCKED。
- [x] 核对当时保护范围并保存 Stage 4 历史报告；历史报告留在开发归档，不随精选材料重复收录。

## 入口与返回值

```powershell
npm.cmd run agent -- "核对2026年10月15日的订单录音"
npm.cmd run smoke:audit
```

在已设置 `DEEPSEEK_API_KEY` 的本机终端执行；也可沿用项目 `.env`。CLI 执行时才加载 `.env`，导入模块不会自动读取配置或发起模型调用。退出码：PASS=0、FAIL=1、BLOCKED=2。主 smoke 只调用一次 `session.prompt()`，不重复尝试；一次 prompt 内包含业务工具往返所需的正常模型回合。

```ts
createAuditDayTool(runId, recordExecution, dependencies?)
createHotelSession({ runId, recordExecution, apiKey?, modelId?, auditEnabled?: boolean })
runAuditAgent(prompt, { apiKey?, modelId?, timeoutMs? }): Promise<AuditAgentRun>
collectAuditToolResults(runId, events, executions): AuditToolResultCapture[]
evaluateAuditSmoke(input): SmokeCheck[]
```

`audit_day` 参数只允许 `date` 和可选的 `window_seconds`。日期须真实存在，窗口须为有限非负数字，默认 180，允许零与小数。`prepareArguments` 在 SDK 的类型转换前严格验证原始值，避免字符串、布尔值或 null 被悄悄转换；execute 中再次校验，支持直接离线调用的错误边界。

工具返回 `{ date, window_seconds, warnings, results }`，同时放入 SDK 的文本内容和 `details`。文本内容供模型读取，结构化 `details` 供业务消费。查询依赖参数只便于测试临时文件，正式 Session 使用默认真实仓库；领域 `auditDay` 始终直接复用，不可由注入参数替换。

`AuditAgentRun` 包含 `{ runId, date, toolResults, finalAnswer, warnings }`，另含 status、错误、时间、模型 ID、Session/工具信息、日志路径及原始记录。`agentRunSummary()` 去掉重复的事件数组，保留完整业务结果及事件计数。每条 `toolResults` 为：

```ts
{
  toolCallId: string;
  toolName: 'audit_day';
  args: { date: string; window_seconds?: number };
  result: { date: string; window_seconds: number; warnings: RecordingDataWarning[]; results: DetailedAuditResult[] };
}
```

`date` 来自实际工具结果；只有单个唯一日期时取该值，无调用或多日期时为 null。每个捕获保留自己的日期。`warnings` 汇集已捕获审计结果中的数据警告。普通订单查询不进入审计结果集合，但保留在原始工具日志中；此 CLI 的成功门槛要求至少一次成功审计调用。

## 事实来源与证据门槛

四阶段依次是 `tool_execution_start → execute_start → execute_end → tool_execution_end`。两种日志共用递增 `sequence`；允许不同调用交错，但同调用的 runId、toolCallId、工具名、参数、顺序与返回值必须一致。Runtime 的 `result.details` 必须深度等于 execute 的 result，结束记录 `isError` 都为 false，数据形状也须完整。

`toolResults` 不从最终文字、历史摘要、编号规律或人工标准答案生成。没有真实事件时返回空列表，即使模型文字说成功也不能通过。候选集合、冲突双方值、理由、原始句子及毫秒范围完整保留。`needs_review` 仍为待复核，标量候选编号不是确认配对。

日志使用新 runId 和排他创建；主 smoke 只补充刚创建的本轮 summary，不修改历史运行。错误、返回值和持久化内容脱敏，避免再次序列化元数据时恢复凭据。日志写入失败、错误工具、无成功 audit_day、异常结束或超时均为 FAIL；缺少凭据为 BLOCKED。

## 验证范围与限制

离线测试使用真实仓库、核对函数、实际 SDK 注册与 SDK 工具参数路径。验证器测试中的合成 Runtime 记录仅存在内存，明确不写入本地在线证据文件；被抑制的 prompt、故障替身和占位密钥用于否定性测试，不构成真实 Tool Calling 成功证据。

Stage 4 初轮为 369/369 测试通过、音频数据校验通过；当次主 smoke 因缺密钥 BLOCKED，零事件、零 execute、空 toolResults，不能声明当次在线成功。其后已有真实工具与网页成功运行，当前全量前端/业务回归基线为 513 项。自然语言文本不作结构化业务输入，模型仍可能表达失误；业务表格始终以工具结果为准。

现有 Express HTTP 层已直接调用 `runAuditAgent` 并消费结构化返回；前端仅为阅读渲染模型 Markdown，不从中推导业务事实。没有实现流式多会话管理或新 Agent Loop。
