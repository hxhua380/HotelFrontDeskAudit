import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import {
  beijingTimestamp, collectAuditToolResults,
  type AgentQueryResult, type ToolEvidenceRecord,
} from '../src/agent/evidence.js';
import { createHotelSession, DEFAULT_MODEL_ID } from '../src/agent/pi-session.js';
import { AUDIT_TOOL_NAME, QUERY_TOOL_NAME } from '../src/agent/tools.js';

export interface AuditAgentOptions {
  apiKey?: string;
  modelId?: string;
  timeoutMs?: number;
}

export interface AuditAgentRun extends AgentQueryResult {
  status: 'PASS' | 'FAIL' | 'BLOCKED';
  prompt: string;
  startedAt: string;
  endedAt: string;
  provider: 'deepseek';
  modelId: string;
  sessionCreated: boolean;
  activeTools: string[];
  finalStopReason: string | null;
  error: string | null;
  evidenceDirectory: string;
  summaryPath: string;
  events: ToolEvidenceRecord[];
  executions: ToolEvidenceRecord[];
}

/** CLI 调用时才加载本项目 .env；import 本模块不读取凭据、不启动会话。 */
export function loadAgentEnvironment(): void {
  config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
}

/** 单次真实 prompt 的编排；结果只能来自被 Runtime/execute 双重记录的工具返回。 */
export async function runAuditAgent(prompt: string, options: AuditAgentOptions = {}): Promise<AuditAgentRun> {
  if (!prompt.trim()) throw new Error('Agent 问题不能为空。');
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs 必须是正的安全整数。');
  const apiKey = (options.apiKey ?? process.env.DEEPSEEK_API_KEY ?? '').trim();
  const modelId = options.modelId ?? (process.env.DEEPSEEK_MODEL?.trim() || DEFAULT_MODEL_ID);
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const evidenceDirectory = fileURLToPath(new URL(`../evidence/local/stage4/${runId}`, import.meta.url));
  mkdirSync(evidenceDirectory, { recursive: true });
  const eventsPath = join(evidenceDirectory, 'pi-events.jsonl');
  const executionsPath = join(evidenceDirectory, 'tool-executions.jsonl');
  const summaryPath = join(evidenceDirectory, 'summary.json');
  writeFileSync(eventsPath, '', { flag: 'wx' });
  writeFileSync(executionsPath, '', { flag: 'wx' });
  const redact = (text: string): string => (apiKey ? text.split(apiKey).join('[REDACTED]') : text)
    .replace(/Bearer\s+[A-Za-z0-9_.-]+/gi, 'Bearer [REDACTED]');
  const events: ToolEvidenceRecord[] = [];
  const executions: ToolEvidenceRecord[] = [];
  const startedArgs = new Map<string, unknown>();
  let sequence = 0;
  function append(path: string, record: ToolEvidenceRecord, destination: ToolEvidenceRecord[]): void {
    const logged = structuredClone({ ...record, sequence: ++sequence });
    appendFileSync(path, redact(JSON.stringify(logged)) + '\n');
    destination.push(logged);
  }
  let session: Awaited<ReturnType<typeof createHotelSession>> | undefined;
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let eventLogError = false;
  const run: AuditAgentRun = {
    runId, date: null, toolResults: [], finalAnswer: '', warnings: [],
    status: 'FAIL', prompt: redact(prompt), startedAt: beijingTimestamp(), endedAt: '',
    provider: 'deepseek', modelId, sessionCreated: false, activeTools: [],
    finalStopReason: null, error: null, evidenceDirectory, summaryPath, events, executions,
  };
  try {
    if (!apiKey) {
      run.status = 'BLOCKED';
      run.error = '缺少 DEEPSEEK_API_KEY；未创建在线会话，未调用 session.prompt()，没有真实 audit_day 调用。';
    } else {
      session = await createHotelSession({
        runId, apiKey, modelId, auditEnabled: true,
        recordExecution: (record) => append(executionsPath, record, executions),
      });
      run.sessionCreated = true;
      run.activeTools = session.getActiveToolNames();
      const allowed = [AUDIT_TOOL_NAME, QUERY_TOOL_NAME].sort();
      if (JSON.stringify([...run.activeTools].sort()) !== JSON.stringify(allowed)) throw new Error('Pi 工具白名单不符，拒绝发送模型请求。');
      unsubscribe = session.subscribe((event) => {
        if (event.type !== 'tool_execution_start' && event.type !== 'tool_execution_end') return;
        if (event.type === 'tool_execution_start') startedArgs.set(event.toolCallId, structuredClone(event.args));
        const record: ToolEvidenceRecord = {
          runId, phase: event.type, toolCallId: event.toolCallId, toolName: event.toolName,
          args: event.type === 'tool_execution_start' ? event.args : startedArgs.get(event.toolCallId) ?? null,
          result: event.type === 'tool_execution_end' ? event.result : null,
          isError: event.type === 'tool_execution_end' ? event.isError : null,
          timestamp: beijingTimestamp(),
        };
        try { append(eventsPath, record, events); }
        catch { eventLogError = true; }
      });
      const currentSession = session;
      await Promise.race([
        currentSession.prompt(prompt),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            void currentSession.abort().catch(() => {});
            reject(new Error(`Pi 请求超过 ${timeoutMs} 毫秒，已中止；请检查网络、认证或模型服务。`));
          }, timeoutMs);
        }),
      ]);
      if (eventLogError) throw new Error('Runtime 事件日志保存失败，不能证明本轮调用。');
      const assistant = session.messages.findLast((message) => message.role === 'assistant');
      if (assistant?.role === 'assistant') {
        run.finalStopReason = assistant.stopReason;
        run.finalAnswer = redact(assistant.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n'));
        if (assistant.stopReason === 'error' || assistant.stopReason === 'aborted') throw new Error(`DeepSeek 请求失败：${assistant.errorMessage ?? assistant.stopReason}`);
      }
      run.toolResults = collectAuditToolResults(runId, events, executions);
      const successfulIds = new Set(run.toolResults.map((item) => item.toolCallId));
      const auditStarts = events.filter((event) => event.phase === 'tool_execution_start' && event.toolName === AUDIT_TOOL_NAME);
      if (auditStarts.length === 0 || auditStarts.some((event) => !successfulIds.has(event.toolCallId))) throw new Error('没有完整成功的 audit_day 调用，或存在未成功/无法关联的审计调用。');
      if ([...events, ...executions].some((record) => record.isError === true)) throw new Error('本轮业务工具发生错误，请检查日志。');
      if (run.finalStopReason !== 'stop' || !run.finalAnswer.trim()) throw new Error('模型没有正常结束并生成回答。');
      run.status = 'PASS';
    }
  } catch (error) {
    run.status = 'FAIL';
    run.error = redact(error instanceof Error ? error.message : '未知 Pi Agent 错误').slice(0, 2000);
  } finally {
    if (timer) clearTimeout(timer);
    if (session) {
      try { await session.abort(); }
      catch { run.status = 'FAIL'; run.error = 'Pi 会话中止失败。'; }
      unsubscribe?.();
      session.dispose();
    }
    run.endedAt = beijingTimestamp();
    // 即使模型回答失败，已完成且可追溯的真实工具结果仍可供诊断，不补造缺失结果。
    run.toolResults = collectAuditToolResults(runId, events, executions);
    const dates = [...new Set(run.toolResults.map((item) => item.result.date))];
    run.date = dates.length === 1 ? dates[0]! : null;
    run.warnings = run.toolResults.flatMap((item) => item.result.warnings);
    writeFileSync(summaryPath, redact(JSON.stringify(agentRunSummary(run), null, 2)) + '\n', { flag: 'wx' });
  }
  // 返回值也脱敏，避免 CLI 或 smoke 再次序列化元数据时恢复敏感字符串。
  return JSON.parse(redact(JSON.stringify(run))) as AuditAgentRun;
}

/** 完整结构化业务结果与计数写入摘要；原始事件在独立 JSONL 文件。 */
export function agentRunSummary(run: AuditAgentRun) {
  const { events, executions, ...summary } = run;
  return { ...summary, eventCount: events.length, executeRecordCount: executions.length,
    toolCallIds: [...new Set(events.map((event) => event.toolCallId))] };
}

async function main(): Promise<void> {
  const prompt = process.argv.slice(2).join(' ').trim();
  if (!prompt) throw new Error('用法：npm.cmd run agent -- "核对2026年10月15日的订单录音"');
  loadAgentEnvironment();
  const run = await runAuditAgent(prompt);
  console.log(JSON.stringify(agentRunSummary(run), null, 2));
  process.exitCode = run.status === 'PASS' ? 0 : run.status === 'BLOCKED' ? 2 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error: unknown) => {
    console.error(JSON.stringify({ status: 'FAIL', error: error instanceof Error ? error.message : 'Agent 无法运行或保存证据。' }));
    process.exitCode = 1;
  });
}
