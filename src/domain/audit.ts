import { extractTranscript } from "./transcript.js";
import type {
  AuditableField,
  DetailedAuditResult,
  FieldConflict,
  Order,
  Recording,
  RecordingDataWarning,
  TranscriptEvidence,
  TranscriptFacts,
} from "./types.js";

export interface AuditOptions {
  window_seconds?: number;
  data_warnings?: RecordingDataWarning[];
}

const fields: AuditableField[] = ["room_number", "room_type", "check_in_date", "check_out_date", "amount_cents"];
const fieldNames: Record<AuditableField, string> = {
  room_number: "房号",
  room_type: "房型",
  check_in_date: "入住日期",
  check_out_date: "退房日期",
  amount_cents: "金额",
};

interface TimedOrder {
  order: Order;
  time: number;
}

interface TimedRecording {
  recording: Recording;
  time: number;
  facts: TranscriptFacts;
  evidence: TranscriptEvidence[];
}

interface Component {
  orders: number[];
  recordings: number[];
}

const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.slice(0, 4) === "0000") return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function beijingTimestamp(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?\+08:00$/.test(value)
    || !isCalendarDate(value.slice(0, 10))) {
    throw new Error(`无效的北京时间 timestamp：${value}`);
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`无效的北京时间 timestamp：${value}`);
  return time;
}

function uniqueIds(values: string[], kind: string): void {
  const seen = new Set<string>();
  for (const id of values) {
    if (seen.has(id)) throw new Error(`当日${kind} ID 重复：${id}`);
    seen.add(id);
  }
}

function sortEvidence(evidence: TranscriptEvidence[]): TranscriptEvidence[] {
  const unique = new Map<string, TranscriptEvidence>();
  for (const item of evidence) {
    const key = JSON.stringify([item.recording_id, item.segment_index, item.field ?? null, item.start_ms, item.end_ms, item.text]);
    unique.set(key, { ...item });
  }
  return [...unique.values()].sort((a, b) => compareText(a.recording_id, b.recording_id)
    || a.segment_index - b.segment_index
    || a.start_ms - b.start_ms
    || a.end_ms - b.end_ms
    || compareText(a.field ?? "", b.field ?? "")
    || compareText(a.text, b.text));
}

function recordingEvidence(recording: Recording, facts: TranscriptFacts): TranscriptEvidence[] {
  const evidence = fields.flatMap((field) => facts[field].observations.map((observation) => observation.evidence));
  const observedSegments = new Set(evidence.map((item) => item.segment_index));
  for (const [segment_index, segment] of recording.transcript_segments.entries()) {
    if (!observedSegments.has(segment_index)) {
      evidence.push({ recording_id: recording.recording_id, field: null, segment_index, ...segment });
    }
  }
  return sortEvidence(evidence);
}

function known(facts: TranscriptFacts, field: AuditableField): boolean {
  return facts[field].value !== null && !facts[field].ambiguous;
}

function pairComparison(order: Order, facts: TranscriptFacts): {
  identity: string | null;
  conflicts: FieldConflict[];
  unknown: AuditableField[];
  ambiguous: AuditableField[];
} {
  const agrees = (field: AuditableField): boolean => known(facts, field) && order[field] === facts[field].value;
  let identity: string | null = null;
  if (agrees("room_number") && (agrees("check_in_date") || agrees("check_out_date") || agrees("room_type"))) {
    const anchors = (["check_in_date", "check_out_date", "room_type"] as const).filter(agrees).map((field) => fieldNames[field]);
    identity = `房号一致，且${anchors.join("、")}一致，提供同一业务事件的正向身份依据。`;
  } else if (agrees("check_in_date") && agrees("check_out_date") && agrees("room_type") && agrees("amount_cents")) {
    identity = "入住日期、退房日期、房型及金额一致，提供同一业务事件的正向身份依据。";
  }
  const conflicts: FieldConflict[] = [];
  for (const field of fields) {
    const value = facts[field].value;
    if (known(facts, field) && value !== null && order[field] !== value) {
      conflicts.push({
        field,
        order_value: order[field],
        recording_value: value,
        evidence: sortEvidence(facts[field].observations.filter((observation) => observation.value === value).map((observation) => observation.evidence)),
      });
    }
  }
  return {
    identity,
    conflicts,
    unknown: fields.filter((field) => !known(facts, field) && !facts[field].ambiguous),
    ambiguous: fields.filter((field) => facts[field].ambiguous),
  };
}

/**
 * Pure candidate-graph audit. Time creates candidates; unambiguous room content may
 * prune them. Connected components preserve every unresolved candidate instead of
 * selecting a nearest record or using identifier order to decide a relationship.
 */
export function auditDay(orders: Order[], recordings: Recording[], date: string, options: AuditOptions = {}): DetailedAuditResult[] {
  if (!isCalendarDate(date)) throw new Error(`无效的核对日期 date：${date}`);
  const windowSeconds = options.window_seconds ?? 180;
  if (!Number.isFinite(windowSeconds) || windowSeconds < 0) throw new Error("时间窗口 window_seconds 必须是大于等于零的有限数值");
  const windowMs = windowSeconds * 1000;

  // Validate before filtering so malformed input cannot silently disappear.
  const dayOrders: TimedOrder[] = orders.map((order) => ({ order, time: beijingTimestamp(order.handled_at) }))
    .filter(({ order }) => order.handled_at.slice(0, 10) === date);
  const selectedRecordings = recordings.map((recording) => ({ recording, time: beijingTimestamp(recording.started_at) }))
    .filter(({ recording }) => recording.started_at.slice(0, 10) === date);
  uniqueIds(dayOrders.map(({ order }) => order.order_id), "订单");
  uniqueIds(selectedRecordings.map(({ recording }) => recording.recording_id), "录音");
  const dayRecordings: TimedRecording[] = selectedRecordings.map(({ recording, time }) => {
    const facts = extractTranscript(recording);
    return { recording, time, facts, evidence: recordingEvidence(recording, facts) };
  });
  const warnings = (options.data_warnings ?? []).map((warning) => ({ warning, time: beijingTimestamp(warning.started_at) }))
    .filter(({ warning }) => warning.started_at.slice(0, 10) === date);

  const orderEdges: number[][] = dayOrders.map(() => []);
  const recordingEdges: number[][] = dayRecordings.map(() => []);
  for (const [recordingIndex, recording] of dayRecordings.entries()) {
    let candidates = dayOrders.flatMap((order, orderIndex) => Math.abs(order.time - recording.time) <= windowMs ? [orderIndex] : []);
    const room = recording.facts.room_number;
    if (!room.ambiguous && room.value !== null) {
      const roomCandidates = candidates.filter((orderIndex) => dayOrders[orderIndex]!.order.room_number === room.value);
      if (roomCandidates.length > 0) {
        const agrees = (orderIndex: number, field: AuditableField): boolean => known(recording.facts, field)
          && dayOrders[orderIndex]!.order[field] === recording.facts[field].value;
        const hasCompleteRoomMatch = roomCandidates.some((orderIndex) => fields.every((field) => agrees(orderIndex, field)));
        const roomCandidateSet = new Set(roomCandidates);
        // A room observation must not hide a strong four-field alternative when
        // the matching-room event itself has conflicting or unknown content.
        candidates = hasCompleteRoomMatch ? roomCandidates : candidates.filter((orderIndex) => roomCandidateSet.has(orderIndex)
          || (["check_in_date", "check_out_date", "room_type", "amount_cents"] as const).every((field) => agrees(orderIndex, field)));
      }
    }
    for (const orderIndex of candidates) {
      orderEdges[orderIndex]!.push(recordingIndex);
      recordingEdges[recordingIndex]!.push(orderIndex);
    }
  }

  const visitedOrders = new Set<number>();
  const visitedRecordings = new Set<number>();
  const components: Component[] = [];
  const visit = (initialOrder: number | null, initialRecording: number | null): void => {
    const component: Component = { orders: [], recordings: [] };
    const pending: { kind: "order" | "recording"; index: number }[] = [];
    if (initialOrder !== null) pending.push({ kind: "order", index: initialOrder });
    if (initialRecording !== null) pending.push({ kind: "recording", index: initialRecording });
    while (pending.length > 0) {
      const next = pending.pop()!;
      if (next.kind === "order") {
        if (visitedOrders.has(next.index)) continue;
        visitedOrders.add(next.index);
        component.orders.push(next.index);
        for (const index of orderEdges[next.index]!) pending.push({ kind: "recording", index });
      } else {
        if (visitedRecordings.has(next.index)) continue;
        visitedRecordings.add(next.index);
        component.recordings.push(next.index);
        for (const index of recordingEdges[next.index]!) pending.push({ kind: "order", index });
      }
    }
    components.push(component);
  };
  for (let index = 0; index < dayOrders.length; index++) if (!visitedOrders.has(index)) visit(index, null);
  for (let index = 0; index < dayRecordings.length; index++) if (!visitedRecordings.has(index)) visit(null, index);

  const results = components.map((component): { result: DetailedAuditResult; time: number } => {
    const componentOrders = component.orders.map((index) => dayOrders[index]!);
    const componentRecordings = component.recordings.map((index) => dayRecordings[index]!);
    const orderIds = componentOrders.map(({ order }) => order.order_id).sort(compareText);
    const recordingIds = componentRecordings.map(({ recording }) => recording.recording_id).sort(compareText);
    const relevantWarnings = warnings.filter(({ time }) => componentOrders.some((order) => Math.abs(order.time - time) <= windowMs))
      .map(({ warning }) => ({ ...warning }))
      .sort((a, b) => compareText(a.recording_id, b.recording_id) || compareText(a.started_at, b.started_at) || compareText(a.code, b.code) || compareText(a.audio_path, b.audio_path) || compareText(a.message, b.message));
    const result: DetailedAuditResult = {
      status: "needs_review",
      order_id: orderIds.length === 1 ? orderIds[0]! : null,
      recording_id: recordingIds.length === 1 ? recordingIds[0]! : null,
      candidate_order_ids: orderIds,
      candidate_recording_ids: recordingIds,
      conflicting_fields: [],
      conflicts: [],
      reasons: [],
      evidence: sortEvidence(componentRecordings.flatMap((recording) => recording.evidence)),
      data_warnings: relevantWarnings,
    };
    if (componentRecordings.length === 0) {
      result.status = "missing_recording";
      result.reasons.push(`北京时间当日的 ${windowSeconds} 秒窗口内没有可用录音候选。`);
    } else if (componentOrders.length === 0) {
      result.status = "orphan_recording";
      result.reasons.push(`北京时间当日的 ${windowSeconds} 秒窗口及房号业务筛选后没有订单候选。`);
    } else if (componentOrders.length > 1 || componentRecordings.length > 1) {
      result.reasons.push(`关联组包含 ${componentOrders.length} 个订单候选和 ${componentRecordings.length} 个录音候选，无法唯一确定对应关系；保留全部候选供人工复核，未确认配对。`);
    } else {
      const comparison = pairComparison(componentOrders[0]!.order, componentRecordings[0]!.facts);
      result.conflicts = comparison.conflicts;
      result.conflicting_fields = comparison.conflicts.map((conflict) => conflict.field);
      if (comparison.identity !== null) result.reasons.push(comparison.identity);
      else result.reasons.push("时间接近仅形成候选；缺少足够的正向业务身份依据，未确认订单与录音是同一事件。");
      if (comparison.ambiguous.length > 0) result.reasons.push(`录音中的${comparison.ambiguous.map((field) => fieldNames[field]).join("、")}存在多个冲突值，提取有歧义，必须人工复核。`);
      if (comparison.unknown.length > 0) result.reasons.push(`录音未提取到${comparison.unknown.map((field) => fieldNames[field]).join("、")}；这些字段为未知，不能视为一致或冲突。`);
      if (comparison.conflicts.length > 0) result.reasons.push(`已知字段差异：${comparison.conflicts.map((conflict) => `${fieldNames[conflict.field]}（订单 ${conflict.order_value}，录音 ${conflict.recording_value}）`).join("；")}。`);
      if (comparison.identity !== null && comparison.ambiguous.length === 0) {
        if (comparison.conflicts.length > 0) result.status = "field_mismatch";
        else if (comparison.unknown.length === 0) {
          result.status = "matched";
          result.reasons.push("五项业务字段均可明确观察且一致，确认对应。");
        }
      }
    }
    for (const warning of relevantWarnings) result.reasons.push(`候选音频不可用，已排除：${warning.recording_id}，${warning.message}`);
    const time = Math.min(...componentOrders.map((order) => order.time), ...componentRecordings.map((recording) => recording.time));
    return { result, time };
  });
  return results.sort((a, b) => a.time - b.time
    || compareText(JSON.stringify(a.result.candidate_order_ids), JSON.stringify(b.result.candidate_order_ids))
    || compareText(JSON.stringify(a.result.candidate_recording_ids), JSON.stringify(b.result.candidate_recording_ids)))
    .map(({ result }) => result);
}
