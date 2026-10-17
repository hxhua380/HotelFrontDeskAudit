# 数据契约

类型声明位于 `src/domain/types.ts`。Stage 2 沿用冻结的领域类型；Stage 3 保持原基础接口，追加提取、诊断和派生结果类型。TypeScript 类型不能代替外部 JSON 的运行时校验。

## 订单文件与订单

`data/orders.json` 的顶层必须是对象，结构为：

```json
{
  "data_source": "synthetic demo data",
  "orders": [
    {
      "order_id": "O001",
      "handled_at": "2026-10-15T14:05:00+08:00",
      "room_number": "802",
      "room_type": "大床房",
      "check_in_date": "2026-10-15",
      "check_out_date": "2026-10-16",
      "amount_cents": 39800,
      "currency": "CNY"
    }
  ]
}
```

来源标记必须精确为 `synthetic demo data`。上例是保留不变的 O001，实际文件共有八条订单，另在外层增加兼容元数据 `hotel: "Demo Hotel"` 和 `time_zone: "Asia/Shanghai"`。房号、日期与金额均为合成演示数据，订单本身仍只有以下八个字段。

`Order` 包含以下八个必填字段：

| 字段 | 类型 | 含义与约束 |
| --- | --- | --- |
| `order_id` | `string` | 非空订单编号。 |
| `handled_at` | `string` | 北京时间办理时刻，必须明确带 `+08:00` 偏移。 |
| `room_number` | `string` | 非空房号，保留为字符串以支持前导零等格式。 |
| `room_type` | `string` | 非空房型名称。 |
| `check_in_date` | `string` | 有效入住日期，格式为 `YYYY-MM-DD`。 |
| `check_out_date` | `string` | 有效退房日期，格式为 `YYYY-MM-DD`，必须晚于入住日期。 |
| `amount_cents` | `number` | 非负且安全的整数，单位为人民币分。 |
| `currency` | `"CNY"` | 固定为人民币。 |

所有字段均不可省略，也不可填 `null`。金额 `39800` 表示人民币 398.00 元；不得将小数元金额放入 `amount_cents`。安全整数要求金额不超过 JavaScript 的 `Number.MAX_SAFE_INTEGER`，避免整数精度丢失。

## 日期查询语义

```ts
queryOrdersByDate(date: string, ordersFile?: string | URL): Promise<Order[]>
```

`date` 必须是实际存在的日历日，使用四位年、两位月和两位日，例如 `2026-10-15`。年份从 `0001` 开始。无效闰日、`2026-02-30`、`2026-1-5` 及含时间的字符串都不是合法查询日期。

`handled_at` 的格式为 `YYYY-MM-DDTHH:mm:ss+08:00`，允许秒后附一至三位小数，例如 `2026-10-15T14:05:00.123+08:00`。日期和时分秒必须有效；`Z`、其他时区偏移及缺少偏移的字符串不符合契约。

查询按 `handled_at` 的北京时间日历日筛选，不能按 `check_in_date` 或电脑当前时区筛选。办理日期和入住日期可能不同。2026-10-15 有七条订单，2026-10-16 有一条；其他没有记录的合法日期（例如 2026-10-20）返回 `[]`。

省略 `ordersFile` 时，函数读取由模块位置解析的仓库 `data/orders.json`；测试可指定其他本地文件路径或文件 URL。每次调用都会重新读取并校验完整文件，没有缓存。文件不存在、JSON 损坏或数据不合法时，查询应拒绝并返回错误，不能静默当作空订单数组。合法文件中没有匹配记录时，才返回空数组。

## 录音与转写片段

`Recording` 的必填字段如下：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `recording_id` | `string` | 录音编号。 |
| `started_at` | `string` | 录音开始时刻，使用明确的北京时间 `+08:00` 日期时间。 |
| `audio_path` | `string` | 对应音频资源相对项目根目录的路径，例如 `audio/R001.mp3`。 |
| `transcript_segments` | `TranscriptSegment[]` | 带时间范围的转写片段。 |

每个 `TranscriptSegment` 包含 `start_ms: number`、`end_ms: number` 和 `text: string`。时间以相对于录音开始的毫秒表示，供后续定位音频。Stage 2 质量检查要求整数时间范围满足 `0 <= start_ms < end_ms <= 真实解码时长`，各片段按时间排列、文本与实际 TTS 台词一致。

`transcript_segments: []` 在类型上表示没有转写片段；不得将它写成 `null` 或省略字段。Stage 2 的八条交付记录均须有非空转写。

录音文件外层为 `{ data_source, hotel, time_zone, recordings: Recording[] }`。TTS 工具/版本、音色、语速、时长、哈希与对齐精度另存 `data/audio-metadata.json`，没有扩展或破坏 `Recording` 接口。句子级边界来自 TTS 服务返回，原始 tick 字段和 SRT 保留在音频旁；表示分辨率不等于实际声学精度，详见 [模拟数据说明](demo-data.md)。

## 核对状态与结果

`AuditStatus` 只允许以下五个值：

| 值 | 含义 |
| --- | --- |
| `matched` | 订单与录音匹配，待核对字段一致。 |
| `field_mismatch` | 已关联订单与录音，但存在字段冲突。 |
| `missing_recording` | 订单缺少对应录音。 |
| `orphan_recording` | 录音缺少对应订单。 |
| `needs_review` | 信息不足或关联不确定，需要人工复核。 |

`AuditResult` 包含：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `status` | `AuditStatus` | 核对状态。 |
| `order_id` | `string \| null` | 关联订单编号；无可关联订单时为 `null`。 |
| `recording_id` | `string \| null` | 关联录音编号；无可关联录音时为 `null`。 |
| `conflicting_fields` | `(keyof Order)[]` | 存在冲突的订单字段名，只能取 `Order` 的八个键。 |
| `reasons` | `string[]` | 支撑该结果的说明。 |
| `evidence` | `Evidence[]` | 可定位到录音片段的证据。 |

这里的可空编号仍是必填字段。例如缺少录音时，应明确写 `recording_id: null`，不能省略该属性。数组字段始终保留：没有冲突、说明或证据时分别写 `[]`，不使用 `null`。

## 证据

每个 `Evidence` 包含：

| 字段 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `recording_id` | `string` | 是 | 证据所属录音。 |
| `text` | `string` | 是 | 对应转写原文。 |
| `start_ms` | `number` | 是 | 片段相对录音开始的起始毫秒。 |
| `end_ms` | `number` | 是 | 片段相对录音开始的结束毫秒。 |
| `field` | `keyof Order \| null` | 否 | 证据支持的订单字段；无法归属于单个字段时可显式为 `null`。 |

`field` 是唯一可省略的证据属性：省略表示没有提供字段归属，`null` 表示明确标注为不对应某个单独字段。字段名字符串表示该片段支持指定字段。在启用 `exactOptionalPropertyTypes` 的 TypeScript 中，可省略属性不等于允许显式赋值 `undefined`；JSON 也没有 `undefined` 值。

后续核对结果引用证据时，应能通过录音编号和毫秒范围找到原始片段，文本应与该片段相符。冲突字段应有对应的依据；没有足够录音依据时，应如实表达缺失或需要复核，不能编造证据。Stage 1 只约定这些要求，不实现录音匹配算法或状态判定规则。

## Stage 3 兼容扩展

原有 `Order`、`Recording`、`TranscriptSegment`、`Evidence`、`AuditResult` 字段均未改变，原类型精确断言继续适用。

`TranscriptEvidence extends Evidence` 增加必填 `segment_index: number`（从零开始）。提取器返回 `TranscriptFacts`，五个字段各自为 `ExtractedField<T>`：`value: T | null`、`ambiguous: boolean`、`observations: { value: T, evidence: TranscriptEvidence }[]`。未知值与冲突观察分开表达；时间和文本直接引用原始整段。

`DetailedAuditResult extends AuditResult` 增加：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `candidate_order_ids` | `string[]` | 分组内全部候选订单，不依赖编号决定配对 |
| `candidate_recording_ids` | `string[]` | 分组内全部可用录音候选 |
| `conflicts` | `FieldConflict[]` | `field`、`order_value`、`recording_value`、`evidence` |
| `evidence` | `TranscriptEvidence[]` | 基础证据的兼容派生数组，增加原始片段索引 |
| `data_warnings` | `RecordingDataWarning[]` | 与组内订单时间相关的不可用音频诊断 |

`AuditableField` 限于 `room_number`、`room_type`、`check_in_date`、`check_out_date`、`amount_cents`。只有明确观察到的不同值才进入 `conflicts`。若 `status` 为 `needs_review`，这些差异仍是候选间差异，不能当作已确认业务事件的冲突。

标量 `order_id` / `recording_id` 只在该侧有一个候选时保留，多候选侧为 `null`。对于 `needs_review`，它们只引用唯一候选，不表示身份已确认；调用方应同时查看状态、理由和候选集合。C005 维持人工答案中的 O004/R004 标量候选，不补造确认信息。

```ts
queryRecordingsByDate(
  date: string,
  recordingsFile?: string | URL,
  audioRoot?: string | URL,
): Promise<RecordingQueryResult>
```

返回 `{ recordings: Recording[], warnings: RecordingDataWarning[] }`，按 `started_at` 的北京时间日期实时读取。警告的 `code` 为 `audio_missing` 或 `audio_not_file`，同时含 `recording_id`、`started_at`、`audio_path`、`message`。不可用音频不会出现在 `recordings`；非法 JSON、字段、日期、重复录音编号和越界路径直接报错。为显式传递完整性诊断而采用包装返回值，未改动已有订单查询接口。真实时长范围仍须由离线数据校验检查。

```ts
auditDay(orders, recordings, date, { window_seconds?: number, data_warnings?: RecordingDataWarning[] }): DetailedAuditResult[]
```

默认窗口 180 秒，输出均可 JSON 序列化。`matched` 要求五项明确一致与可靠身份；可靠身份且明确差异为 `field_mismatch`；未知、歧义、多候选保持复核。规则及边界见 [核对规则](audit-rules.md)。
