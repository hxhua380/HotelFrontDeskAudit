import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import * as sessionModule from '../../src/agent/pi-session.js';
import { createHotelSession } from '../../src/agent/pi-session.js';
import * as evidence from '../../src/agent/evidence.js';
import type { ToolEvidenceRecord } from '../../src/agent/evidence.js';
import { createAuditDayTool } from '../../src/agent/tools.js';
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { evaluateAuditSmoke, type AuditSmokeInput } from '../../scripts/smoke-audit-checks.js';

describe('Stage 4 real SDK registration without inference', () => {
  it('registers and exposes exactly two business tools in audit mode', async () => {
    const session = await createHotelSession({
      runId: 'offline-audit-registration', auditEnabled: true,
      recordExecution: () => { throw new Error('registration must not execute tools'); },
    });
    try {
      expect(session.getActiveToolNames().sort()).toEqual(['audit_day', 'query_orders_by_date']);
      expect(session.getAllTools().map((tool) => tool.name).sort()).toEqual(['audit_day', 'query_orders_by_date']);
      expect(session.model?.provider).toBe('deepseek');
      expect(session.model?.id).toBe('deepseek-flash');
    } finally { session.dispose(); }
  });
  it('does not manufacture audit results when there are no Runtime or execute records', () => {
    expect(evidence.collectAuditToolResults('offline-no-events', [], [])).toEqual([]);
  });
});

describe('Stage 4 runner boundaries', () => {
  it('provides an importable runner without running an online call on import', async () => {
    const path = new URL('../../scripts/audit-agent.ts', import.meta.url);
    expect(existsSync(path)).toBe(true);
    const module = await import('../../scripts/audit-agent.js');
    expect(module.runAuditAgent).toBeTypeOf('function');
  });
  it('missing credentials produce BLOCKED with empty real tool results and independent logs', async () => {
    const { runAuditAgent } = await import('../../scripts/audit-agent.js');
    const create = vi.spyOn(sessionModule, 'createHotelSession');
    try {
      const run = await runAuditAgent('核对2026年10月15日的订单录音', { apiKey: '' });
      expect(run.status).toBe('BLOCKED');
      expect(run.toolResults).toEqual([]);
      expect(run.date).toBeNull();
      expect(run.sessionCreated).toBe(false);
      expect(create).not.toHaveBeenCalled();
      const summary = JSON.parse(await readFile(run.summaryPath, 'utf8')) as { runId: string; status: string; toolResults: unknown[] };
      expect(summary.runId).toBe(run.runId);
      expect(summary.status).toBe('BLOCKED');
      expect(summary.toolResults).toEqual([]);
      expect(fileURLToPath(new URL('../../evidence/local/stage4/', import.meta.url))).toBe(run.evidenceDirectory.slice(0, -run.runId.length));
    } finally { create.mockRestore(); }
  });
  it('a real offline SDK session whose prompt is suppressed cannot claim tool success', async () => {
    const { runAuditAgent } = await import('../../scripts/audit-agent.js');
    const session = await createHotelSession({ runId: 'offline-no-prompt', auditEnabled: true, recordExecution: () => {} });
    // 只阻止推理，绝不合成 Runtime 事件或模型回答作为在线证据。
    const prompt = vi.spyOn(session, 'prompt').mockResolvedValue(undefined);
    const dispose = vi.spyOn(session, 'dispose');
    const create = vi.spyOn(sessionModule, 'createHotelSession').mockResolvedValue(session);
    try {
      const run = await runAuditAgent('核对2026年10月15日', { apiKey: 'offline-placeholder' });
      expect(run.status).toBe('FAIL');
      expect(run.toolResults).toEqual([]);
      expect(run.finalAnswer).toBe('');
      expect(run.error).toMatch(/audit_day/);
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally { create.mockRestore(); prompt.mockRestore(); dispose.mockRestore(); }
  });
  it('propagates SDK/network errors and redacts the configured key from saved diagnostics', async () => {
    const { runAuditAgent } = await import('../../scripts/audit-agent.js');
    const key = 'offline-sensitive-placeholder';
    const create = vi.spyOn(sessionModule, 'createHotelSession').mockRejectedValue(new Error(`authentication ${key} Bearer abc123`));
    try {
      const run = await runAuditAgent('核对2026年10月15日', { apiKey: key });
      expect(run.status).toBe('FAIL');
      expect(run.sessionCreated).toBe(false);
      expect(run.error).not.toContain(key);
      const saved = await readFile(run.summaryPath, 'utf8');
      expect(saved).not.toContain(key);
      expect(saved).not.toContain('Bearer abc123');
      expect(saved).toContain('[REDACTED]');
    } finally { create.mockRestore(); }
  });
  it('returned summaries cannot restore a key accidentally placed in model metadata', async () => {
    const { runAuditAgent, agentRunSummary } = await import('../../scripts/audit-agent.js');
    const key = 'offline-secret-in-model-placeholder';
    const create = vi.spyOn(sessionModule, 'createHotelSession').mockRejectedValue(new Error('invalid configured model'));
    try {
      const run = await runAuditAgent('核对2026年10月15日', { apiKey: key, modelId: key });
      expect(JSON.stringify(agentRunSummary(run)).includes(key)).toBe(false);
      expect(run.modelId).toBe('[REDACTED]');
    } finally { create.mockRestore(); }
  });
  it('refuses an unexpected active tool before prompting', async () => {
    const { runAuditAgent } = await import('../../scripts/audit-agent.js');
    const session = await createHotelSession({ runId: 'offline-wrong-tools', auditEnabled: true, recordExecution: () => {} });
    const tools = vi.spyOn(session, 'getActiveToolNames').mockReturnValue(['read']);
    const prompt = vi.spyOn(session, 'prompt').mockResolvedValue(undefined);
    const create = vi.spyOn(sessionModule, 'createHotelSession').mockResolvedValue(session);
    try {
      const run = await runAuditAgent('核对2026年10月15日', { apiKey: 'offline-placeholder' });
      expect(run.status).toBe('FAIL');
      expect(prompt).not.toHaveBeenCalled();
      expect(run.error).toMatch(/白名单/);
    } finally { create.mockRestore(); tools.mockRestore(); prompt.mockRestore(); }
  });
  it('times out an unfinished prompt and disposes the SDK session', async () => {
    const { runAuditAgent } = await import('../../scripts/audit-agent.js');
    const session = await createHotelSession({ runId: 'offline-timeout', auditEnabled: true, recordExecution: () => {} });
    const prompt = vi.spyOn(session, 'prompt').mockImplementation(() => new Promise<void>(() => {}));
    const dispose = vi.spyOn(session, 'dispose');
    const create = vi.spyOn(sessionModule, 'createHotelSession').mockResolvedValue(session);
    try {
      const run = await runAuditAgent('核对2026年10月15日', { apiKey: 'offline-placeholder', timeoutMs: 5 });
      expect(run.status).toBe('FAIL');
      expect(run.error).toMatch(/超过/);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(run.toolResults).toEqual([]);
    } finally { create.mockRestore(); prompt.mockRestore(); dispose.mockRestore(); }
  });
  it('agent CLI has a nonzero BLOCKED exit and structured empty results without credentials', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const loader = pathToFileURL(fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url))).href;
    const child = spawnSync(process.execPath, ['--import', loader, fileURLToPath(new URL('../../scripts/audit-agent.ts', import.meta.url)), '核对2026年10月15日的订单录音'], {
      cwd: root, env: { ...process.env, DEEPSEEK_API_KEY: ' ', DEEPSEEK_MODEL: 'deepseek-flash' }, encoding: 'utf8', timeout: 20_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(2);
    expect(JSON.parse(child.stdout)).toMatchObject({ status: 'BLOCKED', sessionCreated: false, toolResults: [], date: null });
  });
  it('invalid agent CLI arguments fail clearly without inference', () => {
    const loader = pathToFileURL(fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url))).href;
    const child = spawnSync(process.execPath, ['--import', loader, fileURLToPath(new URL('../../scripts/audit-agent.ts', import.meta.url))], {
      env: { ...process.env, DEEPSEEK_API_KEY: ' ' }, encoding: 'utf8', timeout: 20_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    expect(JSON.parse(child.stderr)).toMatchObject({ status: 'FAIL', error: expect.stringContaining('用法') });
  });
});

// 这些只在内存中的验证器夹具有意构造 Runtime 记录，不写入 evidence/local，
// 不运行模型，也不作为 Stage 4 真实 Tool Calling 成功证据。
async function validatorFixture(): Promise<AuditSmokeInput> {
  const runId = 'synthetic-validator-fixture';
  const toolCallId = 'synthetic-validator-call';
  const args = { date: '2026-10-15' };
  const executions: ToolEvidenceRecord[] = [];
  const startedAt = evidence.beijingTimestamp();
  const tool = createAuditDayTool(runId, (record) => executions.push({ ...record, sequence: executions.length + 2 }));
  const response = await tool.execute(toolCallId, args, undefined, undefined, {} as ExtensionToolContext);
  const events: ToolEvidenceRecord[] = [
    { runId, toolCallId, toolName: 'audit_day', phase: 'tool_execution_start', args, result: null, isError: null, timestamp: startedAt, sequence: 1 },
    { runId, toolCallId, toolName: 'audit_day', phase: 'tool_execution_end', args, result: response, isError: false, timestamp: evidence.beijingTimestamp(), sequence: 4 },
  ];
  return { runId, events, executions, sessionCreated: true, activeTools: ['query_orders_by_date', 'audit_day'], finalAnswer: '仅供离线验证器测试的占位文本', finalStopReason: 'stop' };
}

describe('audit evidence validator, in-memory fixtures only', () => {
  it('validates all fifteen conditions and captures the full real business payload from the fixture', async () => {
    const input = await validatorFixture();
    const checks = evaluateAuditSmoke(input);
    expect(checks).toHaveLength(15);
    expect(checks.filter((check) => !check.passed)).toEqual([]);
    const captures = evidence.collectAuditToolResults(input.runId, input.events, input.executions);
    expect(captures).toHaveLength(1);
    expect(captures[0]?.result.results).toHaveLength(7);
    expect(captures[0]?.result).toEqual(input.executions[1]?.result);
    expect(JSON.parse(JSON.stringify(captures))).toEqual(captures);
  });
  it('a model claim without any evidence fails all fifteen requirements', () => {
    const checks = evaluateAuditSmoke({ runId: 'no-records', sessionCreated: false, activeTools: [], events: [], executions: [], finalAnswer: '', finalStopReason: undefined });
    expect(checks).toHaveLength(15);
    expect(checks.every((check) => !check.passed)).toBe(true);
    expect(evidence.collectAuditToolResults('no-records', [], [])).toEqual([]);
  });
  it.each(['missing_runtime_end', 'missing_execute', 'wrong_run', 'wrong_call', 'wrong_tool', 'wrong_args', 'wrong_result', 'is_error', 'duplicate_sequence', 'reversed_sequence', 'invalid_time', 'missing_candidates', 'zero_duration'])(
    'rejects incomplete or altered traces: %s', async (change) => {
      const input = await validatorFixture();
      if (change === 'missing_runtime_end') input.events.pop();
      if (change === 'missing_execute') input.executions.pop();
      if (change === 'wrong_run') input.executions[0]!.runId = 'old-run';
      if (change === 'wrong_call') input.executions[0]!.toolCallId = 'different-call';
      if (change === 'wrong_tool') input.executions[0]!.toolName = 'query_orders_by_date';
      if (change === 'wrong_args') input.executions[0]!.args = { date: '2026-10-16' };
      if (change === 'wrong_result') input.events[1]!.result = { details: {} };
      if (change === 'is_error') input.events[1]!.isError = true;
      if (change === 'duplicate_sequence') input.executions[0]!.sequence = 1;
      if (change === 'reversed_sequence') input.executions.reverse();
      if (change === 'invalid_time') input.executions[0]!.timestamp = 'invalid';
      if (change === 'missing_candidates' || change === 'zero_duration') {
        const result = input.executions[1]!.result as { results: { candidate_order_ids?: string[]; evidence: { start_ms: number; end_ms: number }[] }[] };
        if (change === 'missing_candidates') delete result.results[0]!.candidate_order_ids;
        else { const item = result.results.find((group) => group.evidence.length > 0)!.evidence[0]!; item.end_ms = item.start_ms; }
      }
      expect(evidence.collectAuditToolResults(input.runId, input.events, input.executions)).toEqual([]);
      expect(evaluateAuditSmoke(input).every((check) => check.passed)).toBe(false);
    },
  );
  it('rejects extra tools and normal-looking answers without a successful audit call', () => {
    const checks = evaluateAuditSmoke({ runId: 'text-only', sessionCreated: true, activeTools: ['audit_day', 'query_orders_by_date', 'bash'], events: [], executions: [], finalAnswer: '已成功核对全部订单', finalStopReason: 'stop' });
    expect(checks.find((check) => check.id === 'tools_registered')?.passed).toBe(false);
    expect(checks.find((check) => check.id === 'events_correlated')?.passed).toBe(false);
    expect(checks.every((check) => check.passed)).toBe(false);
  });
});
