# 精选历史证据与公开版离线复核

这里保留一次真实 Pi / HTTP 在线运行的八份精选材料。其业务日期为 2026-10-15，真实 runId 为 `2026-10-16T06-25-59-472Z-92b4ec36-83c0-4df6-96dc-f8ae4bc72c7a`。订单、转写与录音来自合成 Demo 数据。完整模型回答按历史原文保留，不把模型叙述当作独立预期答案。

八份历史文件按字节保留，原件来源哈希与派生关系也保持不变：

| 文件 | 内容与边界 |
| --- | --- |
| [run-summary.json](run-summary.json) | 记录的会话、模型、状态、最终回答与完整工具结果；省略 `prompt`、`evidenceDirectory`、`summaryPath` |
| [pi-events.jsonl](pi-events.jsonl) | 经审查的精选 Runtime 开始/结束记录，保留真实 ID、时间、参数、结果与 sequence |
| [tool-executions.jsonl](tool-executions.jsonl) | 同一调用的 execute 开始/结束记录，与 Runtime 结果关联 |
| [http-acceptance.json](http-acceptance.json) | 当时 HTTP 请求/响应元信息、关联断言与 body 哈希；不是完整原响应体 |
| [provenance.json](provenance.json) | 原件相对路径和哈希、派生哈希、字段省略说明及历史交付策略 |
| [verification.json](verification.json) | Stage7B-1 当时读取原件与副本后实际生成的本地复核报告；其中原件检查 PASS 属于历史结果 |
| [acceptance.md](acceptance.md) | Stage7B-1 的历史验收摘要、调用 ID、时间、数量、哈希与限制 |
| [verify.mjs](verify.mjs) | 当时的本地验证器；必须读取未发布的 `evidence/local/`，公开仓库中不要运行此入口 |

`acceptance.md` 末段及 `provenance.json` 的 `externalSourcePackagePolicy` 描述 Stage7B 最小学习包仅包含两份摘要文件的历史策略。本公开仓库采用扩展的精选证据范围，提供上述八份材料及下面的新验证入口。这个范围差异由本说明记录，不改写历史清单，也不改写八文件内容。`evidence/local/` 原始归档仍不发布；材料中出现的原件路径用于来源辨识，不表示仓库包含原件。

在项目根目录安装锁定依赖后运行公开版入口。首次安装可能需要网络；下面的证据复核本身只在本地读取精选材料、加载既有验证器，不需要 `.env`、API Key、Python 环境、DeepSeek 请求或网页服务。

```powershell
npm.cmd ci
node --import tsx evidence/submission/verify-public.mjs
# 可选：同时保存本轮公开版复核报告
node --import tsx evidence/submission/verify-public.mjs --write
```

新入口固定核对历史 `verification.json` 的 SHA-256，再检查另外七份历史文件及三个既有验证器实现的字节数和哈希。它实际调用 `collectAuditToolResults` 和 `evaluateAuditSmoke`，核对同轮完整调用、15 项 smoke、四阶段 sequence、精确参数、Runtime 文本与 details / execute / summary 的完整结果，以及 HTTP 200、runId、日期、七组结果和 1/1/1/1/3 分布。失败退出码为 1，成功为 0。默认仅读取并输出 JSON；`--write` 只新增或更新 `verification-public.json`，不会覆盖历史 `verification.json`。

公开版报告的 `PASS` 仅表示当前发布的精选材料及其关联检查通过。报告始终明确标记 `rawSourceRead=false`、`sourceHashStatus=NOT_RECOMPUTED_ORIGINALS_NOT_INCLUDED`。原件未随仓库提供，因此本轮不能重新打开原件核对其哈希，也不能重新执行“原 summary 仅删除三字段”的源到派生比较；这些保持为已有历史 provenance 声明。JSONL 与 HTTP 文件的当前哈希可与声明的逐字节相同源哈希比较，但不能据此声称重新审查了未发布的原文件。

HTTP 制品没有保存完整原请求/响应体。因此新入口只能验证保留元信息、历史断言及哈希之间的一致性，不能重新计算原 body 哈希或重新比较完整原响应。`httpBodyHashStatus=NOT_RECOMPUTED_BODY_NOT_INCLUDED` 会保留这一限制。

此复核不创建新 Pi Session、不调用模型或业务工具、不启动网页；记录的 `sessionCreated=true`、模型与 PASS/stop 描述历史运行。文件哈希用于检测相对固定历史报告的变化，不是模型服务商的签名或独立在线证明。
