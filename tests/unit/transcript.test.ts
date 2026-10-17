import { describe, expect, it } from "vitest";
import { extractTranscript } from "../../src/domain/transcript.js";
import type { Recording, TranscriptFacts } from "../../src/domain/types.js";

function recording(text: string | string[], startedAt = "2026-08-15T22:30:00+08:00"): Pick<Recording, "recording_id" | "started_at" | "transcript_segments"> {
  return {
    recording_id: "GENERIC-TRANSCRIPT",
    started_at: startedAt,
    transcript_segments: (Array.isArray(text) ? text : [text]).map((part, index) => ({
      text: part,
      start_ms: 120 + index * 3000,
      end_ms: 2500 + index * 3000,
    })),
  };
}

function values(facts: TranscriptFacts): Record<keyof TranscriptFacts, string | number | null> {
  return Object.fromEntries(Object.entries(facts).map(([field, result]) => [field, result.value])) as Record<keyof TranscriptFacts, string | number | null>;
}

describe("extractTranscript", () => {
  it("leaves unspoken information unknown", () => {
    const facts = extractTranscript(recording("欢迎光临，正在为您办理，请稍等。"));
    for (const field of Object.values(facts)) {
      expect(field).toEqual({ value: null, ambiguous: false, observations: [] });
    }
  });

  it("extracts the five business fields without recording-specific rules", () => {
    const facts = extractTranscript(recording("给您安排九零六号双床房，二零二六年八月十五日入住，八月十七日退房，两晚合计七百九十六元。"));
    expect(values(facts)).toEqual({ room_number: "906", room_type: "双床房", check_in_date: "2026-08-15", check_out_date: "2026-08-17", amount_cents: 79600 });
  });

  it.each([
    ["房号802。", "802"],
    ["房间是0802。", "0802"],
    ["给您八零二号大床房。", "802"],
    ["八〇二号房间。", "802"],
    ["一零零八号豪华大床房。", "1008"],
    ["房号：九零六。", "906"],
  ])("recognizes contextual room numbers: %s", (text, expected) => {
    expect(extractTranscript(recording(text)).room_number.value).toBe(expected);
  });

  it.each(["802", "人民币398元。", "房间398元。", "房号八百零二。", "入住日期10月15号，退房日期10月17号。", "2026年10月15日入住。", "15号入住。"])(
    "does not turn unrelated numeric text into a room number: %s", (text) => {
      expect(extractTranscript(recording(text)).room_number).toEqual({ value: null, ambiguous: false, observations: [] });
    },
  );

  it.each(["豪华大床房", "商务大床房", "豪华双床房", "商务套房", "大床房", "双床房", "套房"])(
    "recognizes the longest room-type phrase: %s", (roomType) => {
      const result = extractTranscript(recording(`预订的是${roomType}。`)).room_type;
      expect(result.value).toBe(roomType);
      expect(result.ambiguous).toBe(false);
      expect(result.observations).toHaveLength(1);
    },
  );

  it.each([
    ["房费398元。", 39800],
    ["人民币398元。", 39800],
    ["一共三百九十八块。", 39800],
    ["房费共一千九百九十八元。", 199800],
    ["共两千零八十元。", 208000],
    ["合计一万零三百元。", 1030000],
    ["房费398.05元。", 39805],
    ["总金额0.1元。", 10],
    ["房费0元。", 0],
    ["房费90071992547409.91元。", Number.MAX_SAFE_INTEGER],
  ])("converts exact money to safe integer cents: %s", (text, expected) => {
    expect(extractTranscript(recording(text)).amount_cents.value).toBe(expected);
  });

  it.each([
    "入住日期2026年10月15日。", "大约三百多元。", "大约三百元。", "三四百元。", "几百元。", "三百元左右。",
    "398.001元。", "90071992547410元。", "90071992547409.92元。", "-398元。", "三百多块钱。",
    "三百九十八点五元。", "398元5角。", "三百九十八元五角。", "房费1,398元。",
  ])("does not guess an inexact or invalid amount: %s", (text) => {
    expect(extractTranscript(recording(text)).amount_cents).toEqual({ value: null, ambiguous: false, observations: [] });
  });

  it.each([
    ["2026年10月15日入住，10月17日退房。", "2026-10-15", "2026-10-17"],
    ["二零二六年十月十五日入住，十月十七日退房。", "2026-10-15", "2026-10-17"],
    ["入住日期十月十五日，退房日期十月十七日。", "2026-10-15", "2026-10-17"],
    ["入住日期2026-08-15，退房日期2026-08-17。", "2026-08-15", "2026-08-17"],
    ["十月十五号入住，十月十七号退房。", "2026-10-15", "2026-10-17"],
    ["十月十五日至十七日住。", "2026-10-15", "2026-10-17"],
    ["入住十月十五日至十七日。", "2026-10-15", "2026-10-17"],
    ["十月十五日入住，十七日退房。", "2026-10-15", "2026-10-17"],
  ])("assigns dates using explicit stay context: %s", (text, checkIn, checkOut) => {
    const facts = extractTranscript(recording(text));
    expect(facts.check_in_date.value).toBe(checkIn);
    expect(facts.check_out_date.value).toBe(checkOut);
  });

  it("extracts explicit fields from separate timed segments", () => {
    const facts = extractTranscript(recording(["房号901，大床房。", "入住日期2026-08-15，退房日期2026-08-17。", "房费总金额968元。"]));
    expect(values(facts)).toEqual({ room_number: "901", room_type: "大床房", check_in_date: "2026-08-15", check_out_date: "2026-08-17", amount_cents: 96800 });
  });

  it("resolves relative dates from the recording Beijing day", () => {
    const facts = extractTranscript(recording("今天入住，明天退房。", "2024-02-28T18:30:00Z"));
    expect(facts.check_in_date.value).toBe("2024-02-29");
    expect(facts.check_out_date.value).toBe("2024-03-01");
  });

  it("rolls relative dates across a year using calendar arithmetic", () => {
    const facts = extractTranscript(recording("今天入住，明天退房。", "2026-12-31T20:00:00+08:00"));
    expect(facts.check_in_date.value).toBe("2026-12-31");
    expect(facts.check_out_date.value).toBe("2027-01-01");
  });

  it("does not infer a missing month from the recording month", () => {
    const facts = extractTranscript(recording("十五日入住，十七日退房。"));
    expect(facts.check_in_date.observations).toEqual([]);
    expect(facts.check_out_date.observations).toEqual([]);
  });

  it("does not inherit a bare day month across sentence or segment boundaries", () => {
    const facts = extractTranscript(recording(["十月十五日入住。十七日退房。", "十八日退房。"]));
    expect(facts.check_in_date.value).toBe("2026-10-15");
    expect(facts.check_out_date.value).toBeNull();
  });

  it.each(["not-a-time", "2026-02-30T12:00:00+08:00", "2026-08-15T25:00:00+08:00", "2026-08-15T12:00:00"])(
    "does not supply dates from an invalid recording timestamp: %s", (startedAt) => {
      const facts = extractTranscript(recording("八月十五日入住，明天退房。", startedAt));
      expect(facts.check_in_date.value).toBeNull();
      expect(facts.check_out_date.value).toBeNull();
    },
  );

  it("can extract a complete explicit date without a usable recording timestamp", () => {
    expect(extractTranscript(recording("2024年2月29日入住。", "invalid")).check_in_date.value).toBe("2024-02-29");
  });

  it.each(["2026年2月30日入住。", "2026年2月29日入住。", "2026年13月1日入住。", "2026年0月1日入住。", "入住日期2026-04-31。"])(
    "rejects impossible calendar dates rather than normalizing: %s", (text) => {
      expect(extractTranscript(recording(text)).check_in_date.observations).toEqual([]);
    },
  );

  it("requires explicit year or month when a stay would otherwise need rollover inference", () => {
    const facts = extractTranscript(recording("十二月三十一日入住，一月一日退房。", "2026-12-30T10:00:00+08:00"));
    expect(facts.check_in_date.value).toBe("2026-12-31");
    expect(facts.check_out_date.value).toBeNull();
    expect(extractTranscript(recording("一月三十一日至二日住。")).check_out_date.value).toBeNull();
  });

  it("accepts a stay with explicitly stated years across New Year", () => {
    const facts = extractTranscript(recording("2026年12月31日入住，2027年1月1日退房。"));
    expect(facts.check_in_date.value).toBe("2026-12-31");
    expect(facts.check_out_date.value).toBe("2027-01-01");
  });

  it.each([
    ["room_number", "房号901。", "房号902。", ["901", "902"]],
    ["room_type", "预订豪华大床房。", "确认商务大床房。", ["豪华大床房", "商务大床房"]],
    ["check_in_date", "八月十五日入住。", "八月十六日入住。", ["2026-08-15", "2026-08-16"]],
    ["check_out_date", "八月十七日退房。", "八月十八日退房。", ["2026-08-17", "2026-08-18"]],
    ["amount_cents", "房费968元。", "房费1088元。", [96800, 108800]],
  ] as const)("preserves conflicting %s values without choosing one", (field, first, second, expected) => {
    const result = extractTranscript(recording([first, second]))[field];
    expect(result.value).toBeNull();
    expect(result.ambiguous).toBe(true);
    expect(result.observations.map((observation) => observation.value)).toEqual(expected);
  });

  it("preserves alternative room numbers in one explicit room phrase", () => {
    const result = extractTranscript(recording("房号901或902，请再核对。" )).room_number;
    expect(result.value).toBeNull();
    expect(result.ambiguous).toBe(true);
    expect(result.observations.map((observation) => observation.value)).toEqual(["901", "902"]);
  });

  it("keeps repeated supporting observations without creating ambiguity", () => {
    const result = extractTranscript(recording(["房费398元。", "再次确认房费三百九十八元。"])).amount_cents;
    expect(result.value).toBe(39800);
    expect(result.ambiguous).toBe(false);
    expect(result.observations).toHaveLength(2);
  });

  it.each(["房费每晚398元，住两晚。", "每晚的房费398元。", "单价398元。", "398元每晚。", "398元/晚。", "房费三百到四百元。", "房费300元到400元。", "房费约为398元。", "大约房费398元。"])(
    "does not treat a rate, range, or approximation as an exact total: %s", (text) => {
      expect(extractTranscript(recording(text)).amount_cents).toEqual({ value: null, ambiguous: false, observations: [] });
    },
  );

  it("uses the explicit total when a nightly rate is also spoken", () => {
    const result = extractTranscript(recording("每晚398元，两晚合计796元。" )).amount_cents;
    expect(result.value).toBe(79600);
    expect(result.ambiguous).toBe(false);
    expect(result.observations.map((observation) => observation.value)).toEqual([79600]);
  });

  it("preserves alternative amounts sharing one currency marker", () => {
    const result = extractTranscript(recording("房费398或428元，请核对。" )).amount_cents;
    expect(result.value).toBeNull();
    expect(result.ambiguous).toBe(true);
    expect(result.observations.map((observation) => observation.value)).toEqual([39800, 42800]);
  });

  it("preserves alternative relative dates rather than choosing the last", () => {
    const result = extractTranscript(recording("明天或后天退房。" )).check_out_date;
    expect(result.value).toBeNull();
    expect(result.ambiguous).toBe(true);
    expect(result.observations.map((observation) => observation.value)).toEqual(["2026-08-16", "2026-08-17"]);
  });

  it("leaves an explicitly uncertain relative date unknown", () => {
    expect(extractTranscript(recording("可能今天入住。" )).check_in_date).toEqual({ value: null, ambiguous: false, observations: [] });
  });

  it("does not turn an uncertain date alternative into a definite last date", () => {
    expect(extractTranscript(recording("可能今天或明天入住。" )).check_in_date).toEqual({ value: null, ambiguous: false, observations: [] });
  });

  it("does not interpret 预约 as an approximation marker", () => {
    expect(extractTranscript(recording("预约明天入住。" )).check_in_date.value).toBe("2026-08-16");
  });

  it("leaves an explicitly uncertain room assignment unknown", () => {
    const facts = extractTranscript(recording("可能房号901豪华大床房。"));
    expect(facts.room_number.observations).toEqual([]);
    expect(facts.room_type.observations).toEqual([]);
  });

  it.each(["押金968元。", "定金968元。", "订金968元。", "退款968元。", "押金总额968元。", "押金200元，合计968元。", "房号901，大床房，今天入住，后天退房，押金968元。"])(
    "does not treat a non-room charge or refund as the room total: %s", (text) => {
      expect(extractTranscript(recording(text)).amount_cents).toEqual({ value: null, ambiguous: false, observations: [] });
    },
  );

  it.each(["押金200元，房费合计968元。", "房费总额968元，另收押金200元。", "退款100元、房费总计968元。"])(
    "retains only an explicit room total when another charge is present: %s", (text) => {
      const result = extractTranscript(recording(text)).amount_cents;
      expect(result.value).toBe(96800);
      expect(result.ambiguous).toBe(false);
      expect(result.observations.map((observation) => observation.value)).toEqual([96800]);
    },
  );

  it.each(["金额968元或更多。", "金额968元或者更多。", "金额968元或更少。"])(
    "does not treat an open-ended amount as exact: %s", (text) => {
      expect(extractTranscript(recording(text)).amount_cents).toEqual({ value: null, ambiguous: false, observations: [] });
    },
  );

  it.each(["房号802到803。", "房号802至803。", "房号802-803。", "802号到803号。"])(
    "does not choose an endpoint from a room-number range: %s", (text) => {
      expect(extractTranscript(recording(text)).room_number.value).toBeNull();
    },
  );

  it("preserves original whole segment evidence and exact source interval", () => {
    const input = recording(["请稍等。", "  房号901，大床房，房费968元。  "]);
    const facts = extractTranscript(input);
    for (const field of ["room_number", "room_type", "amount_cents"] as const) {
      expect(facts[field].observations[0]?.evidence).toEqual({
        recording_id: "GENERIC-TRANSCRIPT", field, segment_index: 1,
        text: "  房号901，大床房，房费968元。  ", start_ms: 3120, end_ms: 5500,
      });
    }
  });

  it("does not mutate the recording or its segments", () => {
    const input = recording("房号901，大床房，房费968元。");
    const original = structuredClone(input);
    extractTranscript(input);
    expect(input).toEqual(original);
  });
});
