import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { queryOrdersByDate, queryRecordingsByDate } from '../data/repository.js';
import { auditDay } from '../domain/audit.js';
import type { DetailedAuditResult, RecordingDataWarning } from '../domain/types.js';
import { beijingTimestamp, type ToolEvidenceRecord } from './evidence.js';

export const QUERY_TOOL_NAME = 'query_orders_by_date';
export const AUDIT_TOOL_NAME = 'audit_day';

export interface AuditDayToolResult {
  date: string;
  window_seconds: number;
  warnings: RecordingDataWarning[];
  results: DetailedAuditResult[];
}

/** 默认使用真实仓库；可指定读函数以核验临时数据副本，不替换审计算法。 */
export interface AuditDayToolDependencies {
  queryOrdersByDate?: typeof queryOrdersByDate;
  queryRecordingsByDate?: typeof queryRecordingsByDate;
}

const auditDayParameters = Type.Object({
  date: Type.String({ description: '北京时间办理日期，真实的 YYYY-MM-DD 日期', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
  window_seconds: Type.Optional(Type.Number({ description: '订单与录音的时间窗口，单位秒', minimum: 0, default: 180 })),
}, { additionalProperties: false });

function auditArguments(args: unknown): { date: string; window_seconds: number } {
  if (typeof args !== 'object' || args === null || Array.isArray(args)
    || Reflect.ownKeys(args).some((key) => key !== 'date' && key !== 'window_seconds')) {
    throw new Error('无效的 audit_day 参数 arguments：只允许 date 和可选的 window_seconds');
  }
  const input = args as Record<string, unknown>;
  const date = input.date;
  if (!Object.hasOwn(input, 'date') || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || date.startsWith('0000-')) {
    throw new Error('无效的 date：必须是真实的 YYYY-MM-DD 日期');
  }
  const parsedDate = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
    throw new Error('无效的 date：必须是真实的 YYYY-MM-DD 日期');
  }
  const windowSeconds = Object.hasOwn(input, 'window_seconds') ? input.window_seconds : 180;
  if (typeof windowSeconds !== 'number' || !Number.isFinite(windowSeconds) || windowSeconds < 0) {
    throw new Error('无效的 window_seconds：必须是大于等于零的有限数值');
  }
  return { date, window_seconds: windowSeconds };
}

/** 只编排真实数据读取与既有纯审计函数；每次执行均重新查询。 */
export function createAuditDayTool(
  runId: string,
  recordExecution: (record: ToolEvidenceRecord) => void,
  dependencies: AuditDayToolDependencies = {},
) {
  const readOrders = dependencies.queryOrdersByDate ?? queryOrdersByDate;
  const readRecordings = dependencies.queryRecordingsByDate ?? queryRecordingsByDate;
  return defineTool<typeof auditDayParameters, AuditDayToolResult>({
    name: AUDIT_TOOL_NAME,
    label: '按办理日期核对酒店订单与录音',
    description: '按北京时间的办理日期读取订单和可用录音，再核对五项业务字段。date 必须为真实的 YYYY-MM-DD 日期；window_seconds 可选，默认 180 秒，必须是有限非负数字。返回全部候选、字段冲突、转写证据及音频数据警告。金额为人民币整数分。',
    parameters: auditDayParameters,
    prepareArguments(args) {
      // Pi 会在 schema 校验前转换值；先核实原始类型，并保留原始省略字段以便关联证据。
      auditArguments(args);
      return args as { date: string; window_seconds?: number };
    },
    async execute(toolCallId, args, signal) {
      const base = { runId, toolCallId, toolName: AUDIT_TOOL_NAME, args };
      recordExecution({ ...base, phase: 'execute_start', result: null, isError: null, timestamp: beijingTimestamp() });
      try {
        signal?.throwIfAborted();
        const input = auditArguments(args);
        const [orders, recordingQuery] = await Promise.all([readOrders(input.date), readRecordings(input.date)]);
        signal?.throwIfAborted();
        const results = auditDay(orders, recordingQuery.recordings, input.date, {
          window_seconds: input.window_seconds,
          data_warnings: recordingQuery.warnings,
        });
        signal?.throwIfAborted();
        const result: AuditDayToolResult = { ...input, warnings: recordingQuery.warnings, results };
        recordExecution({ ...base, phase: 'execute_end', result, isError: false, timestamp: beijingTimestamp() });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], details: result };
      } catch (error) {
        recordExecution({
          ...base, phase: 'execute_end',
          result: { error: error instanceof Error ? error.message : '未知核对错误' },
          isError: true, timestamp: beijingTimestamp(),
        });
        throw error;
      }
    },
  });
}

/** 只适配业务函数；调用是否来自 Agent，由 smoke 对照 Runtime 事件判断。 */
export function createQueryOrdersTool(
  runId: string,
  recordExecution: (record: ToolEvidenceRecord) => void,
) {
  return defineTool({
    name: QUERY_TOOL_NAME,
    label: '按办理日期查询酒店订单',
    description: '按北京时间的办理日期查询酒店订单，date 必须为真实的 YYYY-MM-DD 日期。金额为整数分，币种 CNY。',
    parameters: Type.Object({ date: Type.String({ description: '北京时间办理日期，YYYY-MM-DD' }) }),
    async execute(toolCallId, args, signal) {
      const base = { runId, toolCallId, toolName: QUERY_TOOL_NAME, args };
      recordExecution({ ...base, phase: 'execute_start', result: null, isError: null, timestamp: beijingTimestamp() });
      try {
        signal?.throwIfAborted();
        const orders = await queryOrdersByDate(args.date);
        const result = { date: args.date, orders };
        recordExecution({ ...base, phase: 'execute_end', result, isError: false, timestamp: beijingTimestamp() });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], details: result };
      } catch (error) {
        recordExecution({
          ...base, phase: 'execute_end',
          result: { error: error instanceof Error ? error.message : '未知数据查询错误' },
          isError: true, timestamp: beijingTimestamp(),
        });
        throw error;
      }
    },
  });
}
