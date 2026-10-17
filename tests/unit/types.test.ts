import { describe, expectTypeOf, it } from "vitest";
import type { AuditResult, AuditStatus, Evidence, Order, Recording, TranscriptSegment } from "../../src/domain/types.js";

describe("domain type contracts", () => {
  it("keeps identifiers, timestamps, dates and room numbers as strings", () => {
    expectTypeOf<Order>().toEqualTypeOf<{
      order_id: string;
      handled_at: string;
      room_number: string;
      room_type: string;
      check_in_date: string;
      check_out_date: string;
      amount_cents: number;
      currency: "CNY";
    }>();
  });

  it("connects recordings to timed transcript segments", () => {
    expectTypeOf<TranscriptSegment>().toEqualTypeOf<{ start_ms: number; end_ms: number; text: string }>();
    expectTypeOf<Recording>().toEqualTypeOf<{
      recording_id: string;
      started_at: string;
      audio_path: string;
      transcript_segments: TranscriptSegment[];
    }>();
  });

  it("allows missing-side IDs and names every supported audit status", () => {
    expectTypeOf<AuditStatus>().toEqualTypeOf<
      "matched" | "field_mismatch" | "missing_recording" | "orphan_recording" | "needs_review"
    >();
    expectTypeOf<AuditResult>().toEqualTypeOf<{
      status: AuditStatus;
      order_id: string | null;
      recording_id: string | null;
      conflicting_fields: (keyof Order)[];
      reasons: string[];
      evidence: Evidence[];
    }>();
  });

  it("retains the source recording and exact evidence interval", () => {
    expectTypeOf<Evidence>().toEqualTypeOf<{
      recording_id: string;
      field?: keyof Order | null;
      text: string;
      start_ms: number;
      end_ms: number;
    }>();
  });
});
