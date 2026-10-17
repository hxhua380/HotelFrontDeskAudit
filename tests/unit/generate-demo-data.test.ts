import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { queryOrdersByDate } from "../../src/data/repository.js";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const cacheRoot = join(projectRoot, ".cache", "tests");
const generatorPath = join(projectRoot, "scripts", "generate-demo-data.ts");
let fixtureDirectory: string;

async function generator(): Promise<{ generateDemoData: (outputRoot?: string) => Promise<unknown> }> {
  expect(existsSync(generatorPath), "the reusable demo-data generator exists").toBe(true);
  return await import(pathToFileURL(generatorPath).href) as {
    generateDemoData: (outputRoot?: string) => Promise<unknown>;
  };
}

beforeEach(async () => {
  await mkdir(cacheRoot, { recursive: true });
  fixtureDirectory = await mkdtemp(join(cacheRoot, "demo-data-"));
});

afterEach(async () => {
  const target = resolve(fixtureDirectory);
  const scopedPath = relative(resolve(cacheRoot), target);
  if (!scopedPath || scopedPath.startsWith("..") || isAbsolute(scopedPath)) {
    throw new Error(`Refusing to remove an unscoped test directory: ${target}`);
  }
  await rm(target, { recursive: true, force: true });
});

describe("generateDemoData", () => {
  it("repeats byte-for-byte while preserving unrelated files", async () => {
    const { generateDemoData } = await generator();
    const dataDirectory = join(fixtureDirectory, "data");
    await mkdir(dataDirectory);
    await writeFile(join(dataDirectory, "recordings.json"), "keep recordings\n");
    await writeFile(join(dataDirectory, "notes.txt"), "keep notes\n");

    await generateDemoData(fixtureDirectory);
    const ordersFile = join(dataDirectory, "orders.json");
    const manifestFile = join(dataDirectory, "tts-manifest.json");
    const firstOrders = await readFile(ordersFile, "utf8");
    const firstManifest = await readFile(manifestFile, "utf8");
    await generateDemoData(fixtureDirectory);

    expect(await readFile(ordersFile, "utf8")).toBe(firstOrders);
    expect(await readFile(manifestFile, "utf8")).toBe(firstManifest);
    expect(await readFile(join(dataDirectory, "recordings.json"), "utf8")).toBe("keep recordings\n");
    expect(await readFile(join(dataDirectory, "notes.txt"), "utf8")).toBe("keep notes\n");
    expect((await readdir(dataDirectory)).sort()).toEqual([
      "notes.txt", "orders.json", "recordings.json", "tts-manifest.json",
    ]);

    const firstDay = await queryOrdersByDate("2026-10-15", ordersFile);
    const secondDay = await queryOrdersByDate("2026-10-16", ordersFile);
    expect(firstDay).toHaveLength(7);
    expect(secondDay).toHaveLength(1);
    expect(firstDay.find((order) => order.order_id === "O001")).toEqual({
      order_id: "O001",
      handled_at: "2026-10-15T14:05:00+08:00",
      room_number: "802",
      room_type: "大床房",
      check_in_date: "2026-10-15",
      check_out_date: "2026-10-16",
      amount_cents: 39800,
      currency: "CNY",
    });
  });

  it("does not replace orders when the manifest destination cannot be published", async () => {
    const { generateDemoData } = await generator();
    const dataDirectory = join(fixtureDirectory, "data");
    await mkdir(dataDirectory);
    await writeFile(join(dataDirectory, "orders.json"), "original orders\n");
    await mkdir(join(dataDirectory, "tts-manifest.json"));

    await expect(generateDemoData(fixtureDirectory)).rejects.toThrow(/tts-manifest\.json/);
    expect(await readFile(join(dataDirectory, "orders.json"), "utf8")).toBe("original orders\n");
    expect((await readdir(dataDirectory)).sort()).toEqual(["orders.json", "tts-manifest.json"]);
  });

  it("rejects an alternate output root outside the repository cache", async () => {
    const { generateDemoData } = await generator();
    await expect(generateDemoData(join(projectRoot, "data"))).rejects.toThrow(/output root.*cache/i);
  });

  it("does not generate or log anything when merely imported", async () => {
    await generator();
    const dataPaths = ["orders.json", "tts-manifest.json"].map((name) => join(projectRoot, "data", name));
    const before = await Promise.all(dataPaths.map(async (path) => existsSync(path) ? await readFile(path, "utf8") : null));
    const child = spawnSync(process.execPath, [
      "--import", "tsx", "--input-type=module", "--eval",
      `await import(${JSON.stringify(pathToFileURL(generatorPath).href)});`,
    ], { cwd: fixtureDirectory, encoding: "utf8", timeout: 10000 });

    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe("");
    expect(await readdir(fixtureDirectory)).toEqual([]);
    const after = await Promise.all(dataPaths.map(async (path) => existsSync(path) ? await readFile(path, "utf8") : null));
    expect(after).toEqual(before);
  });
});
