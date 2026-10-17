import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { beijingTimestamp, type ToolEvidenceRecord } from '../src/agent/evidence.js';
import { createHotelSession, DEFAULT_MODEL_ID } from '../src/agent/pi-session.js';
import { evaluateSmoke } from './smoke-checks.js';

const PROMPT = '请使用 query_orders_by_date 工具查询 2026-10-15 办理的酒店订单，并告诉我查询结果。';
const root = new URL('../', import.meta.url);
config({ path: fileURLToPath(new URL('.env', root)), quiet: true });

async function main(): Promise<void> {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim() ?? '';
  const modelId = process.env.DEEPSEEK_MODEL?.trim() || DEFAULT_MODEL_ID;
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const directory = new URL(`evidence/local/${runId}/`, root);
  mkdirSync(directory, { recursive: true });
  const eventsPath = new URL('pi-events.jsonl', directory);
  const executionsPath = new URL('tool-executions.jsonl', directory);
  // 新目录 + 排他创建，保证本轮不会读取或覆盖旧轮的成功证据。
  writeFileSync(eventsPath, '', { flag: 'wx' });
  writeFileSync(executionsPath, '', { flag: 'wx' });

  function redact(text: string): string {
    return (apiKey ? text.split(apiKey).join('[REDACTED]') : text)
      .replace(/Bearer\s+[A-Za-z0-9_.-]+/gi, 'Bearer [REDACTED]');
  }
  const serialize = (value: unknown) => redact(JSON.stringify(value, null, 2));
  const events: ToolEvidenceRecord[] = [];
  const executions: ToolEvidenceRecord[] = [];
  const startedArgs = new Map<string, unknown>();
  let session: Awaited<ReturnType<typeof createHotelSession>> | undefined;
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let eventLogError: unknown;
  let sessionCreated = false;
  let activeTools: string[] = [];
  let finalAnswer = '';
  let finalStopReason: string | undefined;
  let status: 'PASS' | 'FAIL' | 'BLOCKED' = 'FAIL';
  let error: string | null = null;
  const startedAt = beijingTimestamp();

  function append(path: URL, record: ToolEvidenceRecord): void {
    appendFileSync(path, redact(JSON.stringify(record)) + '\n');
  }

  try {
    if (!apiKey) {
      status = 'BLOCKED';
      error = '缺少 DEEPSEEK_API_KEY；未创建在线会话、未调用 session.prompt()，未发生真实工具调用。';
    } else {
      session = await createHotelSession({
        runId, apiKey, modelId,
        recordExecution(record) {
          append(executionsPath, record);
          executions.push(record);
        },
      });
      sessionCreated = true;
      activeTools = session.getActiveToolNames();
      if (activeTools.length !== 1 || activeTools[0] !== 'query_orders_by_date') {
        throw new Error('工具白名单不符，禁止发送模型请求。');
      }
      unsubscribe = session.subscribe((event) => {
        if (event.type !== 'tool_execution_start' && event.type !== 'tool_execution_end') return;
        if (event.type === 'tool_execution_start') startedArgs.set(event.toolCallId, event.args);
        const record: ToolEvidenceRecord = {
          runId, phase: event.type, toolCallId: event.toolCallId, toolName: event.toolName,
          args: event.type === 'tool_execution_start' ? event.args : startedArgs.get(event.toolCallId) ?? null,
          result: event.type === 'tool_execution_end' ? event.result : null,
          isError: event.type === 'tool_execution_end' ? event.isError : null,
          timestamp: beijingTimestamp(),
        };
        try { append(eventsPath, record); events.push(record); }
        catch (writeError) { eventLogError = writeError; }
      });

      const currentSession = session;
      await Promise.race([
        currentSession.prompt(PROMPT),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            void currentSession.abort().catch(() => {});
            reject(new Error('网络或模型请求超过 60 秒，已中止；请检查网络、认证和模型兼容性。'));
          }, 60_000);
        }),
      ]);
      if (eventLogError) throw new Error('Pi 事件日志保存失败，不能证明本轮工具调用。');

      const lastAssistant = session.messages.findLast((message) => message.role === 'assistant');
      if (lastAssistant?.role === 'assistant') {
        finalStopReason = lastAssistant.stopReason;
        finalAnswer = lastAssistant.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n');
        if (lastAssistant.stopReason === 'error' || lastAssistant.stopReason === 'aborted') {
          throw new Error(`DeepSeek 请求失败（网络、认证或模型兼容性）：${lastAssistant.errorMessage ?? lastAssistant.stopReason}`);
        }
      }
      const checks = evaluateSmoke({ runId, sessionCreated, activeTools, events, executions, finalAnswer, finalStopReason });
      status = checks.every((check) => check.passed) ? 'PASS' : 'FAIL';
      if (status === 'FAIL') error = '关键证据不足：' + checks.filter((check) => !check.passed).map((check) => check.description).join('；');
    }
  } catch (caught) {
    status = 'FAIL';
    error = redact(caught instanceof Error ? caught.message : '未知冒烟错误').slice(0, 2000);
  } finally {
    if (timer) clearTimeout(timer);
    if (session) {
      try { await session.abort(); }
      catch { status = 'FAIL'; error = 'Pi 会话中止失败。'; }
      unsubscribe?.();
      session.dispose();
    }
    const checks = evaluateSmoke({ runId, sessionCreated, activeTools, events, executions, finalAnswer, finalStopReason });
    writeFileSync(new URL('summary.json', directory), serialize({
      runId, status, startedAt, endedAt: beijingTimestamp(), provider: 'deepseek', modelId,
      prompt: PROMPT, sessionCreated, activeTools, checks,
      eventCount: events.length, executeRecordCount: executions.length,
      toolCallIds: [...new Set(events.map((event) => event.toolCallId))],
      finalStopReason: finalStopReason ?? null, finalAnswer, error,
    }) + '\n');
    console.log(`${status}: runId=${runId}`);
    console.log(`本轮报告：${fileURLToPath(new URL('summary.json', directory))}`);
    if (error) console.error(error);
    process.exitCode = status === 'PASS' ? 0 : status === 'BLOCKED' ? 2 : 1;
  }
}

await main().catch(() => {
  console.error('FAIL: 冒烟脚本无法完成或保存报告，请检查本仓库文件权限。');
  process.exitCode = 1;
});
