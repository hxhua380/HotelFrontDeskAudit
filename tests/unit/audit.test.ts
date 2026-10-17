import { describe, expect, it } from "vitest";
import { auditDay } from "../../src/domain/audit.js";
import type { DetailedAuditResult, Order, Recording, RecordingDataWarning } from "../../src/domain/types.js";

const day = "2026-08-15";

function order(id = "X", overrides: Partial<Order> = {}): Order {
  return {
    order_id: id,
    handled_at: `${day}T14:00:00+08:00`,
    room_number: "901",
    room_type: "大床房",
    check_in_date: day,
    check_out_date: "2026-08-17",
    amount_cents: 96800,
    currency: "CNY",
    ...overrides,
  };
}

function recording(id = "Y", values: Partial<Order> = {}, overrides: Partial<Recording> = {}): Recording {
  const facts = order("source", values);
  return {
    recording_id: id,
    started_at: `${day}T14:00:10+08:00`,
    audio_path: `audio/${id}.mp3`,
    transcript_segments: [
      { start_ms: 120, end_ms: 2300, text: `房号${facts.room_number}，${facts.room_type}。` },
      { start_ms: 2500, end_ms: 5300, text: `入住日期${facts.check_in_date}，退房日期${facts.check_out_date}。` },
      { start_ms: 5500, end_ms: 6500, text: `房费总金额${facts.amount_cents / 100}元。` },
    ],
    ...overrides,
  };
}

function partialRecording(text: string, id = "Y", overrides: Partial<Recording> = {}): Recording {
  return recording(id, {}, { transcript_segments: [{ start_ms: 300, end_ms: 1400, text }], ...overrides });
}

function only(results: DetailedAuditResult[]): DetailedAuditResult {
  expect(results).toHaveLength(1);
  return results[0]!;
}

describe("auditDay business identity and field comparison", () => {
  it("matches five observable fields with positive business identity", () => {
    const result = only(auditDay([order()], [recording()], day));
    expect(result).toMatchObject({ status: "matched", order_id: "X", recording_id: "Y", candidate_order_ids: ["X"], candidate_recording_ids: ["Y"], conflicting_fields: [], conflicts: [], data_warnings: [] });
    expect(result.reasons.join(" ")).toMatch(/房号/);
  });

  it("reports the conflicting amount without breaking a reliable identity", () => {
    const result = only(auditDay([order()], [recording("Y", { amount_cents: 108800 })], day));
    expect(result.status).toBe("field_mismatch");
    expect(result.conflicting_fields).toEqual(["amount_cents"]);
    expect(result.conflicts).toEqual([expect.objectContaining({ field: "amount_cents", order_value: 96800, recording_value: 108800 })]);
    expect(result.conflicts[0]!.evidence[0]).toMatchObject({ recording_id: "Y", field: "amount_cents", text: "房费总金额1088元。", start_ms: 5500, end_ms: 6500, segment_index: 2 });
  });

  it("reports a date conflict when room and room type establish identity", () => {
    const result = only(auditDay([order()], [recording("Y", { check_out_date: "2026-08-18" })], day));
    expect(result.status).toBe("field_mismatch");
    expect(result.conflicting_fields).toEqual(["check_out_date"]);
  });

  it("reports room conflicts when both dates, room type and amount establish identity", () => {
    const result = only(auditDay([order()], [recording("Y", { room_number: "905" })], day));
    expect(result.status).toBe("field_mismatch");
    expect(result.conflicting_fields).toEqual(["room_number"]);
  });

  it("reports a known conflict when identity is reliable and a different field is unknown", () => {
    const source = recording("Y", { amount_cents: 108800 });
    source.transcript_segments[1]!.text = `入住日期${day}。`;
    const result = only(auditDay([order()], [source], day));
    expect(result.status).toBe("field_mismatch");
    expect(result.conflicting_fields).toEqual(["amount_cents"]);
    expect(result.reasons.join(" ")).toMatch(/退房日期.*未知/);
  });

  it("accepts an agreeing room and date as identity while flagging a room type conflict", () => {
    const result = only(auditDay([order()], [recording("Y", { room_type: "双床房" })], day));
    expect(result.status).toBe("field_mismatch");
    expect(result.conflicting_fields).toEqual(["room_type"]);
  });

  it("keeps a known conflict unconfirmed when positive identity is insufficient", () => {
    const result = only(auditDay([order()], [partialRecording("房费总金额1088元。")], day));
    expect(result.status).toBe("needs_review");
    expect(result.conflicting_fields).toEqual(["amount_cents"]);
    expect(result.reasons.join(" ")).toMatch(/未确认/);
  });

  it("requires review of entirely contradictory business events despite the same time", () => {
    const result = only(auditDay([order()], [recording("Y", { room_number: "205", room_type: "双床房", check_in_date: "2026-09-02", check_out_date: "2026-09-04", amount_cents: 40800 })], day));
    expect(result.status).toBe("needs_review");
    expect(result.order_id).toBe("X");
    expect(result.recording_id).toBe("Y");
    expect(result.reasons.join(" ")).toMatch(/未确认|无法确认/);
  });

  it("does not confirm a pair from proximity and unknown business fields", () => {
    const result = only(auditDay([order()], [partialRecording("欢迎光临，正在为您办理。")], day));
    expect(result.status).toBe("needs_review");
    expect(result.conflicting_fields).toEqual([]);
    expect(result.reasons.join(" ")).toMatch(/未知|缺少|未提取/);
  });

  it("does not convert unknowns to matches even when room and type establish identity", () => {
    const result = only(auditDay([order()], [partialRecording("房号901，大床房。")], day));
    expect(result.status).toBe("needs_review");
    expect(result.conflicting_fields).toEqual([]);
  });

  it("requires review of ambiguous fields even when another observation agrees", () => {
    const source = recording();
    source.transcript_segments.push({ start_ms: 7000, end_ms: 8000, text: "房费总金额1088元。" });
    const result = only(auditDay([order()], [source], day));
    expect(result.status).toBe("needs_review");
    expect(result.reasons.join(" ")).toMatch(/歧义|多个|冲突值/);
    expect(result.evidence.some((evidence) => evidence.text.includes("1088"))).toBe(true);
  });

  it("retains every transcript source interval and segment index", () => {
    const result = only(auditDay([order()], [recording()], day));
    expect(result.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ recording_id: "Y", start_ms: 120, end_ms: 2300, segment_index: 0 }),
      expect.objectContaining({ recording_id: "Y", start_ms: 2500, end_ms: 5300, segment_index: 1 }),
      expect.objectContaining({ recording_id: "Y", start_ms: 5500, end_ms: 6500, segment_index: 2 }),
    ]));
    expect(result.evidence.every((evidence) => recording().transcript_segments[evidence.segment_index]!.text === evidence.text)).toBe(true);
  });
});

describe("auditDay candidate graph", () => {
  it("returns missing and orphan records for isolated events", () => {
    const results = auditDay([order()], [recording("Y", {}, { started_at: `${day}T15:00:00+08:00` })], day);
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "missing_recording", order_id: "X", recording_id: null, candidate_order_ids: ["X"], candidate_recording_ids: [], evidence: [] }),
      expect.objectContaining({ status: "orphan_recording", order_id: null, recording_id: "Y", candidate_order_ids: [], candidate_recording_ids: ["Y"] }),
    ]));
  });

  it("keeps two orders and one recording in one review group", () => {
    const result = only(auditDay([order("X"), order("Z")], [recording()], day));
    expect(result).toMatchObject({ status: "needs_review", order_id: null, recording_id: "Y", candidate_order_ids: ["X", "Z"], candidate_recording_ids: ["Y"] });
  });

  it("keeps one order and two recordings in one review group", () => {
    const result = only(auditDay([order()], [recording("Y"), recording("W")], day));
    expect(result).toMatchObject({ status: "needs_review", order_id: "X", recording_id: null, candidate_order_ids: ["X"], candidate_recording_ids: ["W", "Y"] });
  });

  it("preserves an overlapping graph component without greedy pairing", () => {
    const result = only(auditDay([
      order("X", { handled_at: `${day}T14:00:00+08:00` }),
      order("Z", { handled_at: `${day}T14:05:00+08:00` }),
    ], [
      recording("Y", {}, { started_at: `${day}T14:02:30+08:00` }),
      recording("W", {}, { started_at: `${day}T14:00:20+08:00` }),
    ], day));
    expect(result).toMatchObject({ status: "needs_review", order_id: null, recording_id: null, candidate_order_ids: ["X", "Z"], candidate_recording_ids: ["W", "Y"] });
    expect(new Set(result.evidence.map((evidence) => evidence.recording_id))).toEqual(new Set(["W", "Y"]));
  });

  it("uses a unique observable room anchor to distinguish simultaneous business events", () => {
    const results = auditDay([order("X"), order("Z", { room_number: "902" })], [recording("Y"), recording("W", { room_number: "902" })], day);
    expect(results).toHaveLength(2);
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "matched", order_id: "X", recording_id: "Y" }),
      expect.objectContaining({ status: "matched", order_id: "Z", recording_id: "W" }),
    ]));
  });

  it("preserves a four-field identity alternative when the room match has no positive identity", () => {
    const result = only(auditDay([
      order("X"),
      order("Z", { room_number: "905", room_type: "双床房", check_in_date: "2026-09-01", check_out_date: "2026-09-02", amount_cents: 50000 }),
    ], [recording("Y", { room_number: "905" })], day));
    expect(result).toMatchObject({ status: "needs_review", order_id: null, recording_id: "Y", candidate_order_ids: ["X", "Z"] });
  });

  it("preserves a four-field identity alternative when the room match only has room and type identity", () => {
    const result = only(auditDay([
      order("X"),
      order("Z", { room_number: "905", check_in_date: "2026-09-01", check_out_date: "2026-09-02", amount_cents: 50000 }),
    ], [recording("Y", { room_number: "905" })], day));
    expect(result).toMatchObject({ status: "needs_review", order_id: null, recording_id: "Y", candidate_order_ids: ["X", "Z"] });
  });

  it("does not choose one of multiple orders using amount alone", () => {
    const result = only(auditDay([order("X"), order("Z", { amount_cents: 108800 })], [partialRecording("房费总金额968元。")], day));
    expect(result.status).toBe("needs_review");
    expect(result.candidate_order_ids).toEqual(["X", "Z"]);
  });

  it("does not use an ambiguous room observation to prune candidates", () => {
    const source = recording();
    source.transcript_segments.push({ start_ms: 7000, end_ms: 8000, text: "房号902。" });
    const result = only(auditDay([order("X"), order("Z", { room_number: "902" })], [source], day));
    expect(result.status).toBe("needs_review");
    expect(result.candidate_order_ids).toEqual(["X", "Z"]);
  });

  it("does not confirm either duplicate full-content candidate", () => {
    const result = only(auditDay([order()], [recording("Y"), recording("W")], day));
    expect(result.status).toBe("needs_review");
    expect(result.reasons.join(" ")).toMatch(/多个|候选|唯一/);
  });

  it("is independent of order and recording input permutations", () => {
    const orders = [order("X"), order("Z", { room_number: "902" }), order("Q", { handled_at: `${day}T19:00:00+08:00` })];
    const recordings = [recording("Y"), recording("W", { room_number: "902" }), recording("P", {}, { started_at: `${day}T20:00:00+08:00` })];
    expect(auditDay(orders, recordings, day)).toEqual(auditDay([...orders].reverse(), [...recordings].reverse(), day));
  });

  it("keeps review-group evidence and warnings stable under input permutation", () => {
    const orders = [order("Z"), order("X")];
    const recordings = [recording("Y"), recording("W")];
    const warnings: RecordingDataWarning[] = [
      { code: "audio_missing", recording_id: "missing-Z", started_at: `${day}T14:00:30+08:00`, audio_path: "audio/z.mp3", message: "文件缺失" },
      { code: "audio_not_file", recording_id: "missing-A", started_at: `${day}T14:00:40+08:00`, audio_path: "audio/a.mp3", message: "不是文件" },
    ];
    expect(auditDay(orders, recordings, day, { data_warnings: warnings })).toEqual(auditDay([...orders].reverse(), [...recordings].reverse(), day, { data_warnings: [...warnings].reverse() }));
  });

  it("does not use IDs to decide a business relationship", () => {
    const original = auditDay([order("X"), order("Z", { room_number: "902" })], [recording("Y"), recording("W", { room_number: "902" })], day);
    const renamed = auditDay([order("zz"), order("aa", { room_number: "902" })], [recording("aa"), recording("zz", { room_number: "902" })], day);
    const relations = (results: DetailedAuditResult[]) => results.map((result) => `${result.status}:${result.evidence.find((evidence) => evidence.field === "room_number")?.text}`).sort();
    expect(relations(renamed)).toEqual(relations(original));
    expect(renamed).toEqual(expect.arrayContaining([
      expect.objectContaining({ order_id: "zz", recording_id: "aa", status: "matched" }),
      expect.objectContaining({ order_id: "aa", recording_id: "zz", status: "matched" }),
    ]));
  });

  it("never reuses a recording in multiple confirmed results", () => {
    const results = auditDay([order("X"), order("Z"), order("Q", { room_number: "902" })], [recording("Y"), recording("W", { room_number: "902" })], day);
    const confirmed = results.filter((result) => result.status === "matched" || result.status === "field_mismatch");
    expect(confirmed.map((result) => result.recording_id)).toEqual(["W"]);
    expect(new Set(results.flatMap((result) => result.candidate_recording_ids)).size).toBe(2);
  });
});

describe("auditDay calendar, time window and data warnings", () => {
  it("uses an inclusive default 180 second candidate window", () => {
    expect(only(auditDay([order()], [recording("Y", {}, { started_at: `${day}T14:03:00+08:00` })], day)).status).toBe("matched");
    expect(auditDay([order()], [recording("Y", {}, { started_at: `${day}T14:03:01+08:00` })], day)).toHaveLength(2);
  });

  it("honors a finite configurable time window including zero", () => {
    expect(auditDay([order()], [recording()], day, { window_seconds: 9 })).toHaveLength(2);
    expect(only(auditDay([order()], [recording()], day, { window_seconds: 10 })).status).toBe("matched");
    expect(only(auditDay([order()], [recording("Y", {}, { started_at: order().handled_at })], day, { window_seconds: 0 })).status).toBe("matched");
  });

  it("filters events by their Beijing handled/start day", () => {
    expect(auditDay([order("X", { handled_at: "2026-08-16T00:00:00+08:00" })], [recording("Y", {}, { started_at: "2026-08-14T23:59:59+08:00" })], day)).toEqual([]);
  });

  it.each(["2026-8-15", "2026-02-29", "2026-04-31", "2026-08-15junk", "not-a-date"])("rejects invalid audit date %s", (date) => {
    expect(() => auditDay([], [], date)).toThrow(/日期|date/i);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid window %s", (window_seconds) => {
    expect(() => auditDay([], [], day, { window_seconds })).toThrow(/窗口|window/i);
  });

  it.each(["2026-02-30T14:00:00+08:00", "2026-08-15T25:00:00+08:00", "2026-08-15T14:00:00Z", "2026-08-15"])("rejects invalid Beijing timestamps %s", (handled_at) => {
    expect(() => auditDay([order("X", { handled_at })], [], day)).toThrow(/时间|timestamp/i);
    expect(() => auditDay([], [recording("Y", {}, { started_at: handled_at })], day)).toThrow(/时间|timestamp/i);
  });

  it("rejects duplicate IDs within the selected day", () => {
    expect(() => auditDay([order(), order()], [], day)).toThrow(/重复|duplicate/i);
    expect(() => auditDay([], [recording(), recording()], day)).toThrow(/重复|duplicate/i);
  });

  it("allows the same ID on distinct days without merging business events", () => {
    const result = only(auditDay([order(), order("X", { handled_at: "2026-08-16T14:00:00+08:00" })], [recording(), recording("Y", {}, { started_at: "2026-08-16T14:00:00+08:00" })], day));
    expect(result.status).toBe("matched");
  });

  it("explains relevant unavailable audio on a missing order without creating an orphan", () => {
    const warning: RecordingDataWarning = { code: "audio_missing", recording_id: "absent", started_at: `${day}T14:00:30+08:00`, audio_path: "audio/absent.mp3", message: "音频文件缺失，已排除" };
    const result = only(auditDay([order()], [], day, { data_warnings: [warning] }));
    expect(result).toMatchObject({ status: "missing_recording", recording_id: null, candidate_recording_ids: [], evidence: [], data_warnings: [warning] });
    expect(result.reasons.join(" ")).toMatch(/缺失|不可用/);
    expect(auditDay([], [], day, { data_warnings: [warning] })).toEqual([]);
  });

  it("does not attach audio warnings outside the selected date and order window", () => {
    const base: RecordingDataWarning = { code: "audio_not_file", recording_id: "absent", started_at: `${day}T15:00:00+08:00`, audio_path: "audio/directory.mp3", message: "音频路径不是文件" };
    expect(only(auditDay([order()], [], day, { data_warnings: [base, { ...base, started_at: "2026-08-16T14:00:00+08:00" }] })).data_warnings).toEqual([]);
  });

  it("does not mutate input events or their transcript segments", () => {
    const orders = [order()];
    const recordings = [recording()];
    const before = structuredClone({ orders, recordings });
    auditDay(orders, recordings, day);
    expect({ orders, recordings }).toEqual(before);
  });
});
