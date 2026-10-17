import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { queryOrdersByDate } from "../src/data/repository.js";
import type { Recording, TranscriptSegment } from "../src/domain/types.js";

const defaultProjectRoot = fileURLToPath(new URL("../", import.meta.url));
const beijingTimestampPattern = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?\+08:00$/;

interface DecodedAudio {
  audio_path: string;
  duration_ms: number;
  sample_rate: number;
  channels: number;
  decoded_frames: number;
  rms: number;
  amplitude_std: number;
  min_sample: number;
  max_sample: number;
  non_silent: boolean;
  sha256: string;
  size_bytes: number;
}

export interface DemoDataSummary {
  data_source: "synthetic demo data";
  hotel: "Demo Hotel";
  time_zone: "Asia/Shanghai";
  orders_count: number;
  recordings_count: number;
  orders_by_handled_date: Record<string, number>;
  recordings_by_started_date: Record<string, number>;
  decoder: "ffmpeg";
  alignment: string;
  recordings: (DecodedAudio & { recording_id: string })[];
}

function requireValid(condition: unknown, location: string, detail: string): asserts condition {
  if (!condition) throw new Error(`Invalid demo data at ${location}: ${detail}`);
}

function object(value: unknown, location: string): Record<string, unknown> {
  requireValid(typeof value === "object" && value !== null && !Array.isArray(value), location, "must be an object");
  return value as Record<string, unknown>;
}

function text(value: unknown, location: string): string {
  requireValid(typeof value === "string" && value.trim().length > 0, location, "must be a nonempty string");
  return value;
}

function rows(value: unknown, location: string): unknown[] {
  requireValid(Array.isArray(value), location, "must be an array");
  return value;
}

async function json(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Unable to read or parse JSON file "${path}"`, { cause: error });
  }
}

function envelope(value: unknown, location: string): Record<string, unknown> {
  const parsed = object(value, location);
  requireValid(parsed.data_source === "synthetic demo data", `${location}.data_source`, 'must be "synthetic demo data"');
  requireValid(parsed.hotel === "Demo Hotel", `${location}.hotel`, 'must be "Demo Hotel"');
  requireValid(parsed.time_zone === "Asia/Shanghai", `${location}.time_zone`, 'must be "Asia/Shanghai"');
  return parsed;
}

function exactFields(value: Record<string, unknown>, fields: string[], location: string): void {
  const actual = Object.keys(value).sort();
  requireValid(JSON.stringify(actual) === JSON.stringify([...fields].sort()), location, `must contain exactly these fields: ${fields.join(", ")}`);
}

function validBeijingTime(value: unknown, location: string): string {
  const timestamp = text(value, location);
  const year = Number(timestamp.slice(0, 4));
  const month = Number(timestamp.slice(5, 7));
  const day = Number(timestamp.slice(8, 10));
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  requireValid(beijingTimestampPattern.test(timestamp) && year > 0 && day > 0 && day <= monthDays, location, "must be a valid calendar timestamp with explicit +08:00 offset");
  return timestamp;
}

// Only punctuation/whitespace are insignificant; digits and all spoken characters remain evidence.
function normalized(value: string): string {
  return value.replace(/[\p{P}\p{White_Space}]/gu, "");
}

function subtitleTimestamp(milliseconds: number): string {
  const hours = String(Math.floor(milliseconds / 3600000)).padStart(2, "0");
  const minutes = String(Math.floor(milliseconds / 60000) % 60).padStart(2, "0");
  const seconds = String(Math.floor(milliseconds / 1000) % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds},${String(milliseconds % 1000).padStart(3, "0")}`;
}

function unique(values: string[], location: string): void {
  requireValid(new Set(values).size === values.length, location, `duplicate ${location} values are not allowed`);
}

function containedPath(root: string, value: unknown, location: string): string {
  const path = text(value, location);
  const result = resolve(root, path);
  const local = relative(root, result);
  requireValid(!isAbsolute(path) && !win32.isAbsolute(path) && local !== "" && local !== ".." && !local.startsWith(`..\\`) && !local.startsWith("../") && !isAbsolute(local), location, "must be a relative path contained within the project root");
  return result;
}

async function existingAsset(root: string, value: unknown, location: string): Promise<{ path: string; size_bytes: number; sha256: string }> {
  const path = containedPath(root, value, location);
  let physicalPath: string;
  try {
    // The JS realpath implementation also works in Windows file sandboxes that deny the native API.
    physicalPath = realpathSync(path);
    const info = await stat(physicalPath);
    requireValid(info.isFile() && info.size > 0, location, `asset "${path}" must be a nonempty regular file`);
  } catch (error) {
    throw new Error(`Invalid demo data at ${location}: audio/asset "${path}" must exist as a nonempty file`, { cause: error });
  }
  const physicalRoot = realpathSync(root);
  const local = relative(physicalRoot, physicalPath);
  requireValid(local !== ".." && !local.startsWith(`..\\`) && !local.startsWith("../") && !isAbsolute(local), location, "asset real path must remain contained within the project root");
  const bytes = await readFile(physicalPath);
  return { path, size_bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function parseRecording(value: unknown, index: number, root: string): Recording {
  const location = `recordings[${index}]`;
  const row = object(value, location);
  exactFields(row, ["recording_id", "started_at", "audio_path", "transcript_segments"], location);
  const recordingId = text(row.recording_id, `${location}.recording_id`);
  const startedAt = validBeijingTime(row.started_at, `${location}.started_at`);
  const audioPath = text(row.audio_path, `${location}.audio_path`);
  containedPath(root, audioPath, `${location}.audio_path`);
  const segments = rows(row.transcript_segments, `${location}.transcript_segments`);
  requireValid(segments.length > 0, `${location}.transcript_segments`, "must contain at least one segment");
  let previousEnd = 0;
  const parsedSegments = segments.map((value, segmentIndex): TranscriptSegment => {
    const where = `${location}.transcript_segments[${segmentIndex}]`;
    const segment = object(value, where);
    exactFields(segment, ["start_ms", "end_ms", "text"], where);
    const start = segment.start_ms;
    const end = segment.end_ms;
    requireValid(typeof start === "number" && Number.isSafeInteger(start) && typeof end === "number" && Number.isSafeInteger(end) && start >= previousEnd && start >= 0 && end > start, where, "times must be monotonic integer milliseconds with 0 <= start_ms < end_ms and no overlap");
    previousEnd = end;
    const segmentText = text(segment.text, `${where}.text`);
    requireValid(normalized(segmentText).length > 0, `${where}.text`, "must contain spoken characters");
    return { start_ms: start, end_ms: end, text: segmentText };
  });
  return { recording_id: recordingId, started_at: startedAt, audio_path: audioPath, transcript_segments: parsedSegments };
}

function finiteMetric(value: unknown, location: string): number {
  requireValid(typeof value === "number" && Number.isFinite(value), location, "must be a finite number");
  return value;
}

function decodeAudio(root: string, recordings: Recording[]): DecodedAudio[] {
  const python = join(root, ".venv-audio", "Scripts", "python.exe");
  const script = join(root, "scripts", "generate-audio.py");
  const child = spawnSync(python, [script, "--inspect", ...recordings.map((recording) => recording.audio_path)], {
    cwd: root,
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  requireValid(!child.error && child.status === 0, "audio decoder", `ffmpeg inspection failed: ${child.error?.message ?? child.stderr.trim() ?? "unknown decoder failure"}`);
  let parsed: Record<string, unknown>;
  try {
    parsed = object(JSON.parse(child.stdout) as unknown, "audio decoder");
  } catch (error) {
    throw new Error("Audio decoder did not return valid JSON", { cause: error });
  }
  requireValid(parsed.schema_version === 1 && parsed.decoder === "ffmpeg", "audio decoder", "must report schema_version 1 and real ffmpeg decoding");
  const decoded = rows(parsed.recordings, "audio decoder.recordings").map((value, index): DecodedAudio => {
    const where = `audio decoder.recordings[${index}]`;
    const row = object(value, where);
    const duration = finiteMetric(row.duration_ms, `${where}.duration_ms`);
    requireValid(Number.isSafeInteger(duration) && duration >= 5000 && duration <= 20000, `${where}.duration_ms`, "decoded duration must be 5–20 seconds");
    const sampleRate = finiteMetric(row.sample_rate, `${where}.sample_rate`);
    const channels = finiteMetric(row.channels, `${where}.channels`);
    const frames = finiteMetric(row.decoded_frames, `${where}.decoded_frames`);
    requireValid(Number.isSafeInteger(sampleRate) && sampleRate >= 8000 && Number.isSafeInteger(channels) && channels > 0 && Number.isSafeInteger(frames) && frames > 0, where, "must contain decoded PCM samples with valid sample_rate, channels and decoded_frames");
    requireValid(Math.abs(Math.round(frames / sampleRate * 1000) - duration) <= 1, where, "duration_ms must agree with decoded PCM frame count");
    const rms = finiteMetric(row.rms, `${where}.rms`);
    const amplitudeStd = finiteMetric(row.amplitude_std, `${where}.amplitude_std`);
    const min = finiteMetric(row.min_sample, `${where}.min_sample`);
    const max = finiteMetric(row.max_sample, `${where}.max_sample`);
    requireValid(row.non_silent === true && rms > 0.0001 && amplitudeStd > 0.0001 && min < max, where, "decoded PCM must be non-silent with nonzero amplitude variation");
    const sha = text(row.sha256, `${where}.sha256`);
    requireValid(/^[a-f0-9]{64}$/.test(sha), `${where}.sha256`, "must be a SHA-256 digest");
    const size = finiteMetric(row.size_bytes, `${where}.size_bytes`);
    requireValid(Number.isSafeInteger(size) && size > 0, `${where}.size_bytes`, "must be a positive integer");
    return { audio_path: text(row.audio_path, `${where}.audio_path`), duration_ms: duration, sample_rate: sampleRate, channels, decoded_frames: frames, rms, amplitude_std: amplitudeStd, min_sample: min, max_sample: max, non_silent: true, sha256: sha, size_bytes: size };
  });
  requireValid(decoded.length === recordings.length, "audio decoder.recordings", "must inspect every recording exactly once");
  unique(decoded.map((row) => row.audio_path), "decoded audio_path");
  return decoded;
}

/** Validate source data and real audio; independent scenario expectations are read only by tests. */
export async function validateDemoData(projectRoot: string = defaultProjectRoot): Promise<DemoDataSummary> {
  const root = resolve(projectRoot);
  const ordersPath = join(root, "data", "orders.json");
  const orderEnvelope = envelope(await json(ordersPath), "orders.json");
  const rawOrders = rows(orderEnvelope.orders, "orders");
  requireValid(rawOrders.length >= 6, "orders", "must contain at least 6 orders");
  // The repository validates every row even if the requested date has no results.
  await queryOrdersByDate("0001-01-01", ordersPath);
  const dates = [...new Set(rawOrders.map((value) => String(object(value, "orders").handled_at).slice(0, 10)))].sort();
  const ordersByDate: Record<string, number> = {};
  const orderIds: string[] = [];
  for (const date of dates) {
    const orders = await queryOrdersByDate(date, ordersPath);
    ordersByDate[date] = orders.length;
    orderIds.push(...orders.map((order) => order.order_id));
  }
  requireValid(orderIds.length === rawOrders.length, "orders", "all valid orders must be returned by their handled date");
  unique(orderIds, "order_id");

  const recordingEnvelope = envelope(await json(join(root, "data", "recordings.json")), "recordings.json");
  const rawRecordings = rows(recordingEnvelope.recordings, "recordings");
  requireValid(rawRecordings.length >= 6, "recordings", "must contain at least 6 recordings");
  const recordings = rawRecordings.map((value, index) => parseRecording(value, index, root));
  unique(recordings.map((row) => row.recording_id), "recording_id");
  unique(recordings.map((row) => row.audio_path), "audio_path");
  const transcripts = recordings.map((row) => normalized(row.transcript_segments.map((segment) => segment.text).join("")));
  requireValid(new Set(transcripts).size === transcripts.length, "transcripts", "all recording transcripts must be distinct");
  const assets = new Map<string, Awaited<ReturnType<typeof existingAsset>>>();
  for (const recording of recordings) assets.set(recording.recording_id, await existingAsset(root, recording.audio_path, `${recording.recording_id}.audio_path`));

  const manifest = envelope(await json(join(root, "data", "tts-manifest.json")), "tts-manifest.json");
  requireValid(manifest.schema_version === 1, "tts-manifest.schema_version", "must be 1");
  const manifestRows = rows(manifest.recordings, "tts-manifest.recordings").map((value) => object(value, "tts-manifest.recordings"));
  unique(manifestRows.map((row) => text(row.recording_id, "tts-manifest.recording_id")), "manifest recording_id");
  requireValid(manifestRows.length === recordings.length, "tts-manifest.recordings", "must describe every recording exactly once");

  const metadata = envelope(await json(join(root, "data", "audio-metadata.json")), "audio-metadata.json");
  requireValid(metadata.schema_version === 1 && metadata.tool === "edge-tts" && metadata.boundary === "SentenceBoundary", "audio-metadata", "must identify edge-tts SentenceBoundary generation with schema_version 1");
  const version = text(metadata.version, "audio-metadata.version");
  requireValid(text(metadata.voice, "audio-metadata.voice") === text(manifest.voice, "tts-manifest.voice") && text(metadata.rate, "audio-metadata.rate") === text(manifest.rate, "tts-manifest.rate"), "audio-metadata", "voice and rate must agree with the TTS manifest");
  const metadataRows = rows(metadata.recordings, "audio-metadata.recordings").map((value) => object(value, "audio-metadata.recordings"));
  unique(metadataRows.map((row) => text(row.recording_id, "audio-metadata.recording_id")), "metadata recording_id");
  requireValid(metadataRows.length === recordings.length, "audio-metadata.recordings", "must describe every recording exactly once");

  // One bounded subprocess decodes every asset; neither extensions nor hashes establish playable speech.
  const decoded = decodeAudio(root, recordings);
  const summaries: DemoDataSummary["recordings"] = [];
  const recordingsByDate: Record<string, number> = {};
  for (const recording of recordings) {
    const id = recording.recording_id;
    const source = manifestRows.find((row) => row.recording_id === id);
    const meta = metadataRows.find((row) => row.recording_id === id);
    const actual = decoded.find((row) => row.audio_path.replaceAll("\\", "/") === recording.audio_path.replaceAll("\\", "/"));
    requireValid(source && meta && actual, id, "must have matching manifest, metadata and decoded audio entries");
    const asset = assets.get(id)!;
    requireValid(source.audio_path === recording.audio_path && source.started_at === recording.started_at && meta.audio_path === recording.audio_path, id, "manifest and metadata must agree with the recording path and started_at");
    const sourceText = text(source.text, `${id}.manifest.text`);
    requireValid(normalized(sourceText) === normalized(recording.transcript_segments.map((segment) => segment.text).join("")), `${id}.transcript_segments`, "concatenated transcript must match manifest text after removing only punctuation and whitespace");
    requireValid(actual.sha256 === asset.sha256 && actual.size_bytes === asset.size_bytes && meta.sha256 === asset.sha256 && meta.size_bytes === asset.size_bytes, `${id}.audio-metadata`, "SHA-256 and size_bytes must agree with the actual audio file");
    for (const field of ["duration_ms", "sample_rate", "channels", "decoded_frames", "rms", "amplitude_std", "min_sample", "max_sample"] as const) {
      const value = finiteMetric(meta[field], `${id}.audio-metadata.${field}`);
      requireValid(Math.abs(value - actual[field]) < 0.000001, `${id}.audio-metadata.${field}`, "must agree with real decoded audio");
    }
    requireValid(meta.non_silent === true, `${id}.audio-metadata.non_silent`, "must agree with real non-silent audio");
    const input = { text: sourceText, voice: manifest.voice, rate: manifest.rate, tool_version: version, boundary: "SentenceBoundary", pipeline_version: 1 };
    const inputHash = createHash("sha256").update(`${JSON.stringify(input, null, 2)}\n`).digest("hex");
    requireValid(meta.input_sha256 === inputHash, `${id}.audio-metadata.input_sha256`, "must agree with the source text and generator settings");
    requireValid(meta.transcript_source === "service_sentence_boundary" && meta.timestamp_precision === "100ns service ticks, rounded outward to integer milliseconds", `${id}.audio-metadata`, "must document service-estimated sentence boundaries and outward millisecond rounding");

    const rawAsset = await existingAsset(root, meta.raw_alignment_path, `${id}.raw_alignment_path`);
    const subtitleAsset = await existingAsset(root, meta.subtitle_path, `${id}.subtitle_path`);
    const raw = object(await json(rawAsset.path), `${id}.raw_alignment`);
    requireValid(raw.schema_version === 1 && raw.tool === "edge-tts" && raw.version === version && raw.recording_id === id && raw.boundary === "SentenceBoundary" && raw.time_unit === "100ns", `${id}.raw_alignment`, "must identify the original service sentence boundary ticks");
    const events = rows(raw.events, `${id}.raw_alignment.events`);
    requireValid(events.length === recording.transcript_segments.length && meta.boundary_count === events.length, `${id}.raw_alignment.events`, "event and segment counts must agree");
    for (const [index, segment] of recording.transcript_segments.entries()) {
      const where = `${id}.transcript_segments[${index}]`;
      requireValid(segment.end_ms <= actual.duration_ms, where, "end_ms must not exceed actual decoded duration_ms");
      const event = object(events[index], `${id}.raw_alignment.events[${index}]`);
      const offset = event.offset;
      const duration = event.duration;
      requireValid(event.type === "SentenceBoundary" && typeof offset === "number" && Number.isSafeInteger(offset) && offset >= 0 && typeof duration === "number" && Number.isSafeInteger(duration) && duration > 0 && Number.isSafeInteger(offset + duration), where, "raw boundary must contain valid integer 100ns offset/duration ticks");
      requireValid(segment.start_ms === Math.floor(offset / 10000) && segment.end_ms === Math.ceil((offset + duration) / 10000), where, "timestamps must come from raw service boundary ticks rounded outward, without invented offsets");
      requireValid(normalized(text(event.text, `${where}.raw.text`)) === normalized(segment.text), where, "text must agree with its raw service boundary after punctuation/whitespace normalization");
    }
    const expectedSubtitle = recording.transcript_segments.map((segment, index) => `${index + 1}\n${subtitleTimestamp(segment.start_ms)} --> ${subtitleTimestamp(segment.end_ms)}\n${segment.text}`).join("\n\n") + "\n";
    const actualSubtitle = (await readFile(subtitleAsset.path, "utf8")).replaceAll("\r\n", "\n");
    requireValid(actualSubtitle === expectedSubtitle, `${id}.subtitle_path`, "subtitle cue times and text must exactly agree with transcript_segments");
    const date = recording.started_at.slice(0, 10);
    recordingsByDate[date] = (recordingsByDate[date] ?? 0) + 1;
    summaries.push({ recording_id: id, ...actual });
  }
  return {
    data_source: "synthetic demo data", hotel: "Demo Hotel", time_zone: "Asia/Shanghai",
    orders_count: orderIds.length, recordings_count: recordings.length,
    orders_by_handled_date: ordersByDate, recordings_by_started_date: recordingsByDate,
    decoder: "ffmpeg", alignment: "Service-estimated SentenceBoundary alignment; 100ns tick representation rounded outward to integer milliseconds, not physical timing accuracy.",
    recordings: summaries,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await validateDemoData(), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
