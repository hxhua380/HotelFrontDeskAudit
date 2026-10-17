import type { AuditableField, ExtractedField, Recording, TranscriptEvidence, TranscriptFacts } from "./types.js";

const chineseDigits: Readonly<Record<string, string>> = {
  零: "0", 〇: "0", 一: "1", 二: "2", 两: "2", 三: "3", 四: "4", 五: "5", 六: "6", 七: "7", 八: "8", 九: "9",
};
const digitCharacters = "0-9零〇一二两三四五六七八九";
const numberCharacters = `${digitCharacters}十百千万亿`;
const numberPattern = `[${numberCharacters}]+`;
const roomNumberPattern = `[${digitCharacters}]+`;
const sentenceBoundary = /[。！？!?；;]/;
const uncertainBefore = /(?:大约|大概|(?<![预合])约|差不多|将近|近|不到|至少|最多|超过|可能|也许)\s*(?:为|是)?\s*$/;
const uncertainClause = /(?:大约|大概|(?<![预合])约|差不多|将近|不到|至少|最多|超过|可能|也许)[^，,。！？!?；;]*$/;
const uncertainAfter = /^\s*(?:(?:或者|或)\s*)?(?:左右|上下|以内|以上|以下|起|多|余|更多|更少)/;
const roomTypes = [
  "豪华大床房", "商务大床房", "行政大床房", "高级大床房", "标准大床房",
  "豪华双床房", "商务双床房", "行政双床房", "高级双床房", "标准双床房",
  "豪华套房", "商务套房", "行政套房", "家庭房", "单人房", "标准间", "大床房", "双床房", "套房",
].sort((first, second) => second.length - first.length);

type DateField = "check_in_date" | "check_out_date";
interface CalendarDate { year: number; month: number; day: number }
interface DateMention {
  start: number;
  end: number;
  year: number | null;
  month: number | null;
  day: number | null;
  relative: number | null;
  explicitYear: boolean;
  hasMonth: boolean;
  field: DateField | null;
}

function contextMonth(context: { date: CalendarDate } | null): number | null {
  return context?.date.month ?? null;
}

function uncertainContext(prefix: string): boolean {
  return uncertainBefore.test(prefix) || uncertainClause.test(prefix);
}

function emptyField<T extends string | number>(): ExtractedField<T> {
  return { value: null, ambiguous: false, observations: [] };
}

function observe<T extends string | number>(field: ExtractedField<T>, value: T, evidence: TranscriptEvidence): void {
  field.observations.push({ value, evidence });
  const distinctValues = new Set(field.observations.map((observation) => observation.value));
  field.ambiguous = distinctValues.size > 1;
  field.value = field.ambiguous ? null : value;
}

/** Parse explicit digit strings or descending Chinese units; adjacent digits before a unit are uncertain (三四百). */
function integerValue(input: string): bigint | null {
  if (/^\d+$/.test(input)) return BigInt(input);
  const normalized = input.replaceAll("两", "二").replaceAll("〇", "零");
  if (/^[零一二三四五六七八九]+$/.test(normalized)) {
    return BigInt([...normalized].map((character) => chineseDigits[character]).join(""));
  }
  for (const [unit, multiplier] of [["亿", 100000000n], ["万", 10000n]] as const) {
    if (!normalized.includes(unit)) continue;
    const parts = normalized.split(unit);
    if (parts.length !== 2 || !parts[0]) return null;
    const left = integerValue(parts[0]);
    const rightText = parts[1] ?? "";
    const right = rightText ? integerValue(rightText.replace(/^零/, "")) : 0n;
    if (left === null || right === null || right >= multiplier) return null;
    // 一万三 and 一百二 can be colloquial shorthand, so require the missing place to be explicit.
    if (right > 0n && right < multiplier / 10n && !rightText.startsWith("零")) return null;
    return left * multiplier + right;
  }
  const units: Readonly<Record<string, bigint>> = { 十: 10n, 百: 100n, 千: 1000n };
  let result = 0n;
  let pending: bigint | null = null;
  let previousUnit = 10000n;
  let zeroAfterUnit = false;
  for (const character of normalized) {
    const digit = chineseDigits[character];
    if (digit !== undefined) {
      if (digit === "0") {
        if (result === 0n || pending !== null || zeroAfterUnit) return null;
        zeroAfterUnit = true;
      } else {
        if (pending !== null) return null;
        pending = BigInt(digit);
      }
      continue;
    }
    const unit = units[character];
    if (unit === undefined || unit >= previousUnit) return null;
    const coefficient = pending ?? (unit === 10n && result === 0n ? 1n : null);
    if (coefficient === null) return null;
    result += coefficient * unit;
    pending = null;
    previousUnit = unit;
    zeroAfterUnit = false;
  }
  if (pending !== null && previousUnit > 10n && !zeroAfterUnit) return null;
  return result + (pending ?? 0n);
}

function smallInteger(input: string | undefined): number | null {
  if (input === undefined) return null;
  const parsed = integerValue(input);
  return parsed !== null && parsed <= 9999n ? Number(parsed) : null;
}

function isCalendarDate(date: CalendarDate): boolean {
  const { year, month, day } = date;
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return days !== undefined && day <= days;
}

function formatDate(date: CalendarDate): string {
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

function beijingDate(timestamp: string): CalendarDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(timestamp);
  if (!match) return null;
  const original = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  if (!isCalendarDate(original) || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) return null;
  const zone = match[7];
  if (zone !== "Z" && (Number(zone?.slice(1, 3)) > 23 || Number(zone?.slice(4, 6)) > 59)) return null;
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) return null;
  const date = new Date(milliseconds + 8 * 60 * 60 * 1000);
  const result = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
  return isCalendarDate(result) ? result : null;
}

function relativeDate(base: CalendarDate, days: number): CalendarDate | null {
  const date = new Date(`${formatDate(base)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  const result = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
  return isCalendarDate(result) ? result : null;
}

function dateField(text: string, start: number, end: number): DateField | null {
  const after = /^\s*(?:办理)?(入住|退房)/.exec(text.slice(end));
  const before = /(入住|退房)(?:日期|时间|日)?(?:是|为|定于|定在|：|:|\s)*$/.exec(text.slice(0, start));
  const label = after?.[1] ?? before?.[1];
  return label === "入住" ? "check_in_date" : label === "退房" ? "check_out_date" : null;
}

function dateMentions(text: string): DateMention[] {
  const expression = new RegExp(
    `(?<isoYear>\\d{4})-(?<isoMonth>\\d{2})-(?<isoDay>\\d{2})|(?:(?<year>${numberPattern})年)?(?:(?<month>${numberPattern})月)?(?<day>${numberPattern})[日号]|(?<relative>今天|明天|后天)`, "g",
  );
  const mentions: DateMention[] = [];
  for (const match of text.matchAll(expression)) {
    const groups = match.groups ?? {};
    const start = match.index;
    const end = start + match[0].length;
    mentions.push({
      start, end, year: smallInteger(groups.isoYear ?? groups.year), month: smallInteger(groups.isoMonth ?? groups.month),
      day: smallInteger(groups.isoDay ?? groups.day), relative: groups.relative ? ["今天", "明天", "后天"].indexOf(groups.relative) : null,
      explicitYear: groups.isoYear !== undefined || groups.year !== undefined,
      hasMonth: groups.isoMonth !== undefined || groups.month !== undefined,
      field: dateField(text, start, end),
    });
  }
  // A shared 入住/退房 label also governs every explicitly listed date alternative.
  for (let index = 0; index < mentions.length; index++) {
    const group = [mentions[index]];
    while (index + 1 < mentions.length) {
      const current = mentions[index];
      const next = mentions[index + 1];
      if (!current || !next || !/^\s*(?:或|或者|还是|、)\s*$/.test(text.slice(current.end, next.start))) break;
      group.push(next);
      index++;
    }
    const fields = new Set(group.flatMap((mention) => mention?.field ? [mention.field] : []));
    if (fields.size === 1) {
      const field = [...fields][0];
      if (field) for (const mention of group) if (mention) mention.field = field;
    }
  }
  for (let index = 0; index < mentions.length - 1; index++) {
    const first = mentions[index];
    const second = mentions[index + 1];
    if (!first || !second || !/^\s*(?:至|到|[-—~～])\s*$/.test(text.slice(first.end, second.start))) continue;
    const stayContext = text.slice(Math.max(0, first.start - 10), first.start) + text.slice(second.end, second.end + 10);
    if (/(?:入住|退房|住宿|住)/.test(stayContext) && (first.hasMonth || first.relative !== null)) {
      first.field = "check_in_date";
      second.field = "check_out_date";
    }
  }
  return mentions;
}

function extractDates(text: string, base: CalendarDate | null, emit: (field: DateField, value: string) => void): DateMention[] {
  const mentions = dateMentions(text);
  let previous: { mention: DateMention; date: CalendarDate } | null = null;
  for (const mention of mentions) {
    if (previous && sentenceBoundary.test(text.slice(previous.mention.end, mention.start))) previous = null;
    const beforeLabel = text.slice(0, mention.start).replace(/(?:入住|退房)(?:日期|时间|日)?(?:是|为|定于|定在|：|:|\s)*$/, "");
    if (uncertainContext(beforeLabel)) continue;
    let date: CalendarDate | null;
    if (mention.relative !== null) date = base ? relativeDate(base, mention.relative) : null;
    else {
      const year = mention.explicitYear ? mention.year : base?.year;
      const month: number | null = mention.hasMonth ? mention.month : contextMonth(previous);
      date = year != null && month != null && mention.day !== null ? { year, month, day: mention.day } : null;
      if (date && !isCalendarDate(date)) date = null;
      // Omitted month/year never silently advances the calendar across a stay boundary.
      if (date && previous?.mention.field === "check_in_date" && mention.field === "check_out_date" && !mention.explicitYear) {
        if (formatDate(date) < formatDate(previous.date)) date = null;
      }
    }
    if (date && mention.field !== null) emit(mention.field, formatDate(date));
    if (date && (mention.hasMonth || mention.relative !== null)) previous = { mention, date };
  }
  return mentions.filter((mention) => mention.hasMonth || mention.relative !== null || mention.field !== null);
}

function extractRooms(text: string, dates: DateMention[], emit: (value: string) => void): void {
  const candidates: { start: number; end: number; value: string }[] = [];
  const prefix = new RegExp(`(?:房号|房间)(?:是|为)?\\s*[:：]?\\s*(${roomNumberPattern}(?:\\s*(?:或者|或|还是|、|和)\\s*${roomNumberPattern})*)`, "g");
  for (const match of text.matchAll(prefix)) {
    const body = match[1];
    if (body === undefined) continue;
    const offset = match.index + match[0].length - body.length;
    for (const digits of body.matchAll(new RegExp(roomNumberPattern, "g"))) {
      candidates.push({ start: offset + digits.index, end: offset + digits.index + digits[0].length, value: digits[0] });
    }
  }
  const suffix = new RegExp(`(?<![${numberCharacters}])(${roomNumberPattern})(?:号(?:房间|房)?|房间)`, "g");
  for (const match of text.matchAll(suffix)) {
    const number = match[1];
    if (number !== undefined) candidates.push({ start: match.index, end: match.index + number.length, value: number });
  }
  const seen = new Set<string>();
  const rangeBefore = new RegExp(`${roomNumberPattern}(?:号(?:房间|房)?)?\\s*(?:到|至|[-—~～])\\s*$`);
  const rangeAfter = new RegExp(`^\\s*(?:号(?:房间|房)?)?\\s*(?:到|至|[-—~～])\\s*${roomNumberPattern}`);
  for (const candidate of candidates.sort((first, second) => first.start - second.start)) {
    const key = `${candidate.start}:${candidate.end}`;
    if (seen.has(key) || dates.some((date) => candidate.start >= date.start && candidate.start < date.end)) continue;
    if (uncertainContext(text.slice(0, candidate.start))) continue;
    if (rangeBefore.test(text.slice(0, candidate.start)) || rangeAfter.test(text.slice(candidate.end))) continue;
    if (/^\s*(?:[十百千万亿年月日元块角分.]|点)/.test(text.slice(candidate.end))) continue;
    seen.add(key);
    emit([...candidate.value].map((digit) => chineseDigits[digit] ?? digit).join(""));
  }
}

function amountCents(input: string): number | null {
  let cents: bigint;
  if (/^\d+(?:\.\d{1,2})?$/.test(input)) {
    const [whole = "", fractional = ""] = input.split(".");
    cents = BigInt(whole) * 100n + BigInt(fractional.padEnd(2, "0"));
  } else {
    const whole = integerValue(input);
    if (whole === null) return null;
    cents = whole * 100n;
  }
  return cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null;
}

function extractAmounts(text: string, emit: (value: number) => void): void {
  const amountNumber = "(?:[0-9]+(?:\\.[0-9]+)?|[零〇一二两三四五六七八九十百千万亿]+)";
  const currency = "(?:元|块(?:钱)?)";
  const expression = new RegExp(`(?<![${numberCharacters}.点负-])(${amountNumber}(?:\\s*(?:或者|或|还是)\\s*${amountNumber})*)${currency}`, "g");
  const rangeBefore = new RegExp(`${amountNumber}${currency}?\\s*(?:到|至|[-—~～])\\s*$`);
  const rangeAfter = new RegExp(`^\\s*(?:到|至|[-—~～])\\s*${amountNumber}${currency}`);
  const otherCharge = /押金|定金|订金|退款|退费|退还|返还/;
  const hasOtherCharges = otherCharge.test(text);
  for (const match of text.matchAll(expression)) {
    const raw = match[1];
    const before = text.slice(0, match.index);
    const after = text.slice(match.index + match[0].length);
    const chargeContext = before.split(/[，,。！？!?；;、]|元|块钱?/).at(-1) ?? "";
    if (otherCharge.test(chargeContext) || (hasOtherCharges && !/房费|房款|住宿费/.test(chargeContext))) continue;
    if (raw === undefined || uncertainContext(before) || uncertainAfter.test(after) || rangeBefore.test(before) || rangeAfter.test(after)) continue;
    if (new RegExp(`[${numberCharacters}][,，]\\s*$`).test(before) || new RegExp(`^\\s*${numberPattern}[角分]`).test(after)) continue;
    const rateContext = /(?:每[晚夜日天]|单价)([^，,。！？!?；;]*)$/.exec(before);
    if (rateContext && !/(?:合计|总计|总金额|总价|一共|共)/.test(rateContext[1] ?? "")) continue;
    if (/^\s*(?:每[晚夜日天]|[/／][晚夜日天])/.test(after)) continue;
    const alternatives = [...raw.matchAll(new RegExp(amountNumber, "g"))].map((number) => amountCents(number[0]));
    if (alternatives.some((value) => value === null)) continue;
    for (const value of alternatives) if (value !== null) emit(value);
  }
}

/** Pure rule extraction. Every observation points to the original complete timed segment. */
export function extractTranscript(recording: Pick<Recording, "recording_id" | "started_at" | "transcript_segments">): TranscriptFacts {
  const facts: TranscriptFacts = {
    room_number: emptyField(), room_type: emptyField(), check_in_date: emptyField(), check_out_date: emptyField(), amount_cents: emptyField(),
  };
  const base = beijingDate(recording.started_at);
  for (const [segmentIndex, segment] of recording.transcript_segments.entries()) {
    const evidence = (field: AuditableField): TranscriptEvidence => ({
      recording_id: recording.recording_id, field, segment_index: segmentIndex,
      text: segment.text, start_ms: segment.start_ms, end_ms: segment.end_ms,
    });
    const dates = extractDates(segment.text, base, (field, value) => observe(facts[field], value, evidence(field)));
    extractRooms(segment.text, dates, (value) => observe(facts.room_number, value, evidence("room_number")));
    for (const match of segment.text.matchAll(new RegExp(roomTypes.join("|"), "g"))) {
      if (!uncertainContext(segment.text.slice(0, match.index))) observe(facts.room_type, match[0], evidence("room_type"));
    }
    extractAmounts(segment.text, (value) => observe(facts.amount_cents, value, evidence("amount_cents")));
  }
  return facts;
}
