import { isDeepStrictEqual } from 'node:util';
import type { ToolEvidenceRecord } from '../src/agent/evidence.js';
import { QUERY_TOOL_NAME } from '../src/agent/tools.js';

export interface SmokeCheck { id: string; description: string; passed: boolean }
interface SmokeInput {
  runId: string;
  sessionCreated: boolean;
  activeTools: string[];
  events: ToolEvidenceRecord[];
  executions: ToolEvidenceRecord[];
  finalAnswer: string;
  finalStopReason: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 独立验收九项条件，不把模型自述或旧日志作为执行证据。 */
export function evaluateSmoke(input: SmokeInput): SmokeCheck[] {
  const starts = input.events.filter((e) => e.phase === 'tool_execution_start');
  const ends = input.events.filter((e) => e.phase === 'tool_execution_end');
  const entered = input.executions.filter((e) => e.phase === 'execute_start');
  const completed = input.executions.filter((e) => e.phase === 'execute_end');
  const all = [...input.events, ...input.executions];
  const currentOnly = all.every((e) => e.runId === input.runId && e.toolName === QUERY_TOOL_NAME && e.toolCallId.length > 0);
  const paired = currentOnly && starts.length > 0 && starts.length === ends.length
    && starts.length === entered.length && starts.length === completed.length
    && new Set(starts.map((e) => e.toolCallId)).size === starts.length
    && starts.every((start) => {
      const matching = [ends, entered, completed].map((records) => records.filter((e) => e.toolCallId === start.toolCallId));
      if (!matching.every((records) => records.length === 1)) return false;
      const end = matching[0]?.[0];
      const enter = matching[1]?.[0];
      const complete = matching[2]?.[0];
      if (!end || !enter || !complete) return false;
      return isDeepStrictEqual(start.args, enter.args) && isDeepStrictEqual(start.args, complete.args)
        && isDeepStrictEqual(start.args, end.args)
        && isRecord(end.result) && isDeepStrictEqual(end.result.details, complete.result)
        && Date.parse(start.timestamp) <= Date.parse(enter.timestamp)
        && Date.parse(enter.timestamp) <= Date.parse(complete.timestamp)
        && Date.parse(complete.timestamp) <= Date.parse(end.timestamp);
    });
  const correctDates = paired && all.every((e) => isRecord(e.args) && e.args.date === '2026-10-15');
  const returnedOrder = paired && completed.every((e) => isRecord(e.result)
    && e.result.date === '2026-10-15' && Array.isArray(e.result.orders)
    && e.result.orders.some((order: unknown) => isRecord(order) && order.order_id === 'O001'));
  const noErrors = paired && [...ends, ...completed].every((e) => e.isError === false);
  return [
    { id: 'session_created', description: 'SDK 会话成功创建', passed: input.sessionCreated },
    { id: 'tool_registered', description: '仅开放 query_orders_by_date', passed: input.activeTools.length === 1 && input.activeTools[0] === QUERY_TOOL_NAME },
    { id: 'agent_tool_call', description: 'Agent 发起当前 runId 的工具调用', passed: currentOnly && starts.length > 0 },
    { id: 'execute_called', description: '实际 execute() 有进入和完成记录', passed: currentOnly && entered.length > 0 && completed.length === entered.length },
    { id: 'events_correlated', description: '开始/结束/execute 的 ID、参数、结果及先后关系一致', passed: paired },
    { id: 'correct_date', description: '调用日期为 2026-10-15', passed: correctDates },
    { id: 'returned_o001', description: '工具结构化结果包含 O001', passed: returnedOrder },
    { id: 'no_tool_error', description: 'Runtime 与 execute 的 isError 均为 false', passed: noErrors },
    { id: 'final_answer', description: '模型最终正常结束并给出包含 O001 的回答', passed: input.finalStopReason === 'stop' && input.finalAnswer.trim().length > 0 && input.finalAnswer.includes('O001') },
  ];
}
