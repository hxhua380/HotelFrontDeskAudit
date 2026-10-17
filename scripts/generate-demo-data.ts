import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { queryOrdersByDate } from "../src/data/repository.js";
import type { Order } from "../src/domain/types.js";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const cacheRoot = join(projectRoot, ".cache");

interface TtsScript {
  recording_id: string;
  started_at: string;
  audio_path: string;
  text: string;
}

interface TtsManifest {
  schema_version: 1;
  data_source: "synthetic demo data";
  hotel: "Demo Hotel";
  time_zone: "Asia/Shanghai";
  voice: "zh-CN-XiaoxiaoNeural";
  rate: "+0%";
  recordings: TtsScript[];
}

const orders: Order[] = [
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
  {
    order_id: "O002",
    handled_at: "2026-10-15T15:10:00+08:00",
    room_number: "806",
    room_type: "双床房",
    check_in_date: "2026-10-15",
    check_out_date: "2026-10-17",
    amount_cents: 75600,
    currency: "CNY",
  },
  {
    order_id: "O003",
    handled_at: "2026-10-15T09:00:00+08:00",
    room_number: "505",
    room_type: "大床房",
    check_in_date: "2026-10-17",
    check_out_date: "2026-10-18",
    amount_cents: 29800,
    currency: "CNY",
  },
  {
    order_id: "O004",
    handled_at: "2026-10-15T16:20:00+08:00",
    room_number: "701",
    room_type: "商务大床房",
    check_in_date: "2026-10-15",
    check_out_date: "2026-10-16",
    amount_cents: 45800,
    currency: "CNY",
  },
  {
    order_id: "O005",
    handled_at: "2026-10-15T17:30:00+08:00",
    room_number: "901",
    room_type: "大床房",
    check_in_date: "2026-10-15",
    check_out_date: "2026-10-16",
    amount_cents: 42800,
    currency: "CNY",
  },
  {
    order_id: "O006",
    handled_at: "2026-10-15T17:30:20+08:00",
    room_number: "902",
    room_type: "大床房",
    check_in_date: "2026-10-15",
    check_out_date: "2026-10-16",
    amount_cents: 42800,
    currency: "CNY",
  },
  {
    order_id: "O007",
    handled_at: "2026-10-15T19:00:10+08:00",
    room_number: "1008",
    room_type: "豪华大床房",
    check_in_date: "2026-10-15",
    check_out_date: "2026-10-17",
    amount_cents: 95600,
    currency: "CNY",
  },
  {
    order_id: "O008",
    handled_at: "2026-10-16T10:15:00+08:00",
    room_number: "803",
    room_type: "大床房",
    check_in_date: "2026-10-18",
    check_out_date: "2026-10-19",
    amount_cents: 39800,
    currency: "CNY",
  },
];

const manifest: TtsManifest = {
  schema_version: 1,
  data_source: "synthetic demo data",
  hotel: "Demo Hotel",
  time_zone: "Asia/Shanghai",
  voice: "zh-CN-XiaoxiaoNeural",
  rate: "+0%",
  recordings: [
    {
      recording_id: "R001",
      started_at: "2026-10-15T14:05:02+08:00",
      audio_path: "audio/R001.mp3",
      text: "欢迎来到Demo Hotel，给您安排的是八零二号大床房，二零二六年十月十五日入住，十月十六日退房，房费合计三百九十八元，请您确认。",
    },
    {
      recording_id: "R002",
      started_at: "2026-10-15T15:10:02+08:00",
      audio_path: "audio/R002.mp3",
      text: "您好，Demo Hotel给您安排的是八零六号双床房，十月十五日入住，十月十七日退房，两晚房费合计七百九十六元，请核对入住信息。",
    },
    {
      recording_id: "R003",
      started_at: "2026-10-15T11:30:00+08:00",
      audio_path: "audio/R003.mp3",
      text: "您好，这里是Demo Hotel前台，您预订的是六零一号套房，十一月一日入住，十一月三日退房，两晚房费共一千九百九十八元，请确认。",
    },
    {
      recording_id: "R004",
      started_at: "2026-10-15T16:20:02+08:00",
      audio_path: "audio/R004.mp3",
      text: "Demo Hotel前台正在为您办理入住，请稍等，我先核对证件信息，房间和费用稍后再向您确认。",
    },
    {
      recording_id: "R005",
      started_at: "2026-10-15T17:30:10+08:00",
      audio_path: "audio/R005.mp3",
      text: "欢迎来到Demo Hotel，您预订的大床房已为您保留，十月十五日入住，十月十六日退房，请先出示证件，我再为您办理手续。",
    },
    {
      recording_id: "R006",
      started_at: "2026-10-15T19:00:00+08:00",
      audio_path: "audio/R006.mp3",
      text: "您好，Demo Hotel已为您安排一零零八号豪华大床房，十月十五日入住，十月十七日退房，房费合计九百五十六元，请核对一下。",
    },
    {
      recording_id: "R007",
      started_at: "2026-10-15T19:00:20+08:00",
      audio_path: "audio/R007.mp3",
      text: "再和您确认，您在Demo Hotel的一零零八号豪华大床房，入住日期十月十五日，退房日期十月十七日，两晚共九百五十六元。",
    },
    {
      recording_id: "R008",
      started_at: "2026-10-16T10:15:02+08:00",
      audio_path: "audio/R008.mp3",
      text: "您好，Demo Hotel为您保留了八零三号大床房，二零二六年十月十八日入住，十月十九日退房，一晚房费三百九十八元，今天先确认预订信息。",
    },
  ],
};

function isWithin(parent: string, path: string): boolean {
  const scopedPath = relative(parent, path);
  return scopedPath === "" || (!scopedPath.startsWith("..") && !isAbsolute(scopedPath));
}

async function fileContents(path: string): Promise<Buffer | null> {
  try {
    if (!(await lstat(path)).isFile()) throw new Error(`Destination must be a regular file: ${path}`);
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function validateManifest(value: TtsManifest): void {
  if (value.schema_version !== 1 || value.data_source !== "synthetic demo data"
    || value.hotel !== "Demo Hotel" || value.time_zone !== "Asia/Shanghai"
    || value.voice !== "zh-CN-XiaoxiaoNeural" || value.rate !== "+0%") {
    throw new Error("Invalid TTS manifest settings");
  }
  const ids = new Set<string>();
  for (const recording of value.recordings) {
    const timestamp = recording.started_at;
    const timestampValid = /^2026-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(timestamp)
      && Number.isFinite(Date.parse(timestamp))
      && new Date(Date.parse(timestamp) + 8 * 60 * 60 * 1000).toISOString().slice(0, 19) === timestamp.slice(0, 19);
    if (!/^R\d{3}$/.test(recording.recording_id) || ids.has(recording.recording_id)
      || !timestampValid || recording.audio_path !== `audio/${recording.recording_id}.mp3`
      || !recording.text.trim() || /[OR]\d{3}/.test(recording.text)) {
      throw new Error(`Invalid TTS manifest recording: ${recording.recording_id}`);
    }
    ids.add(recording.recording_id);
  }
  if (ids.size !== 8) throw new Error("TTS manifest must contain eight distinct recordings");
}

/** Only the real data directory or test roots under this repository's cache may be used. */
export async function generateDemoData(outputRoot = projectRoot): Promise<{
  ordersPath: string;
  manifestPath: string;
  orderCount: number;
  recordingCount: number;
}> {
  const root = resolve(outputRoot);
  if (root !== resolve(projectRoot) && !isWithin(cacheRoot, root)) {
    throw new Error("Alternate output root must be inside the repository .cache directory");
  }
  const dataDirectory = join(root, "data");
  await mkdir(dataDirectory, { recursive: true });
  const ordersPath = join(dataDirectory, "orders.json");
  const manifestPath = join(dataDirectory, "tts-manifest.json");
  const token = randomUUID();
  const files = [
    {
      path: ordersPath,
      temporaryPath: join(dataDirectory, `.orders.${token}.tmp`),
      contents: `${JSON.stringify({ data_source: "synthetic demo data", hotel: "Demo Hotel", time_zone: "Asia/Shanghai", orders }, null, 2)}\n`,
      previous: await fileContents(ordersPath),
    },
    {
      path: manifestPath,
      temporaryPath: join(dataDirectory, `.tts-manifest.${token}.tmp`),
      contents: `${JSON.stringify(manifest, null, 2)}\n`,
      previous: await fileContents(manifestPath),
    },
  ];
  const published: typeof files = [];

  try {
    for (const file of files) await writeFile(file.temporaryPath, file.contents, { encoding: "utf8", flag: "wx" });
    // The frozen repository validates the complete staged orders, before either destination changes.
    const validatedOrders = await queryOrdersByDate("2026-10-15", files[0]!.temporaryPath);
    validatedOrders.push(...await queryOrdersByDate("2026-10-16", files[0]!.temporaryPath));
    if (validatedOrders.length !== 8 || new Set(validatedOrders.map((order) => order.order_id)).size !== 8) {
      throw new Error("Demo data must contain eight distinct orders on the two handled dates");
    }
    validateManifest(JSON.parse(await readFile(files[1]!.temporaryPath, "utf8")) as TtsManifest);

    for (const file of files) {
      await rename(file.temporaryPath, file.path);
      published.push(file);
    }
  } catch (error) {
    // Restore a destination if a later rename fails, so a failed run cannot leave half a new pair.
    const rollbackErrors: unknown[] = [];
    for (const file of published.reverse()) {
      try {
        if (file.previous === null) await rm(file.path, { force: true });
        else {
          await writeFile(file.temporaryPath, file.previous, { flag: "wx" });
          await rename(file.temporaryPath, file.path);
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], "Demo-data publication and rollback failed");
    throw error;
  } finally {
    for (const file of files) await rm(file.temporaryPath, { force: true });
  }

  return { ordersPath, manifestPath, orderCount: orders.length, recordingCount: manifest.recordings.length };
}

// Importing this module in a test does not run the command.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  generateDemoData().then((result) => {
    console.log(`Generated ${result.orderCount} demo orders and ${result.recordingCount} TTS scripts.`);
  }).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
