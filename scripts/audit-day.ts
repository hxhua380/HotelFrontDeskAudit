import { auditDay } from "../src/domain/audit.js";
import { queryOrdersByDate, queryRecordingsByDate } from "../src/data/repository.js";

// 离线业务调试入口，不创建 Agent 会话，也不调用外部模型。
try {
  const args = process.argv.slice(2);
  if (args.length !== 1) throw new Error("用法：npm.cmd run audit -- YYYY-MM-DD");
  const date = args[0]!;
  const [orders, recordingQuery] = await Promise.all([queryOrdersByDate(date), queryRecordingsByDate(date)]);
  const results = auditDay(orders, recordingQuery.recordings, date, { data_warnings: recordingQuery.warnings });
  console.log(JSON.stringify({ date, warnings: recordingQuery.warnings, results }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : "未知核对错误" }));
  process.exitCode = 1;
}
