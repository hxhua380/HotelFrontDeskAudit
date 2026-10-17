import { isDeepStrictEqual } from 'node:util';
import type {
  AuditableField, DetailedAuditResult, Order, RecordingDataWarning, TranscriptEvidence,
} from '../domain/types.js';
import type { AuditDayToolResult } from './tools.js';

/** 原始记录只存于被 Git 忽略的 evidence/local/，不含认证配置。 */
export interface ToolEvidenceRecord {
  runId: string;
  toolCallId: string;
  toolName: string;
  phase: 'tool_execution_start' | 'tool_execution_end' | 'execute_start' | 'execute_end';
  args: unknown;
  result: unknown;
  isError: boolean | null;
  timestamp: string;
  /** Stage 4 在两个日志共用的记录入口分配；旧版记录无需此字段。 */
  sequence?: number;
}

export interface AuditToolResultCapture {
  toolCallId: string;
  toolName: 'audit_day';
  args: { date: string; window_seconds?: number };
  result: AuditDayToolResult;
}

export interface AgentQueryResult {
  runId: string;
  date: string | null;
  toolResults: AuditToolResultCapture[];
  finalAnswer: string;
  warnings: RecordingDataWarning[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isWindow(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isAuditArgs(value: unknown): value is AuditToolResultCapture['args'] {
  return isRecord(value) && isDate(value.date)
    && Object.keys(value).every((key) => key === 'date' || key === 'window_seconds')
    && (!Object.hasOwn(value, 'window_seconds') || isWindow(value.window_seconds));
}

const orderFields: (keyof Order)[] = [
  'order_id', 'handled_at', 'room_number', 'room_type', 'check_in_date', 'check_out_date', 'amount_cents', 'currency',
];
const auditFields: AuditableField[] = ['room_number', 'room_type', 'check_in_date', 'check_out_date', 'amount_cents'];

function isOrderField(value: unknown): value is keyof Order {
  return typeof value === 'string' && orderFields.some((field) => field === value);
}

function isWarning(value: unknown): value is RecordingDataWarning {
  return isRecord(value) && (value.code === 'audio_missing' || value.code === 'audio_not_file')
    && isNonemptyString(value.recording_id) && isNonemptyString(value.started_at)
    && Number.isFinite(Date.parse(value.started_at))
    && isNonemptyString(value.audio_path) && isNonemptyString(value.message);
}

function isEvidence(value: unknown): value is TranscriptEvidence {
  return isRecord(value) && isNonemptyString(value.recording_id) && isNonemptyString(value.text)
    && (value.field === undefined || value.field === null || isOrderField(value.field))
    && typeof value.segment_index === 'number' && Number.isSafeInteger(value.segment_index) && value.segment_index >= 0
    && typeof value.start_ms === 'number' && Number.isSafeInteger(value.start_ms) && value.start_ms >= 0
    && typeof value.end_ms === 'number' && Number.isSafeInteger(value.end_ms) && value.end_ms > value.start_ms;
}

function isStringSet(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonemptyString) && new Set(value).size === value.length;
}

function isDetailedResult(value: unknown): value is DetailedAuditResult {
  if (!isRecord(value)
    || !['matched', 'field_mismatch', 'missing_recording', 'orphan_recording', 'needs_review'].includes(String(value.status))
    || !(value.order_id === null || isNonemptyString(value.order_id))
    || !(value.recording_id === null || isNonemptyString(value.recording_id))
    || !isStringSet(value.candidate_order_ids) || !isStringSet(value.candidate_recording_ids)
    || !Array.isArray(value.conflicting_fields) || !value.conflicting_fields.every(isOrderField)
    || new Set(value.conflicting_fields).size !== value.conflicting_fields.length
    || !Array.isArray(value.reasons) || !value.reasons.every(isNonemptyString)
    || !Array.isArray(value.evidence) || !value.evidence.every(isEvidence)
    || !Array.isArray(value.data_warnings) || !value.data_warnings.every(isWarning)
    || !Array.isArray(value.conflicts)) return false;
  if ((value.order_id !== null && !value.candidate_order_ids.includes(value.order_id))
    || (value.recording_id !== null && !value.candidate_recording_ids.includes(value.recording_id))) return false;
  return value.conflicts.every((conflict: unknown) => {
    if (!isRecord(conflict) || !auditFields.some((field) => field === conflict.field)
      || !Array.isArray(conflict.evidence) || !conflict.evidence.every(isEvidence)) return false;
    if (conflict.field === 'amount_cents') {
      return typeof conflict.order_value === 'number' && Number.isSafeInteger(conflict.order_value) && conflict.order_value >= 0
        && typeof conflict.recording_value === 'number' && Number.isSafeInteger(conflict.recording_value) && conflict.recording_value >= 0;
    }
    return isNonemptyString(conflict.order_value) && isNonemptyString(conflict.recording_value);
  });
}

function isAuditResult(value: unknown, args: AuditToolResultCapture['args']): value is AuditDayToolResult {
  return isRecord(value) && value.date === args.date
    && isWindow(value.window_seconds) && value.window_seconds === (args.window_seconds ?? 180)
    && Array.isArray(value.warnings) && value.warnings.every(isWarning)
    && Array.isArray(value.results) && value.results.every(isDetailedResult);
}

/**
 * 只筛选已有 Runtime/execute 记录中的结构化成功结果。调用方负责订阅真实事件；
 * 本函数不会执行工具，也不会把模型回答或缺失的记录补成调用证据。
 */
export function collectAuditToolResults(
  runId: string,
  events: ToolEvidenceRecord[],
  executions: ToolEvidenceRecord[],
): AuditToolResultCapture[] {
  if (!isNonemptyString(runId)) return [];
  const currentEvents = events.filter((record) => record?.runId === runId);
  const currentExecutions = executions.filter((record) => record?.runId === runId);
  const current = [...currentEvents, ...currentExecutions];
  // 两个文件共享一条顺序轴；旧日志不能借时间戳冒充 Stage 4 证据。
  if (current.some((record) => !Number.isSafeInteger(record.sequence) || (record.sequence ?? 0) < 1)
    || new Set(current.map((record) => record.sequence)).size !== current.length) return [];
  const increasing = (records: ToolEvidenceRecord[]): boolean => records.every((record, index) => index === 0
    || records[index - 1]!.sequence! < record.sequence!);
  if (!increasing(currentEvents) || !increasing(currentExecutions)) return [];

  const starts = currentEvents.filter((record) => record.phase === 'tool_execution_start' && record.toolName === 'audit_day');
  const captured: { sequence: number; value: AuditToolResultCapture }[] = [];
  for (const start of starts) {
    if (!isNonemptyString(start.toolCallId) || !isAuditArgs(start.args)) continue;
    const group = current.filter((record) => record.toolCallId === start.toolCallId);
    if (group.length !== 4 || group.some((record) => record.toolName !== 'audit_day')) continue;
    const ends = currentEvents.filter((record) => record.toolCallId === start.toolCallId && record.phase === 'tool_execution_end');
    const entered = currentExecutions.filter((record) => record.toolCallId === start.toolCallId && record.phase === 'execute_start');
    const completed = currentExecutions.filter((record) => record.toolCallId === start.toolCallId && record.phase === 'execute_end');
    if (ends.length !== 1 || entered.length !== 1 || completed.length !== 1) continue;
    const end = ends[0]!;
    const enter = entered[0]!;
    const complete = completed[0]!;
    const ordered = [start, enter, complete, end];
    if (!increasing(ordered) || !ordered.every((record) => isDeepStrictEqual(record.args, start.args))
      || !ordered.every((record) => typeof record.timestamp === 'string' && Number.isFinite(Date.parse(record.timestamp)))
      || !ordered.every((record, index) => index === 0 || Date.parse(ordered[index - 1]!.timestamp) <= Date.parse(record.timestamp))
      || complete.isError !== false || end.isError !== false
      || !isRecord(end.result) || !isDeepStrictEqual(end.result.details, complete.result)
      || !isAuditResult(complete.result, start.args)) continue;
    captured.push({
      sequence: start.sequence!,
      value: { toolCallId: start.toolCallId, toolName: 'audit_day', args: structuredClone(start.args), result: structuredClone(complete.result) },
    });
  }
  return captured.sort((a, b) => a.sequence - b.sequence).map(({ value }) => value);
}

export function beijingTimestamp(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00');
}
