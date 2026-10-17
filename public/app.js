/* Native browser UI. Business facts are rendered only from this request's HTTP response. */
(function () {
  'use strict';

  const statuses = {
    matched: { label: '匹配', tone: 'green' },
    field_mismatch: { label: '字段不一致', tone: 'red' },
    missing_recording: { label: '缺少录音', tone: 'amber' },
    orphan_recording: { label: '录音无对应订单', tone: 'blue' },
    needs_review: { label: '待确认', tone: 'purple' },
  };
  const fields = {
    order_id: '订单编号', handled_at: '办理时间', room_number: '房号', room_type: '房型',
    check_in_date: '入住日期', check_out_date: '退房日期', amount_cents: '金额', currency: '币种',
  };
  const playbackStates = new WeakMap();
  const list = (value) => Array.isArray(value) ? value : [];
  const text = (value) => value === null || value === undefined ? '—' : String(value);
  const uniqueIds = (...values) => [...new Set(values.flatMap(list).filter((id) => typeof id === 'string' && id.length > 0))];

  function formatMoney(cents) {
    return typeof cents === 'number' && Number.isFinite(cents) ? `¥${(cents / 100).toFixed(2)}` : '—';
  }

  function formatTime(milliseconds) {
    if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds) || milliseconds < 0) return '时间未知';
    const value = Math.floor(milliseconds);
    const minutes = Math.floor(value / 60000).toString().padStart(2, '0');
    const seconds = Math.floor(value / 1000 % 60).toString().padStart(2, '0');
    return `${minutes}:${seconds}.${(value % 1000).toString().padStart(3, '0')}`;
  }

  function audioSource(id) {
    return typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id) ? `/audio/${id}.mp3` : null;
  }

  function cancelAudio(audio) {
    const state = playbackStates.get(audio);
    if (state) {
      if (state.pending) audio.removeEventListener('loadedmetadata', state.pending);
      state.pending = null;
      state.end = null;
    }
    audio.pause();
  }

  function playEvidenceSegment(audio, evidence, warn) {
    if (!Number.isFinite(evidence.start_ms) || !Number.isFinite(evidence.end_ms)
      || evidence.start_ms < 0 || evidence.end_ms <= evidence.start_ms) {
      warn('此证据的时间范围无效，无法定位播放。');
      return;
    }
    let state = playbackStates.get(audio);
    if (!state) {
      state = { end: null, pending: null };
      playbackStates.set(audio, state);
      audio.addEventListener('timeupdate', () => {
        if (state.end !== null && audio.currentTime >= state.end) {
          audio.pause();
          state.end = null;
        }
      });
    }
    if (state.pending) audio.removeEventListener('loadedmetadata', state.pending);
    const start = () => {
      state.pending = null;
      state.end = evidence.end_ms / 1000;
      try {
        audio.currentTime = evidence.start_ms / 1000;
        const playing = audio.play();
        if (playing && typeof playing.catch === 'function') playing.catch(() => warn('录音播放未能启动，请使用播放器重试。'));
      } catch {
        warn('录音无法定位或播放，请检查本地音频是否可用。');
      }
    };
    if (audio.readyState >= 1) start();
    else {
      state.pending = start;
      audio.addEventListener('loadedmetadata', start, { once: true });
      audio.load();
    }
  }

  function createAuditApp(document, fetchRequest) {
    const get = (id) => document.getElementById(id);
    const form = get('audit-form');
    const date = get('audit-date');
    const question = get('audit-question');
    const submit = get('audit-submit');
    const resultList = get('result-list');
    const resultDetail = get('result-detail');
    const state = { sequence: 0, active: null, hasQueried: false, observedKey: '', observedDate: date.value, results: [], selectedIndex: -1 };
    const inputKey = () => JSON.stringify([date.value, question.value.trim()]);
    state.observedKey = inputKey();

    function element(tag, value, className) {
      const output = document.createElement(tag);
      if (value !== undefined) output.textContent = text(value);
      if (className) output.className = className;
      return output;
    }

    // A deliberately small Markdown subset: model text never becomes HTML or URLs.
    function renderAiAnswer(value) {
      const container = get('ai-answer');
      container.replaceChildren();
      const technicalNotes = new Set([
        '业务判断以结构化工具结果为依据。候选关系保留待确认状态，不据此推定已匹配。',
        '以上结论均来自 audit_day 结构化结果，未作额外推断。',
        '窗口时间与转写时间均为整句范围（非词级精确时间）。',
      ].map((note) => note.replace(/\s+/g, '')));
      function isTechnicalNote(content) {
        const plain = content.trim().replace(/^\*\*([\s\S]*)\*\*$/, '$1');
        return technicalNotes.has(plain.replace(/\s+/g, ''))
          || /^(?:Run ID|runId)\s*[·:：]\s*[A-Za-z0-9][A-Za-z0-9._:-]*$/i.test(plain);
      }
      function inline(parent, content) {
        const bold = /\*\*([^*]+)\*\*/g;
        let offset = 0;
        for (const match of content.matchAll(bold)) {
          if (match.index > offset) parent.append(element('span', content.slice(offset, match.index)));
          parent.append(element('strong', match[1]));
          offset = match.index + match[0].length;
        }
        if (offset < content.length) parent.append(element('span', content.slice(offset)));
      }
      let paragraph = [];
      let quotation = [];
      let currentList = null;
      let listKind = null;
      function flushParagraph() {
        if (!paragraph.length) return;
        const content = paragraph.join('\n');
        if (!isTechnicalNote(content)) {
          const node = element('p');
          inline(node, content);
          container.append(node);
        }
        paragraph = [];
      }
      function flushQuotation() {
        if (!quotation.length) return;
        const node = element('blockquote');
        inline(node, quotation.join('\n'));
        container.append(node);
        quotation = [];
      }
      function tableCells(line) {
        const source = line.trim();
        const cells = [];
        let cell = '';
        let slashes = 0;
        let trailingSeparator = false;
        for (const character of source) {
          if (character === '|' && slashes % 2 === 0) {
            cells.push(cell.trim());
            cell = '';
            trailingSeparator = true;
          } else {
            if (character === '|' && slashes % 2 === 1) cell = cell.slice(0, -1);
            cell += character;
            trailingSeparator = false;
          }
          slashes = character === '\\' ? slashes + 1 : 0;
        }
        if (!cells.length) return null;
        cells.push(cell.trim());
        if (source.startsWith('|')) cells.shift();
        if (trailingSeparator) cells.pop();
        return cells;
      }
      const lines = value.split(/\r\n|\n|\r/);
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const headers = tableCells(line);
        const separator = tableCells(lines[index + 1] ?? '');
        if (headers && headers.length >= 2 && separator && separator.length === headers.length
          && separator.every((cell) => /^:?-{3,}:?$/.test(cell))) {
          flushParagraph();
          flushQuotation();
          currentList = null;
          listKind = null;
          const cards = element('div', undefined, 'ai-table-cards');
          cards.setAttribute('role', 'list');
          cards.setAttribute('aria-label', '表格内容，按行展示');
          let next = index + 2;
          while (next < lines.length) {
            const cells = tableCells(lines[next]);
            if (!cells) break;
            const card = element('div', undefined, 'ai-table-card');
            card.setAttribute('role', 'listitem');
            const details = element('dl');
            for (let column = 0; column < Math.max(headers.length, cells.length); column++) {
              const label = element('dt');
              const content = element('dd');
              inline(label, headers[column] ?? '');
              inline(content, cells[column] ?? '');
              details.append(label, content);
            }
            card.append(details);
            cards.append(card);
            next++;
          }
          if (next === index + 2) {
            // An empty table still exposes its headings without inventing a data row.
            for (const header of headers) {
              const label = element('p');
              inline(label, header);
              cards.append(label);
            }
          }
          container.append(cards);
          index = next - 1;
          continue;
        }
        const heading = /^ {0,3}(#{1,3})[ \t]+(.+)$/.exec(line);
        const unordered = /^ {0,3}[-+*][ \t]+(.+)$/.exec(line);
        const ordered = /^ {0,3}(\d{1,9})[.)][ \t]+(.+)$/.exec(line);
        const quote = /^ {0,3}>[ \t]?(.*)$/.exec(line);
        if (!quote) flushQuotation();
        if (!line.trim()) {
          flushParagraph();
          currentList = null;
          listKind = null;
        } else if (heading) {
          flushParagraph();
          currentList = null;
          listKind = null;
          const node = element(`h${heading[1].length}`);
          inline(node, heading[2]);
          container.append(node);
        } else if (quote) {
          flushParagraph();
          currentList = null;
          listKind = null;
          quotation.push(quote[1]);
        } else if (unordered || ordered) {
          flushParagraph();
          if (isTechnicalNote(ordered ? ordered[2] : unordered[1])) continue;
          const kind = ordered ? 'ol' : 'ul';
          if (!currentList || listKind !== kind) {
            currentList = element(kind);
            if (ordered) currentList.setAttribute('start', ordered[1]);
            listKind = kind;
            container.append(currentList);
          }
          const node = element('li');
          // Preserve explicit numbers even when a model's ordered list skips a number.
          if (ordered) node.setAttribute('value', ordered[1]);
          inline(node, ordered ? ordered[2] : unordered[1]);
          currentList.append(node);
        } else {
          currentList = null;
          listKind = null;
          paragraph.push(line);
        }
      }
      flushParagraph();
      flushQuotation();
    }

    function stopPlayers(except) {
      for (const audio of resultDetail.querySelectorAll('audio')) if (audio !== except) cancelAudio(audio);
    }

    function selectTab(name, focus) {
      if (name === 'report') stopPlayers();
      for (const tabName of ['workspace', 'report']) {
        const selected = name === tabName;
        get(`${tabName}-tab`).setAttribute('aria-selected', String(selected));
        get(`${tabName}-tab`).setAttribute('tabindex', selected ? '0' : '-1');
        get(`${tabName}-panel`).hidden = !selected;
      }
      if (focus) get(`${name}-tab`).focus();
    }

    function busy(value) {
      submit.disabled = value;
      submit.textContent = value ? '正在核对…' : '开始核对';
      form.setAttribute('aria-busy', String(value));
    }

    function showStatus(kind, message) {
      const status = get('request-status');
      status.className = `request-status ${kind}`;
      status.dataset.status = kind;
      status.textContent = message;
    }

    function renderStats(results) {
      const container = get('stats');
      container.replaceChildren();
      for (const [key, config] of Object.entries(statuses)) {
        const card = element('div', undefined, `stat-card ${config.tone}`);
        const count = results ? results.filter((result) => result.status === key).length : '—';
        card.append(element('span', config.label, 'stat-label'), element('strong', count, 'stat-count'));
        container.append(card);
      }
    }

    function clearPresentation(message) {
      stopPlayers();
      state.results = [];
      state.selectedIndex = -1;
      selectTab('workspace');
      resultList.replaceChildren(element('p', message, 'list-empty'));
      const empty = element('div', undefined, 'detail-empty');
      empty.append(element('h3', '请选择一条核对记录'), element('p', '核对完成后，在左侧选择记录查看差异、判断理由与录音证据。'));
      resultDetail.replaceChildren(empty);
      renderStats(null);
      get('ai-answer').textContent = '完成核对后，这里将显示 AI 核对说明。';
      get('result-summary').textContent = '等待查询';
      get('run-id').textContent = '';
      get('warnings').replaceChildren();
      get('warnings').hidden = true;
    }

    function renderWarnings(warnings) {
      const container = get('warnings');
      container.replaceChildren();
      container.hidden = warnings.length === 0;
      if (!warnings.length) return;
      container.append(element('h3', '数据警告'));
      const items = element('ul');
      for (const warning of warnings) items.append(element('li', `${warning.recording_id ? `${warning.recording_id} · ` : ''}${text(warning.message ?? warning)}`));
      container.append(items);
    }

    function factsRow(label, values, emptyMessage) {
      const row = element('div', undefined, 'fact-row');
      row.append(element('dt', label));
      const value = element('dd');
      if (values.length) {
        for (const id of values) value.append(element('span', id, 'id-chip'));
      } else value.append(element('span', emptyMessage, 'muted'));
      row.append(value);
      return row;
    }

    function evidenceFor(result) {
      const groups = [];
      const identity = ['recording_id', 'segment_index', 'start_ms', 'end_ms', 'text'];
      // Group only this result's view; field-specific source references stay intact.
      function add(evidence, conflictField) {
        let group = groups.find((item) => identity.every((key) => item[key] === evidence[key]));
        if (!group) {
          group = { ...evidence, fields: [] };
          groups.push(group);
        }
        for (const field of [evidence.field, conflictField]) {
          if (field !== null && field !== undefined && !group.fields.includes(field)) group.fields.push(field);
        }
      }
      for (const evidence of list(result.evidence)) add(evidence);
      for (const conflict of list(result.conflicts)) {
        for (const evidence of list(conflict.evidence)) add(evidence, conflict.field);
      }
      return groups;
    }

    function renderRecording(id, evidence) {
      const block = element('section', undefined, 'recording-block');
      block.append(element('h5', `录音 ${id}`, 'recording-heading'));
      const warning = element('p', '', 'audio-warning');
      warning.hidden = true;
      const warn = (message) => { warning.textContent = message; warning.hidden = false; };
      const source = audioSource(id);
      let audio = null;
      const buttons = [];
      if (source) {
        audio = element('audio');
        audio.controls = true;
        audio.preload = 'metadata';
        audio.src = source;
        audio.setAttribute('aria-label', `播放录音 ${id}`);
        audio.addEventListener('play', () => stopPlayers(audio));
        audio.addEventListener('error', () => {
          cancelAudio(audio);
          warn(`录音 ${id} 加载失败或文件缺失，请检查本地音频。`);
          for (const button of buttons) button.disabled = true;
        });
        block.append(audio);
      } else warn('录音编号不合法，无可播放录音。');
      block.append(warning);
      if (!evidence.length) block.append(element('p', '此录音没有可展示的转写证据。', 'muted'));
      for (const item of evidence) {
        const card = element('div', undefined, 'evidence-card');
        const labels = element('div', undefined, 'evidence-meta');
        labels.setAttribute('aria-label', '关联业务字段');
        for (const field of item.fields) labels.append(element('span', fields[field] ?? field, 'evidence-field-tag'));
        if (!item.fields.length) labels.append(element('span', '转写原句', 'evidence-field-tag'));
        card.append(labels);
        card.append(element('blockquote', item.text, 'evidence-text'));
        card.append(element('div', `${formatTime(item.start_ms)} – ${formatTime(item.end_ms)}`, 'evidence-time'));
        const button = element('button', '▷ 播放证据', 'evidence-play');
        button.type = 'button';
        button.disabled = !audio;
        button.addEventListener('click', () => {
          if (!audio) return;
          stopPlayers(audio);
          playEvidenceSegment(audio, item, warn);
        });
        buttons.push(button);
        card.append(button);
        block.append(card);
      }
      return block;
    }

    function amountDifference(conflict) {
      if (conflict.field !== 'amount_cents' || !Number.isSafeInteger(conflict.order_value)
        || !Number.isSafeInteger(conflict.recording_value)) return null;
      const difference = Math.abs(conflict.recording_value - conflict.order_value);
      return Number.isSafeInteger(difference) ? difference : null;
    }

    function resultContext(result) {
      const config = statuses[result.status] ?? { label: text(result.status), tone: 'amber' };
      const orderIds = uniqueIds(result.candidate_order_ids, result.order_id ? [result.order_id] : []);
      const evidence = evidenceFor(result);
      const recordingIds = uniqueIds(result.candidate_recording_ids, result.recording_id ? [result.recording_id] : [], evidence.map((item) => item.recording_id));
      const conflictNames = list(result.conflicting_fields).map((field) => fields[field] ?? field);
      const uncertain = result.status === 'needs_review';
      const orderLabel = orderIds.length ? `${uncertain ? '候选订单' : '订单'} ${orderIds.join('、')}` : '未找到对应订单';
      const recordingLabel = recordingIds.length ? `${uncertain ? '候选录音' : '录音'} ${recordingIds.join('、')}` : '无录音';
      return { config, orderIds, recordingIds, evidence, conflictNames, uncertain, orderLabel, recordingLabel };
    }

    function renderRecordOption(result, index) {
      const { config, orderLabel, recordingLabel } = resultContext(result);
      const button = element('button', undefined, 'audit-record record-option');
      button.type = 'button';
      button.dataset.resultIndex = String(index);
      button.setAttribute('aria-pressed', 'false');
      button.setAttribute('aria-controls', 'result-detail');
      const copy = element('span', undefined, 'summary-copy');
      const heading = element('span', undefined, 'record-title');
      heading.append(element('span', String(index + 1).padStart(2, '0'), 'record-index'), element('span', config.label, `status-badge ${config.tone}`), element('strong', orderLabel, 'record-name'));
      const firstReason = list(result.reasons).find((reason) => typeof reason === 'string' && reason.trim());
      copy.append(heading, element('span', recordingLabel, 'recording-relation'));
      copy.append(element('span', firstReason ?? '请查看本条核对详情。', 'record-summary'));
      button.append(copy);
      button.addEventListener('click', () => selectRecord(index, true));
      return button;
    }

    function selectRecord(index, userInitiated) {
      if (!Number.isInteger(index) || index < 0 || index >= state.results.length) return;
      if (state.selectedIndex !== index) {
        stopPlayers();
        state.selectedIndex = index;
        for (const button of resultList.querySelectorAll('.record-option')) {
          const selected = Number(button.dataset.resultIndex) === index;
          button.className = `audit-record record-option${selected ? ' is-selected' : ''}`;
          button.setAttribute('aria-pressed', String(selected));
        }
        resultDetail.replaceChildren(renderDetail(state.results[index], index));
      }
      // Keep desktop list focus; on a small screen bring the newly selected context into view.
      if (userInitiated && typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches) {
        resultDetail.scrollIntoView({ block: 'start', behavior: 'auto' });
        resultDetail.focus({ preventScroll: true });
      }
    }

    function renderDetail(result, index) {
      const { config, orderIds, recordingIds, evidence, conflictNames, orderLabel, recordingLabel } = resultContext(result);
      const detail = element('article', undefined, 'detail-record');
      const header = element('div', undefined, 'detail-header');
      const title = element('h3', orderIds.length ? orderLabel : recordingIds.length ? `录音 ${recordingIds.join('、')}` : `核对记录 ${index + 1}`);
      title.id = 'detail-title';
      header.append(element('span', config.label, `status-badge ${config.tone}`), title, element('p', recordingLabel, 'detail-relation'));
      detail.append(header);
      const content = element('div', undefined, 'record-content');
      if (result.status === 'needs_review') content.append(element('p', '候选关联，尚未确认', 'candidate-notice'));
      else if (result.status === 'matched') content.append(element('p', '已确认匹配 · 业务字段一致', 'confirmed-notice'));
      const facts = element('dl', undefined, 'record-facts');
      facts.append(
        factsRow('订单编号', result.order_id ? [result.order_id] : [], orderIds.length ? '未唯一确定，见候选集合' : '未找到对应订单。'),
        factsRow('录音编号', result.recording_id ? [result.recording_id] : [], recordingIds.length ? '未唯一确定，见候选集合' : '无可播放录音。'),
        factsRow('候选订单集合', list(result.candidate_order_ids), '空集合'),
        factsRow('候选录音集合', list(result.candidate_recording_ids), '空集合'),
      );
      content.append(facts);
      content.append(element('h4', '判断理由', 'detail-heading'));
      const reasons = element('ul', undefined, 'reason-list');
      for (const reason of list(result.reasons)) reasons.append(element('li', reason));
      if (!list(result.reasons).length) reasons.append(element('li', '本条未返回判断理由。'));
      content.append(reasons);
      content.append(element('h4', '字段差异', 'detail-heading'));
      content.append(element('p', conflictNames.length ? `差异字段：${conflictNames.join('、')}` : '未发现已知字段差异；是否确认关联以本条状态为准。', 'muted'));
      if (list(result.conflicts).length) {
        const wrapper = element('div', undefined, 'table-scroll');
        const table = element('table', undefined, 'conflict-table');
        const header = element('tr');
        for (const label of ['字段', '订单值', '录音值', '差异']) header.append(element('th', label));
        const head = element('thead');
        head.append(header);
        const body = element('tbody');
        for (const conflict of result.conflicts) {
          const row = element('tr');
          const value = (raw) => conflict.field === 'amount_cents' ? formatMoney(raw) : text(raw);
          const difference = amountDifference(conflict);
          row.append(element('th', fields[conflict.field] ?? conflict.field), element('td', value(conflict.order_value)), element('td', value(conflict.recording_value), 'recording-value'), element('td', difference === null ? '—' : formatMoney(difference), 'conflict-difference'));
          body.append(row);
        }
        table.append(head, body);
        wrapper.append(table);
        content.append(wrapper);
      }
      for (const warning of list(result.data_warnings)) content.append(element('p', `${warning.recording_id} · ${warning.message}`, 'audio-warning'));
      content.append(element('h4', '录音与转写证据', 'detail-heading'));
      if (!recordingIds.length) content.append(element('p', '无可播放录音。', 'unavailable-note'));
      for (const id of recordingIds) content.append(renderRecording(id, evidence.filter((item) => item.recording_id === id)));
      detail.append(content);
      return detail;
    }

    function inputChanged() {
      const key = inputKey();
      if (state.observedKey === key) return;
      state.observedKey = key;
      state.sequence++;
      if (state.active) state.active.controller.abort();
      state.active = null;
      busy(false);
      if (state.hasQueried) {
        clearPresentation('输入已更改，请重新核对');
        get('stale-notice').hidden = false;
        showStatus('idle', '查询条件已更新，请重新核对。');
      }
    }

    function validDate(value) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const parsed = new Date(`${value}T00:00:00Z`);
      return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
    }

    function runAudit() {
      const key = inputKey();
      if (state.active?.key === key) return state.active.promise;
      const selectedDate = date.value;
      const selectedQuestion = question.value.trim();
      if (!validDate(selectedDate)) {
        showStatus('error', '请输入有效日期（YYYY-MM-DD）。');
        return Promise.resolve();
      }
      if (!selectedQuestion || selectedQuestion.length > 1000) {
        showStatus('error', '请输入核对问题，长度须为 1–1000 个字符。');
        return Promise.resolve();
      }
      if (state.active) state.active.controller.abort();
      const id = ++state.sequence;
      const controller = new AbortController();
      state.hasQueried = true;
      state.observedKey = key;
      clearPresentation('正在核对订单与接待录音…');
      get('stale-notice').hidden = true;
      showStatus('loading', '正在核对订单与录音，请稍候。');
      busy(true);
      const current = () => id === state.sequence && key === inputKey();
      const request = (async () => {
        try {
          const response = await fetchRequest('/api/audit', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ date: selectedDate, question: selectedQuestion }), signal: controller.signal,
          });
          const payload = await response.json();
          if (!current()) return;
          renderWarnings(list(payload.warnings));
          if (!response.ok || payload.status !== 'PASS') {
            const blocked = response.status === 503 && payload.status === 'BLOCKED';
            const prefix = response.status === 400 ? '输入无效' : '核对失败';
            const messages = {
              'Pi 在线审计不可用；请在本机配置 DEEPSEEK_API_KEY 后重试。': '核对服务尚未配置完成，请联系管理员。',
              'Pi 审计未成功完成，请检查本机运行日志后重试。': '核对服务未能完成本次查询，请稍后重试。',
              '本轮没有所选日期完整成功的 audit_day 结果。': '未获得所选日期的完整核对结果，请重试。',
            };
            const reason = (Object.hasOwn(messages, payload.error) ? messages[payload.error] : payload.error) ?? '未获得核对结果，请稍后重试。';
            showStatus(blocked ? 'blocked' : 'error', `${prefix}：${reason}`);
            get('result-summary').textContent = '本次没有成功核对结果';
            resultList.replaceChildren(element('p', '本次未返回可用的结构化核对结果。请按上方提示处理后重试。', 'unavailable-note'));
            return;
          }
          if (payload.date !== selectedDate || !Array.isArray(payload.results)) throw new Error('服务响应的日期或结构不符合本次查询。');
          renderStats(payload.results);
          state.results = payload.results.slice();
          resultList.replaceChildren();
          const firstMismatch = payload.results.findIndex((result) => result.status === 'field_mismatch');
          const firstAttention = payload.results.findIndex((result) => result.status !== 'matched');
          for (const [index, result] of payload.results.entries()) resultList.append(renderRecordOption(result, index));
          if (payload.results.length) selectRecord(firstMismatch >= 0 ? firstMismatch : firstAttention >= 0 ? firstAttention : 0, false);
          else {
            resultList.append(element('p', '该日期没有可展示的核对记录，请确认所选办理日期。', 'unavailable-note'));
            resultDetail.replaceChildren(element('p', '该日期没有核对记录。请选择其他办理日期。', 'detail-empty'));
          }
          get('result-summary').textContent = `${selectedDate} · ${payload.results.length} 组核对记录`;
          get('run-id').textContent = '';
          renderAiAnswer(typeof payload.finalAnswer === 'string' && payload.finalAnswer.trim() ? payload.finalAnswer : '本次未返回 AI 自然语言说明。结构化结果仍是业务依据。');
          showStatus('success', '核对完成');
        } catch (error) {
          if (!current()) return;
          clearPresentation('未获得可用核对结果');
          showStatus('error', `核对失败：网络连接或响应处理失败，${error instanceof Error ? error.message : String(error)}`);
          get('result-summary').textContent = '请求未完成';
          resultList.replaceChildren(element('p', '未获得可用核对结果，请确认本地服务和网络后重试。', 'unavailable-note'));
        } finally {
          if (state.active?.id === id) {
            state.active = null;
            busy(false);
          }
        }
      })();
      state.active = { id, key, controller, promise: request };
      return request;
    }

    function init() {
      get('stale-notice').hidden = true;
      clearPresentation('选择日期，开始核对');
      showStatus('idle', '选择办理日期并输入问题，开始核对。');
      for (const id of ['run-id', 'health-status']) {
        get(id).hidden = true;
        get(id).textContent = '';
      }
      for (const name of ['workspace', 'report']) {
        const tab = get(`${name}-tab`);
        tab.addEventListener('click', () => selectTab(name));
        tab.addEventListener('keydown', (event) => {
          let target;
          if (event.key === 'Home') target = 'workspace';
          else if (event.key === 'End') target = 'report';
          else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') target = name === 'workspace' ? 'report' : 'workspace';
          if (target) {
            event.preventDefault();
            selectTab(target, true);
          }
        });
      }
      form.addEventListener('submit', (event) => { event.preventDefault(); return runAudit(); });
      question.addEventListener('input', inputChanged);
      date.addEventListener('input', inputChanged);
      date.addEventListener('change', () => {
        inputChanged();
        if (date.value === state.observedDate) return;
        state.observedDate = date.value;
        if (state.hasQueried) return runAudit();
      });
      for (const shortcut of document.querySelectorAll('[data-question]')) {
        shortcut.addEventListener('click', () => {
          question.value = shortcut.dataset.question;
          inputChanged();
          question.focus();
        });
      }
      // Keep the liveness probe separate from user-visible business status.
      fetchRequest('/api/health').catch(() => {});
    }

    return { init };
  }

  globalThis.HotelAuditUI = { formatMoney, formatTime, audioSource, playEvidenceSegment, createAuditApp };
  if (typeof document !== 'undefined') createAuditApp(document, (...args) => fetch(...args)).init();
})();
