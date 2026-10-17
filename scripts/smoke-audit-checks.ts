import { isDeepStrictEqual } from 'node:util';
import { collectAuditToolResults, type ToolEvidenceRecord } from '../src/agent/evidence.js';
import { AUDIT_TOOL_NAME, QUERY_TOOL_NAME } from '../src/agent/tools.js';
import type { DetailedAuditResult } from '../src/domain/types.js';
import type { SmokeCheck } from './smoke-checks.js';

export interface AuditSmokeInput {
  runId: string;
  sessionCreated: boolean;
  activeTools: string[];
  events: ToolEvidenceRecord[];
  executions: ToolEvidenceRecord[];
  finalAnswer: string;
  finalStopReason: string | undefined;
}

function sameIds(actual: string[], required: string[]): boolean {
  return actual.length === required.length && [...actual].sort().every((value, index) => value === [...required].sort()[index]);
}

/** 此处的固定日期、编号、金额与分布只用于独立验收，不进入生产核对。 */
export function evaluateAuditSmoke(input: AuditSmokeInput): SmokeCheck[] {
  const all = [...input.events, ...input.executions];
  const auditEvents = input.events.filter((record) => record.runId === input.runId && record.toolName === AUDIT_TOOL_NAME);
  const auditExecutions = input.executions.filter((record) => record.runId === input.runId && record.toolName === AUDIT_TOOL_NAME);
  const starts = auditEvents.filter((record) => record.phase === 'tool_execution_start');
  const ends = auditEvents.filter((record) => record.phase === 'tool_execution_end');
  const entered = auditExecutions.filter((record) => record.phase === 'execute_start');
  const completed = auditExecutions.filter((record) => record.phase === 'execute_end');
  const captures = collectAuditToolResults(input.runId, input.events, input.executions);
  const hasCaptures = captures.length > 0;
  const paired = hasCaptures && captures.length === starts.length
    && auditEvents.length === captures.length * 2 && auditExecutions.length === captures.length * 2;
  const currentOnly = all.length > 0 && all.every((record) => record.runId === input.runId
    && (record.toolName === AUDIT_TOOL_NAME || record.toolName === QUERY_TOOL_NAME)
    && typeof record.toolCallId === 'string' && record.toolCallId.trim().length > 0);
  const correctDate = hasCaptures && captures.every((capture) => capture.args.date === '2026-10-15' && capture.result.date === '2026-10-15');
  const sevenGroups = hasCaptures && captures.every((capture) => capture.result.results.length === 7);
  const distribution = hasCaptures && captures.every(({ result }) => {
    const counts = new Map<string, number>();
    for (const group of result.results) counts.set(group.status, (counts.get(group.status) ?? 0) + 1);
    return counts.get('matched') === 1 && counts.get('field_mismatch') === 1
      && counts.get('missing_recording') === 1 && counts.get('orphan_recording') === 1
      && counts.get('needs_review') === 3;
  });
  const amountEvidence = hasCaptures && captures.every(({ result }) => {
    const groups = result.results.filter((group) => group.status === 'field_mismatch'
      && group.order_id === 'O002' && group.recording_id === 'R002'
      && sameIds(group.candidate_order_ids, ['O002']) && sameIds(group.candidate_recording_ids, ['R002']));
    return groups.length === 1 && groups[0]!.conflicting_fields.includes('amount_cents')
      && groups[0]!.conflicts.some((conflict) => conflict.field === 'amount_cents'
        && conflict.order_value === 75600 && conflict.recording_value === 79600
        && conflict.evidence.length > 0 && conflict.evidence.every((evidence) => evidence.recording_id === 'R002'
          && evidence.field === 'amount_cents' && evidence.text.trim().length > 0
          && evidence.end_ms > evidence.start_ms
          && groups[0]!.evidence.some((top) => isDeepStrictEqual(top, evidence))));
  });
  const reviewsComplete = hasCaptures && captures.every(({ result }) => {
    const reviews = result.results.filter((group) => group.status === 'needs_review');
    const hasGroup = (orders: string[], recordings: string[]): boolean => reviews.filter((group: DetailedAuditResult) =>
      sameIds(group.candidate_order_ids, orders) && sameIds(group.candidate_recording_ids, recordings)).length === 1;
    return reviews.length === 3 && hasGroup(['O004'], ['R004'])
      && hasGroup(['O005', 'O006'], ['R005']) && hasGroup(['O007'], ['R006', 'R007']);
  });
  return [
    { id: 'session_created', description: 'SDK 会话成功创建', passed: input.sessionCreated },
    { id: 'tools_registered', description: '仅开放 query_orders_by_date 与 audit_day 两个工具', passed: input.activeTools.length === 2 && new Set(input.activeTools).size === 2 && input.activeTools.includes(QUERY_TOOL_NAME) && input.activeTools.includes(AUDIT_TOOL_NAME) },
    { id: 'agent_audit_call', description: 'Agent 发起本轮 audit_day 调用', passed: starts.length > 0 },
    { id: 'execute_called', description: 'audit_day 的 execute() 实际进入并完成', passed: entered.length > 0 && completed.length === entered.length },
    { id: 'runtime_start', description: '捕获 audit_day 的 Runtime 开始事件', passed: starts.length > 0 },
    { id: 'runtime_end', description: '捕获 audit_day 的 Runtime 结束事件', passed: ends.length > 0 && ends.length === starts.length },
    { id: 'events_correlated', description: '同轮同调用四条记录的参数、结果与全局顺序一致', passed: paired },
    { id: 'correct_date', description: '工具调用及结构化返回日期均为 2026-10-15', passed: correctDate },
    { id: 'no_tool_error', description: 'audit_day 的 Runtime 与 execute 均无工具错误', passed: ends.length > 0 && completed.length > 0 && [...ends, ...completed].every((record) => record.isError === false) },
    { id: 'seven_groups', description: '结构化核对返回七个结果组', passed: sevenGroups },
    { id: 'status_distribution', description: '五类结果数量为 1/1/1/1/3', passed: distribution },
    { id: 'amount_conflict_evidence', description: 'O002 金额 75600/79600 分及原文片段证据完整', passed: amountEvidence },
    { id: 'review_candidates', description: '三个人工复核组保留全部订单与录音候选', passed: reviewsComplete },
    { id: 'final_answer', description: '模型正常结束并给出非空最终回答', passed: input.finalStopReason === 'stop' && input.finalAnswer.trim().length > 0 },
    { id: 'current_run', description: '全部日志均属于本轮 runId 和工具白名单', passed: currentOnly },
  ];
}
