# Hotel Front Desk Audit

酒店前台订单与接待录音核对演示。按北京时间办理日读取订单与录音，通过真实 Pi Agent 调用 `audit_day`，由确定性规则输出五类结果、字段差异、完整候选和可播放的原句证据。网页采用记录列表与详情工作台，并提供独立的 AI 核对报告。

项目包含 **8 条虚构订单、8 段已生成的 AI 中文 MP3 和两天场景**。运行时读取 `data/recordings.json` 中预置的 `transcript_segments`，**不实时识别 MP3，也不提供实时 ASR**。转写来自合成台词与 TTS 服务的句子边界对齐。

已有开发验收记录为 **513/513 测试通过**；公开副本可按下文命令独立复测。既有真实 Pi 运行与公开证据边界见[公开证据说明](evidence/submission/README.md)。项目仅供本机运行，**尚未云部署，没有公网演示地址；视频尚未录制**。

## 环境

已记录的开发环境为 **Windows x64、Node.js 24.14.0、npm 11.9.0、Python 3.13.5**。建议使用该 Node 版本复现；项目声明 Node.js `>=22.19.0`，但锁定的 Vitest 5.0.5 支持 `^22.12.0 || ^24.0.0 || >=26.0.0`，因此 Node 23/25 不适合本项目全套测试。

官方 SDK 固定为 `@earendil-works/pi-coding-agent@1.3.0` 与 `@earendil-works/pi-ai@1.3.0`。安装以 `package-lock.json` 为准，保留开发依赖和平台可选依赖；启动器 `tsx` 也在开发依赖中，不能使用 `npm ci --omit=dev`。

## 安装、配置与启动

下载或克隆仓库后，在包含 `package.json` 的项目根目录打开 PowerShell。Windows 使用 `npm.cmd`，可避开对 `npm.ps1` 的执行策略限制。首次安装 npm/Python 依赖需要可用的软件源。

```powershell
node --version
npm.cmd --version
npm.cmd ci
```

真实网页核对需要 DeepSeek API Key。首次配置时创建项目 `.env`，已有文件则直接编辑：

```powershell
if (-not (Test-Path -LiteralPath '.env')) { Copy-Item -LiteralPath '.env.example' -Destination '.env' }
notepad .env
```

填写 `DEEPSEEK_API_KEY`；也可使用启动终端已有的同名环境变量。Provider 为 `deepseek`，默认模型为 SDK 已注册的 `deepseek-flash`；可选 `DEEPSEEK_MODEL` 只接受已安装 SDK 注册的 DeepSeek 模型，不会静默回退。密钥只由服务端读取，不写入前端、问题、报告或版本库。

```powershell
npm.cmd run dev
```

浏览器打开 **http://127.0.0.1:3000**。服务只绑定本机回环地址；端口占用时，在启动前设置 `$env:PORT = "3001"`，再访问对应端口。HTTP 健康检查只表示服务已启动；缺少密钥时真实核对返回 `BLOCKED`，不会创建模型会话或补造结果。

现有 MP3 可直接播放，启动网页和播放录音不需要 Python，也不需要重新请求 TTS。真实核对仍需要模型网络及有效凭据。

## 网页操作与示例

1. 选择办理日期，默认 `2026-10-15`；输入问题或选择示例，点击“开始核对”。问题中的日期须与选择器一致。
2. 在“核对工作台”选择左侧记录，右侧查看判断理由、字段差异、全部候选、原句和播放器。切换记录或报告标签不会再次调用模型。
3. 点击证据播放按钮，从原句起点播放，在句末暂停；也可使用原生播放器。“AI核对报告”提供本次解释，业务事实仍以结构化结果为准。
4. 已完成查询后切换日期会自动重新核对；修改问题会清除旧结果，需要再次提交。真实查询可能等待模型响应，失败会明确显示。

订单按 `handled_at`、录音按 `started_at` 的 **Asia/Shanghai（北京时间）日期**筛选，不能用入住日替代办理日。

| 状态 | 含义 | 2026-10-15 场景 |
| --- | --- | --- |
| `matched` | 身份可靠且五字段完整一致 | O001 / R001，1 组 |
| `field_mismatch` | 身份可靠，但存在明确字段差异 | O002 / R002，1 组 |
| `missing_recording` | 订单没有合理的可用录音候选 | O003，1 组；不补造证据 |
| `orphan_recording` | 录音没有订单候选 | R003，1 组 |
| `needs_review` | 信息不足、歧义或多个合理候选 | O004 / R004、O005 + O006 / R005、O007 / R006 + R007，共 3 组 |

当日共 **7 组结果，统计为 1 / 1 / 1 / 1 / 3**。O002 的订单金额为 **¥756.00**，R002 说 **¥796.00**，差额 **¥40.00**；内部金额使用人民币整数分。R002 的证据范围为 **100–12538 ms**，覆盖完整原句。

切到 `2026-10-16`，只有 O008 / R008 一组 `matched`；其入住日为 10 月 18 日，说明查询依据是办理日。以上为预置演示数据的已有结果，网页统计由每次成功响应计算。

## 项目目录

```text
HotelFrontDeskAudit/
  public/              # 原生 HTML、CSS、JavaScript 工作台
  src/
    web/               # Express HTTP 校验与受限音频路由
    agent/             # Pi Session、业务工具与运行证据
    data/              # 订单、录音仓库与运行时校验
    domain/            # 字段提取、候选图、核对规则与类型
  data/                # 虚构订单、预置转写、TTS 清单与元数据
  audio/               # 8 段 MP3、SRT 与原始句子边界
  scripts/             # 启动以外的 CLI、数据生成与质量校验
  tests/               # 单元/集成测试及独立人工标准答案
  docs/                # 架构、契约、规则、来源与使用说明
  evidence/submission/ # 历史真实运行的公开材料与独立复核入口
  .env.example         # 服务端凭据字段示例，不含真实密钥
  package.json
  package-lock.json
  tsconfig.json
```

## 架构与事实来源

```text
public/ 原生 HTML/CSS/JavaScript 工作台
  → src/web/server.ts：Express HTTP 校验与音频路由
  → scripts/audit-agent.ts：runAuditAgent
  → src/agent/pi-session.ts：真实 Pi SDK Session / DeepSeek
  → src/agent/tools.ts：audit_day
  → src/data/repository.ts：实时读取订单、预置转写与文件状态
  → src/domain/transcript.ts + audit.ts：规则提取与纯函数核对
  → 工具结构化结果 → 工作台；finalAnswer → AI 核对报告
```

审计会话只开放 `query_orders_by_date`、`audit_day` 两个业务工具；网页要求调用所选日期的 `audit_day`。模型负责工具调用和解释，业务状态由既有 `auditDay()` 决定。服务端仅接受本次成功工具返回，网页不解析模型 Markdown 生成业务结果，`finalAnswer` 也不能覆盖金额、候选或状态。

`tests/fixtures/expected_results.json` 是独立人工标准答案，**仅供测试读取**，不进入生产查询、领域规则或 Agent 上下文。匹配不依赖编号后缀、数组顺序或标准答案。

## 真实 Pi 工具与公开证据

[公开证据说明](evidence/submission/README.md)关联已留存的 `2026-10-15` 真实网页运行、脱敏公开材料及其既有 **15/15** 工具检查记录。安装依赖后，可离线复核公开材料：

```powershell
node --import tsx evidence/submission/verify-public.mjs
```

公开验证仅检查随仓库发布的材料，包括同一 `runId`、`toolCallId` 的四阶段关联、参数、顺序、返回值与公开文件哈希。四阶段为 `tool_execution_start → execute_start → execute_end → tool_execution_end`；记录中的 Runtime 返回与实际 `execute` 返回必须一致。该命令不发起模型请求，**不读取或重算未发布原件的源哈希**；文档中记录的原件哈希只是整理时保留的来源声明。

HTTP 材料仅保存当时验收元信息，未保存完整请求/响应 body，因此不能重算原始 HTTP body 哈希或独立重做完整响应比较。公开材料的离线一致性复核不等于一次新的在线调用。

如需自行发起新的真实 Agent 查询，可在已配置凭据的终端执行：

```powershell
npm.cmd run agent -- "核对2026年10月15日的订单录音"
npm.cmd run smoke:audit
```

两条命令均会访问真实模型；主 smoke 只发送一次问题。CLI 退出码为成功 `0`、失败 `1`、缺凭据 `2`。离线测试、直接调用函数、健康检查和标注的历史回放均不能替代一次新的 Pi 在线成功证据。

## 离线检查

全套测试和音频解码校验需要项目内 Python 环境。已记录的 Python 版本为 3.13.5；首次准备如下，无需激活虚拟环境：

```powershell
python --version
python -m venv .venv-audio
& .\.venv-audio\Scripts\python.exe -m pip install -r scripts\requirements-audio.txt
npm.cmd run typecheck
npm.cmd test
npm.cmd run validate:data
npm.cmd run test:audio
```

安装完成后这些检查无需模型密钥，使用既有 MP3 离线解码。已有开发验收记录为类型检查通过、**513/513 测试通过**、8/8 音频实际解码及数据校验通过；公开副本的实际结果以本地复测输出为准。HTTP 测试使用受控 runner，其通过不代表新增在线调用。

也可直接运行确定性日期核对，无需 Pi Session 或 API Key：

```powershell
npm.cmd run audit -- 2026-10-15
npm.cmd run audit -- 2026-10-16
```

## 核对规则与限制

默认候选窗口为办理时刻与录音开始时刻相差 **不超过 180 秒**。时间接近仅产生候选；身份确认还需要房号、房型、住宿日期等业务依据。比较房号、房型、入住日、退房日、金额五项，未知和多候选保留 `needs_review`，不选择“最近一条”或候选首项。缺失音频会产生警告并从可用录音中排除。

当前规则面向常见中文前台话术，不能完整理解复杂否定、更正、跨句指代、全部同义词或多对多最佳分配；不跨办理日搜索。项目是本机演示，尚未提供登录、数据库、多租户或订单修改功能，也未提供云端部署。模型解释可能有误，需结合结构化差异和原始录音复核。

## AI 辅助与数据声明

项目开发使用 AI 辅助编写、检查代码、测试和文档；运行时通过真实 Pi SDK 调用 DeepSeek 解释工具结果。所有订单和台词均为 **Demo Hotel 的虚构合成数据**，不包含真实客人信息。

音频由 **Edge TTS / `zh-CN-XiaoxiaoNeural`** 合成，是真实可解码的 MP3，但不是客人通话。转写来源为合成台词与服务返回的 `SentenceBoundary`，**不是独立 ASR 识别结果**。毫秒范围只表示服务估计的整句边界，不承诺逐字或逐音素精度。数据和音频生成脚本保留供研究，常规运行无需重新生成。

## 项目文档

| 文档 | 内容 |
| --- | --- |
| [架构说明](docs/architecture.md) | 模块职责、依赖与调用链 |
| [数据契约](docs/data-contract.md) | 日期、金额、候选与证据字段 |
| [核对规则](docs/audit-rules.md) | 字段提取、身份确认与保守边界 |
| [数据与语音来源](docs/demo-data.md) | 虚构数据、TTS、字幕与对齐精度 |
| [Pi 集成说明](docs/agent-integration.md) | 真实 Session、工具接口与四阶段门槛 |
| [网页接口说明](docs/web-interface.md) | HTTP 协议、工作台与播放行为 |
| [公开证据说明](evidence/submission/README.md) | 历史真实运行、公开材料复核与限制 |
| [150 秒视频大纲](docs/07_demo_video_outline.md) | 录制计划；视频尚未录制 |

当前仓库没有已录制的演示视频。视频大纲只描述计划，不代表存在可播放的视频文件。
