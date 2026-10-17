# Hotel Front Desk Audit

酒店前台订单与接待录音核对工具。按办理日期查询订单和录音，结合业务规则识别字段差异、缺失记录与候选歧义，并在网页中展示判断依据和可播放的转写证据。

## 功能

- **按日核对**：以北京时间筛选订单办理时间和录音开始时间。
- **五类结果**：一致、字段不一致、缺少录音、孤立录音、待人工复核。
- **证据工作台**：查看订单值、录音值、冲突字段和全部候选关系。
- **原句播放**：从转写证据起点播放录音，同一片段合并展示相关字段。
- **Pi Agent 集成**：通过 DeepSeek 调用 `audit_day` 工具，并根据结构化结果生成核对说明。

## 快速开始

推荐环境：**Windows x64、Node.js 24、npm**。Pi SDK 版本为 **1.3.0**，依赖版本由 `package-lock.json` 固定。

```powershell
git clone https://github.com/hxhua380/HotelFrontDeskAudit.git
cd HotelFrontDeskAudit
npm.cmd ci
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

在 `.env` 中填写 `DEEPSEEK_API_KEY`。`DEEPSEEK_MODEL` 可选，默认使用 `deepseek-flash`。保留开发依赖，启动命令需要其中的 `tsx`。

```powershell
npm.cmd run dev
```

浏览器访问 **http://127.0.0.1:3000**。更换端口可在启动前设置 `$env:PORT = "3001"`。

## 示例操作

1. 选择 `2026-10-15`，输入“核对当天所有订单与录音”，点击“开始核对”。
2. 在左侧选择记录，查看右侧字段差异、判断理由与录音证据。
3. 点击证据播放按钮收听原句；切换“AI核对报告”查看完整说明。
4. 切换到 `2026-10-16`，查看 O008 / R008 的唯一匹配结果。

`2026-10-15` 的七组结果覆盖以下场景：

| 状态 | 含义 | 示例 |
| --- | --- | --- |
| `matched` | 业务字段完整一致 | O001 / R001 |
| `field_mismatch` | 同一事件存在明确字段差异 | O002 / R002 |
| `missing_recording` | 订单没有合理录音候选 | O003 |
| `orphan_recording` | 录音没有合理订单候选 | R003 |
| `needs_review` | 信息不足或候选无法唯一确认 | O004 / R004；O005 + O006 / R005；O007 / R006 + R007 |

其中，O002 的订单金额为 **¥756.00**，R002 录音金额为 **¥796.00**，相差 **¥40.00**。五类数量依次为 **1 / 1 / 1 / 1 / 3**。

## 技术架构

```text
网页工作台（HTML / CSS / JavaScript）
  → Express HTTP 服务
  → Pi SDK Session / DeepSeek
  → audit_day 工具
  → 数据仓库 + 转写字段提取 + 确定性核对规则
  → 结构化结果、字段差异与录音证据
```

Pi 管理会话和工具调用，DeepSeek 负责选择工具及解释结果；`audit_day` 读取当前数据并调用 `auditDay()` 生成业务结论。页面以工具的结构化返回为准，模型文字不覆盖字段值、状态或候选集合。

默认候选时间窗口为 **180 秒**。房号、房型、入住日、退房日和金额共同参与判断；时间接近只产生候选，证据不足或存在多候选时保留人工复核。查询依据为 `handled_at` / `started_at`，不是入住日期。

```text
src/
  domain/              # 数据类型、字段提取与核对规则
  data/                # 订单和录音查询
  agent/               # Pi 会话、业务工具与事件关联
  web/                 # Express 接口与音频路由
public/                # 网页工作台
data/                  # 订单、转写与音频元数据
audio/                 # MP3、SRT 与句子边界
scripts/               # CLI、数据生成和质量校验
tests/                 # 单元测试、集成测试与独立预期答案
docs/                  # 技术说明
evidence/submission/   # 精选真实工具调用证据
```

## 测试与验证

音频质量校验需要 Python，已验证版本为 **3.13.5**。首次运行时创建项目内环境：

```powershell
python -m venv .venv-audio
& .\.venv-audio\Scripts\python.exe -m pip install -r scripts\requirements-audio.txt
npm.cmd run typecheck
npm.cmd test
npm.cmd run validate:data
```

已通过 **513 项自动化测试**，覆盖规则核对、日期切换、动态数据变化、证据去重、安全 Markdown 和音频播放；8 段 MP3 均通过实际解码、非静音及时间戳校验。

离线运行规则引擎：

```powershell
npm.cmd run audit -- 2026-10-15
npm.cmd run audit -- 2026-10-16
```

真实 Pi 调用的参数、四阶段事件、执行返回和关联 ID 见[公开证据说明](evidence/submission/README.md)。离线复核随仓库提供的证据：

```powershell
node --import tsx evidence/submission/verify-public.mjs
```

独立预期答案位于 `tests/fixtures/expected_results.json`，仅由测试读取。

## 数据与适用范围

示例包含 Demo Hotel 的 **8 条虚构订单和 8 段 Edge TTS 合成语音**。转写为随数据提供的预置文本，时间戳采用 TTS 服务的整句边界；运行时不进行语音识别。

当前规则面向常见中文前台话术，复杂否定、更正、跨句指代及多对多关系需要人工复核。项目用于本机运行，模型说明应结合结构化结果和原始录音核查。

## 技术文档

- [架构说明](docs/architecture.md)
- [数据契约](docs/data-contract.md)
- [核对规则](docs/audit-rules.md)
- [数据与语音来源](docs/demo-data.md)
- [Pi 集成说明](docs/agent-integration.md)
- [网页接口说明](docs/web-interface.md)
