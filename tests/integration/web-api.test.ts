import { existsSync } from 'node:fs';
import * as files from 'node:fs/promises';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditAgentRun, runAuditAgent } from '../../scripts/audit-agent.js';
import type { AuditToolResultCapture } from '../../src/agent/evidence.js';
import type { DetailedAuditResult, RecordingDataWarning, TranscriptEvidence } from '../../src/domain/types.js';

// Built-in ESM namespaces cannot be spied on directly. Delegate to the real
// filesystem by default; a few boundary tests replace only metadata/stat reads.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile), lstat: vi.fn(actual.lstat) };
});

// These controlled in-memory fixtures test only the HTTP adapter. They never
// invoke a model or become evidence of a successful online Pi audit.
const selectedDate = '2026-10-15';
const serverFile = new URL('../../src/web/server.ts', import.meta.url);
const recordingsFile = fileURLToPath(new URL('../../data/recordings.json', import.meta.url));
const servers: Server[] = [];
const warning: RecordingDataWarning = {
  code: 'audio_missing', recording_id: 'offline-voice-missing',
  started_at: `${selectedDate}T12:00:00+08:00`, audio_path: 'audio/offline-voice-missing.mp3',
  message: '离线适配器测试：音频不存在。',
};
const evidence: TranscriptEvidence = {
  recording_id: 'offline-voice-amount', field: 'amount_cents', segment_index: 2,
  text: '离线测试证据：房费合计七百九十六元。', start_ms: 5500, end_ms: 6500,
};

function fixtureResults(): DetailedAuditResult[] {
  return (['matched', 'field_mismatch', 'missing_recording', 'orphan_recording', 'needs_review'] as const).map((status, index) => {
    const orderId = status === 'orphan_recording' ? null : `offline-order-${index}`;
    const recordingId = status === 'missing_recording' ? null : status === 'field_mismatch' ? evidence.recording_id : `offline-voice-${index}`;
    return {
      status, order_id: orderId, recording_id: recordingId,
      candidate_order_ids: orderId ? [orderId] : [],
      candidate_recording_ids: status === 'needs_review' ? ['offline-voice-4', 'offline-voice-alternative'] : recordingId ? [recordingId] : [],
      conflicting_fields: status === 'field_mismatch' ? ['amount_cents'] : [],
      reasons: [`离线 HTTP 适配器测试：${status}`],
      evidence: status === 'field_mismatch' ? [structuredClone(evidence)] : [],
      conflicts: status === 'field_mismatch' ? [{ field: 'amount_cents', order_value: 75600, recording_value: 79600, evidence: [structuredClone(evidence)] }] : [],
      data_warnings: status === 'missing_recording' ? [structuredClone(warning)] : [],
    };
  });
}

function capture(date = selectedDate): AuditToolResultCapture {
  return { toolCallId: 'offline-api-tool-call', toolName: 'audit_day', args: { date },
    result: { date, window_seconds: 180, results: fixtureResults(), warnings: [structuredClone(warning)] } };
}

function fixtureRun(overrides: Partial<AuditAgentRun> = {}): AuditAgentRun {
  return {
    runId: 'offline-api-run', date: selectedDate, toolResults: [capture()],
    finalAnswer: '离线适配器测试回答，不是 Pi 在线调用证据。', warnings: [structuredClone(warning)],
    status: 'PASS', prompt: 'offline fixture', startedAt: `${selectedDate}T12:00:00+08:00`,
    endedAt: `${selectedDate}T12:00:01+08:00`, provider: 'deepseek', modelId: 'offline-fixture',
    sessionCreated: true, activeTools: ['audit_day', 'query_orders_by_date'], finalStopReason: 'stop',
    error: null, evidenceDirectory: 'private-local-directory', summaryPath: 'private-local-summary',
    events: [], executions: [], ...overrides,
  };
}

async function serve(options: { runner?: typeof runAuditAgent } = {}): Promise<string> {
  expect(existsSync(serverFile), 'the local web adapter must exist').toBe(true);
  const { createWebApp } = await import('../../src/web/server.js');
  const server = createWebApp(options).listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No loopback test address');
  return `http://127.0.0.1:${address.port}`;
}

interface ApiBody {
  status: string;
  runId: string | null;
  date: string | null;
  results: DetailedAuditResult[];
  warnings: RecordingDataWarning[];
  finalAnswer: string;
  error?: string;
}

async function audit(base: string, input: unknown = { date: selectedDate, question: '核对当日订单和录音' }) {
  const response = await fetch(`${base}/api/audit`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
  return { response, body: await response.json() as ApiBody };
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  vi.restoreAllMocks();
  vi.mocked(files.readFile).mockReset();
  vi.mocked(files.lstat).mockReset();
  vi.unstubAllEnvs();
});

describe('Stage 5 HTTP adapter, offline runner injection', () => {
  it('health reports only HTTP availability without implying that Pi is online', async () => {
    const runner = vi.fn<typeof runAuditAgent>(async () => fixtureRun());
    const base = await serve({ runner });
    const response = await fetch(`${base}/api/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok', piStatus: 'not_checked', message: expect.stringMatching(/HTTP.*Pi|Pi.*HTTP/) });
    expect(runner).not.toHaveBeenCalled();
  });

  it('returns all five statuses with complete candidates, integer amounts and timed source evidence', async () => {
    const runner = vi.fn<typeof runAuditAgent>(async () => fixtureRun());
    const { response, body } = await audit(await serve({ runner }));
    expect(response.status).toBe(200);
    expect(body).toEqual({ status: 'PASS', runId: 'offline-api-run', date: selectedDate,
      results: fixtureResults(), warnings: [warning], finalAnswer: fixtureRun().finalAnswer });
    expect(body.results.map((result) => result.status)).toEqual(['matched', 'field_mismatch', 'missing_recording', 'orphan_recording', 'needs_review']);
    expect(body.results[1]?.conflicts[0]).toEqual({ field: 'amount_cents', order_value: 75600, recording_value: 79600, evidence: [evidence] });
    expect(body.results[4]?.candidate_recording_ids).toHaveLength(2);
    expect(runner).toHaveBeenCalledWith(expect.stringMatching(/2026-10-15/), { timeoutMs: 60_000 });
    const prompt = runner.mock.calls[0]![0];
    expect(prompt).toMatch(/audit_day/);
    expect(prompt).toMatch(/只|仅/);
    expect(prompt).toContain('核对当日订单和录音');
    expect(JSON.stringify(body)).not.toMatch(/private-local|activeTools|summaryPath/);
  });

  it('trims a question and accepts the selected day in numeric and Chinese date forms', async () => {
    const runner = vi.fn<typeof runAuditAgent>(async () => fixtureRun());
    const base = await serve({ runner });
    for (const question of ['  请核对2026-10-15  ', '核对2026.10.15', '核对2026年10月15日', '核对二零二六年十月十五日', '核对十月十五号', '核对10月15日', '核对今天所选日期']) {
      expect((await audit(base, { date: selectedDate, question })).response.status, question).toBe(200);
    }
    expect(runner.mock.calls[0]![0]).toContain('请核对2026-10-15');
    expect(runner.mock.calls[0]![0]).not.toContain('  请核对2026-10-15  ');
  });

  it.each([
    null, [], 'question', 2, {}, { date: selectedDate }, { date: selectedDate, question: '' },
    { date: selectedDate, question: '   ' }, { date: selectedDate, question: 12 },
    { date: selectedDate, question: 'x'.repeat(1001) }, { date: '2026-1-5', question: '核对' },
    { date: '2026-02-30', question: '核对' }, { date: '0000-01-01', question: '核对' },
    { date: 20261015, question: '核对' }, { date: selectedDate, question: '核对', apiKey: 'must-not-be-accepted' },
  ].map((input) => ({ input })))('rejects an invalid request before invoking the runner: $input', async ({ input }) => {
    const runner = vi.fn<typeof runAuditAgent>(async () => fixtureRun());
    const { response, body } = await audit(await serve({ runner }), input);
    expect(response.status).toBe(400);
    expect(body).toMatchObject({ status: 'FAIL', runId: null, results: [], warnings: [], finalAnswer: '', error: expect.any(String) });
    expect(runner).not.toHaveBeenCalled();
  });

  it.each(['核对2026-10-16', '核对2026/10/16', '核对2026.10.16', '核对2026年10月16日', '核对二零二六年十月十六日', '核对10月16号', '核对十月十六日', '核对2025年10月15日', '核对昨天', '核对明天', '核对前天', '核对后天', 'audit yesterday', '核对2026-02-30'])('rejects a conflicting question date: %s', async (question) => {
    const runner = vi.fn<typeof runAuditAgent>(async () => fixtureRun());
    const { response, body } = await audit(await serve({ runner }), { date: selectedDate, question });
    expect(response.status).toBe(400);
    expect(body.error).toMatch(/日期/);
    expect(runner).not.toHaveBeenCalled();
  });

  it.each(['{broken', JSON.stringify({ date: selectedDate, question: 'x'.repeat(17_000) })])('returns sanitized JSON for malformed or oversized JSON bodies', async (raw) => {
    const runner = vi.fn<typeof runAuditAgent>(async () => fixtureRun());
    const response = await fetch(`${await serve({ runner })}/api/audit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ status: 'FAIL', results: [], error: expect.any(String) });
    expect(runner).not.toHaveBeenCalled();
  });

  it('does not interpret a text body as JSON', async () => {
    const runner = vi.fn<typeof runAuditAgent>(async () => fixtureRun());
    const response = await fetch(`${await serve({ runner })}/api/audit`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ date: selectedDate, question: '核对' }) });
    expect(response.status).toBe(400);
    expect(runner).not.toHaveBeenCalled();
  });

  it.each([['BLOCKED', 503], ['FAIL', 502]] as const)('maps %s without exposing partial successful data or raw errors', async (status, code) => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'offline-sensitive-placeholder');
    const runner: typeof runAuditAgent = async () => fixtureRun({ status, error: `offline-sensitive-placeholder ${fileURLToPath(serverFile)}` });
    const { response, body } = await audit(await serve({ runner }));
    expect(response.status).toBe(code);
    expect(body).toMatchObject({ status, results: [], warnings: [], finalAnswer: '', error: expect.any(String) });
    expect(JSON.stringify(body)).not.toMatch(/offline-sensitive-placeholder|server\.ts|private-local/);
  });

  it('maps unexpected runner exceptions to a generic 500 response', async () => {
    const runner: typeof runAuditAgent = async () => { throw new Error(`rawsecret ${fileURLToPath(serverFile)}`); };
    const { response, body } = await audit(await serve({ runner }));
    expect(response.status).toBe(500);
    expect(body).toMatchObject({ status: 'FAIL', runId: null, results: [], error: expect.any(String) });
    expect(JSON.stringify(body)).not.toMatch(/rawsecret|server\.ts/);
  });

  it('uses the real runner without loading .env or fabricating results when no key is present', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', ' ');
    const { response, body } = await audit(await serve());
    expect(response.status).toBe(503);
    expect(body).toMatchObject({ status: 'BLOCKED', date: selectedDate, results: [], warnings: [], finalAnswer: '' });
    expect(body.runId).toBeTypeOf('string');
    expect(body.error).toMatch(/DEEPSEEK_API_KEY/);
  });

  it('never derives business results from model Markdown or a claimed PASS with no captures', async () => {
    const runner: typeof runAuditAgent = async () => fixtureRun({ toolResults: [], finalAnswer: `全部匹配\n\`\`\`json\n${JSON.stringify(fixtureResults())}\n\`\`\`` });
    const { response, body } = await audit(await serve({ runner }));
    expect(response.status).toBe(502);
    expect(body).toMatchObject({ status: 'FAIL', results: [], finalAnswer: '' });
  });

  it.each(['args', 'result', 'both'] as const)('rejects captures whose %s date does not match the selected date', async (part) => {
    const wrong = capture();
    if (part === 'args' || part === 'both') wrong.args.date = '2026-10-16';
    if (part === 'result' || part === 'both') wrong.result.date = '2026-10-16';
    const runner: typeof runAuditAgent = async () => fixtureRun({ date: '2026-10-16', toolResults: [wrong] });
    const { response, body } = await audit(await serve({ runner }));
    expect(response.status).toBe(502);
    expect(body.results).toEqual([]);
  });

  it('selects only captures for the chosen date and does not use aggregate warnings from other dates', async () => {
    const other = capture('2026-10-16');
    other.result.warnings = [];
    const runner: typeof runAuditAgent = async () => fixtureRun({ date: null, toolResults: [other, capture()], warnings: [] });
    const { response, body } = await audit(await serve({ runner }));
    expect(response.status).toBe(200);
    expect(body.results).toEqual(fixtureResults());
    expect(body.warnings).toEqual([warning]);
  });

  it('deduplicates identical same-day captures', async () => {
    const first = capture();
    const second = structuredClone(first);
    second.toolCallId = 'offline-second-call';
    const runner: typeof runAuditAgent = async () => fixtureRun({ toolResults: [first, second] });
    const { response, body } = await audit(await serve({ runner }));
    expect(response.status).toBe(200);
    expect(body.results).toEqual(fixtureResults());
    expect(body.warnings).toEqual([warning]);
  });

  it('refuses conflicting same-day captures instead of choosing the first', async () => {
    const second = capture();
    second.toolCallId = 'offline-conflicting-call';
    second.result.results[0]!.reasons = ['changed result'];
    const runner: typeof runAuditAgent = async () => fixtureRun({ toolResults: [capture(), second] });
    const { response, body } = await audit(await serve({ runner }));
    expect(response.status).toBe(502);
    expect(body).toMatchObject({ status: 'FAIL', results: [], warnings: [], finalAnswer: '' });
    expect(body.error).toMatch(/不一致|冲突/);
  });

  it('allows a successful empty-day capture', async () => {
    const empty = capture();
    empty.result.results = [];
    empty.result.warnings = [];
    const runner: typeof runAuditAgent = async () => fixtureRun({ toolResults: [empty] });
    expect((await audit(await serve({ runner }))).body).toMatchObject({ status: 'PASS', results: [], warnings: [] });
  });

  it('redacts the configured key even if a controlled runner returns it in answer text', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'offline-key-never-browser');
    const runner: typeof runAuditAgent = async () => fixtureRun({ finalAnswer: 'offline-key-never-browser Bearer abc.secret' });
    const { body } = await audit(await serve({ runner }));
    expect(body.finalAnswer).not.toMatch(/offline-key-never-browser|abc\.secret/);
    expect(body.finalAnswer).toContain('[REDACTED]');
  });
});

describe('Stage 5 real audio and public file boundaries', () => {
  it('serves an exact known MP3 using real bytes and supports byte Range requests', async () => {
    const base = await serve();
    const expected = await files.readFile(new URL('../../audio/R001.mp3', import.meta.url));
    const response = await fetch(`${base}/audio/R001.mp3`, { headers: { range: 'bytes=0-31' } });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-type')).toMatch(/audio\/mpeg/);
    expect(response.headers.get('content-range')).toBe(`bytes 0-31/${expected.length}`);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(expected.subarray(0, 32));
  });

  it.each(['/audio/unknown.mp3', '/audio/R001.srt', '/audio/R001.MP3', '/audio/%2e%2e%2f.env.mp3', '/audio/%2e%2e%5c.env.mp3', '/audio/R001.mp3/extra', `/audio/${'a'.repeat(65)}.mp3`])('returns JSON 404 for unknown or invalid audio URLs: %s', async (path) => {
    const response = await fetch(`${await serve()}${path}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: expect.any(String) });
  });

  it.each(['../.env', 'audio/../audio/R001.mp3', 'audio/R001.srt', 'C:\\private.mp3', '/private.mp3', 'https://invalid.example/a.mp3'])('rejects unsafe metadata audio paths: %s', async (audio_path) => {
    const base = await serve();
    vi.mocked(files.readFile).mockResolvedValue(JSON.stringify({ recordings: [{ recording_id: 'R001', audio_path }] }));
    const response = await fetch(`${base}/audio/R001.mp3`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: expect.any(String) });
  });

  it('returns JSON 404 for a known metadata row whose audio file is absent', async () => {
    const base = await serve();
    vi.mocked(files.readFile).mockResolvedValue(JSON.stringify({ recordings: [{ recording_id: 'offline-absent', audio_path: 'audio/offline-absent.mp3' }] }));
    const response = await fetch(`${base}/audio/offline-absent.mp3`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: expect.any(String) });
  });

  it('rejects linked audio paths before sending bytes', async () => {
    const base = await serve();
    vi.mocked(files.lstat).mockResolvedValue({ isSymbolicLink: () => true } as Awaited<ReturnType<typeof files.lstat>>);
    const response = await fetch(`${base}/audio/R001.mp3`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: expect.any(String) });
  });

  it.each(['/.env', '/package.json', '/src/web/server.ts', '/data/recordings.json', '/tests/fixtures/expected_results.json', '/audio/R001.boundaries.json', '/.git/config'])('does not expose repository or non-MP3 files: %s', async (path) => {
    const response = await fetch(`${await serve()}${path}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: expect.any(String) });
  });

  it('keeps the HTTP adapter connected to the runner rather than an offline engine or expected fixture', async () => {
    expect(existsSync(serverFile), 'the local web adapter must exist').toBe(true);
    const source = await files.readFile(serverFile, 'utf8');
    expect(source).toMatch(/runAuditAgent/);
    expect(source).not.toMatch(/expected_results|tests[\\/]fixtures|domain[\\/]audit|\bauditDay\s*\(/);
    expect(source).toMatch(/127\.0\.0\.1/);
    expect(recordingsFile).toContain('recordings.json');
  });
});
