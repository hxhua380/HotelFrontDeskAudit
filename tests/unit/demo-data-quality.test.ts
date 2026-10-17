import { spawnSync } from "node:child_process";
import { cp, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { validateDemoData } from "../../scripts/validate-demo-data.js";
import { queryOrdersByDate } from "../../src/data/repository.js";
import type { AuditStatus, Order, Recording } from "../../src/domain/types.js";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixtureRoot = join(projectRoot, ".cache", "tests");
let fixtureDirectory: string;

interface ExpectedCase {
  case_id: string;
  order_id: string | null;
  recording_id: string | null;
  expected_status: AuditStatus;
  expected_conflicting_fields: (keyof Order)[];
  expected_reason: string;
  scenario_description: string;
  ambiguity: boolean;
  candidate_order_ids: string[];
  candidate_recording_ids: string[];
  evidence: { recording_id: string; segment_indexes: number[]; start_ms: number; end_ms: number; quote: string; fields: string[]; note: string }[];
  missing_evidence_fields?: string[];
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function cloneActualData(): Promise<void> {
  await cp(join(projectRoot, "data"), join(fixtureDirectory, "data"), { recursive: true });
  await cp(join(projectRoot, "audio"), join(fixtureDirectory, "audio"), { recursive: true });
  await mkdir(join(fixtureDirectory, "scripts"), { recursive: true });
  await copyFile(join(projectRoot, "scripts", "generate-audio.py"), join(fixtureDirectory, "scripts", "generate-audio.py"));
  // Copy only the launcher; a .pth file reuses installed packages without junction privileges.
  const fixtureVenv = join(fixtureDirectory, ".venv-audio");
  const actualVenv = join(projectRoot, ".venv-audio");
  await mkdir(join(fixtureVenv, "Scripts"), { recursive: true });
  await mkdir(join(fixtureVenv, "Lib", "site-packages"), { recursive: true });
  await copyFile(join(actualVenv, "Scripts", "python.exe"), join(fixtureVenv, "Scripts", "python.exe"));
  await copyFile(join(actualVenv, "pyvenv.cfg"), join(fixtureVenv, "pyvenv.cfg"));
  await writeFile(join(fixtureVenv, "Lib", "site-packages", "demo-test-packages.pth"), `${join(actualVenv, "Lib", "site-packages")}\n`, "utf8");
}

async function updateRecordings(change: (recordings: Recording[]) => void): Promise<void> {
  const path = join(fixtureDirectory, "data", "recordings.json");
  const contents = await readJson<{ recordings: Recording[] }>(path);
  change(contents.recordings);
  await writeJson(path, contents);
}

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== "__pycache__") files.push(...await sourceFiles(path));
    else if (entry.isFile() && /\.(?:ts|js|py)$/.test(entry.name)) files.push(path);
  }
  return files;
}

function makeOrders(): Order[] {
  return Array.from({ length: 6 }, (_, index) => ({
    order_id: `TEST-O${index}`,
    handled_at: "2026-10-15T14:05:00+08:00",
    room_number: String(800 + index),
    room_type: "大床房",
    check_in_date: "2026-10-15",
    check_out_date: "2026-10-16",
    amount_cents: 39800,
    currency: "CNY",
  }));
}

function makeRecordings(): Recording[] {
  return Array.from({ length: 6 }, (_, index) => ({
    recording_id: `TEST-R${index}`,
    started_at: "2026-10-15T14:05:00+08:00",
    audio_path: `audio/TEST-R${index}.mp3`,
    transcript_segments: [{ start_ms: 0, end_ms: 5000, text: `第${index}位客人的入住信息。` }],
  }));
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeMinimalData(recordings: unknown[]): Promise<void> {
  await mkdir(join(fixtureDirectory, "data"), { recursive: true });
  const envelope = { data_source: "synthetic demo data", hotel: "Demo Hotel", time_zone: "Asia/Shanghai" };
  await writeJson(join(fixtureDirectory, "data", "orders.json"), { ...envelope, orders: makeOrders() });
  await writeJson(join(fixtureDirectory, "data", "recordings.json"), { ...envelope, recordings });
}

beforeAll(async () => {
  await mkdir(fixtureRoot, { recursive: true });
});

beforeEach(async () => {
  fixtureDirectory = await mkdtemp(join(fixtureRoot, "demo-quality-"));
});

afterEach(async () => {
  const target = resolve(fixtureDirectory);
  const scopedPath = relative(resolve(fixtureRoot), target);
  if (!scopedPath || scopedPath.startsWith("..") || isAbsolute(scopedPath)) {
    throw new Error(`Refusing to remove an unscoped test directory: ${target}`);
  }
  await rm(target, { recursive: true, force: true });
});

describe("demo data quality", () => {
  it("decodes eight real demo recordings with complete date buckets from its module-relative default", async () => {
    const summary = await validateDemoData();
    expect(summary.orders_count).toBe(8);
    expect(summary.recordings_count).toBe(8);
    expect(summary.orders_by_handled_date).toEqual({ "2026-10-15": 7, "2026-10-16": 1 });
    expect(summary.recordings_by_started_date).toEqual({ "2026-10-15": 7, "2026-10-16": 1 });
    expect(summary.decoder).toBe("ffmpeg");
    expect(summary.recordings).toHaveLength(8);
    expect(new Set(summary.recordings.map((recording) => recording.sha256)).size).toBe(8);
    for (const recording of summary.recordings) {
      expect(recording.duration_ms).toBeGreaterThanOrEqual(5000);
      expect(recording.duration_ms).toBeLessThanOrEqual(20000);
      expect(recording.non_silent).toBe(true);
      expect(recording.amplitude_std).toBeGreaterThan(0.001);
      expect(recording.decoded_frames).toBeGreaterThan(0);
    }
  }, 30000);

  it("rejects an empty recordings dataset before considering audio metadata", async () => {
    await writeMinimalData([]);
    await expect(validateDemoData(fixtureDirectory)).rejects.toThrow(/recordings.*at least 6/i);
  });

  it("rejects missing audio files even when their paths end with mp3", async () => {
    await writeMinimalData(makeRecordings());
    await expect(validateDemoData(fixtureDirectory)).rejects.toThrow(/audio.*TEST-R0.*exist/i);
  });

  it("rejects duplicate recording identifiers", async () => {
    const recordings = makeRecordings();
    recordings[1]!.recording_id = recordings[0]!.recording_id;
    await writeMinimalData(recordings);
    await expect(validateDemoData(fixtureDirectory)).rejects.toThrow(/duplicate.*recording_id/i);
  });

  it("rejects duplicate order identifiers through the production repository", async () => {
    await writeMinimalData(makeRecordings());
    const orders = makeOrders();
    orders[1]!.order_id = orders[0]!.order_id;
    await writeJson(join(fixtureDirectory, "data", "orders.json"), {
      data_source: "synthetic demo data", hotel: "Demo Hotel", time_zone: "Asia/Shanghai", orders,
    });
    await expect(validateDemoData(fixtureDirectory)).rejects.toThrow(/duplicate.*order_id/i);
  });

  it.each([
    ["2026-02-30T14:05:00+08:00"],
    ["2026-10-15T14:05:00Z"],
    ["2026-10-15T24:05:00+08:00"],
  ])("rejects invalid Beijing recording timestamp %s", async (startedAt) => {
    const recordings = makeRecordings();
    recordings[0]!.started_at = startedAt;
    await writeMinimalData(recordings);
    await expect(validateDemoData(fixtureDirectory)).rejects.toThrow(/started_at.*valid.*\+08:00/i);
  });

  it.each(["../outside.mp3", "C:\\outside.mp3", "/outside.mp3"])("rejects escaping or absolute audio path %s", async (audioPath) => {
    const recordings = makeRecordings();
    recordings[0]!.audio_path = audioPath;
    await writeMinimalData(recordings);
    await expect(validateDemoData(fixtureDirectory)).rejects.toThrow(/audio_path.*relative.*contained/i);
  });

  it("rejects extra fields in the frozen Recording interface", async () => {
    const recordings = makeRecordings();
    await writeMinimalData([{ ...recordings[0], expected_status: "matched" }, ...recordings.slice(1)]);
    await expect(validateDemoData(fixtureDirectory)).rejects.toThrow(/recordings\[0\].*exact.*fields/i);
  });

  it.each([
    [{ start_ms: -1, end_ms: 3000, text: "你好。" }],
    [{ start_ms: 0, end_ms: 0, text: "你好。" }],
    [{ start_ms: 0.5, end_ms: 3000, text: "你好。" }],
    [{ start_ms: 1000, end_ms: 3000, text: "你好。" }, { start_ms: 2000, end_ms: 4000, text: "再见。" }],
    [{ start_ms: 0, end_ms: 3000, text: " " }],
  ])("rejects invalid or overlapping transcript timing/text %#", async (...segments) => {
    const recordings = makeRecordings();
    recordings[0]!.transcript_segments = segments;
    await writeMinimalData(recordings);
    await expect(validateDemoData(fixtureDirectory)).rejects.toThrow(/transcript_segments/i);
  });

  it("rejects repeated transcript content even when punctuation differs", async () => {
    const recordings = makeRecordings();
    recordings[1]!.transcript_segments[0]!.text = recordings[0]!.transcript_segments[0]!.text.replace("。", "！");
    await writeMinimalData(recordings);
    await expect(validateDemoData(fixtureDirectory)).rejects.toThrow(/transcript.*distinct/i);
  });

  it("locates real data and the decoder when invoked from a different working directory", () => {
    const validatorUrl = pathToFileURL(join(projectRoot, "scripts", "validate-demo-data.ts")).href;
    const script = `const {validateDemoData} = await import(${JSON.stringify(validatorUrl)}); const summary = await validateDemoData(); console.log(JSON.stringify({orders:summary.orders_count,recordings:summary.recordings_count}));`;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: fixtureDirectory, encoding: "utf8", timeout: 30000, windowsHide: true,
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout) as unknown).toEqual({ orders: 8, recordings: 8 });
  }, 30000);

  it("rejects a text file disguised as mp3 using the real decoder", async () => {
    await cloneActualData();
    await writeFile(join(fixtureDirectory, "audio", "R001.mp3"), "ID3 this is not decodable speech", "utf8");
    await expect(validateDemoData(fixtureDirectory)).rejects.toThrow(/audio decoder.*ffmpeg inspection failed/i);
  }, 30000);

  it("rejects an actual six-second silent mp3 using decoded amplitude", async () => {
    await cloneActualData();
    const pythonScript = "import imageio_ffmpeg,subprocess,sys; subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(),'-v','error','-y','-f','lavfi','-i','anullsrc=r=24000:cl=mono','-t','6','-c:a','libmp3lame',sys.argv[1]],check=True,timeout=15)";
    const child = spawnSync(join(projectRoot, ".venv-audio", "Scripts", "python.exe"), ["-c", pythonScript, join(fixtureDirectory, "audio", "R001.mp3")], {
      encoding: "utf8", timeout: 20000, windowsHide: true,
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    await expect(validateDemoData(fixtureDirectory)).rejects.toThrow(/audio decoder[\s\S]*silent or constant/i);
  }, 30000);

  it("rejects metadata that disagrees with decoded duration", async () => {
    await cloneActualData();
    const path = join(fixtureDirectory, "data", "audio-metadata.json");
    const metadata = await readJson<{ recordings: { duration_ms: number }[] }>(path);
    metadata.recordings[0]!.duration_ms += 50;
    await writeJson(path, metadata);
    await expect(validateDemoData(fixtureDirectory)).rejects.toThrow(/audio-metadata.duration_ms.*real decoded audio/i);
  }, 30000);

  it("rejects metadata that disagrees with the actual audio hash", async () => {
    await cloneActualData();
    const path = join(fixtureDirectory, "data", "audio-metadata.json");
    const metadata = await readJson<{ recordings: { sha256: string }[] }>(path);
    metadata.recordings[0]!.sha256 = "0".repeat(64);
    await writeJson(path, metadata);
    await expect(validateDemoData(fixtureDirectory)).rejects.toThrow(/SHA-256.*actual audio file/i);
  }, 30000);

  it("rejects a stale nonempty SRT whose cue times and text disagree with transcript segments", async () => {
    await cloneActualData();
    await writeFile(join(fixtureDirectory, "audio", "R001.srt"), "1\n00:00:00,000 --> 00:00:01,000\n这条字幕已过期。\n", "utf8");
    await expect(validateDemoData(fixtureDirectory)).rejects.toThrow(/subtitle.*cue times and text.*transcript_segments/i);
  }, 30000);

  it("rejects changed spoken characters rather than normalizing them away", async () => {
    await cloneActualData();
    await updateRecordings((recordings) => {
      recordings[0]!.transcript_segments[0]!.text = recordings[0]!.transcript_segments[0]!.text.replace("三百九十八", "三百九十九");
    });
    await expect(validateDemoData(fixtureDirectory)).rejects.toThrow(/transcript.*match manifest text/i);
  }, 30000);

  it("rejects invented segment offsets even when they remain within the real audio", async () => {
    await cloneActualData();
    await updateRecordings((recordings) => { recordings[0]!.transcript_segments[0]!.start_ms += 1; });
    await expect(validateDemoData(fixtureDirectory)).rejects.toThrow(/timestamps.*raw service boundary ticks/i);
  }, 30000);

  it("rejects segments extending beyond actual decoded audio", async () => {
    await cloneActualData();
    await updateRecordings((recordings) => { recordings[0]!.transcript_segments[0]!.end_ms = 30000; });
    await expect(validateDemoData(fixtureDirectory)).rejects.toThrow(/end_ms.*actual decoded duration/i);
  }, 30000);

  it("keeps manual expected results outside every production source and generator", async () => {
    const files = [...await sourceFiles(join(projectRoot, "src")), ...await sourceFiles(join(projectRoot, "scripts"))];
    expect(files.length).toBeGreaterThan(0);
    for (const path of files) {
      expect(await readFile(path, "utf8"), relative(projectRoot, path)).not.toMatch(/expected_results(?:\.json)?|tests[\\/]fixtures/);
    }
  });
});

describe("independent manual scenario expectations", () => {
  let orders: Order[];
  let recordings: Recording[];
  let cases: ExpectedCase[];
  let fixture: { data_source: string; hotel: string; cases: ExpectedCase[] };
  const orderById = (id: string): Order => orders.find((order) => order.order_id === id)!;
  const recordingById = (id: string): Recording => recordings.find((recording) => recording.recording_id === id)!;
  const transcript = (id: string): string => recordingById(id).transcript_segments.map((segment) => segment.text).join("");
  const caseFor = (orderId: string | null, recordingId: string | null): ExpectedCase => cases.find((item) => item.order_id === orderId && item.recording_id === recordingId)!;

  beforeAll(async () => {
    orders = (await readJson<{ orders: Order[] }>(join(projectRoot, "data", "orders.json"))).orders;
    recordings = (await readJson<{ recordings: Recording[] }>(join(projectRoot, "data", "recordings.json"))).recordings;
    fixture = await readJson<typeof fixture>(join(projectRoot, "tests", "fixtures", "expected_results.json"));
    cases = fixture.cases;
  });

  it("covers all eight orders/recordings and all five statuses with three review cases", () => {
    expect(fixture.data_source).toBe("independent manual expectation; test only");
    expect(fixture.hotel).toBe("Demo Hotel");
    expect(cases).toHaveLength(8);
    expect(new Set(cases.map((item) => item.case_id)).size).toBe(8);
    expect(new Set(cases.map((item) => item.expected_status))).toEqual(new Set<AuditStatus>(["matched", "field_mismatch", "missing_recording", "orphan_recording", "needs_review"]));
    expect(cases.filter((item) => item.expected_status === "needs_review")).toHaveLength(3);
    const orderCoverage = new Set(cases.flatMap((item) => [...item.candidate_order_ids, ...(item.order_id ? [item.order_id] : [])]));
    const recordingCoverage = new Set(cases.flatMap((item) => [...item.candidate_recording_ids, ...(item.recording_id ? [item.recording_id] : [])]));
    expect(orderCoverage).toEqual(new Set(orders.map((order) => order.order_id)));
    expect(recordingCoverage).toEqual(new Set(recordings.map((recording) => recording.recording_id)));
  });

  it("uses valid explicit evidence pointers and preserves missing/orphan/null semantics", () => {
    for (const item of cases) {
      expect(item.case_id.length).toBeGreaterThan(0);
      expect(item.expected_reason.length).toBeGreaterThan(5);
      expect(item.scenario_description.length).toBeGreaterThan(5);
      expect(typeof item.ambiguity).toBe("boolean");
      expect(new Set(item.candidate_order_ids).size).toBe(item.candidate_order_ids.length);
      expect(new Set(item.candidate_recording_ids).size).toBe(item.candidate_recording_ids.length);
      for (const id of [...item.candidate_order_ids, ...(item.order_id ? [item.order_id] : [])]) expect(orderById(id), id).toBeDefined();
      for (const id of [...item.candidate_recording_ids, ...(item.recording_id ? [item.recording_id] : [])]) expect(recordingById(id), id).toBeDefined();
      if (item.expected_status === "missing_recording") {
        expect(item.order_id).not.toBeNull();
        expect(item.recording_id).toBeNull();
        expect(item.candidate_recording_ids).toEqual([]);
        expect(item.evidence).toEqual([]);
      } else if (item.expected_status === "orphan_recording") {
        expect(item.order_id).toBeNull();
        expect(item.recording_id).not.toBeNull();
        expect(item.candidate_order_ids).toEqual([]);
      } else if (!item.ambiguity) {
        expect(item.order_id).not.toBeNull();
        expect(item.recording_id).not.toBeNull();
      }
      const allowedRecordingIds = new Set([...item.candidate_recording_ids, ...(item.recording_id ? [item.recording_id] : [])]);
      for (const evidence of item.evidence) {
        expect(allowedRecordingIds.has(evidence.recording_id)).toBe(true);
        const recording = recordingById(evidence.recording_id);
        expect(recording).toBeDefined();
        expect(evidence.segment_indexes.length).toBeGreaterThan(0);
        expect(new Set(evidence.segment_indexes).size).toBe(evidence.segment_indexes.length);
        for (const index of evidence.segment_indexes) {
          expect(Number.isSafeInteger(index) && index >= 0 && index < recording.transcript_segments.length).toBe(true);
          expect(recording.transcript_segments[index]!.text.trim().length).toBeGreaterThan(0);
        }
        const segments = evidence.segment_indexes.map((index) => recording.transcript_segments[index]!);
        expect(evidence.start_ms).toBe(Math.min(...segments.map((segment) => segment.start_ms)));
        expect(evidence.end_ms).toBe(Math.max(...segments.map((segment) => segment.end_ms)));
        expect(evidence.quote.length).toBeGreaterThan(0);
        expect(segments.map((segment) => segment.text).join("")).toContain(evidence.quote);
        expect(evidence.fields.length).toBeGreaterThan(0);
        expect(evidence.fields.every((field) => typeof field === "string" && field.length > 0)).toBe(true);
        expect(evidence.note.length).toBeGreaterThan(0);
      }
      if (item.expected_status !== "field_mismatch") expect(item.expected_conflicting_fields).toEqual([]);
    }
  });

  it("explicitly preserves the original matched O001 fields and spoken confirmation", () => {
    expect(caseFor("O001", "R001").expected_status).toBe("matched");
    expect(orderById("O001")).toEqual({ order_id: "O001", handled_at: "2026-10-15T14:05:00+08:00", room_number: "802", room_type: "大床房", check_in_date: "2026-10-15", check_out_date: "2026-10-16", amount_cents: 39800, currency: "CNY" });
    for (const phrase of ["八零二", "十月十五日", "十月十六日", "三百九十八元"]) expect(transcript("R001")).toContain(phrase);
  });

  it("records the explicit O002 amount conflict while room and stay dates agree", () => {
    expect(caseFor("O002", "R002").expected_status).toBe("field_mismatch");
    expect(caseFor("O002", "R002").expected_conflicting_fields).toEqual(["amount_cents"]);
    expect(orderById("O002")).toMatchObject({ room_number: "806", check_in_date: "2026-10-15", check_out_date: "2026-10-17", amount_cents: 75600 });
    for (const phrase of ["八零六", "十月十五日", "十月十七日", "七百九十六元"]) expect(transcript("R002")).toContain(phrase);
  });

  it("keeps missing O003 and orphan R003 separated by time and business content", () => {
    expect(caseFor("O003", null).expected_status).toBe("missing_recording");
    expect(caseFor(null, "R003").expected_status).toBe("orphan_recording");
    const handledAt = Date.parse(orderById("O003").handled_at);
    for (const recording of recordings) expect(Math.abs(Date.parse(recording.started_at) - handledAt)).toBeGreaterThanOrEqual(2 * 60 * 60 * 1000);
    for (const phrase of ["六零一", "十一月一日", "十一月三日", "一千九百九十八元"]) expect(transcript("R003")).toContain(phrase);
    expect(orders.every((order) => order.room_number !== "601" && order.check_in_date !== "2026-11-01" && order.amount_cents !== 199800)).toBe(true);
  });

  it("leaves O004 under review because R004 supplies only identity-check context", () => {
    const item = caseFor("O004", "R004");
    expect(item.expected_status).toBe("needs_review");
    expect(item.ambiguity).toBe(false);
    expect(item.missing_evidence_fields).toEqual(expect.arrayContaining(["room_number", "check_in_date", "check_out_date", "amount_cents"]));
    expect(transcript("R004")).toContain("核对证件信息");
    expect(transcript("R004")).not.toMatch(/七零一|十月|四百五十八/);
  });

  it("preserves both equidistant order candidates for R005 without selecting an order", () => {
    const item = caseFor(null, "R005");
    expect(item.expected_status).toBe("needs_review");
    expect(item.ambiguity).toBe(true);
    expect(new Set(item.candidate_order_ids)).toEqual(new Set(["O005", "O006"]));
    expect(item.candidate_recording_ids).toEqual(["R005"]);
    expect(item.order_id).toBeNull();
    const first = orderById("O005");
    const second = orderById("O006");
    for (const field of ["room_type", "check_in_date", "check_out_date", "amount_cents"] as const) expect(first[field]).toBe(second[field]);
    expect(first.room_number).not.toBe(second.room_number);
    const startedAt = Date.parse(recordingById("R005").started_at);
    expect(startedAt - Date.parse(first.handled_at)).toBe(10000);
    expect(Date.parse(second.handled_at) - startedAt).toBe(10000);
    expect(transcript("R005")).toContain("大床房");
    expect(transcript("R005")).not.toMatch(/九零一|九零二|四百二十八|房费/);
  });

  it("preserves both equally informative recording candidates for O007 without selecting a recording", () => {
    const item = caseFor("O007", null);
    expect(item.expected_status).toBe("needs_review");
    expect(item.ambiguity).toBe(true);
    expect(item.candidate_order_ids).toEqual(["O007"]);
    expect(new Set(item.candidate_recording_ids)).toEqual(new Set(["R006", "R007"]));
    expect(item.recording_id).toBeNull();
    const handledAt = Date.parse(orderById("O007").handled_at);
    expect(handledAt - Date.parse(recordingById("R006").started_at)).toBe(10000);
    expect(Date.parse(recordingById("R007").started_at) - handledAt).toBe(10000);
    expect(transcript("R006")).not.toBe(transcript("R007"));
    for (const id of ["R006", "R007"]) for (const phrase of ["一零零八", "十月十五日", "十月十七日", "九百五十六元"]) expect(transcript(id)).toContain(phrase);
  });

  it("keeps O008 handling/recording dates distinct from the future check-in date", async () => {
    expect(caseFor("O008", "R008").expected_status).toBe("matched");
    expect(orderById("O008").handled_at.slice(0, 10)).toBe("2026-10-16");
    expect(recordingById("R008").started_at.slice(0, 10)).toBe("2026-10-16");
    expect(orderById("O008").check_in_date).toBe("2026-10-18");
    expect((await queryOrdersByDate("2026-10-16")).map((order) => order.order_id)).toEqual(["O008"]);
    expect(await queryOrdersByDate("2026-10-18")).toEqual([]);
    for (const phrase of ["八零三", "十月十八日", "十月十九日", "三百九十八元"]) expect(transcript("R008")).toContain(phrase);
  });
});
