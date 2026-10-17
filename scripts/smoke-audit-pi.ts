import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentRunSummary, loadAgentEnvironment, runAuditAgent } from './audit-agent.js';
import { evaluateAuditSmoke } from './smoke-audit-checks.js';

export const AUDIT_SMOKE_PROMPT = '请核对 2026 年 10 月 15 日的酒店前台订单与接待录音，列出当天异常，并重点解释 O002 为什么金额不一致。';

async function main(): Promise<void> {
  loadAgentEnvironment();
  const run = await runAuditAgent(AUDIT_SMOKE_PROMPT);
  const checks = evaluateAuditSmoke({
    runId: run.runId, sessionCreated: run.sessionCreated, activeTools: run.activeTools,
    events: run.events, executions: run.executions, finalAnswer: run.finalAnswer,
    finalStopReason: run.finalStopReason ?? undefined,
  });
  if (run.status !== 'BLOCKED' && !checks.every((check) => check.passed)) {
    run.status = 'FAIL';
    run.error = [run.error, '未通过：' + checks.filter((check) => !check.passed).map((check) => check.id).join(', ')].filter(Boolean).join('；');
  }
  // 只补充刚由本进程新建的本轮摘要，不读取或更新任何历史运行。
  writeFileSync(run.summaryPath, JSON.stringify({ ...agentRunSummary(run), checks, smoke: true }, null, 2) + '\n');
  console.log(`${run.status}: runId=${run.runId}`);
  console.log(`本轮报告：${run.summaryPath}`);
  console.log(`在线证据检查：${checks.filter((check) => check.passed).length}/${checks.length}`);
  if (run.error) console.error(run.error);
  process.exitCode = run.status === 'PASS' ? 0 : run.status === 'BLOCKED' ? 2 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(() => {
    console.error('FAIL: Pi 审计冒烟无法运行或保存报告，请检查文件权限及 CLI 配置。');
    process.exitCode = 1;
  });
}
