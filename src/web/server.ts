import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import express, { type ErrorRequestHandler, type Response } from 'express';
import { loadAgentEnvironment, runAuditAgent } from '../../scripts/audit-agent.js';
import type { DetailedAuditResult, RecordingDataWarning } from '../domain/types.js';

const projectDirectory = fileURLToPath(new URL('../../', import.meta.url));
const recordingsFile = resolve(projectDirectory, 'data/recordings.json');
const audioDirectory = resolve(projectDirectory, 'audio');
const publicDirectory = resolve(projectDirectory, 'public');

export interface WebAppOptions {
  /** Controlled runners are for offline HTTP tests; the application defaults to the real Pi runner. */
  runner?: typeof runAuditAgent;
}

interface WebAuditResponse {
  status: 'PASS' | 'FAIL' | 'BLOCKED';
  runId: string | null;
  date: string | null;
  results: DetailedAuditResult[];
  warnings: RecordingDataWarning[];
  finalAnswer: string;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function chineseNumber(token: string): number {
  if (/^\d+$/.test(token)) return Number(token);
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (token.includes('十')) {
    const [tens, units] = token.split('十');
    return (tens ? digits[tens] ?? NaN : 1) * 10 + (units ? digits[units] ?? NaN : 0);
  }
  const mapped = [...token].map((character) => digits[character]);
  return mapped.every((digit) => digit !== undefined) ? Number(mapped.join('')) : NaN;
}

function normalizedDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Explicit dates are interpreted against the selected day, never the server's wall clock. */
function hasConflictingDate(question: string, selectedDate: string): boolean {
  // Every nonzero relative offset conflicts with the explicitly selected audit day.
  if (/昨天|昨日|昨晚|明天|明日|明晚|前天|后天|yesterday|tomorrow/i.test(question)) return true;
  const mentions: string[] = [];
  for (const match of question.matchAll(/(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/g)) {
    mentions.push(normalizedDate(Number(match[1]), Number(match[2]), Number(match[3])));
  }
  const year = Number(selectedDate.slice(0, 4));
  for (const match of question.matchAll(/([\d零〇一二三四五六七八九]{4})年\s*([\d零〇一二两三四五六七八九十]{1,3})月\s*([\d零〇一二两三四五六七八九十]{1,3})(?:日|号)?/g)) {
    mentions.push(normalizedDate(chineseNumber(match[1]!), chineseNumber(match[2]!), chineseNumber(match[3]!)));
  }
  for (const match of question.matchAll(/([\d零〇一二两三四五六七八九十]{1,3})月\s*([\d零〇一二两三四五六七八九十]{1,3})(?:日|号)?/g)) {
    mentions.push(normalizedDate(year, chineseNumber(match[1]!), chineseNumber(match[2]!)));
  }
  for (const match of question.matchAll(/([\d零〇一二三四五六七八九]{4})年/g)) {
    if (chineseNumber(match[1]!) !== year) return true;
  }
  return mentions.some((date) => !isDate(date) || date !== selectedDate);
}

function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    const key = process.env.DEEPSEEK_API_KEY?.trim();
    return (key ? value.split(key).join('[REDACTED]') : value).replace(/Bearer\s+[A-Za-z0-9_.-]+/gi, 'Bearer [REDACTED]');
  }
  if (Array.isArray(value)) return value.map(redact);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
  return value;
}

function reply(response: Response, code: number, body: WebAuditResponse): void {
  response.status(code).json(redact(body));
}

function failed(date: string | null, error: string, status: 'FAIL' | 'BLOCKED' = 'FAIL', runId: string | null = null): WebAuditResponse {
  return { status, runId, date, results: [], warnings: [], finalAnswer: '', error };
}

function isWithin(directory: string, target: string): boolean {
  const path = relative(directory, target);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** Only an exact known metadata ID can resolve to a nonlinked file under audio/. */
async function knownAudioPath(recordingId: string): Promise<string | null> {
  const metadata: unknown = JSON.parse(await readFile(recordingsFile, 'utf8'));
  if (!isRecord(metadata) || !Array.isArray(metadata.recordings)) throw new Error('Invalid recording metadata');
  const rows = metadata.recordings.filter((row: unknown) => isRecord(row) && row.recording_id === recordingId);
  if (rows.length !== 1) return null;
  const audioPath: unknown = (rows[0] as Record<string, unknown>).audio_path;
  if (typeof audioPath !== 'string' || !audioPath.endsWith('.mp3') || /[:\0]/.test(audioPath)
    || isAbsolute(audioPath) || win32.isAbsolute(audioPath)
    || audioPath.split(/[\\/]/).some((part) => part === '..' || part === '.')) return null;
  const absolutePath = resolve(projectDirectory, audioPath);
  if (!isWithin(audioDirectory, absolutePath)) return null;
  try {
    if ((await lstat(audioDirectory)).isSymbolicLink()) return null;
    let component = audioDirectory;
    for (const part of relative(audioDirectory, absolutePath).split(sep)) {
      component = resolve(component, part);
      const info = await lstat(component);
      if (info.isSymbolicLink() || (component === absolutePath && !info.isFile())) return null;
    }
    const [realDirectory, realFile] = await Promise.all([realpath(audioDirectory), realpath(absolutePath)]);
    return isWithin(realDirectory, realFile) ? absolutePath : null;
  } catch (error) {
    if (isRecord(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'ELOOP')) return null;
    throw error;
  }
}

/** Importing this module never reads .env, starts a listener, or sends a model request. */
export function createWebApp(options: WebAppOptions = {}) {
  const app = express();
  const runner = options.runner ?? runAuditAgent;
  app.disable('x-powered-by');
  app.set('case sensitive routing', true);
  app.get('/api/health', (_request, response) => {
    response.json({ status: 'ok', service: 'hotel-front-desk-audit', piStatus: 'not_checked',
      message: '本地 HTTP 服务已运行；此状态不代表 Pi 在线，在线能力仅由实际审计请求验证。' });
  });
  app.use(express.json({ limit: '16kb', strict: true }));
  app.post('/api/audit', async (request, response) => {
    const input: unknown = request.body;
    const date = isRecord(input) && isDate(input.date) ? input.date : null;
    if (!isRecord(input) || Object.keys(input).some((key) => key !== 'date' && key !== 'question')
      || date === null || typeof input.question !== 'string' || !input.question.trim()
      || input.question.trim().length > 1000) {
      reply(response, 400, failed(date, '请求只允许 date 和 question；日期须为真实 YYYY-MM-DD，问题须为 1 至 1000 字符。'));
      return;
    }
    const question = input.question.trim();
    if (hasConflictingDate(question, date)) {
      reply(response, 400, failed(date, '问题中的日期与所选日期冲突；请统一日期后重试。'));
      return;
    }
    const prompt = `请以用户选择的北京时间办理日期 ${date} 核对酒店订单和录音。\n`
      + `只允许调用 audit_day，并且每次 audit_day 的 date 必须严格为 ${date}；不要改用其他日期。\n`
      + '请根据 audit_day 的结构化结果解释候选、字段冲突和转写证据，不要虚构核对结果。\n'
      + `用户问题：${question}`;
    try {
      // The Stage 4 runner owns its aborting timeout and real Runtime/execute evidence capture.
      const run = await runner(prompt, { timeoutMs: 60_000 });
      const runId = typeof run.runId === 'string' && run.runId.trim() ? run.runId : null;
      if (run.status === 'BLOCKED') {
        reply(response, 503, failed(date, 'Pi 在线审计不可用；请在本机配置 DEEPSEEK_API_KEY 后重试。', 'BLOCKED', runId));
        return;
      }
      if (run.status !== 'PASS') {
        reply(response, 502, failed(date, 'Pi 审计未成功完成，请检查本机运行日志后重试。', 'FAIL', runId));
        return;
      }
      // toolResults have already been correlated and validated by the real Stage 4 runner.
      // Neither model Markdown nor aggregate metadata is a source of business results.
      const captures = run.toolResults.filter((item) => item.toolName === 'audit_day'
        && item.args.date === date && item.result.date === date);
      if (!runId || captures.length === 0) {
        reply(response, 502, failed(date, '本轮没有所选日期完整成功的 audit_day 结果。', 'FAIL', runId));
        return;
      }
      const result = captures[0]!.result;
      if (captures.some((item) => !isDeepStrictEqual(item.result, result))) {
        reply(response, 502, failed(date, '本轮同一日期的 audit_day 结果不一致，请重新核对。', 'FAIL', runId));
        return;
      }
      const warnings = [...new Map(result.warnings.map((item) => [JSON.stringify(item), item])).values()];
      reply(response, 200, { status: 'PASS', runId, date, results: result.results, warnings, finalAnswer: run.finalAnswer });
    } catch {
      reply(response, 500, failed(date, '本地审计服务发生内部错误，请检查本机日志后重试。'));
    }
  });
  app.get('/audio/:filename', async (request, response) => {
    const match = /^([A-Za-z0-9_-]{1,64})\.mp3$/.exec(request.params.filename);
    if (!match) { response.status(404).json({ error: '未找到可播放的录音。' }); return; }
    try {
      const path = await knownAudioPath(match[1]!);
      if (!path) { response.status(404).json({ error: '录音不存在或音频文件不可用。' }); return; }
      response.sendFile(path, { acceptRanges: true, dotfiles: 'deny' }, (error) => {
        if (!error) return;
        if (response.headersSent) { response.destroy(); return; }
        const code = isRecord(error) && (error.status === 416 || error.statusCode === 416) ? 416 : 404;
        response.status(code).json({ error: code === 416 ? '请求的音频范围不可用。' : '录音不存在或音频文件不可用。' });
      });
    } catch {
      response.status(500).json({ error: '无法读取录音，请检查本机音频配置。' });
    }
  });
  app.use(express.static(publicDirectory, { dotfiles: 'deny', index: 'index.html', redirect: false }));
  app.use((_request, response) => { response.status(404).json({ error: '未找到请求的资源。' }); });
  const errors: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (response.headersSent) { response.destroy(); return; }
    if (isRecord(error) && (error.type === 'entity.parse.failed' || error.type === 'entity.too.large')) {
      reply(response, 400, failed(null, '请求必须是有效的 JSON 对象，且请求体不能超过 16 KB。'));
    } else if (error instanceof URIError) {
      response.status(404).json({ error: '未找到请求的资源。' });
    } else {
      reply(response, 500, failed(null, '本地服务发生内部错误，请检查本机日志后重试。'));
    }
  };
  app.use(errors);
  return app;
}

async function main(): Promise<void> {
  loadAgentEnvironment();
  const configuredPort = process.env.PORT?.trim() || '3000';
  const port = Number(configuredPort);
  if (!/^\d+$/.test(configuredPort) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local port');
  const server = createWebApp().listen(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  console.log(`本地网页已启动：http://127.0.0.1:${port}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(() => {
    console.error('本地网页启动失败，请检查 PORT 或端口占用。');
    process.exitCode = 1;
  });
}
