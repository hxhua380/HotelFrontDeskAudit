import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AssistantMessage, JsonObject } from '@earendil-works/pi-ai';
import { runToolCall, type AgentTool, type AgentToolCall } from '@earendil-works/pi-agent-core';
import type { AgentToolResult, ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it } from 'vitest';
import * as agentTools from '../../src/agent/tools.js';
import type { AuditDayToolDependencies, AuditDayToolResult } from '../../src/agent/tools.js';
import type { ToolEvidenceRecord } from '../../src/agent/evidence.js';
import { queryOrdersByDate, queryRecordingsByDate } from '../../src/data/repository.js';
import type { Order, Recording } from '../../src/domain/types.js';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const fixtureRoot = join(projectRoot, '.cache', 'tests');
const fixtureDirectories: string[] = [];
const day = '2026-10-15';

function createTool(records: ToolEvidenceRecord[] = [], dependencies?: AuditDayToolDependencies) {
  expect(agentTools).toHaveProperty('createAuditDayTool', expect.any(Function));
  return agentTools.createAuditDayTool('audit-tool-test', (record) => records.push(record), dependencies);
}

function execute(tool: ReturnType<typeof createTool>, args: unknown = { date: day }, signal?: AbortSignal): Promise<AgentToolResult<AuditDayToolResult>> {
  return tool.execute('audit-call-1', args, signal, undefined, {} as ExtensionToolContext);
}

function executeThroughSdk(tool: ReturnType<typeof createTool>, args: JsonObject) {
  const toolCall: AgentToolCall = { type: 'toolCall', id: 'sdk-audit-call', name: 'audit_day', arguments: args };
  const sdkTool: AgentTool = {
    ...tool,
    execute: (id, parameters, signal, onUpdate) => tool.execute(id, parameters, signal, onUpdate, {} as ExtensionToolContext),
  };
  const assistantMessage: AssistantMessage = {
    role: 'assistant', content: [toolCall], api: 'openai-completions', provider: 'offline-test', model: 'offline-test',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'toolUse', timestamp: 0,
  };
  return runToolCall(toolCall, { tools: [sdkTool], assistantMessage, context: { messages: [assistantMessage] } });
}

async function fixture() {
  await mkdir(fixtureRoot, { recursive: true });
  const directory = await mkdtemp(join(fixtureRoot, 'audit-tool-'));
  fixtureDirectories.push(directory);
  const ordersFile = join(directory, 'orders.json');
  const recordingsFile = join(directory, 'recordings.json');
  await Promise.all([
    copyFile(join(projectRoot, 'data', 'orders.json'), ordersFile),
    copyFile(join(projectRoot, 'data', 'recordings.json'), recordingsFile),
  ]);
  const dependencies: AuditDayToolDependencies = {
    queryOrdersByDate: (date) => queryOrdersByDate(date, ordersFile),
    queryRecordingsByDate: (date) => queryRecordingsByDate(date, recordingsFile, projectRoot),
  };
  return { directory, ordersFile, recordingsFile, dependencies };
}

afterEach(async () => {
  for (const directory of fixtureDirectories.splice(0)) {
    const target = resolve(directory);
    const scoped = relative(resolve(fixtureRoot), target);
    if (!scoped || scoped.startsWith('..') || isAbsolute(scoped)) throw new Error(`Unscoped fixture: ${target}`);
    await rm(target, { recursive: true, force: true });
  }
});

describe('audit_day tool', () => {
  it('exports the audit tool factory and stable tool name', () => {
    expect(agentTools).toHaveProperty('AUDIT_TOOL_NAME', 'audit_day');
    expect(agentTools).toHaveProperty('createAuditDayTool', expect.any(Function));
  });

  it('exposes a closed schema with a required date and an optional nonnegative window', () => {
    const tool = createTool();
    expect(tool.name).toBe('audit_day');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['date'],
      properties: { date: { type: 'string' }, window_seconds: { type: 'number', minimum: 0, default: 180 } },
    });
  });

  it('returns all seven real audit groups, five statuses, candidates and full amount evidence', async () => {
    const records: ToolEvidenceRecord[] = [];
    const response = await execute(createTool(records));
    const result: AuditDayToolResult = response.details;
    expect(response.content).toEqual([{ type: 'text', text: JSON.stringify(result) }]);
    expect(result).toMatchObject({ date: day, window_seconds: 180, warnings: [] });
    expect(result.results).toHaveLength(7);
    expect([...new Set(result.results.map((item) => item.status))].sort()).toEqual([
      'field_mismatch', 'matched', 'missing_recording', 'needs_review', 'orphan_recording',
    ]);
    expect(result.results).toContainEqual(expect.objectContaining({
      status: 'needs_review', order_id: null, recording_id: 'R005',
      candidate_order_ids: ['O005', 'O006'], candidate_recording_ids: ['R005'],
    }));
    expect(result.results).toContainEqual(expect.objectContaining({
      status: 'needs_review', order_id: 'O007', recording_id: null,
      candidate_order_ids: ['O007'], candidate_recording_ids: ['R006', 'R007'],
    }));
    const amountConflict = result.results.find((item) => item.order_id === 'O002');
    expect(amountConflict).toMatchObject({
      status: 'field_mismatch', recording_id: 'R002', conflicting_fields: ['amount_cents'],
      conflicts: [{ field: 'amount_cents', order_value: 75600, recording_value: 79600, evidence: [
        { recording_id: 'R002', field: 'amount_cents', segment_index: 0, start_ms: 100, end_ms: 12538, text: expect.stringContaining('七百九十六元') },
      ] }],
    });
    expect(amountConflict?.evidence).toContainEqual(expect.objectContaining({
      recording_id: 'R002', field: 'amount_cents', segment_index: 0, text: expect.stringContaining('七百九十六元'),
    }));
    expect(records).toEqual([
      expect.objectContaining({ runId: 'audit-tool-test', toolCallId: 'audit-call-1', toolName: 'audit_day', args: { date: day }, phase: 'execute_start', result: null, isError: null }),
      expect.objectContaining({ runId: 'audit-tool-test', toolCallId: 'audit-call-1', toolName: 'audit_day', args: { date: day }, phase: 'execute_end', result, isError: false }),
    ]);
    for (const record of records) expect(record.timestamp).toMatch(/\+08:00$/);
  });

  it('queries the handled date on October 16 even when the stay dates are later', async () => {
    const result = (await execute(createTool(), { date: '2026-10-16' })).details;
    expect(result).toMatchObject({ date: '2026-10-16', window_seconds: 180, warnings: [] });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ status: 'matched', order_id: 'O008', recording_id: 'R008' });
  });

  it('applies a zero-second window instead of replacing zero with the default', async () => {
    const result = (await execute(createTool(), { date: '2026-10-16', window_seconds: 0 })).details;
    expect(result.window_seconds).toBe(0);
    expect(result.results.map((item) => item.status).sort()).toEqual(['missing_recording', 'orphan_recording']);
  });

  it.each([null, [], '2026-10-15', {}, { date: 20261015 }, { date: day, extra: true },
    { date: '2026-1-15' }, { date: ' 2026-10-15' }, { date: '2026-02-29' }, { date: '2026-04-31' },
    { date: '0000-01-01' }, { date: '2026-13-01' }, { date: day, window_seconds: '180' },
    { date: day, window_seconds: null }, { date: day, window_seconds: undefined },
    { date: day, window_seconds: -1 }, { date: day, window_seconds: Number.NaN },
    { date: day, window_seconds: Number.POSITIVE_INFINITY }, { date: day, window_seconds: false },
  ])('rejects invalid arguments before querying and records a failed execution (%#)', async (args) => {
    const records: ToolEvidenceRecord[] = [];
    const tool = createTool(records, {
      queryOrdersByDate: async () => { throw new Error('must not query orders'); },
      queryRecordingsByDate: async () => { throw new Error('must not query recordings'); },
    });
    await expect(execute(tool, args)).rejects.toThrow(/date|window_seconds|argument|参数/i);
    expect(records.map((record) => [record.phase, record.isError])).toEqual([['execute_start', null], ['execute_end', true]]);
    expect(records[1]?.result).toEqual({ error: expect.any(String) });
  });

  it('accepts a true leap day and a finite fractional window', async () => {
    const seen: string[] = [];
    const tool = createTool([], {
      queryOrdersByDate: async (date) => { seen.push(`orders:${date}`); return []; },
      queryRecordingsByDate: async (date) => { seen.push(`recordings:${date}`); return { recordings: [], warnings: [] }; },
    });
    expect((await execute(tool, { date: '2024-02-29', window_seconds: 0.5 })).details).toEqual({
      date: '2024-02-29', window_seconds: 0.5, warnings: [], results: [],
    });
    expect(seen.sort()).toEqual(['orders:2024-02-29', 'recordings:2024-02-29']);
  });

  it.each([null, '180', false])('rejects the raw window type before SDK coercion (%#)', async (window) => {
    const records: ToolEvidenceRecord[] = [];
    const result = await executeThroughSdk(createTool(records), { date: day, window_seconds: window });
    expect(result.isError).toBe(true);
    expect(result.result.content).toEqual([{ type: 'text', text: expect.stringMatching(/window_seconds/) }]);
    expect(records).toEqual([]);
  });

  it('preserves omitted-window arguments through the SDK while using the default internally', async () => {
    const records: ToolEvidenceRecord[] = [];
    const result = await executeThroughSdk(createTool(records), { date: '2026-10-16' });
    expect(result.isError).toBe(false);
    expect(result.result.details).toMatchObject({ date: '2026-10-16', window_seconds: 180 });
    expect(records.map((record) => record.args)).toEqual([{ date: '2026-10-16' }, { date: '2026-10-16' }]);
  });

  it('preserves missing-audio warnings and excludes that recording from the real audit', async () => {
    const files = await fixture();
    const source = JSON.parse(await readFile(files.recordingsFile, 'utf8')) as { recordings: Recording[] };
    source.recordings[0]!.audio_path = 'audio/definitely-absent-audit-test.mp3';
    await writeFile(files.recordingsFile, JSON.stringify(source), 'utf8');
    const records: ToolEvidenceRecord[] = [];
    const result = (await execute(createTool(records, files.dependencies))).details;
    expect(result.warnings).toEqual([expect.objectContaining({ code: 'audio_missing', recording_id: 'R001' })]);
    expect(result.results.find((item) => item.order_id === 'O001')).toMatchObject({
      status: 'missing_recording', recording_id: null, candidate_recording_ids: [], data_warnings: result.warnings,
    });
    expect(records.at(-1)?.isError).toBe(false);
  });

  it.each(['orders', 'recordings'] as const)('records and rethrows a malformed %s repository error', async (repository) => {
    const files = await fixture();
    const badFile = repository === 'orders' ? files.ordersFile : files.recordingsFile;
    await writeFile(badFile, '{broken', 'utf8');
    const records: ToolEvidenceRecord[] = [];
    await expect(execute(createTool(records, files.dependencies))).rejects.toThrow(badFile);
    expect(records.at(-1)).toMatchObject({ phase: 'execute_end', isError: true, result: { error: expect.stringContaining(badFile) } });
  });

  it('records and rethrows the original repository error', async () => {
    const failure = new Error('local repository failed');
    const records: ToolEvidenceRecord[] = [];
    const tool = createTool(records, { queryOrdersByDate: async () => { throw failure; } });
    await expect(execute(tool)).rejects.toBe(failure);
    expect(records.at(-1)).toMatchObject({ phase: 'execute_end', isError: true, result: { error: failure.message } });
  });

  it('stops before querying when already aborted', async () => {
    const controller = new AbortController();
    const failure = new Error('audit cancelled');
    controller.abort(failure);
    const records: ToolEvidenceRecord[] = [];
    const tool = createTool(records, {
      queryOrdersByDate: async () => { throw new Error('must not query orders'); },
      queryRecordingsByDate: async () => { throw new Error('must not query recordings'); },
    });
    await expect(execute(tool, { date: day }, controller.signal)).rejects.toBe(failure);
    expect(records.at(-1)).toMatchObject({ phase: 'execute_end', isError: true, result: { error: failure.message } });
  });

  it('stops after repository reads when cancellation arrives during the reads', async () => {
    const controller = new AbortController();
    const failure = new Error('cancelled while reading');
    const records: ToolEvidenceRecord[] = [];
    const tool = createTool(records, {
      queryOrdersByDate: async () => { controller.abort(failure); return []; },
      queryRecordingsByDate: async () => ({ recordings: [], warnings: [] }),
    });
    await expect(execute(tool, { date: day }, controller.signal)).rejects.toBe(failure);
    expect(records.at(-1)).toMatchObject({ phase: 'execute_end', isError: true });
  });

  it('rereads temporary order and recording copies on each execution', async () => {
    const files = await fixture();
    const tool = createTool([], files.dependencies);
    const first = (await execute(tool)).details;
    expect(first.results.find((item) => item.order_id === 'O001')?.status).toBe('matched');

    const orders = JSON.parse(await readFile(files.ordersFile, 'utf8')) as { orders: Order[] };
    orders.orders[0]!.amount_cents = 88800;
    await writeFile(files.ordersFile, JSON.stringify(orders), 'utf8');
    const second = (await execute(tool)).details;
    expect(second.results.find((item) => item.order_id === 'O001')).toMatchObject({
      status: 'field_mismatch', conflicts: [{ field: 'amount_cents', order_value: 88800, recording_value: 39800 }],
    });

    const recordings = JSON.parse(await readFile(files.recordingsFile, 'utf8')) as { recordings: Recording[] };
    recordings.recordings[0]!.transcript_segments[0]!.text = '八零二号大床房，2026-10-15入住，2026-10-16退房，房费总金额888元。';
    await writeFile(files.recordingsFile, JSON.stringify(recordings), 'utf8');
    const third = (await execute(tool)).details;
    expect(third.results.find((item) => item.order_id === 'O001')).toMatchObject({ status: 'matched', conflicts: [] });
    expect(first.results.find((item) => item.order_id === 'O001')?.status).toBe('matched');
  });

  it('keeps the existing query tool callable with its original name and payload', async () => {
    const records: ToolEvidenceRecord[] = [];
    const tool = agentTools.createQueryOrdersTool('query-regression', (record) => records.push(record));
    const response = await tool.execute('query-call-1', { date: '2026-10-16' }, undefined, undefined, {} as ExtensionToolContext);
    expect(tool.name).toBe(agentTools.QUERY_TOOL_NAME);
    expect(response.details).toMatchObject({ date: '2026-10-16', orders: [expect.objectContaining({ order_id: 'O008' })] });
    expect(records.map((record) => record.phase)).toEqual(['execute_start', 'execute_end']);
  });
});
