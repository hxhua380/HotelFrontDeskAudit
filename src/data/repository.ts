import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type { Order, Recording, RecordingDataWarning, RecordingQueryResult, TranscriptSegment } from "../domain/types.js";

// 从模块位置定位样本，调用者切换工作目录也不会影响默认文件。
const defaultOrdersFile = new URL("../../data/orders.json", import.meta.url);
const beijingTimestampPattern = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?\+08:00$/;

function calendarDateIssue(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return "date must use the exact YYYY-MM-DD format";
  }

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  if (year < 1 || day < 1 || day > daysInMonth) {
    return "date must be a valid calendar date";
  }
  return null;
}

function invalidData(filePath: string, location: string, detail: string): Error {
  return new Error(`Invalid orders JSON in "${filePath}" at ${location}: ${detail}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(row: Record<string, unknown>, field: keyof Order, location: string, filePath: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidData(filePath, `${location}.${field}`, "must be a nonempty string");
  }
  return value;
}

function parseOrder(value: unknown, index: number, filePath: string): Order {
  const location = `orders[${index}]`;
  if (!isObject(value)) {
    throw invalidData(filePath, location, "must be an order object");
  }

  const orderId = stringField(value, "order_id", location, filePath);
  const handledAt = stringField(value, "handled_at", location, filePath);
  if (!beijingTimestampPattern.test(handledAt) || calendarDateIssue(handledAt.slice(0, 10))) {
    throw invalidData(filePath, `${location}.handled_at`, "must be a valid Beijing timestamp with explicit +08:00 offset");
  }

  const roomNumber = stringField(value, "room_number", location, filePath);
  const roomType = stringField(value, "room_type", location, filePath);
  const checkInDate = stringField(value, "check_in_date", location, filePath);
  const checkOutDate = stringField(value, "check_out_date", location, filePath);
  for (const [field, date] of [["check_in_date", checkInDate], ["check_out_date", checkOutDate]] as const) {
    const issue = calendarDateIssue(date);
    if (issue) throw invalidData(filePath, `${location}.${field}`, issue);
  }
  if (checkOutDate <= checkInDate) {
    throw invalidData(filePath, `${location}.check_out_date`, "must be later than check_in_date");
  }

  const amountCents = value.amount_cents;
  if (typeof amountCents !== "number" || !Number.isSafeInteger(amountCents) || amountCents < 0) {
    throw invalidData(filePath, `${location}.amount_cents`, "must be a nonnegative safe integer in cents");
  }
  if (value.currency !== "CNY") {
    throw invalidData(filePath, `${location}.currency`, "must be CNY");
  }

  return {
    order_id: orderId,
    handled_at: handledAt,
    room_number: roomNumber,
    room_type: roomType,
    check_in_date: checkInDate,
    check_out_date: checkOutDate,
    amount_cents: amountCents,
    currency: "CNY",
  };
}

/** 每次调用都重新读取并校验 JSON，再按北京时间的办理日期筛选。 */
export async function queryOrdersByDate(date: string, ordersFile: string | URL = defaultOrdersFile): Promise<Order[]> {
  const issue = calendarDateIssue(date);
  if (issue) throw new Error(`Invalid query date: ${issue}`);

  const filePath = ordersFile instanceof URL ? fileURLToPath(ordersFile) : resolve(ordersFile);
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`Unable to read orders file "${filePath}"`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch (error) {
    throw new Error(`Unable to parse orders JSON in "${filePath}"`, { cause: error });
  }

  if (!isObject(parsed)) {
    throw invalidData(filePath, "root", "must be an object containing data_source and orders");
  }
  if (parsed.data_source !== "synthetic demo data") {
    throw invalidData(filePath, "data_source", 'must be "synthetic demo data"');
  }
  if (!Array.isArray(parsed.orders)) {
    throw invalidData(filePath, "orders", "must be an array");
  }

  // 时间戳已限定 +08:00，取日期部分即可避免宿主时区的影响。
  return parsed.orders
    .map((order: unknown, index: number) => parseOrder(order, index, filePath))
    .filter((order) => order.handled_at.slice(0, 10) === date);
}

const defaultRecordingsFile = new URL("../../data/recordings.json", import.meta.url);
const defaultAudioRoot = fileURLToPath(new URL("../../", import.meta.url));

function recordingError(file: string, location: string, detail: string): Error {
  return new Error(`Invalid recordings JSON in "${file}" at ${location}: ${detail}`);
}

function recordingString(row: Record<string, unknown>, field: string, file: string, location: string): string {
  const value = row[field];
  if (typeof value !== "string" || !value.trim()) throw recordingError(file, `${location}.${field}`, "must be a nonempty string");
  return value;
}

function isContained(root: string, path: string): boolean {
  const scoped = relative(root, path);
  return scoped !== "" && scoped !== ".." && !scoped.startsWith("../") && !scoped.startsWith("..\\") && !isAbsolute(scoped);
}

function recordingAudioPath(root: string, value: string, file: string, location: string): string {
  const absolute = resolve(root, value);
  if (isAbsolute(value) || win32.isAbsolute(value) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) || !isContained(root, absolute)) {
    throw recordingError(file, `${location}.audio_path`, "path must be relative and contained within the audio root");
  }
  return absolute;
}

function missingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** 文件缺失时也要核实已存在的父路径，避免把越界链接误报成普通缺文件。 */
function assertPhysicalContainment(root: string, path: string, file: string, location: string): void {
  let ancestor = path;
  const visited = new Set<string>();
  while (!visited.has(ancestor)) {
    visited.add(ancestor);
    try {
      const physical = realpathSync(ancestor);
      if (physical !== root && !isContained(root, physical)) throw recordingError(file, location, "resolved path escapes the audio root");
      return;
    } catch (error) {
      if (!missingPathError(error)) throw error;
    }
    // 悬空链接也有可读的目标；目标不存在不能成为绕过路径边界的理由。
    try {
      if (lstatSync(ancestor).isSymbolicLink()) {
        const target = resolve(dirname(ancestor), readlinkSync(ancestor));
        if (target !== root && !isContained(root, target)) throw recordingError(file, location, "linked path escapes the audio root");
        ancestor = target;
        continue;
      }
    } catch (error) {
      if (!missingPathError(error)) throw error;
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) throw recordingError(file, location, "cannot resolve a contained parent path");
    ancestor = parent;
  }
  throw recordingError(file, location, "cyclic audio path");
}

function parseRecording(value: unknown, index: number, file: string, audioRoot: string): Recording {
  const location = `recordings[${index}]`;
  if (!isObject(value)) throw recordingError(file, location, "must be a recording object");
  const recordingId = recordingString(value, "recording_id", file, location);
  const startedAt = recordingString(value, "started_at", file, location);
  if (!beijingTimestampPattern.test(startedAt) || calendarDateIssue(startedAt.slice(0, 10))) {
    throw recordingError(file, `${location}.started_at`, "must be a valid Beijing timestamp with explicit +08:00 offset");
  }
  const audioPath = recordingString(value, "audio_path", file, location);
  recordingAudioPath(audioRoot, audioPath, file, location);
  if (!Array.isArray(value.transcript_segments)) throw recordingError(file, `${location}.transcript_segments`, "must be an array");
  let previousEnd = 0;
  const segments = value.transcript_segments.map((segment: unknown, segmentIndex: number): TranscriptSegment => {
    const where = `${location}.transcript_segments[${segmentIndex}]`;
    if (!isObject(segment)) throw recordingError(file, where, "must be a segment object");
    const start = segment.start_ms;
    const end = segment.end_ms;
    if (typeof start !== "number" || typeof end !== "number" || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < previousEnd || start < 0 || end <= start) {
      throw recordingError(file, where, "must have non-overlapping integer 0 <= start_ms < end_ms");
    }
    previousEnd = end;
    return { start_ms: start, end_ms: end, text: recordingString(segment, "text", file, where) };
  });
  return { recording_id: recordingId, started_at: startedAt, audio_path: audioPath, transcript_segments: segments };
}

/** 返回当天可用录音与独立警告；缺失文件不是有效候选，也不静默当作正常录音。 */
export async function queryRecordingsByDate(
  date: string,
  recordingsFile: string | URL = defaultRecordingsFile,
  audioRoot: string | URL = defaultAudioRoot,
): Promise<RecordingQueryResult> {
  const issue = calendarDateIssue(date);
  if (issue) throw new Error(`Invalid query date: ${issue}`);
  const file = recordingsFile instanceof URL ? fileURLToPath(recordingsFile) : resolve(recordingsFile);
  const root = audioRoot instanceof URL ? fileURLToPath(audioRoot) : resolve(audioRoot);
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(file, "utf8")) as unknown; }
  catch (error) { throw new Error(`Unable to read or parse recordings JSON in "${file}"`, { cause: error }); }
  if (!isObject(parsed) || parsed.data_source !== "synthetic demo data" || !Array.isArray(parsed.recordings)) {
    throw recordingError(file, "root", "must contain synthetic demo data and a recordings array");
  }
  const rows = parsed.recordings.map((value: unknown, index: number) => parseRecording(value, index, file, root));
  if (new Set(rows.map((recording) => recording.recording_id)).size !== rows.length) {
    throw recordingError(file, "recording_id", "duplicate identifiers are not allowed");
  }
  const physicalRoot = realpathSync(root);
  const result: RecordingQueryResult = { recordings: [], warnings: [] };
  for (const recording of rows.filter((row) => row.started_at.slice(0, 10) === date)) {
    const path = recordingAudioPath(root, recording.audio_path, file, recording.recording_id);
    assertPhysicalContainment(physicalRoot, path, file, `${recording.recording_id}.audio_path`);
    let warningCode: RecordingDataWarning["code"] | null = null;
    try {
      // 同时检查符号链接解析后的真实位置，不能通过链接跳出仓库。
      const physicalPath = realpathSync(path);
      if (!isContained(physicalRoot, physicalPath)) throw recordingError(file, `${recording.recording_id}.audio_path`, "resolved path escapes the audio root");
      if (!(await stat(physicalPath)).isFile()) warningCode = "audio_not_file";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") warningCode = "audio_missing";
      else throw new Error(`Unable to inspect audio path for ${recording.recording_id}: ${path}; ${error instanceof Error ? error.message : "unknown error"}`, { cause: error });
    }
    if (warningCode) {
      result.warnings.push({
        code: warningCode, recording_id: recording.recording_id, started_at: recording.started_at,
        audio_path: recording.audio_path,
        message: warningCode === "audio_missing" ? `录音引用的音频文件不存在：${recording.audio_path}` : `录音路径不是普通文件：${recording.audio_path}`,
      });
    } else result.recordings.push(recording);
  }
  return result;
}
