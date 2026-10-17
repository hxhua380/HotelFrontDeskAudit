import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

type Listener = { callback: (event: Record<string, unknown>) => unknown; once: boolean };

// A small event/element boundary lets the shipped browser script run unchanged.
// It deliberately rejects innerHTML so unsafe business/model rendering fails.
class Element {
  children: Element[] = [];
  listeners = new Map<string, Listener[]>();
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  className = '';
  value = '';
  hidden = false;
  open = false;
  disabled = false;
  readyState = 0;
  currentTime = 0;
  paused = true;
  playCount = 0;
  pauseCount = 0;
  src = '';
  controls = false;
  preload = '';
  id = '';
  tabIndex = 0;
  focusCount = 0;
  scrollCount = 0;
  ownerDocument?: Document;
  private ownText = '';

  constructor(readonly tagName: string) {}
  get textContent(): string { return this.ownText + this.children.map((child) => child.textContent).join(''); }
  set textContent(value: unknown) { this.ownText = String(value ?? ''); this.children = []; }
  set innerHTML(_value: string) { throw new Error('Unsafe innerHTML rendering'); }
  append(...children: Element[]) { this.children.push(...children); }
  appendChild(child: Element) { this.append(child); return child; }
  replaceChildren(...children: Element[]) { this.ownText = ''; this.children = [...children]; }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())] = String(value);
  }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  addEventListener(name: string, callback: Listener['callback'], options?: { once?: boolean }) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), { callback, once: options?.once ?? false }]);
  }
  removeEventListener(name: string, callback: Listener['callback']) {
    this.listeners.set(name, (this.listeners.get(name) ?? []).filter((listener) => listener.callback !== callback));
  }
  emit(name: string, properties: Record<string, unknown> = {}): Promise<unknown[]> {
    const listeners = [...(this.listeners.get(name) ?? [])];
    return Promise.all(listeners.map((listener) => {
      if (listener.once) this.removeEventListener(name, listener.callback);
      return listener.callback({ preventDefault() {}, target: this, currentTarget: this, ...properties });
    }));
  }
  querySelectorAll(selector: string): Element[] {
    const all = this.children.flatMap((child) => [child, ...child.querySelectorAll('*')]);
    if (selector === '*') return all;
    if (selector.startsWith('.')) return all.filter((element) => element.className.split(' ').includes(selector.slice(1)));
    if (selector === '[data-question]') return all.filter((element) => element.dataset.question !== undefined);
    return all.filter((element) => element.tagName === selector.toUpperCase());
  }
  focus() { this.focusCount++; if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  scrollIntoView() { this.scrollCount++; }
  load() {}
  pause() { this.paused = true; this.pauseCount++; }
  play() { this.paused = false; this.playCount++; return Promise.resolve(); }
}

class Document {
  body = new Element('BODY');
  elements = new Map<string, Element>();
  created: Element[] = [];
  activeElement: Element | null = null;
  constructor() {
    for (const id of ['audit-form', 'audit-date', 'audit-question', 'audit-submit', 'health-status', 'request-status', 'stats', 'result-list', 'result-detail', 'workspace-tab', 'report-tab', 'workspace-panel', 'report-panel', 'ai-answer', 'warnings', 'stale-notice', 'result-summary', 'run-id']) {
      const element = new Element(id === 'audit-form' ? 'FORM' : id === 'audit-submit' || id.endsWith('-tab') ? 'BUTTON' : 'DIV');
      element.id = id;
      element.ownerDocument = this;
      this.elements.set(id, element);
      this.body.append(element);
    }
    this.getElementById('audit-date').value = '2026-10-15';
    this.getElementById('audit-question').value = '帮我核对当天前台订单和接待录音，列出异常并给出证据。';
    for (const question of ['核对当天所有订单与录音', '当天有哪些异常？', 'O002 为什么金额不一致？']) {
      const element = new Element('BUTTON');
      element.dataset.question = question;
      this.body.append(element);
    }
  }
  getElementById(id: string): Element { return this.elements.get(id) ?? this.body.querySelectorAll('*').find((element) => element.id === id)!; }
  createElement(tag: string): Element { const element = new Element(tag.toUpperCase()); element.ownerDocument = this; this.created.push(element); return element; }
  querySelectorAll(selector: string): Element[] { return this.body.querySelectorAll(selector); }
}

type UI = {
  formatMoney: (cents: number) => string;
  formatTime: (milliseconds: number) => string;
  audioSource: (id: string) => string | null;
  playEvidenceSegment: (audio: Element, evidence: unknown, warn: (message: string) => void) => void;
};
type ResponsePayload = { status: string; date: string; results: unknown[]; warnings: unknown[]; finalAnswer: string; runId: string; error?: string };
const scriptPath = fileURLToPath(new URL('../../public/app.js', import.meta.url));

function response(payload: ResponsePayload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}
function success(results: unknown[] = [], date = '2026-10-15', finalAnswer = '基于工具结果的说明'): ResponsePayload {
  return { status: 'PASS', date, results, warnings: [], finalAnswer, runId: 'offline-ui-test-only' };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function boot(auditFetch: (url: string, options?: RequestInit) => Promise<unknown> = async () => response(success()), options: { narrow?: boolean } = {}) {
  expect(existsSync(scriptPath), 'the browser application must exist').toBe(true);
  const document = new Document();
  const calls: { url: string; options?: RequestInit }[] = [];
  const fetch = async (url: string, options?: RequestInit) => {
    calls.push(options ? { url, options } : { url });
    if (url === '/api/health') return { ok: true, status: 200 };
    return auditFetch(url, options);
  };
  const matchMedia = () => ({ matches: options.narrow ?? false, addEventListener() {}, removeEventListener() {} });
  const context = vm.createContext({ document, fetch, AbortController, console, setTimeout, clearTimeout, matchMedia, window: { matchMedia } });
  vm.runInContext(readFileSync(scriptPath, 'utf8'), context, { filename: 'public/app.js' });
  return { document, calls, ui: context.HotelAuditUI as UI, get: (id: string) => document.getElementById(id) };
}
const evidence = { recording_id: 'R002', field: 'amount_cents', segment_index: 0, start_ms: 100, end_ms: 12525, text: '房费合计七百九十六元。' };
function result(overrides: Record<string, unknown> = {}) {
  return { status: 'field_mismatch', order_id: 'O002', recording_id: 'R002', candidate_order_ids: ['O002'], candidate_recording_ids: ['R002'], conflicting_fields: ['amount_cents'], conflicts: [{ field: 'amount_cents', order_value: 75600, recording_value: 79600, evidence: [evidence] }], reasons: ['已知字段差异：金额（订单 75600，录音 79600）。'], evidence: [evidence], data_warnings: [], ...overrides };
}

describe('web browser UI (offline boundary tests, not a Pi online acceptance)', () => {
  it('uses a master list of native record buttons and one selected detail with no embedded disclosures', async () => {
    const fixtures = [
      result({ status: 'matched', order_id: 'O100', conflicts: [], conflicting_fields: [] }),
      result({ order_id: 'O205', recording_id: 'R205' }),
      result({ order_id: 'O206', recording_id: 'R206' }),
    ];
    const app = boot(async () => response(success(fixtures)));
    await app.get('audit-form').emit('submit');

    const options = app.get('result-list').querySelectorAll('.record-option');
    expect(options).toHaveLength(fixtures.length);
    expect(options.map((option) => option.tagName)).toEqual(['BUTTON', 'BUTTON', 'BUTTON']);
    expect(options.map((option) => option.dataset.resultIndex)).toEqual(['0', '1', '2']);
    expect(options.map((option) => option.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
    expect(app.get('result-list').querySelectorAll('details')).toHaveLength(0);
    expect(app.get('result-list').querySelectorAll('.record-content')).toHaveLength(0);
    expect(app.get('result-detail').querySelectorAll('.record-content')).toHaveLength(1);
    expect(app.get('result-detail').textContent).toContain('O205');
    expect(app.get('result-detail').textContent).not.toContain('O206');
    expect(app.get('detail-title').textContent).toContain('O205');
  });

  it.each([
    { statuses: ['matched', 'needs_review', 'missing_recording'], selected: 1 },
    { statuses: ['matched', 'orphan_recording', 'matched'], selected: 1 },
    { statuses: ['matched', 'matched'], selected: 0 },
  ])('selects the first attention record or first result when no field mismatch exists ($statuses)', async ({ statuses, selected }) => {
    const fixtures = statuses.map((status, index) => result({ status, order_id: `O${100 + index}`, conflicting_fields: [], conflicts: [], evidence: [] }));
    const app = boot(async () => response(success(fixtures)));
    await app.get('audit-form').emit('submit');

    expect(app.get('result-list').querySelectorAll('.record-option').map((option) => option.getAttribute('aria-pressed'))).toEqual(statuses.map((_status, index) => String(index === selected)));
    expect(app.get('result-detail').textContent).toContain(`O${100 + selected}`);
  });

  it('switches records locally without mutating the response or losing complete unconfirmed candidate sets', async () => {
    const candidate = result({
      status: 'needs_review', order_id: null, recording_id: null,
      candidate_order_ids: ['O005', 'O006'], candidate_recording_ids: ['R006', 'R007'],
      conflicting_fields: [], conflicts: [], evidence: [], reasons: ['候选之间无法唯一确认。'],
    });
    const payload = success([result(), candidate]);
    const before = JSON.stringify(payload);
    const app = boot(async () => response(payload));
    await app.get('audit-form').emit('submit');
    const callsBefore = app.calls.length;
    const options = app.get('result-list').querySelectorAll('.record-option');
    expect(options).toHaveLength(2);
    await options[1]!.emit('click');

    expect(options.map((option) => option.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
    for (const id of ['O005', 'O006', 'R006', 'R007']) expect(app.get('result-detail').textContent).toContain(id);
    expect(app.get('result-detail').textContent).toContain('候选关联，尚未确认');
    expect(app.get('result-detail').textContent).toContain(candidate.reasons[0]);
    expect(app.get('result-detail').textContent).not.toContain('已确认匹配');
    expect(app.get('result-detail').querySelectorAll('audio').map((audio) => audio.src)).toEqual(['/audio/R006.mp3', '/audio/R007.mp3']);
    await options[0]!.emit('click');
    expect(app.get('result-detail').textContent).toContain('¥756.00');
    expect(app.get('result-detail').textContent).toContain('¥796.00');
    expect(app.calls).toHaveLength(callsBefore);
    expect(JSON.stringify(payload)).toBe(before);
  });

  it('opens the workspace by default and switches accessible report tabs with click and arrow keys without requests', async () => {
    const payload = success([result()], '2026-10-15', '### 字段冲突\n\nO002 金额需要核对。');
    const app = boot(async () => response(payload));
    expect(app.get('workspace-tab').getAttribute('aria-selected')).toBe('true');
    expect(app.get('report-tab').getAttribute('aria-selected')).toBe('false');
    expect(app.get('workspace-panel').hidden).toBe(false);
    expect(app.get('report-panel').hidden).toBe(true);
    await app.get('audit-form').emit('submit');
    const before = JSON.stringify(payload);
    const callsBefore = app.calls.length;
    const detail = app.get('result-detail').querySelectorAll('.record-content')[0];

    await app.get('report-tab').emit('click');
    expect(app.get('workspace-tab').getAttribute('aria-selected')).toBe('false');
    expect(app.get('report-tab').getAttribute('aria-selected')).toBe('true');
    expect(app.get('workspace-panel').hidden).toBe(true);
    expect(app.get('report-panel').hidden).toBe(false);
    await app.get('report-tab').emit('keydown', { key: 'ArrowLeft' });
    expect(app.get('workspace-tab').getAttribute('aria-selected')).toBe('true');
    expect(app.document.activeElement).toBe(app.get('workspace-tab'));
    await app.get('workspace-tab').emit('keydown', { key: 'End' });
    expect(app.get('report-tab').getAttribute('aria-selected')).toBe('true');
    await app.get('report-tab').emit('keydown', { key: 'Home' });
    expect(app.get('workspace-tab').getAttribute('aria-selected')).toBe('true');
    await app.get('workspace-tab').emit('keydown', { key: 'ArrowRight' });
    expect(app.get('report-tab').getAttribute('aria-selected')).toBe('true');
    expect(app.document.activeElement).toBe(app.get('report-tab'));
    expect(app.get('result-detail').querySelectorAll('.record-content')[0]).toBe(detail);
    expect(app.calls).toHaveLength(callsBefore);
    expect(JSON.stringify(payload)).toBe(before);
  });

  it('cancels pending and playing audio when another record is selected', async () => {
    const app = boot(async () => response(success([result(), result({ order_id: 'O009', recording_id: 'R009', candidate_order_ids: ['O009'], candidate_recording_ids: ['R009'], evidence: [], conflicts: [] })])));
    await app.get('audit-form').emit('submit');
    const original = app.get('result-detail').querySelectorAll('audio')[0];
    expect(original).toBeDefined();
    await app.get('result-detail').querySelectorAll('.evidence-play')[0]!.emit('click');
    expect(original!.playCount).toBe(0);
    await app.get('result-list').querySelectorAll('.record-option')[1]!.emit('click');
    original!.readyState = 1;
    await original!.emit('loadedmetadata');
    expect(original!.playCount).toBe(0);
    expect(original!.paused).toBe(true);
    expect(original!.listeners.get('loadedmetadata') ?? []).toHaveLength(0);
    await app.get('result-list').querySelectorAll('.record-option')[0]!.emit('click');
    const current = app.get('result-detail').querySelectorAll('audio')[0]!;
    current.readyState = 1;
    await app.get('result-detail').querySelectorAll('.evidence-play')[0]!.emit('click');
    expect(current.paused).toBe(false);
    await app.get('result-list').querySelectorAll('.record-option')[1]!.emit('click');
    expect(current.paused).toBe(true);
  });

  it('makes native player play events exclusive and cancels other pending evidence playback', async () => {
    const app = boot(async () => response(success([result({
      status: 'needs_review', recording_id: null, candidate_recording_ids: ['R006', 'R007'], conflicts: [],
      evidence: [{ ...evidence, recording_id: 'R006' }, { ...evidence, recording_id: 'R007' }],
    })])));
    await app.get('audit-form').emit('submit');
    const players = app.get('result-detail').querySelectorAll('audio');
    expect(players).toHaveLength(2);
    await app.get('result-detail').querySelectorAll('.evidence-play')[0]!.emit('click');
    players[1]!.paused = false;
    await players[1]!.emit('play');
    players[0]!.readyState = 1;
    await players[0]!.emit('loadedmetadata');
    expect(players[0]!.playCount).toBe(0);
    expect(players[0]!.paused).toBe(true);
    players[0]!.paused = false;
    await players[0]!.emit('play');
    expect(players[1]!.paused).toBe(true);
  });

  it('renders all three report heading levels with up to three leading spaces and CRLF while preserving other source text', async () => {
    const markdown = ' # 当日核对\r\n\r\n  ## 异常明细\r\n   ### 1. 字段冲突\r\n普通中文 **金额** 与原句。\r\n\r\n### 2. 订单无录音\r\n1. 查看 O003\r\n2. 保留待确认\r\n\r\n### 3. 录音无订单\r\n| 录音 | 说明 |\r\n| --- | --- |\r\n| R003 | <img src=x onerror=alert(1)> |\r\n\r\n    ### 四个空格原样保留\r\n#### 四级标题原样保留';
    const payload = success([], '2026-10-15', markdown);
    const app = boot(async () => response(payload));
    await app.get('audit-form').emit('submit');
    const answer = app.get('ai-answer');
    expect(answer.querySelectorAll('h1').map((node) => node.textContent)).toEqual(['当日核对']);
    expect(answer.querySelectorAll('h2').map((node) => node.textContent)).toEqual(['异常明细']);
    expect(answer.querySelectorAll('h3').map((node) => node.textContent)).toEqual(['1. 字段冲突', '2. 订单无录音', '3. 录音无订单']);
    expect(answer.querySelectorAll('strong').map((node) => node.textContent)).toEqual(['金额']);
    expect(answer.querySelectorAll('ol')[0]!.querySelectorAll('li').map((node) => node.textContent)).toEqual(['查看 O003', '保留待确认']);
    expect(answer.querySelectorAll('.ai-table-card')[0]!.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(answer.querySelectorAll('p').map((node) => node.textContent)).toContain('    ### 四个空格原样保留\n#### 四级标题原样保留');
    expect(app.document.created.some((node) => ['IMG', 'SCRIPT'].includes(node.tagName))).toBe(false);
    expect(payload.finalAnswer).toBe(markdown);
  });

  it('provides native tab semantics and labelled panels in the shipped HTML', () => {
    const html = readFileSync(fileURLToPath(new URL('../../public/index.html', import.meta.url)), 'utf8');
    const openingTag = (id: string) => html.match(new RegExp(`<[^>]+id="${id}"[^>]*>`))?.[0] ?? '';
    expect(openingTag('workspace-tab')).toMatch(/^<button\b/);
    expect(openingTag('workspace-tab')).toContain('role="tab"');
    expect(openingTag('workspace-tab')).toContain('aria-controls="workspace-panel"');
    expect(openingTag('workspace-tab')).toContain('aria-selected="true"');
    expect(openingTag('report-tab')).toMatch(/^<button\b/);
    expect(openingTag('report-tab')).toContain('role="tab"');
    expect(openingTag('report-tab')).toContain('aria-controls="report-panel"');
    expect(openingTag('workspace-panel')).toContain('role="tabpanel"');
    expect(openingTag('workspace-panel')).toContain('aria-labelledby="workspace-tab"');
    expect(openingTag('report-panel')).toContain('role="tabpanel"');
    expect(openingTag('report-panel')).toContain('aria-labelledby="report-tab"');
    expect(openingTag('report-panel')).toMatch(/\bhidden\b/);
    expect(html).toMatch(/role="tablist"/);
  });

  it('requests detail focus or scroll feedback for an explicit narrow-screen record selection', async () => {
    const app = boot(async () => response(success([result(), result({ order_id: 'O009' })])), { narrow: true });
    await app.get('audit-form').emit('submit');
    const detail = app.get('result-detail');
    expect(detail.scrollCount).toBe(0);
    const options = app.get('result-list').querySelectorAll('.record-option');
    expect(options).toHaveLength(2);
    await options[1]!.emit('click');
    expect(detail.textContent).toContain('O009');
    expect(detail.scrollCount + (app.get('detail-title')?.scrollCount ?? 0)).toBeGreaterThan(0);
    expect([detail, app.get('detail-title')]).toContain(app.document.activeElement);
  });

  it('renders report evidence quotations safely without formatting the underlying transcript', async () => {
    const quote = 'R002 00:00.100：“七百九十六元。” <script>alert(1)</script>';
    const payload = success([result()], '2026-10-15', `### 原句证据\r\n> ${quote}\r\n> **金额**需要复核。\r\n\r\n保留全部证据。`);
    const before = JSON.stringify(payload);
    const app = boot(async () => response(payload));
    await app.get('audit-form').emit('submit');
    const quotations = app.get('ai-answer').querySelectorAll('blockquote');
    expect(quotations.length).toBeGreaterThan(0);
    expect(quotations.map((node) => node.textContent).join('\n')).toContain(quote);
    expect(quotations.flatMap((node) => node.querySelectorAll('strong').map((bold) => bold.textContent))).toEqual(['金额']);
    expect(app.get('result-detail').querySelectorAll('.evidence-text').map((node) => node.textContent)).toEqual([evidence.text]);
    expect(app.document.created.some((node) => ['SCRIPT', 'IMG'].includes(node.tagName))).toBe(false);
    expect(JSON.stringify(payload)).toBe(before);
  });

  it('clears the selected detail and its audio when inputs change, on failure, and on an empty replacement result', async () => {
    let calls = 0;
    const next = deferred<ReturnType<typeof response>>();
    const app = boot(async () => {
      calls++;
      if (calls === 1) return response(success([result(), result({ order_id: 'O009' })]));
      if (calls === 2) return next.promise;
      return response(success([]));
    });
    await app.get('audit-form').emit('submit');
    const options = app.get('result-list').querySelectorAll('.record-option');
    expect(options).toHaveLength(2);
    await options[1]!.emit('click');
    expect(app.get('result-detail').textContent).toContain('O009');
    app.get('audit-question').value = '重新核对';
    await app.get('audit-question').emit('input');
    expect(app.get('result-list').querySelectorAll('.record-option')).toHaveLength(0);
    expect(app.get('result-detail').querySelectorAll('.record-content')).toHaveLength(0);
    expect(app.get('result-detail').querySelectorAll('audio')).toHaveLength(0);
    expect(app.get('result-detail').textContent).not.toContain('O009');
    const failed = app.get('audit-form').emit('submit');
    next.resolve(response({ ...success([result()]), status: 'FAIL', error: '本次工具失败。' }, 502));
    await failed;
    expect(app.get('result-list').querySelectorAll('.record-option')).toHaveLength(0);
    expect(app.get('result-detail').querySelectorAll('.record-content')).toHaveLength(0);
    expect(app.get('result-detail').textContent).not.toContain('O002');
    await app.get('audit-form').emit('submit');
    expect(app.get('result-list').querySelectorAll('.record-option')).toHaveLength(0);
    expect(app.get('result-detail').querySelectorAll('.record-content')).toHaveLength(0);
    expect(app.get('result-detail').querySelectorAll('audio')).toHaveLength(0);
    expect(app.get('result-list').textContent).toContain('没有');
  });

  it('rejects an older date response without replacing the newer record selection, counts, or report', async () => {
    const older = deferred<ReturnType<typeof response>>();
    const newer = deferred<ReturnType<typeof response>>();
    let requests = 0;
    const app = boot(async () => ++requests === 1 ? older.promise : newer.promise);
    const oldRequest = app.get('audit-form').emit('submit');
    app.get('audit-date').value = '2026-10-16';
    await app.get('audit-date').emit('input');
    expect(app.get('result-detail').querySelectorAll('.record-content')).toHaveLength(0);
    const currentRequest = app.get('audit-date').emit('change');
    newer.resolve(response(success([result({
      status: 'matched', order_id: 'O016', recording_id: 'R016', candidate_order_ids: ['O016'], candidate_recording_ids: ['R016'],
      conflicting_fields: [], conflicts: [], evidence: [],
    })], '2026-10-16', '### 新日期说明')));
    await currentRequest;
    older.resolve(response(success([result({ order_id: 'O015' })], '2026-10-15', '### 旧日期说明')));
    await oldRequest;
    const records = app.get('result-list').querySelectorAll('.record-option');
    expect(records).toHaveLength(1);
    expect(records[0]!.getAttribute('aria-pressed')).toBe('true');
    expect(app.get('result-detail').textContent).toContain('O016');
    expect(app.get('result-detail').textContent).not.toContain('O015');
    expect(app.get('result-summary').textContent).toContain('2026-10-16');
    expect(app.get('stats').querySelectorAll('strong').map((node) => node.textContent)).toEqual(['1', '0', '0', '0', '0']);
    expect(app.get('ai-answer').querySelectorAll('h3').map((node) => node.textContent)).toEqual(['新日期说明']);
    expect(app.calls.filter((call) => call.url === '/api/audit')).toHaveLength(2);
  });

  it('keeps money units, sentence timestamps and audio paths exact', () => {
    const { ui } = boot();
    expect(ui.formatMoney(75600)).toBe('¥756.00');
    expect(ui.formatMoney(79600)).toBe('¥796.00');
    expect(ui.formatTime(100)).toBe('00:00.100');
    expect(ui.formatTime(12525)).toBe('00:12.525');
    expect(ui.formatTime(60001)).toBe('01:00.001');
    expect(ui.audioSource('R002')).toBe('/audio/R002.mp3');
    for (const id of ['../.env', 'R002/../../secret', 'x?token=y', '<script>', '']) expect(ui.audioSource(id)).toBeNull();
  });

  it('starts without audit results and shortcuts only edit the question', async () => {
    const app = boot();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(app.calls.map((call) => call.url)).toEqual(['/api/health']);
    expect(app.get('health-status').textContent).toBe('');
    expect(app.get('health-status').hidden).toBe(true);
    expect(app.get('result-list').textContent).toContain('开始核对');
    const shortcut = app.document.querySelectorAll('[data-question]')[2]!;
    await shortcut.emit('click');
    expect(app.get('audit-question').value).toBe('O002 为什么金额不一致？');
    expect(app.calls).toHaveLength(1);
  });

  it('renders all five statuses, complete candidates, conflict values and raw sentence evidence safely', async () => {
    const unsafeText = '<img src=x onerror=alert(1)>';
    const fixtures = [result(), result({ status: 'matched', order_id: 'O001', recording_id: 'R001', candidate_order_ids: ['O001'], candidate_recording_ids: ['R001'], conflicting_fields: [], conflicts: [], reasons: ['字段一致'], evidence: [] }), result({ status: 'missing_recording', recording_id: null, candidate_recording_ids: [], conflicts: [], conflicting_fields: [], evidence: [] }), result({ status: 'orphan_recording', order_id: null, candidate_order_ids: [] }), result({ status: 'needs_review', order_id: 'O007', recording_id: 'R006', candidate_order_ids: ['O007', 'O008'], candidate_recording_ids: ['R006', 'R007'], reasons: [unsafeText], conflicts: [], conflicting_fields: [], evidence: [] })];
    const app = boot(async () => response(success(fixtures, '2026-10-15', unsafeText)));
    await app.get('audit-form').emit('submit');
    let text = app.get('result-list').textContent;
    const options = app.get('result-list').querySelectorAll('.record-option');
    expect(options).toHaveLength(fixtures.length);
    for (const option of options) {
      await option.emit('click');
      text += app.get('result-detail').textContent;
    }
    for (const value of ['匹配', '字段不一致', '缺少录音', '录音无对应订单', '待确认', '候选关联，尚未确认', 'O007', 'O008', 'R006', 'R007', '¥756.00', '¥796.00', evidence.text, '00:00.100 – 00:12.525', '无可播放录音', '未找到对应订单', unsafeText]) expect(text).toContain(value);
    for (const label of ['匹配', '字段不一致', '缺少录音', '录音无对应订单', '待确认']) expect(app.get('stats').textContent).toContain(label);
    expect(app.get('stats').querySelectorAll('strong').map((count) => count.textContent)).toEqual(['1', '1', '1', '1', '1']);
    const candidateAudio = app.get('result-detail').querySelectorAll('audio').filter((audio) => ['/audio/R006.mp3', '/audio/R007.mp3'].includes(audio.src));
    expect(candidateAudio.map((audio) => audio.src).sort()).toEqual(['/audio/R006.mp3', '/audio/R007.mp3']);
    expect(app.get('ai-answer').textContent).toBe(unsafeText);
    expect(app.document.created.some((element) => ['IMG', 'SCRIPT'].includes(element.tagName))).toBe(false);
    expect(app.get('request-status').textContent).toBe('核对完成');
  });

  it('removes decorative demo and developer labels while retaining the business page identity', () => {
    const html = readFileSync(fileURLToPath(new URL('../../public/index.html', import.meta.url)), 'utf8');
    const body = html.slice(html.indexOf('<body>'));
    for (const content of ['Hotel Front Desk Audit', '前台订单与接待录音智能核对', 'AI核对报告']) expect(body).toContain(content);
    for (const content of ['本地演示 · 合成数据', 'hotel-badge', 'demo-note', 'HTTP 服务', 'Pi Agent', '工具结果', '业务判断以结构化工具结果为依据。候选关系保留待确认状态，不据此推定已匹配。']) expect(body).not.toContain(content);
    expect(body).not.toContain('Demo Hotel');
    expect(body).toMatch(/id="run-id"[^>]*hidden/);
    expect(body).toMatch(/id="health-status"[^>]*hidden/);
  });

  it('keeps run identifiers in the unchanged response without showing developer status in the page', async () => {
    const payload = { ...success([result()]), runId: 'real-source-run-id-to-retain' };
    const before = JSON.stringify(payload);
    const app = boot(async () => response(payload));
    await app.get('audit-form').emit('submit');

    for (const id of ['run-id', 'health-status']) {
      expect(app.get(id).hidden).toBe(true);
      expect(app.get(id).textContent).toBe('');
    }
    expect(app.document.body.textContent).not.toContain(payload.runId);
    expect(app.get('request-status').textContent).toBe('核对完成');
    expect(app.get('request-status').textContent).not.toMatch(/PASS|FAIL|BLOCKED|HTTP|SDK|Pi/);
    expect(JSON.stringify(payload)).toBe(before);
  });

  it('uses a concise business loading state while keeping duplicate submission prevention', async () => {
    const pending = deferred<ReturnType<typeof response>>();
    const app = boot(async () => pending.promise);
    expect(app.get('request-status').textContent).not.toMatch(/HTTP|SDK|Pi/);
    const request = app.get('audit-form').emit('submit');
    expect(app.get('request-status').textContent).toBe('正在核对订单与录音，请稍候。');
    expect(app.get('audit-submit').disabled).toBe(true);
    expect(app.get('audit-form').attributes.get('aria-busy')).toBe('true');
    pending.resolve(response(success([result()])));
    await request;
    expect(app.get('audit-submit').disabled).toBe(false);
    expect(app.get('audit-form').attributes.get('aria-busy')).toBe('false');
  });

  it('selects only the first field mismatch by its status rather than an order identifier', async () => {
    const fixtures = [
      result({ status: 'matched', order_id: 'O002', conflicts: [], conflicting_fields: [] }),
      result({ order_id: 'O075', recording_id: 'R075' }),
      result({ order_id: 'O076', recording_id: 'R076' }),
      result({ status: 'needs_review', order_id: 'O077' }),
    ];
    const app = boot(async () => response(success(fixtures)));
    await app.get('audit-form').emit('submit');

    const records = app.get('result-list').querySelectorAll('.record-option');
    expect(records.map((record) => record.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false', 'false']);
    expect(records[1]!.textContent).toContain('O075');
    expect(app.get('result-detail').textContent).toContain('O075');
    expect(app.get('result-detail').querySelectorAll('.evidence-card')).toHaveLength(1);
  });

  it('shows complete candidate identities and unconfirmed semantics in the compact record and selected detail', async () => {
    const fixture = result({
      status: 'needs_review', order_id: null, recording_id: null,
      candidate_order_ids: ['O005', 'O006'], candidate_recording_ids: ['R006', 'R007'],
      conflicting_fields: [], conflicts: [], reasons: ['两个订单与两段录音之间不能唯一确认。'], evidence: [],
    });
    const app = boot(async () => response(success([fixture])));
    await app.get('audit-form').emit('submit');

    const record = app.get('result-list').querySelectorAll('.record-option')[0]!;
    expect(record.getAttribute('aria-pressed')).toBe('true');
    for (const id of ['O005', 'O006', 'R006', 'R007']) expect(record.textContent).toContain(id);
    const orderLabel = record.querySelectorAll('.record-name')[0]!.textContent;
    const recordingLabel = record.querySelectorAll('.recording-relation')[0]!.textContent;
    for (const label of ['候选订单', 'O005', 'O006']) expect(orderLabel).toContain(label);
    for (const label of ['候选录音', 'R006', 'R007']) expect(recordingLabel).toContain(label);
    expect(record.querySelectorAll('.status-badge')[0]!.textContent).toBe('待确认');
    expect(record.querySelectorAll('.record-summary')[0]!.textContent).toBe(fixture.reasons[0]);
    expect(app.get('result-detail').textContent).toContain('候选关联，尚未确认');
    expect(record.textContent).not.toContain('已确认匹配');
    expect(app.get('result-detail').querySelectorAll('.reason-list')[0]!.textContent).toContain(fixture.reasons[0]);
  });

  it('keeps the selected record and audio nodes stable during unrelated health and unchanged-input events', async () => {
    const app = boot(async () => response(success([result({ status: 'needs_review' }), result()])));
    await app.get('audit-form').emit('submit');
    const records = app.get('result-list').querySelectorAll('.record-option');
    const first = records[0]!;
    const second = records[1]!;
    await first.emit('click');
    const audio = app.get('result-detail').querySelectorAll('audio')[0]!;

    await app.get('audit-question').emit('input');
    await app.get('audit-date').emit('change');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(app.get('result-list').querySelectorAll('.record-option')[0]).toBe(first);
    expect(app.get('result-list').querySelectorAll('.record-option')[1]).toBe(second);
    expect(first.getAttribute('aria-pressed')).toBe('true');
    expect(second.getAttribute('aria-pressed')).toBe('false');
    expect(app.get('result-detail').querySelectorAll('audio')[0]).toBe(audio);
    expect(app.calls.filter((call) => call.url === '/api/audit')).toHaveLength(1);
  });

  it('reinitializes selection for a changed query date and selects a lone matched result', async () => {
    const app = boot(async (_url, options) => {
      const selectedDate = (JSON.parse(String(options?.body)) as { date: string }).date;
      return response(success(selectedDate === '2026-10-15' ? [result()] : [result({
        status: 'matched', order_id: 'O008', recording_id: 'R008',
        candidate_order_ids: ['O008'], candidate_recording_ids: ['R008'],
        conflicting_fields: [], conflicts: [], evidence: [],
      })], selectedDate));
    });
    await app.get('audit-form').emit('submit');
    const original = app.get('result-list').querySelectorAll('.record-option')[0]!;
    expect(original.getAttribute('aria-pressed')).toBe('true');
    app.get('audit-date').value = '2026-10-16';
    await app.get('audit-date').emit('input');
    await app.get('audit-date').emit('change');

    const next = app.get('result-list').querySelectorAll('.record-option')[0]!;
    expect(next).not.toBe(original);
    expect(next.getAttribute('aria-pressed')).toBe('true');
    expect(next.textContent).toContain('O008');
    expect(next.textContent).toContain('R008');
    expect(app.get('result-detail').textContent).toContain('O008');
  });

  it('calculates and labels the absolute amount difference from integer cents without changing reasons or evidence', async () => {
    const fixture = result();
    const before = JSON.stringify(fixture);
    const app = boot(async () => response(success([fixture])));
    await app.get('audit-form').emit('submit');

    const table = app.get('result-detail').querySelectorAll('.conflict-table')[0]!;
    expect(table.querySelectorAll('thead')[0]!.textContent).toContain('差异');
    expect(table.querySelectorAll('tbody')[0]!.querySelectorAll('td').map((cell) => cell.textContent)).toEqual(['¥756.00', '¥796.00', '¥40.00']);
    expect(app.get('result-detail').querySelectorAll('.reason-list')[0]!.textContent).toContain(fixture.reasons[0]);
    expect(app.get('result-detail').querySelectorAll('.evidence-text')[0]!.textContent).toBe(evidence.text);
    expect(JSON.stringify(fixture)).toBe(before);

    const reverse = boot(async () => response(success([result({
      conflicts: [{ field: 'amount_cents', order_value: 79600, recording_value: 75600, evidence: [evidence] }],
    })])));
    await reverse.get('audit-form').emit('submit');
    expect(reverse.get('result-detail').querySelectorAll('.conflict-table')[0]!.querySelectorAll('tbody')[0]!.querySelectorAll('td').map((cell) => cell.textContent)).toEqual(['¥796.00', '¥756.00', '¥40.00']);
  });

  it('omits only standalone known AI technical notes while preserving the original response and business explanation', async () => {
    const notes = [
      '业务判断以结构化工具结果为依据。候选关系保留待确认状态，不据此推定已匹配。',
      '以上结论均来自 audit_day 结构化结果，未作额外推断。',
      '窗口时间与转写时间均为整句范围（非词级精确时间）。',
      'Run ID · fresh-model-run-id',
    ];
    const explanation = 'O002 订单 ¥756.00，录音 ¥796.00；R006 与 R007 均为待确认候选。';
    const payload = success([result()], '2026-10-15', ['## 核对说明', explanation, ...notes].join('\n\n'));
    const before = JSON.stringify(payload);
    const app = boot(async () => response(payload));
    await app.get('audit-form').emit('submit');

    expect(app.get('ai-answer').querySelectorAll('h2')[0]!.textContent).toBe('核对说明');
    expect(app.get('ai-answer').textContent).toContain(explanation);
    for (const note of notes) expect(app.get('ai-answer').textContent).not.toContain(note);
    expect(JSON.stringify(payload)).toBe(before);
  });

  it('retains mixed business and limitation paragraphs and never filters recording words or backend reasons', async () => {
    const note = '以上结论均来自 audit_day 结构化结果，未作额外推断。';
    const mixed = `${note}O004 缺少房号与金额，不能确认匹配。`;
    const limitation = '录音缺少金额，audit_day 目前仅能保留 R006、R007 两个候选；请人工确认。';
    const literal = 'Demo Hotel 原始转写：<img src=x onerror=alert(1)>。';
    const fixture = result({ reasons: [note, limitation], evidence: [{ ...evidence, text: literal }], conflicts: [] });
    const payload = success([fixture], '2026-10-15', `${mixed}\n\n${limitation}`);
    const before = JSON.stringify(payload);
    const app = boot(async () => response(payload));
    await app.get('audit-form').emit('submit');

    expect(app.get('ai-answer').querySelectorAll('p').map((node) => node.textContent)).toEqual([mixed, limitation]);
    expect(app.get('result-detail').querySelectorAll('.reason-list')[0]!.textContent).toContain(note);
    expect(app.get('result-detail').querySelectorAll('.reason-list')[0]!.textContent).toContain(limitation);
    expect(app.get('result-detail').querySelectorAll('.evidence-text')[0]!.textContent).toBe(literal);
    expect(app.document.created.some((node) => ['IMG', 'SCRIPT'].includes(node.tagName))).toBe(false);
    expect(JSON.stringify(payload)).toBe(before);
  });

  it('retains business facts sharing a Run ID paragraph or line while hiding only an isolated identifier', async () => {
    const mixed = [
      'Run ID · abc；O002金额不一致，需要人工核实。',
      'Run ID · abc\nO004 缺少房号与金额，仍然需要确认。',
    ];
    const payload = success([], '2026-10-15', ['Run ID · safe-run_2026-10-15', ...mixed].join('\n\n'));
    const before = JSON.stringify(payload);
    const app = boot(async () => response(payload));
    await app.get('audit-form').emit('submit');

    expect(app.get('ai-answer').querySelectorAll('p').map((node) => node.textContent)).toEqual(mixed);
    expect(app.get('ai-answer').textContent).not.toContain('safe-run_2026-10-15');
    expect(JSON.stringify(payload)).toBe(before);
  });

  it('keeps the initial AI placeholder understandable without exposing developer technology terms', () => {
    const app = boot();
    expect(app.get('ai-answer').textContent).toContain('完成核对后');
    expect(app.get('ai-answer').textContent).not.toMatch(/Pi|HTTP|SDK|Runtime/);
  });

  it('preserves real error strings even when they equal inherited JavaScript object property names', async () => {
    for (const error of ['constructor', 'toString', '__proto__']) {
      const app = boot(async () => response({ ...success(), status: 'FAIL', error }, 502));
      await app.get('audit-form').emit('submit');
      expect(app.get('request-status').textContent).toContain(error);
      expect(app.get('request-status').textContent).not.toMatch(/function|native code/);
      expect(app.get('result-list').querySelectorAll('.audit-record')).toHaveLength(0);
    }
  });

  it('does not append fixed technical precision or cent-unit disclaimers to every business record', async () => {
    const app = boot(async () => response(success([result()])));
    await app.get('audit-form').emit('submit');

    for (const note of ['上方原始工具理由中的金额数值单位为分', '时间范围为整句级边界，不代表词级精确位置。']) expect(app.get('result-list').textContent).not.toContain(note);
    expect(app.get('result-detail').querySelectorAll('.evidence-time')[0]!.textContent).toBe('00:00.100 – 00:12.525');
    expect(app.get('result-detail').querySelectorAll('.reason-list')[0]!.textContent).toContain('订单 75600，录音 79600');
  });

  it('clears an earlier success completely before showing a subsequent failure with its real reason', async () => {
    let requests = 0;
    const app = boot(async () => ++requests === 1
      ? response(success([result()], '2026-10-15', '## 成功说明\n\n原来的金额差异。'))
      : response({ ...success([result()]), status: 'FAIL', error: '上游工具未返回有效结果，请稍后重试。' }, 502));
    await app.get('audit-form').emit('submit');
    expect(app.get('result-list').textContent).toContain('O002');
    expect(app.get('ai-answer').querySelectorAll('h2')).toHaveLength(1);
    app.get('audit-question').value = '重新核对当天订单';
    await app.get('audit-question').emit('input');
    await app.get('audit-form').emit('submit');

    expect(app.get('request-status').textContent).toContain('上游工具未返回有效结果，请稍后重试。');
    expect(app.get('request-status').textContent).not.toMatch(/PASS|FAIL|BLOCKED|HTTP/);
    expect(app.get('result-list').querySelectorAll('.audit-record')).toHaveLength(0);
    expect(app.get('result-detail').querySelectorAll('audio')).toHaveLength(0);
    expect(app.get('stats').querySelectorAll('.stat-count').map((node) => node.textContent)).toEqual(['—', '—', '—', '—', '—']);
    expect(app.get('ai-answer').querySelectorAll('h2')).toHaveLength(0);
    expect(app.get('ai-answer').textContent).not.toContain('原来的金额差异');
    expect(app.get('run-id').textContent).toBe('');
    expect(app.get('audit-submit').disabled).toBe(false);
  });

  it('renders AI Markdown headings and paragraphs without changing the original model response', async () => {
    const markdown = '# 当日前台核对\n\n普通中文说明。\n\n## 金额核对\n\n订单 ¥756.00，录音 ¥796.00。\n\n### 证据明细';
    const payload = success([], '2026-10-15', markdown);
    const app = boot(async () => response(payload));
    await app.get('audit-form').emit('submit');

    const answer = app.get('ai-answer');
    expect(answer.querySelectorAll('h1').map((node) => node.textContent)).toEqual(['当日前台核对']);
    expect(answer.querySelectorAll('h2').map((node) => node.textContent)).toEqual(['金额核对']);
    expect(answer.querySelectorAll('p').map((node) => node.textContent)).toEqual(['普通中文说明。', '订单 ¥756.00，录音 ¥796.00。']);
    expect(answer.querySelectorAll('h3').map((node) => node.textContent)).toEqual(['证据明细']);
    expect(payload.finalAnswer).toBe(markdown);
  });

  it('renders paired Markdown bold safely while preserving adjacent text and unsupported inline syntax', async () => {
    const markdown = '订单金额 **¥756.00**，录音金额 **¥796.00**。\n\n未闭合 **原样保留；`代码`、_斜体_ 和 [录音](javascript:alert(1)) 也按文字显示。';
    const app = boot(async () => response(success([], '2026-10-15', markdown)));
    await app.get('audit-form').emit('submit');

    const answer = app.get('ai-answer');
    expect(answer.querySelectorAll('strong').map((node) => node.textContent)).toEqual(['¥756.00', '¥796.00']);
    expect(answer.querySelectorAll('p').map((node) => node.textContent)).toEqual([
      '订单金额 ¥756.00，录音金额 ¥796.00。',
      '未闭合 **原样保留；`代码`、_斜体_ 和 [录音](javascript:alert(1)) 也按文字显示。',
    ]);
    expect(answer.querySelectorAll('a')).toHaveLength(0);
    expect(answer.querySelectorAll('code')).toHaveLength(0);
  });

  it('renders separate unordered and ordered AI lists and keeps an ordered list starting number', async () => {
    const markdown = '- **金额**需要确认\n- 录音原句完整\n\n3. 先核对订单\n4. 再播放证据';
    const app = boot(async () => response(success([], '2026-10-15', markdown)));
    await app.get('audit-form').emit('submit');

    const answer = app.get('ai-answer');
    const unordered = answer.querySelectorAll('ul');
    const ordered = answer.querySelectorAll('ol');
    expect(unordered).toHaveLength(1);
    expect(ordered).toHaveLength(1);
    expect(unordered[0]!.querySelectorAll('li').map((node) => node.textContent)).toEqual(['金额需要确认', '录音原句完整']);
    expect(unordered[0]!.querySelectorAll('strong').map((node) => node.textContent)).toEqual(['金额']);
    expect(ordered[0]!.querySelectorAll('li').map((node) => node.textContent)).toEqual(['先核对订单', '再播放证据']);
    expect(ordered[0]!.attributes.get('start')).toBe('3');
  });

  it('renders malicious model HTML and dangerous links as visible text without creating executable nodes', async () => {
    const snippets = [
      '<script>globalThis.markdownXss = true</script>',
      '<img src=x onerror=alert(1)>',
      '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
      '<svg onload=alert(1)>',
      '<a href="javascript:alert(1)">危险 HTML 链接</a>',
      '[危险链接](javascript:alert(1))',
      '[数据链接](data:text/html,<script>alert(1)</script>)',
      '![危险图片](https://example.invalid/tracker.png)',
    ];
    const app = boot(async () => response(success([], '2026-10-15', `# ${snippets[0]}\n\n${snippets.slice(1).join('\n\n')}`)));
    await app.get('audit-form').emit('submit');

    const answer = app.get('ai-answer');
    for (const snippet of snippets) expect(answer.textContent).toContain(snippet);
    expect(answer.querySelectorAll('h1')[0]!.textContent).toBe(snippets[0]);
    const forbiddenTags = ['SCRIPT', 'IMG', 'IFRAME', 'SVG', 'A', 'OBJECT', 'EMBED', 'LINK', 'STYLE'];
    expect(app.document.created.filter((node) => forbiddenTags.includes(node.tagName))).toEqual([]);
    expect(app.document.created.some((node) => [...node.attributes.keys()].some((name) => /^on/i.test(name)))).toBe(false);
  });

  it('preserves Chinese, both currency amounts and quoted recording words in AI paragraphs', async () => {
    const paragraphs = [
      '普通中文核对金额：订单 ¥756.00，录音 ¥796.00，差额 ¥40.00。',
      '录音原句：“您好，您的房间是三零二，房费合计七百九十六元。”',
    ];
    const payload = success([], '2026-10-15', paragraphs.join('\n\n'));
    const before = JSON.stringify(payload);
    const app = boot(async () => response(payload));
    await app.get('audit-form').emit('submit');

    expect(app.get('ai-answer').querySelectorAll('p').map((node) => node.textContent)).toEqual(paragraphs);
    expect(JSON.stringify(payload)).toBe(before);
  });

  it('limits Markdown formatting to AI text and keeps grouped recording evidence verbatim', async () => {
    const transcript = '## 房间 **大床房**，¥796.00。[片段](javascript:alert(1))';
    const fixture = result({
      evidence: [{ ...evidence, field: 'room_number', text: transcript }, { ...evidence, field: 'amount_cents', text: transcript }],
      conflicts: [{ field: 'amount_cents', order_value: 75600, recording_value: 79600, evidence: [{ ...evidence, text: transcript }] }],
    });
    const before = JSON.stringify(fixture);
    const app = boot(async () => response(success([fixture], '2026-10-15', '## 金额核对\n\n**金额差异**需要确认。')));
    await app.get('audit-form').emit('submit');

    expect(app.get('ai-answer').querySelectorAll('h2').map((node) => node.textContent)).toEqual(['金额核对']);
    expect(app.get('ai-answer').querySelectorAll('strong').map((node) => node.textContent)).toEqual(['金额差异']);
    const cards = app.get('result-detail').querySelectorAll('.evidence-card');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.querySelectorAll('.evidence-text')[0]!.textContent).toBe(transcript);
    expect(cards[0]!.querySelectorAll('.evidence-text')[0]!.querySelectorAll('*')).toHaveLength(0);
    expect(cards[0]!.querySelectorAll('.evidence-field-tag').map((node) => node.textContent)).toEqual(['房号', '金额']);
    expect(cards[0]!.querySelectorAll('.evidence-play')).toHaveLength(1);
    expect(app.get('result-detail').textContent).toContain('¥756.00');
    expect(app.get('result-detail').textContent).toContain('¥796.00');
    expect(JSON.stringify(fixture)).toBe(before);
  });

  it('renders Markdown table rows as vertical cards with every header and cell in their original order', async () => {
    const markdown = '| 订单 | 状态 | 金额 |\n| --- | --- | --- |\n| O002 | 金额不一致 | ¥756.00 / ¥796.00 |\n| O003 | 缺少录音 | ¥568.00 |';
    const app = boot(async () => response(success([], '2026-10-15', markdown)));
    await app.get('audit-form').emit('submit');

    const tables = app.get('ai-answer').querySelectorAll('.ai-table-cards');
    expect(tables).toHaveLength(1);
    const cards = tables[0]!.querySelectorAll('.ai-table-card');
    expect(cards).toHaveLength(2);
    expect(cards.map((card) => card.querySelectorAll('dt').map((node) => node.textContent))).toEqual([
      ['订单', '状态', '金额'], ['订单', '状态', '金额'],
    ]);
    expect(cards.map((card) => card.querySelectorAll('dd').map((node) => node.textContent))).toEqual([
      ['O002', '金额不一致', '¥756.00 / ¥796.00'], ['O003', '缺少录音', '¥568.00'],
    ]);
    expect(cards.every((card) => card.querySelectorAll('dl').length === 1)).toBe(true);
    expect(app.get('ai-answer').textContent).not.toContain('|');
    expect(app.get('ai-answer').textContent).not.toContain('---');
  });

  it('accepts alignment delimiters and optional table outer pipes while preserving empty cells and escaped literal pipes', async () => {
    const markdown = '字段 | 订单值 | 录音值\n:--- | :---: | ---:\n房型 | 大床\\|双床 |\n金额 | | ¥796.00';
    const app = boot(async () => response(success([], '2026-10-15', markdown)));
    await app.get('audit-form').emit('submit');

    const cards = app.get('ai-answer').querySelectorAll('.ai-table-card');
    expect(cards).toHaveLength(2);
    expect(cards.map((card) => card.querySelectorAll('dt').map((node) => node.textContent))).toEqual([
      ['字段', '订单值', '录音值'], ['字段', '订单值', '录音值'],
    ]);
    expect(cards.map((card) => card.querySelectorAll('dd').map((node) => node.textContent))).toEqual([
      ['房型', '大床|双床', ''], ['金额', '', '¥796.00'],
    ]);
    expect(app.get('ai-answer').textContent).not.toContain('\\|');
    expect(app.get('ai-answer').textContent).not.toContain(':---');
  });

  it('preserves extra table cells and keeps short rows empty instead of inventing business values', async () => {
    const markdown = '| 订单 | 录音 |\n| --- | --- |\n| O002 | R002 | 录音金额 ¥796.00 |\n| O003 |';
    const app = boot(async () => response(success([], '2026-10-15', markdown)));
    await app.get('audit-form').emit('submit');

    const cards = app.get('ai-answer').querySelectorAll('.ai-table-card');
    expect(cards).toHaveLength(2);
    expect(cards[0]!.querySelectorAll('dt').map((node) => node.textContent)).toEqual(['订单', '录音', '']);
    expect(cards[0]!.querySelectorAll('dd').map((node) => node.textContent)).toEqual(['O002', 'R002', '录音金额 ¥796.00']);
    expect(cards[1]!.querySelectorAll('dt').map((node) => node.textContent)).toEqual(['订单', '录音']);
    expect(cards[1]!.querySelectorAll('dd').map((node) => node.textContent)).toEqual(['O003', '']);
  });

  it('keeps ordinary pipe text and malformed table delimiters as plain paragraphs', async () => {
    const paragraphs = [
      '录音 R002 | 房费七百九十六元。',
      '订单 | 录音\n--- | 非分隔行\nO002 | R002',
      '| 单列 |\n| --- |\n| 保留原文 |',
      '字段 | 金额\n-- | ---\n房费 | ¥796.00',
    ];
    const app = boot(async () => response(success([], '2026-10-15', paragraphs.join('\n\n'))));
    await app.get('audit-form').emit('submit');

    expect(app.get('ai-answer').querySelectorAll('.ai-table-cards')).toHaveLength(0);
    expect(app.get('ai-answer').querySelectorAll('p').map((node) => node.textContent)).toEqual(paragraphs);
  });

  it('keeps headings, inline bold and lists working immediately before and after a table', async () => {
    const markdown = '# 当日核对\n## 差异明细\n| **字段** | 核对值 |\n| --- | --- |\n| 金额 | **¥756.00** 与 **¥796.00** |\n- 先听录音\n- 再核金额\n\n1. 保留证据\n2. 人工确认\n\n说明完整保留。';
    const app = boot(async () => response(success([], '2026-10-15', markdown)));
    await app.get('audit-form').emit('submit');

    const answer = app.get('ai-answer');
    expect(answer.querySelectorAll('h1').map((node) => node.textContent)).toEqual(['当日核对']);
    expect(answer.querySelectorAll('h2').map((node) => node.textContent)).toEqual(['差异明细']);
    expect(answer.querySelectorAll('.ai-table-card')).toHaveLength(1);
    expect(answer.querySelectorAll('strong').map((node) => node.textContent)).toEqual(['字段', '¥756.00', '¥796.00']);
    expect(answer.querySelectorAll('ul')[0]!.querySelectorAll('li').map((node) => node.textContent)).toEqual(['先听录音', '再核金额']);
    expect(answer.querySelectorAll('ol')[0]!.querySelectorAll('li').map((node) => node.textContent)).toEqual(['保留证据', '人工确认']);
    expect(answer.querySelectorAll('p').map((node) => node.textContent)).toEqual(['说明完整保留。']);
  });

  it('renders malicious HTML and dangerous links inside table headers and cells only as safe text', async () => {
    const header = '<img src=x onerror=alert(1)>';
    const snippets = [
      '<script>globalThis.tableXss = true</script>',
      '<svg onload=alert(1)>',
      '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
      '<a href="javascript:alert(1)">危险 HTML 链接</a>',
      '[危险链接](javascript:alert(1))',
      '![图片](data:image/svg+xml,<svg onload=alert(1)>)',
    ];
    const markdown = `| ${header} | 证据 |\n| --- | --- |\n${snippets.map((snippet, index) => `| ${index + 1} | **${snippet}** |`).join('\n')}`;
    const app = boot(async () => response(success([], '2026-10-15', markdown)));
    await app.get('audit-form').emit('submit');

    const answer = app.get('ai-answer');
    expect(answer.querySelectorAll('.ai-table-card')).toHaveLength(snippets.length);
    expect(answer.querySelectorAll('dt').filter((node) => node.textContent === header)).toHaveLength(snippets.length);
    expect(answer.querySelectorAll('strong').map((node) => node.textContent)).toEqual(snippets);
    for (const snippet of [header, ...snippets]) expect(answer.textContent).toContain(snippet);
    const forbiddenTags = ['SCRIPT', 'IMG', 'SVG', 'IFRAME', 'A', 'OBJECT', 'EMBED', 'LINK', 'STYLE'];
    expect(app.document.created.filter((node) => forbiddenTags.includes(node.tagName))).toEqual([]);
    expect(app.document.created.some((node) => [...node.attributes.keys()].some((name) => /^on/i.test(name)))).toBe(false);
  });

  it('keeps separate Markdown tables and the intervening explanation in source order', async () => {
    const markdown = '| 日期 | 结果 |\n| --- | --- |\n| 2026-10-15 | 七组 |\n\n后续日期：\n\n| 订单 | 录音 |\n| --- | --- |\n| O008 | R008 |';
    const app = boot(async () => response(success([], '2026-10-15', markdown)));
    await app.get('audit-form').emit('submit');

    const answer = app.get('ai-answer');
    expect(answer.querySelectorAll('.ai-table-cards')).toHaveLength(2);
    expect(answer.children.map((node) => node.className === 'ai-table-cards' ? 'table' : node.tagName)).toEqual(['table', 'P', 'table']);
    expect(answer.querySelectorAll('dd').map((node) => node.textContent)).toEqual(['2026-10-15', '七组', 'O008', 'R008']);
    expect(answer.querySelectorAll('p').map((node) => node.textContent)).toEqual(['后续日期：']);
  });

  it('does not mutate the model table or apply table formatting to transcript evidence and playback', async () => {
    const transcript = '| 房号 | 金额 |\n| --- | --- |\n| 三零二 | 七百九十六元 |';
    const references = ['room_number', 'amount_cents'].map((field) => ({ ...evidence, field, text: transcript }));
    const fixture = result({ evidence: references, conflicts: [] });
    const payload = success([fixture], '2026-10-15', '| 订单金额 | 录音金额 |\n| --- | --- |\n| ¥756.00 | ¥796.00 |');
    const before = JSON.stringify(payload);
    const app = boot(async () => response(payload));
    await app.get('audit-form').emit('submit');

    expect(app.get('ai-answer').querySelectorAll('.ai-table-card')).toHaveLength(1);
    const cards = app.get('result-detail').querySelectorAll('.evidence-card');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.querySelectorAll('.evidence-text')[0]!.textContent).toBe(transcript);
    expect(cards[0]!.querySelectorAll('.ai-table-cards')).toHaveLength(0);
    expect(cards[0]!.querySelectorAll('.evidence-field-tag').map((node) => node.textContent)).toEqual(['房号', '金额']);
    const buttons = cards[0]!.querySelectorAll('.evidence-play');
    expect(buttons).toHaveLength(1);
    const audio = app.get('result-detail').querySelectorAll('audio')[0]!;
    audio.readyState = 1;
    await buttons[0]!.emit('click');
    expect(audio.currentTime).toBe(0.1);
    expect(audio.playCount).toBe(1);
    expect(JSON.stringify(payload)).toBe(before);
  });

  it.each(['', ' \n\t '])('keeps a clear fallback for an empty AI explanation (%j)', async (finalAnswer) => {
    const app = boot(async () => response(success([result()], '2026-10-15', finalAnswer)));
    await app.get('audit-form').emit('submit');

    expect(app.get('ai-answer').textContent).toBe('本次未返回 AI 自然语言说明。结构化结果仍是业务依据。');
    expect(app.get('ai-answer').querySelectorAll('h1')).toHaveLength(0);
    expect(app.get('result-detail').textContent).toContain('¥756.00');
    expect(app.get('result-detail').textContent).toContain('¥796.00');
  });

  it('clears previous Markdown nodes on changed input and renders only the newer explanation', async () => {
    let requests = 0;
    const app = boot(async () => response(success([], '2026-10-15', ++requests === 1 ? '# 旧结果\n\n**过时金额**' : '## 新结果\n\n最新中文 ¥796.00。')));
    await app.get('audit-form').emit('submit');
    expect(app.get('ai-answer').querySelectorAll('h1')).toHaveLength(1);
    expect(app.get('ai-answer').querySelectorAll('strong')).toHaveLength(1);

    app.get('audit-question').value = '请重新检查金额';
    await app.get('audit-question').emit('input');
    expect(app.get('ai-answer').querySelectorAll('h1')).toHaveLength(0);
    expect(app.get('ai-answer').querySelectorAll('strong')).toHaveLength(0);
    expect(app.get('ai-answer').textContent).not.toContain('旧结果');

    await app.get('audit-form').emit('submit');
    expect(app.get('ai-answer').querySelectorAll('h2').map((node) => node.textContent)).toEqual(['新结果']);
    expect(app.get('ai-answer').querySelectorAll('p').map((node) => node.textContent)).toEqual(['最新中文 ¥796.00。']);
    expect(app.get('ai-answer').textContent).not.toContain('过时金额');
  });

  it('renders one transcript and playback button for a shared segment while retaining every field label', async () => {
    const fieldNames = ['room_number', 'room_type', 'check_in_date', 'check_out_date', 'amount_cents'];
    const references = fieldNames.map((field) => ({ ...evidence, field }));
    const fixture = result({ evidence: references });
    const before = JSON.stringify(fixture);
    const app = boot(async () => response(success([fixture])));
    await app.get('audit-form').emit('submit');

    const cards = app.get('result-detail').querySelectorAll('.evidence-card');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.querySelectorAll('.evidence-text').map((quote) => quote.textContent)).toEqual([evidence.text]);
    expect(cards[0]!.querySelectorAll('.evidence-field-tag').map((tag) => tag.textContent)).toEqual(['房号', '房型', '入住日期', '退房日期', '金额']);
    expect(cards[0]!.querySelectorAll('.evidence-play')).toHaveLength(1);
    expect(cards[0]!.querySelectorAll('.evidence-time').map((time) => time.textContent)).toEqual(['00:00.100 – 00:12.525']);
    expect(JSON.stringify(fixture)).toBe(before);
  });

  it.each([
    { property: 'recording_id', value: 'R003' },
    { property: 'segment_index', value: 1 },
    { property: 'start_ms', value: 200 },
    { property: 'end_ms', value: 12526 },
    { property: 'text', value: '另一个实际转写片段。' },
  ])('does not merge evidence when $property differs, even if the other segment attributes agree', async ({ property, value }) => {
    const otherSegment = { ...evidence, [property]: value };
    const app = boot(async () => response(success([result({
      recording_id: null,
      candidate_recording_ids: property === 'recording_id' ? ['R002', 'R003'] : ['R002'],
      conflicts: [],
      evidence: [
        { ...evidence, field: 'room_number' },
        { ...evidence, field: 'amount_cents' },
        { ...otherSegment, field: 'room_type' },
        { ...otherSegment, field: 'check_in_date' },
      ],
    })])));
    await app.get('audit-form').emit('submit');

    const cards = app.get('result-detail').querySelectorAll('.evidence-card');
    expect(cards).toHaveLength(2);
    expect(cards.map((card) => card.querySelectorAll('.evidence-field-tag').map((tag) => tag.textContent))).toEqual([
      ['房号', '金额'], ['房型', '入住日期'],
    ]);
    expect(app.get('result-detail').querySelectorAll('.evidence-play')).toHaveLength(2);
    if (property === 'recording_id') {
      expect(app.get('result-detail').querySelectorAll('.recording-block').map((block) => block.querySelectorAll('.recording-heading')[0]!.textContent)).toEqual(['录音 R002', '录音 R003']);
    }
  });

  it('retains conflict-only evidence, both its own field and the conflict field, and unchanged amount values', async () => {
    const { field: _omitted, ...unlabelledReference } = evidence;
    const fixture = result({
      evidence: [],
      conflicts: [{
        field: 'amount_cents', order_value: 75600, recording_value: 79600,
        evidence: [{ ...evidence, field: 'room_number' }, unlabelledReference],
      }],
    });
    const before = JSON.stringify(fixture);
    const app = boot(async () => response(success([fixture])));
    await app.get('audit-form').emit('submit');

    const cards = app.get('result-detail').querySelectorAll('.evidence-card');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.querySelectorAll('.evidence-text')[0]!.textContent).toBe(evidence.text);
    expect(cards[0]!.querySelectorAll('.evidence-field-tag').map((tag) => tag.textContent).sort()).toEqual(['房号', '金额']);
    const table = app.get('result-detail').querySelectorAll('.conflict-table')[0]!;
    expect(table.textContent).toContain('¥756.00');
    expect(table.textContent).toContain('¥796.00');
    expect(JSON.stringify(fixture)).toBe(before);
  });

  it('deduplicates repeated field labels and uses a neutral label for evidence with no business field', async () => {
    const fixture = result({
      conflicts: [],
      evidence: [
        { ...evidence, field: 'room_number' },
        { ...evidence, field: 'room_number' },
        { ...evidence, field: null },
        { ...evidence, field: null, segment_index: 1, start_ms: 13000, end_ms: 14000, text: '请您稍等。' },
      ],
    });
    const before = JSON.stringify(fixture);
    const app = boot(async () => response(success([fixture])));
    await app.get('audit-form').emit('submit');

    const cards = app.get('result-detail').querySelectorAll('.evidence-card');
    expect(cards).toHaveLength(2);
    expect(cards[0]!.querySelectorAll('.evidence-field-tag').map((tag) => tag.textContent)).toEqual(['房号']);
    expect(cards[1]!.querySelectorAll('.evidence-field-tag').map((tag) => tag.textContent)).toEqual(['转写原句']);
    expect(cards[1]!.querySelectorAll('.evidence-text')[0]!.textContent).toBe('请您稍等。');
    expect(JSON.stringify(fixture)).toBe(before);
  });

  it('groups each candidate recording separately and plays each unique segment at its real start', async () => {
    const candidates = [
      { ...evidence, recording_id: 'R006', start_ms: 1100, end_ms: 8100 },
      { ...evidence, recording_id: 'R007', start_ms: 2250, end_ms: 9250 },
    ];
    const app = boot(async () => response(success([result({
      status: 'needs_review', order_id: 'O007', recording_id: null,
      candidate_order_ids: ['O007'], candidate_recording_ids: ['R006', 'R007'],
      conflicting_fields: [], conflicts: [],
      evidence: candidates.flatMap((reference) => [{ ...reference, field: 'room_number' }, { ...reference, field: 'room_type' }]),
    })])));
    await app.get('audit-form').emit('submit');

    const blocks = app.get('result-detail').querySelectorAll('.recording-block');
    expect(blocks).toHaveLength(2);
    for (const [index, block] of blocks.entries()) {
      expect(block.querySelectorAll('.evidence-card')).toHaveLength(1);
      expect(block.querySelectorAll('.evidence-field-tag').map((tag) => tag.textContent)).toEqual(['房号', '房型']);
      const audio = block.querySelectorAll('audio')[0]!;
      const buttons = block.querySelectorAll('.evidence-play');
      expect(buttons).toHaveLength(1);
      expect(audio.src).toBe(`/audio/${candidates[index]!.recording_id}.mp3`);
      audio.readyState = 1;
      await buttons[0]!.emit('click');
      expect(audio.currentTime).toBe(candidates[index]!.start_ms / 1000);
      expect(audio.playCount).toBe(1);
    }
    expect(blocks[0]!.querySelectorAll('audio')[0]!.paused).toBe(true);
  });

  it('keeps evidence grouping local to each audit result', async () => {
    const shared = [{ ...evidence, field: 'room_number' }, { ...evidence, field: 'amount_cents' }];
    const app = boot(async () => response(success([
      result({ order_id: 'O002', evidence: shared, conflicts: [] }),
      result({ order_id: 'O009', evidence: shared, conflicts: [] }),
    ])));
    await app.get('audit-form').emit('submit');

    const records = app.get('result-list').querySelectorAll('.audit-record');
    expect(records).toHaveLength(2);
    for (const record of records) {
      await record.emit('click');
      const detail = app.get('result-detail');
      expect(detail.querySelectorAll('.evidence-card')).toHaveLength(1);
      expect(detail.querySelectorAll('.evidence-text')[0]!.textContent).toBe(evidence.text);
      expect(detail.querySelectorAll('.evidence-field-tag').map((tag) => tag.textContent)).toEqual(['房号', '金额']);
      expect(detail.querySelectorAll('.evidence-play')).toHaveLength(1);
    }
  });

  it('degrades without inventing transcript evidence when the recording is missing', async () => {
    const app = boot(async () => response(success([result({
      status: 'missing_recording', order_id: 'O003', recording_id: null,
      candidate_order_ids: ['O003'], candidate_recording_ids: [],
      conflicting_fields: [], conflicts: [], evidence: [], reasons: ['未找到合理录音候选。'],
    })])));
    await app.get('audit-form').emit('submit');

    expect(app.get('result-list').textContent).toContain('缺少录音');
    expect(app.get('result-detail').textContent).toContain('无可播放录音');
    for (const selector of ['audio', '.evidence-card', '.evidence-text', '.evidence-field-tag', '.evidence-play']) {
      expect(app.get('result-detail').querySelectorAll(selector)).toHaveLength(0);
    }
  });

  it('waits for metadata, seeks to the sentence start and pauses at its end', async () => {
    const { ui } = boot();
    const audio = new Element('AUDIO');
    const warnings: string[] = [];
    ui.playEvidenceSegment(audio, evidence, (message) => warnings.push(message));
    expect(audio.playCount).toBe(0);
    expect(audio.currentTime).toBe(0);
    audio.readyState = 1;
    await audio.emit('loadedmetadata');
    expect(audio.currentTime).toBe(0.1);
    expect(audio.playCount).toBe(1);
    audio.currentTime = 12.525;
    await audio.emit('timeupdate');
    expect(audio.paused).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('plays the evidence on its own candidate recording and cancels pending playback when inputs change', async () => {
    const candidateEvidence = [
      { ...evidence, recording_id: 'R006', start_ms: 100, end_ms: 8000 },
      { ...evidence, recording_id: 'R007', start_ms: 250, end_ms: 9000 },
    ];
    const app = boot(async () => response(success([result({ status: 'needs_review', recording_id: null, candidate_recording_ids: ['R006', 'R007'], evidence: candidateEvidence, conflicts: [] })])));
    await app.get('audit-form').emit('submit');
    const players = app.get('result-detail').querySelectorAll('audio');
    const buttons = app.get('result-detail').querySelectorAll('.evidence-play');
    players[1]!.readyState = 1;
    await buttons[1]!.emit('click');
    expect(players[1]!.src).toBe('/audio/R007.mp3');
    expect(players[1]!.currentTime).toBe(0.25);
    expect(players[1]!.playCount).toBe(1);
    expect(players[0]!.playCount).toBe(0);
    await buttons[0]!.emit('click');
    app.get('audit-question').value = '修改查询';
    await app.get('audit-question').emit('input');
    players[0]!.readyState = 1;
    await players[0]!.emit('loadedmetadata');
    expect(players[0]!.playCount).toBe(0);
    expect(players[1]!.paused).toBe(true);
    expect(app.get('result-detail').querySelectorAll('audio')).toHaveLength(0);
  });

  it('shows an audio warning and never builds unsafe player paths', async () => {
    const app = boot(async () => response(success([result({ candidate_recording_ids: ['R002', '../secret'], recording_id: null })])));
    await app.get('audit-form').emit('submit');
    const players = app.get('result-detail').querySelectorAll('audio');
    expect(players).toHaveLength(1);
    await players[0]!.emit('error');
    expect(app.get('result-detail').textContent).toContain('加载失败');
    expect(app.get('result-detail').textContent).toContain('编号不合法');
    expect(app.get('result-detail').querySelectorAll('.audio-warning').some((warning) => !warning.hidden)).toBe(true);
  });

  it('deduplicates submission and rejects an older response after the input changes', async () => {
    const first = deferred<ReturnType<typeof response>>();
    const second = deferred<ReturnType<typeof response>>();
    let auditCount = 0;
    const app = boot(async () => (++auditCount === 1 ? first.promise : second.promise));
    const oldRequest = app.get('audit-form').emit('submit');
    const duplicate = app.get('audit-form').emit('submit');
    expect(auditCount).toBe(1);
    expect(app.get('audit-submit').disabled).toBe(true);
    app.get('audit-question').value = '当天有哪些异常？';
    await app.get('audit-question').emit('input');
    expect(app.get('stale-notice').hidden).toBe(false);
    const newRequest = app.get('audit-form').emit('submit');
    expect(auditCount).toBe(2);
    second.resolve(response(success([], '2026-10-15', '较新查询')));
    await newRequest;
    first.resolve(response(success([], '2026-10-15', '过时查询')));
    await Promise.all([oldRequest, duplicate]);
    expect(app.get('ai-answer').textContent).toBe('较新查询');
    expect(app.get('audit-submit').disabled).toBe(false);
  });

  it('re-requests once on a changed date, clears stale results and rejects an empty date', async () => {
    const app = boot(async (_url, options) => response(success([], (JSON.parse(String(options?.body)) as { date: string }).date)));
    await app.get('audit-form').emit('submit');
    expect(app.get('result-list').textContent).toContain('没有');
    app.get('audit-date').value = '2026-10-16';
    await app.get('audit-date').emit('input');
    expect(app.get('stale-notice').hidden).toBe(false);
    await app.get('audit-date').emit('change');
    await app.get('audit-date').emit('change');
    const audits = app.calls.filter((call) => call.url === '/api/audit');
    expect(audits).toHaveLength(2);
    expect(JSON.parse(String(audits[1]!.options?.body))).toMatchObject({ date: '2026-10-16' });
    app.get('audit-date').value = '';
    await app.get('audit-date').emit('change');
    expect(app.calls.filter((call) => call.url === '/api/audit')).toHaveLength(2);
    expect(app.get('request-status').textContent).toContain('日期');
  });

  it.each([
    { status: 503, payload: { ...success([result()]), status: 'BLOCKED', error: '缺少服务端 API Key' }, expected: '缺少服务端 API Key' },
    { status: 502, payload: { ...success([result()]), status: 'FAIL', error: '上游工具失败' }, expected: '上游工具失败' },
    { status: 400, payload: { ...success([result()]), status: 'FAIL', error: '日期冲突，请统一日期' }, expected: '日期冲突' },
    { status: 500, payload: success([result()]), expected: '核对失败' },
  ])('does not render success data for HTTP $status', async ({ status, payload, expected }) => {
    const app = boot(async () => response(payload, status));
    await app.get('audit-form').emit('submit');
    expect(app.get('request-status').textContent).toContain(expected);
    expect(app.get('request-status').textContent).not.toMatch(/PASS|FAIL|BLOCKED|HTTP|SDK/);
    expect(app.get('result-list').textContent).not.toContain('O002');
    expect(app.get('audit-submit').disabled).toBe(false);
  });

  it('makes network failures and returned data warnings visible', async () => {
    const failing = boot(async () => { throw new Error('离线连接中断'); });
    await failing.get('audit-form').emit('submit');
    expect(failing.get('request-status').textContent).toContain('网络');
    expect(failing.get('request-status').textContent).toContain('离线连接中断');
    const warning = { code: 'audio_missing', recording_id: 'R099', message: '演示音频文件缺失' };
    const app = boot(async () => response({ ...success(), warnings: [warning] }));
    await app.get('audit-form').emit('submit');
    expect(app.get('warnings').hidden).toBe(false);
    expect(app.get('warnings').textContent).toContain('R099');
    expect(app.get('warnings').textContent).toContain(warning.message);
  });

  it('accepts the API question limit of 1000 characters and rejects blank or longer text before requesting', async () => {
    const app = boot();
    app.get('audit-question').value = '核'.repeat(1000);
    await app.get('audit-form').emit('submit');
    expect(app.calls.filter((call) => call.url === '/api/audit')).toHaveLength(1);
    for (const question of ['   ', '核'.repeat(1001)]) {
      const invalid = boot();
      invalid.get('audit-question').value = question;
      await invalid.get('audit-form').emit('submit');
      expect(invalid.calls.filter((call) => call.url === '/api/audit')).toHaveLength(0);
      expect(invalid.get('request-status').textContent).toContain('1000');
    }
    const html = readFileSync(fileURLToPath(new URL('../../public/index.html', import.meta.url)), 'utf8');
    expect(html).toContain('maxlength="1000"');
  });

  it('ships the specified business identity, default inputs and safe external assets policy', () => {
    const htmlPath = fileURLToPath(new URL('../../public/index.html', import.meta.url));
    expect(existsSync(htmlPath)).toBe(true);
    const html = readFileSync(htmlPath, 'utf8');
    for (const text of ['Hotel Front Desk Audit', '2026-10-15', '帮我核对当天前台订单和接待录音，列出异常并给出证据。', 'AI核对报告']) expect(html).toContain(text);
    expect(html).not.toMatch(/https?:\/\/[^\s"']+\.(?:js|css)/);
  });
});
