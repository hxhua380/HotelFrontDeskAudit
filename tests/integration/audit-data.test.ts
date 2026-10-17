import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditDay } from "../../src/domain/audit.js";
import { queryOrdersByDate, queryRecordingsByDate } from "../../src/data/repository.js";
import type { AuditStatus, DetailedAuditResult, Order, Recording } from "../../src/domain/types.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const cache = join(root, ".cache", "stage3-tests");
const originalOrders = (JSON.parse(await readFile(join(root, "data/orders.json"), "utf8")) as { orders: Order[] }).orders;
const originalRecordings = (JSON.parse(await readFile(join(root, "data/recordings.json"), "utf8")) as { recordings: Recording[] }).recordings;
const fixturePath = join(root, "tests/fixtures/expected_results.json");
interface ExpectedCase {
  case_id: string;
  order_id: string | null;
  recording_id: string | null;
  expected_status: AuditStatus;
  expected_conflicting_fields: string[];
  candidate_order_ids: string[];
  candidate_recording_ids: string[];
}
// 评价器只存在于测试侧：先按完整候选集合定位结果，再独立比较状态与冲突。
const expected = (JSON.parse(await readFile(fixturePath, "utf8")) as { cases: ExpectedCase[] }).cases;
const setKey = (ids: string[]) => JSON.stringify([...ids].sort());
function evaluate(predictions: DetailedAuditResult[]) {
  return expected.map((item) => {
    const actual = predictions.filter((result) => setKey(result.candidate_order_ids) === setKey(item.candidate_order_ids)
      && setKey(result.candidate_recording_ids) === setKey(item.candidate_recording_ids));
    const result = actual[0];
    const differences: string[] = [];
    if (actual.length !== 1) differences.push(`expected one group, got ${actual.length}`);
    if (result?.status !== item.expected_status) differences.push(`status: ${result?.status} != ${item.expected_status}`);
    if (result?.order_id !== item.order_id || result?.recording_id !== item.recording_id) differences.push("scalar candidate IDs differ");
    if (setKey(result?.conflicting_fields ?? []) !== setKey(item.expected_conflicting_fields)) differences.push("conflicting_fields differ");
    return { case_id: item.case_id, expected_status: item.expected_status, predicted_status: result?.status ?? null, passed: differences.length === 0, differences };
  });
}
let temp: string;
let recordingsFile: string;
const protectedPaths = ["data/orders.json", "data/recordings.json", "data/tts-manifest.json", "data/audio-metadata.json", "tests/fixtures/expected_results.json",
  ...originalRecordings.flatMap((recording) => [recording.audio_path, recording.audio_path.replace(".mp3", ".srt"), recording.audio_path.replace(".mp3", ".boundaries.json")])];
async function hashes() {
  return Promise.all(protectedPaths.map(async (path) => [path, createHash("sha256").update(await readFile(join(root, path))).digest("hex")]));
}
let beforeHashes: string[][];
beforeAll(async () => { await mkdir(cache, { recursive: true }); beforeHashes = await hashes(); });
beforeEach(async () => {
  temp = await mkdtemp(join(cache, "case-"));
  recordingsFile = join(temp, "recordings.json");
});
afterEach(async () => {
  const path = resolve(temp);
  const scoped = relative(cache, path);
  if (!scoped || scoped.startsWith("..") || isAbsolute(scoped)) throw new Error("Refusing unscoped test cleanup");
  await rm(path, { recursive: true, force: true });
});
afterAll(async () => { expect(await hashes()).toEqual(beforeHashes); });

async function localRecording(): Promise<Recording> {
  const recording = structuredClone(originalRecordings[0]!);
  await mkdir(join(temp, "audio"), { recursive: true });
  await copyFile(join(root, recording.audio_path), join(temp, "audio", "clip.mp3"));
  recording.audio_path = "audio/clip.mp3";
  return recording;
}
async function saveRecordings(recordings: unknown[]) {
  await writeFile(recordingsFile, JSON.stringify({ data_source: "synthetic demo data", hotel: "Demo Hotel", time_zone: "Asia/Shanghai", recordings }), "utf8");
}

describe("recording repository integrity", () => {
  it("reads seven and one real playable-file references by recording date", async () => {
    expect(await queryOrdersByDate("2026-10-15")).toHaveLength(7);
    expect((await queryRecordingsByDate("2026-10-15")).recordings).toHaveLength(7);
    const next = await queryRecordingsByDate("2026-10-16");
    expect(next.recordings.map((recording) => recording.recording_id)).toEqual(["R008"]);
    expect(next.warnings).toEqual([]);
    expect((await queryRecordingsByDate("2026-10-18")).recordings).toEqual([]);
  });
  it.each(["2026-1-5", "2026-02-30", "0000-01-01"])("rejects invalid query date %s", async (date) => {
    await expect(queryRecordingsByDate(date)).rejects.toThrow(/date/i);
  });
  it("rereads metadata after deletion rather than serving the old recording", async () => {
    const recording = await localRecording();
    await saveRecordings([recording]);
    expect((await queryRecordingsByDate("2026-10-15", recordingsFile, temp)).recordings).toHaveLength(1);
    await saveRecordings([]);
    const query = await queryRecordingsByDate("2026-10-15", recordingsFile, temp);
    expect(query.recordings).toEqual([]);
    expect(auditDay([originalOrders[0]!], query.recordings, "2026-10-15")[0]?.status).toBe("missing_recording");
  });
  it("missing MP3 produces a warning and missing_recording instead of an old matched result", async () => {
    const recording = await localRecording();
    await saveRecordings([recording]);
    const valid = await queryRecordingsByDate("2026-10-15", recordingsFile, temp);
    expect(auditDay([originalOrders[0]!], valid.recordings, "2026-10-15")[0]?.status).toBe("matched");
    await rm(join(temp, "audio/clip.mp3"));
    const missing = await queryRecordingsByDate("2026-10-15", recordingsFile, temp);
    expect(missing.recordings).toEqual([]);
    expect(missing.warnings).toEqual([expect.objectContaining({ code: "audio_missing", recording_id: recording.recording_id })]);
    const results = auditDay([originalOrders[0]!], missing.recordings, "2026-10-15", { data_warnings: missing.warnings });
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("missing_recording");
    expect(results[0]?.evidence).toEqual([]);
    expect(results[0]?.data_warnings).toHaveLength(1);
  });
  it("a directory cannot be returned as playable audio", async () => {
    const recording = await localRecording();
    await rm(join(temp, "audio/clip.mp3"));
    await mkdir(join(temp, "audio/clip.mp3"));
    await saveRecordings([recording]);
    const result = await queryRecordingsByDate("2026-10-15", recordingsFile, temp);
    expect(result.recordings).toEqual([]);
    expect(result.warnings[0]?.code).toBe("audio_not_file");
  });
  it.each(["../outside.mp3", "C:\\outside.mp3", "/outside.mp3", "https://example.com/x.mp3", "C:relative.mp3"])("rejects illegal audio path %s", async (audio_path) => {
    const recording = await localRecording();
    await saveRecordings([{ ...recording, audio_path }]);
    await expect(queryRecordingsByDate("2026-10-15", recordingsFile, temp)).rejects.toThrow(/path|路径/i);
  });
  it("rejects malformed JSON clearly", async () => {
    await writeFile(recordingsFile, "{broken", "utf8");
    await expect(queryRecordingsByDate("2026-10-15", recordingsFile, temp)).rejects.toThrow(/JSON/);
  });
  it("rejects a missing leaf whose existing linked parent resolves outside the audio root", async () => {
    const recording = await localRecording();
    await saveRecordings([{ ...recording, audio_path: "audio-link/absent.mp3" }]);
    const linkedParent = join(temp, "audio-link");
    const missingLeaf = join(linkedParent, "absent.mp3");
    // 沙箱不允许创建 Windows junction；只模拟该链接的两次 realpath 系统结果。
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return { ...actual, realpathSync(path: string) {
        if (path === missingLeaf) throw Object.assign(new Error("missing leaf"), { code: "ENOENT" });
        if (path === linkedParent) return join(root, ".cache", "outside-this-audio-root");
        return actual.realpathSync(path);
      } };
    });
    vi.resetModules();
    try {
      const repository = await import("../../src/data/repository.js");
      await expect(repository.queryRecordingsByDate("2026-10-15", recordingsFile, temp)).rejects.toThrow(/path|路径/i);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });
  it("rejects invalid metadata rows and impossible recording dates", async () => {
    await saveRecordings([{ recording_id: "bad" }]);
    await expect(queryRecordingsByDate("2026-10-15", recordingsFile, temp)).rejects.toThrow(/recordings\[0\]/);
    const recording = await localRecording();
    await saveRecordings([{ ...recording, started_at: "2026-02-30T14:05:02+08:00" }]);
    await expect(queryRecordingsByDate("2026-10-15", recordingsFile, temp)).rejects.toThrow(/started_at/);
  });
});

describe("independent Stage 2 evaluation", () => {
  it("predicts all eight protected cases without production access to the expected file", async () => {
    const predictions = ["2026-10-15", "2026-10-16"].flatMap((date) => auditDay(originalOrders, originalRecordings, date));
    const evaluation = evaluate(predictions);
    await writeFile(join(root, ".cache/stage3-evaluation.json"), JSON.stringify({ predictions, evaluation }, null, 2), "utf8");
    expect(evaluation).toHaveLength(8);
    expect(evaluation.filter((item) => !item.passed)).toEqual([]);
    expect(predictions).toHaveLength(8);
    expect(new Set(predictions.map((result) => result.status)).size).toBe(5);
    const mismatch = predictions.find((result) => result.status === "field_mismatch");
    expect(mismatch?.conflicts).toEqual([expect.objectContaining({ field: "amount_cents", order_value: 75600, recording_value: 79600 })]);
    for (const result of predictions) for (const evidence of result.evidence) {
      const source = originalRecordings.find((recording) => recording.recording_id === evidence.recording_id)?.transcript_segments[evidence.segment_index];
      expect(source).toBeDefined();
      expect(evidence).toMatchObject({ text: source!.text, start_ms: source!.start_ms, end_ms: source!.end_ms });
    }
  });
  it("the independent evaluator detects altered predictions", () => {
    const predictions = ["2026-10-15", "2026-10-16"].flatMap((date) => auditDay(originalOrders, originalRecordings, date));
    predictions[0]!.status = predictions[0]!.status === "matched" ? "needs_review" : "matched";
    expect(evaluate(predictions).some((item) => !item.passed)).toBe(true);
  });
  it("production modules and audit CLI never import fixtures, case labels or fixed demo ID pairs", async () => {
    for (const path of ["src/domain/audit.ts", "src/domain/transcript.ts", "src/data/repository.ts", "src/agent/tools.ts", "scripts/audit-day.ts"]) {
      const source = await readFile(join(root, path), "utf8");
      expect(source).not.toMatch(/expected_results|tests[\\/]fixtures|case_id|expected_status|["'`]O00[1-8]["'`]|["'`]R00[1-8]["'`]/);
    }
  });
  it("CLI runs offline from an unrelated cwd and rejects invalid dates", () => {
    const script = join(root, "scripts/audit-day.ts");
    const loader = pathToFileURL(join(root, "node_modules/tsx/dist/loader.mjs")).href;
    const child = spawnSync(process.execPath, ["--import", loader, script, "2026-10-16"], { cwd: temp, encoding: "utf8", timeout: 15000 });
    expect(child.status, child.stderr).toBe(0);
    const output = JSON.parse(child.stdout) as { date: string; results: DetailedAuditResult[] };
    expect(output.date).toBe("2026-10-16");
    expect(output.results).toHaveLength(1);
    expect(output.results[0]?.status).toBe("matched");
    const invalid = spawnSync(process.execPath, ["--import", loader, script, "2026-02-30"], { cwd: root, encoding: "utf8", timeout: 15000 });
    expect(invalid.status).not.toBe(0);
  });
});

describe("content-driven dynamic changes on copies", () => {
  it("changing order amount changes matched to field_mismatch", () => {
    const orders = structuredClone(originalOrders);
    orders[0]!.amount_cents += 1000;
    const result = auditDay(orders, originalRecordings, "2026-10-15").find((item) => item.order_id === orders[0]!.order_id);
    expect(result?.status).toBe("field_mismatch");
    expect(result?.conflicts).toEqual([expect.objectContaining({ field: "amount_cents", order_value: 40800, recording_value: 39800 })]);
  });
  it("removing recording metadata creates missing_recording without cached output", () => {
    const recordings = originalRecordings.filter((recording) => recording.recording_id !== originalRecordings[0]!.recording_id);
    const result = auditDay(originalOrders, recordings, "2026-10-15").find((item) => item.order_id === originalOrders[0]!.order_id);
    expect(result?.status).toBe("missing_recording");
    expect(result?.evidence).toEqual([]);
  });
  it("switches dates using event dates, not the stay date", () => {
    expect(auditDay(originalOrders, originalRecordings, "2026-10-16")).toHaveLength(1);
    expect(auditDay(originalOrders, originalRecordings, "2026-10-18")).toEqual([]);
  });
  it("renaming every ID preserves case structure after inverse relabeling", () => {
    const orders = structuredClone(originalOrders);
    const recordings = structuredClone(originalRecordings);
    const orderMap = new Map(orders.map((order, index) => [order.order_id, `booking-${91 - index}`]));
    const recordingMap = new Map(recordings.map((recording, index) => [recording.recording_id, `voice-${207 + index * 13}`]));
    orders.forEach((order) => { order.order_id = orderMap.get(order.order_id)!; });
    recordings.forEach((recording) => { recording.recording_id = recordingMap.get(recording.recording_id)!; });
    const inverseOrders = new Map([...orderMap].map(([oldId, newId]) => [newId, oldId]));
    const inverseRecordings = new Map([...recordingMap].map(([oldId, newId]) => [newId, oldId]));
    const predictions = ["2026-10-15", "2026-10-16"].flatMap((date) => auditDay(orders.reverse(), recordings.reverse(), date));
    const normalized = predictions.map((result) => ({ ...result,
      order_id: result.order_id === null ? null : inverseOrders.get(result.order_id)!,
      recording_id: result.recording_id === null ? null : inverseRecordings.get(result.recording_id)!,
      candidate_order_ids: result.candidate_order_ids.map((id) => inverseOrders.get(id)!),
      candidate_recording_ids: result.candidate_recording_ids.map((id) => inverseRecordings.get(id)!),
    }));
    expect(evaluate(normalized).every((item) => item.passed)).toBe(true);
  });
  it("moving a recording beyond the window creates separate missing and orphan results", () => {
    const recordings = structuredClone(originalRecordings);
    recordings[0]!.started_at = "2026-10-15T13:45:00+08:00";
    const results = auditDay(originalOrders, recordings, "2026-10-15");
    expect(results.find((item) => item.order_id === originalOrders[0]!.order_id)?.status).toBe("missing_recording");
    expect(results.find((item) => item.recording_id === recordings[0]!.recording_id)?.status).toBe("orphan_recording");
  });
  it("removing the spoken amount cannot remain matched or invent a mismatch", () => {
    const recordings = structuredClone(originalRecordings);
    recordings[0]!.transcript_segments[0]!.text = recordings[0]!.transcript_segments[0]!.text.replace("房费合计三百九十八元，", "");
    const result = auditDay(originalOrders, recordings, "2026-10-15").find((item) => item.order_id === originalOrders[0]!.order_id);
    expect(result?.status).toBe("needs_review");
    expect(result?.conflicting_fields).toEqual([]);
  });
});
