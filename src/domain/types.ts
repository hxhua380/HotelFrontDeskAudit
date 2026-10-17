/** 金额统一使用整数分，日期与时间统一保存为字符串。 */
export interface Order {
  order_id: string;
  handled_at: string;
  room_number: string;
  room_type: string;
  check_in_date: string;
  check_out_date: string;
  amount_cents: number;
  currency: "CNY";
}

export interface TranscriptSegment {
  start_ms: number;
  end_ms: number;
  text: string;
}

export interface Recording {
  recording_id: string;
  started_at: string;
  audio_path: string;
  transcript_segments: TranscriptSegment[];
}

export type AuditStatus =
  | "matched"
  | "field_mismatch"
  | "missing_recording"
  | "orphan_recording"
  | "needs_review";

export interface Evidence {
  recording_id: string;
  field?: keyof Order | null;
  text: string;
  start_ms: number;
  end_ms: number;
}

export interface AuditResult {
  status: AuditStatus;
  order_id: string | null;
  recording_id: string | null;
  conflicting_fields: (keyof Order)[];
  reasons: string[];
  evidence: Evidence[];
}

// Stage 3 通过派生类型增加诊断信息，保留 Stage 1 的精确基础契约。
export type AuditableField = "room_number" | "room_type" | "check_in_date" | "check_out_date" | "amount_cents";

export interface TranscriptEvidence extends Evidence {
  segment_index: number;
}

export interface FieldObservation<T extends string | number> {
  value: T;
  evidence: TranscriptEvidence;
}

export interface ExtractedField<T extends string | number> {
  value: T | null;
  ambiguous: boolean;
  observations: FieldObservation<T>[];
}

export interface TranscriptFacts {
  room_number: ExtractedField<string>;
  room_type: ExtractedField<string>;
  check_in_date: ExtractedField<string>;
  check_out_date: ExtractedField<string>;
  amount_cents: ExtractedField<number>;
}

export interface FieldConflict {
  field: AuditableField;
  order_value: string | number;
  recording_value: string | number;
  evidence: TranscriptEvidence[];
}

export interface RecordingDataWarning {
  code: "audio_missing" | "audio_not_file";
  recording_id: string;
  started_at: string;
  audio_path: string;
  message: string;
}

export interface RecordingQueryResult {
  recordings: Recording[];
  warnings: RecordingDataWarning[];
}

export interface DetailedAuditResult extends AuditResult {
  candidate_order_ids: string[];
  candidate_recording_ids: string[];
  conflicts: FieldConflict[];
  evidence: TranscriptEvidence[];
  data_warnings: RecordingDataWarning[];
}
