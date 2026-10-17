import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { queryOrdersByDate } from "../../src/data/repository.js";
import type { Order } from "../../src/domain/types.js";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixtureRoot = join(projectRoot, ".cache", "tests");
let fixtureDirectory: string;

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    order_id: "TEST-200",
    handled_at: "2026-10-15T14:05:00+08:00",
    room_number: "0802",
    room_type: "大床房",
    check_in_date: "2026-10-15",
    check_out_date: "2026-10-16",
    amount_cents: 39800,
    currency: "CNY",
    ...overrides,
  };
}

function envelope(orders: unknown[] = [makeOrder()]): unknown {
  return { data_source: "synthetic demo data", orders };
}

async function writeFixture(value: unknown): Promise<string> {
  const filePath = join(fixtureDirectory, "orders.json");
  await writeFile(filePath, JSON.stringify(value), "utf8");
  return filePath;
}

beforeAll(async () => {
  await mkdir(fixtureRoot, { recursive: true });
});

beforeEach(async () => {
  fixtureDirectory = await mkdtemp(join(fixtureRoot, "repository-"));
});

afterEach(async () => {
  // 删除前确认临时目录仍在本仓库的测试缓存内。
  const target = resolve(fixtureDirectory);
  const scopedPath = relative(resolve(fixtureRoot), target);
  if (!scopedPath || scopedPath.startsWith("..") || isAbsolute(scopedPath)) {
    throw new Error(`Refusing to remove an unscoped test directory: ${target}`);
  }
  await rm(target, { recursive: true, force: true });
});

describe("queryOrdersByDate", () => {
  it("reads the actual synthetic sample from its module-relative default path", async () => {
    // Stage 2 新增订单；继续逐字段核对原始 O001，不再假设整天只有一条。
    await expect(queryOrdersByDate("2026-10-15")).resolves.toContainEqual(
      {
        order_id: "O001",
        handled_at: "2026-10-15T14:05:00+08:00",
        room_number: "802",
        room_type: "大床房",
        check_in_date: "2026-10-15",
        check_out_date: "2026-10-16",
        amount_cents: 39800,
        currency: "CNY",
      },
    );
  });

  it("accepts a custom file path and preserves string room numbers", async () => {
    const order = makeOrder();
    const filePath = await writeFixture(envelope([order]));
    await expect(queryOrdersByDate("2026-10-15", filePath)).resolves.toEqual([order]);
  });

  it("locates the default sample when called from a different working directory", () => {
    const repositoryUrl = pathToFileURL(join(projectRoot, "src", "data", "repository.ts")).href;
    const script = `
      const { queryOrdersByDate } = await import(${JSON.stringify(repositoryUrl)});
      console.log(JSON.stringify(await queryOrdersByDate("2026-10-15")));
    `;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: fixtureDirectory,
      encoding: "utf8",
      timeout: 10000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout) as unknown).toContainEqual(
      makeOrder({ order_id: "O001", room_number: "802" }),
    );
  });

  it("accepts a custom file URL", async () => {
    const order = makeOrder();
    const filePath = await writeFixture(envelope([order]));
    await expect(queryOrdersByDate("2026-10-15", pathToFileURL(filePath))).resolves.toEqual([order]);
  });

  it("returns an empty array when no handled date matches", async () => {
    const filePath = await writeFixture(envelope());
    await expect(queryOrdersByDate("2026-10-16", filePath)).resolves.toEqual([]);
  });

  it("accepts an empty orders array", async () => {
    const filePath = await writeFixture(envelope([]));
    await expect(queryOrdersByDate("2026-10-15", filePath)).resolves.toEqual([]);
  });

  it.each(["2026-1-15", "2026-10-5", "2026/10/15", "2026-10-15T00:00:00+08:00", " 2026-10-15", ""])(
    "rejects a query date that is not exact YYYY-MM-DD: %s",
    async (date) => {
      await expect(queryOrdersByDate(date)).rejects.toThrow(/date.*YYYY-MM-DD/i);
    },
  );

  it.each(["2026-02-29", "2026-04-31", "2026-00-15", "2026-13-15", "2026-10-00", "0000-01-01"])(
    "rejects an impossible query calendar date: %s",
    async (date) => {
      await expect(queryOrdersByDate(date)).rejects.toThrow(/date.*valid.*calendar/i);
    },
  );

  it("accepts a real leap day", async () => {
    const order = makeOrder({ handled_at: "2024-02-29T10:00:00+08:00" });
    const filePath = await writeFixture(envelope([order]));
    await expect(queryOrdersByDate("2024-02-29", filePath)).resolves.toEqual([order]);
  });

  it.each(["UTC", "America/Los_Angeles", "Asia/Shanghai"])(
    "uses Beijing midnight boundaries when host TZ is %s",
    async (timezone) => {
      const originalTimezone = process.env.TZ;
      process.env.TZ = timezone;
      try {
        const orders = [
          makeOrder({ order_id: "BEFORE", handled_at: "2026-10-14T23:59:59+08:00" }),
          makeOrder({ order_id: "START", handled_at: "2026-10-15T00:00:00+08:00" }),
          makeOrder({ order_id: "END", handled_at: "2026-10-15T23:59:59.999+08:00" }),
          makeOrder({ order_id: "AFTER", handled_at: "2026-10-16T00:00:00+08:00" }),
        ];
        const filePath = await writeFixture(envelope(orders));
        const results = await queryOrdersByDate("2026-10-15", filePath);
        expect(results.map((order) => order.order_id)).toEqual(["START", "END"]);
      } finally {
        if (originalTimezone === undefined) delete process.env.TZ;
        else process.env.TZ = originalTimezone;
      }
    },
  );

  it("reads changes to the same file on every call", async () => {
    const filePath = await writeFixture(envelope([makeOrder({ order_id: "FIRST" })]));
    expect((await queryOrdersByDate("2026-10-15", filePath))[0]?.order_id).toBe("FIRST");
    await writeFixture(envelope([makeOrder({ order_id: "SECOND", amount_cents: 42800 })]));
    await expect(queryOrdersByDate("2026-10-15", filePath)).resolves.toEqual([
      makeOrder({ order_id: "SECOND", amount_cents: 42800 }),
    ]);
  });

  it("reports the path when the JSON file does not exist", async () => {
    const filePath = join(fixtureDirectory, "missing.json");
    await expect(queryOrdersByDate("2026-10-15", filePath)).rejects.toThrow(filePath);
  });

  it("reports the path and JSON parse failure", async () => {
    const filePath = join(fixtureDirectory, "broken.json");
    await writeFile(filePath, "{broken", "utf8");
    const result = queryOrdersByDate("2026-10-15", filePath);
    await expect(result).rejects.toThrow(filePath);
    await expect(result).rejects.toThrow(/JSON/i);
  });

  it.each([
    [null, "root"],
    [[], "root"],
    [{ orders: [] }, "data_source"],
    [{ data_source: "production", orders: [] }, "data_source"],
    [{ data_source: "synthetic demo data" }, "orders"],
    [{ data_source: "synthetic demo data", orders: {} }, "orders"],
  ])("rejects an invalid JSON envelope %#", async (value, field) => {
    const filePath = await writeFixture(value);
    const result = queryOrdersByDate("2026-10-15", filePath);
    await expect(result).rejects.toThrow(filePath);
    await expect(result).rejects.toThrow(String(field));
  });

  it.each([null, [], "order"])("reports an invalid order row %#", async (value) => {
    const filePath = await writeFixture(envelope([value]));
    const result = queryOrdersByDate("2026-10-15", filePath);
    await expect(result).rejects.toThrow(filePath);
    await expect(result).rejects.toThrow(/orders\[0\]/);
  });

  it.each([
    ["order_id", ""],
    ["order_id", "   "],
    ["order_id", 7],
    ["handled_at", "2026-10-15T06:05:00Z"],
    ["handled_at", "2026-10-15T14:05:00+00:00"],
    ["handled_at", "2026-10-15T14:05:00"],
    ["handled_at", "2026-10-15 14:05:00+08:00"],
    ["handled_at", "2026-02-30T14:05:00+08:00"],
    ["handled_at", "2026-10-15T24:00:00+08:00"],
    ["handled_at", "2026-10-15T14:60:00+08:00"],
    ["handled_at", "2026-10-15T14:05:60+08:00"],
    ["handled_at", "2026-10-15T14:05:00.1234+08:00"],
    ["room_number", 802],
    ["room_number", ""],
    ["room_type", "  "],
    ["check_in_date", "2026-02-30"],
    ["check_in_date", "2026-1-15"],
    ["check_out_date", "2026-02-29"],
    ["check_out_date", "2026-10-15"],
    ["check_out_date", "2026-10-14"],
    ["amount_cents", -1],
    ["amount_cents", 398.5],
    ["amount_cents", "39800"],
    ["amount_cents", Number.MAX_SAFE_INTEGER + 1],
    ["currency", "USD"],
  ])("reports path, row and field for invalid %s (%#)", async (field, value) => {
    const filePath = await writeFixture(envelope([{ ...makeOrder(), [field as string]: value }]));
    const result = queryOrdersByDate("2026-10-15", filePath);
    await expect(result).rejects.toThrow(filePath);
    await expect(result).rejects.toThrow(`orders[0].${field}`);
  });

  it.each([
    "order_id", "handled_at", "room_number", "room_type", "check_in_date", "check_out_date", "amount_cents", "currency",
  ])("rejects a missing required %s field", async (field) => {
    const order: Record<string, unknown> = { ...makeOrder() };
    delete order[field];
    const filePath = await writeFixture(envelope([order]));
    await expect(queryOrdersByDate("2026-10-15", filePath)).rejects.toThrow(`orders[0].${field}`);
  });

  it("validates rows outside the requested date too", async () => {
    const filePath = await writeFixture(envelope([
      makeOrder(),
      { ...makeOrder({ handled_at: "2026-10-16T10:00:00+08:00" }), amount_cents: -1 },
    ]));
    await expect(queryOrdersByDate("2026-10-15", filePath)).rejects.toThrow("orders[1].amount_cents");
  });

  it.each(["2026-10-15T14:05:00.1+08:00", "2026-10-15T14:05:00.12+08:00", "2026-10-15T14:05:00.123+08:00"])(
    "accepts explicit Beijing timestamps with fractional seconds: %s",
    async (handledAt) => {
      const order = makeOrder({ handled_at: handledAt, amount_cents: 0 });
      const filePath = await writeFixture(envelope([order]));
      await expect(queryOrdersByDate("2026-10-15", filePath)).resolves.toEqual([order]);
    },
  );
});
