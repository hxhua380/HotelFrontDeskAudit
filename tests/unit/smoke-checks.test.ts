import { describe, expect, it } from 'vitest';
import { evaluateSmoke } from '../../scripts/smoke-checks.js';

// 仅测试拒绝无证据的判定；不模拟 Runtime、不制造工具事件。
describe('在线冒烟的证据门槛', () => {
  it('即使模型文字声称成功，没有真实事件和 execute 记录仍然失败', () => {
    const checks = evaluateSmoke({
      runId: 'offline-negative-check',
      sessionCreated: true,
      activeTools: ['query_orders_by_date'],
      events: [],
      executions: [],
      finalAnswer: '已查询到 O001。',
      finalStopReason: 'stop',
    });
    expect(checks.every((check) => check.passed)).toBe(false);
    expect(checks.find((check) => check.id === 'agent_tool_call')?.passed).toBe(false);
    expect(checks.find((check) => check.id === 'execute_called')?.passed).toBe(false);
    expect(checks.find((check) => check.id === 'returned_o001')?.passed).toBe(false);
  });

  it('未创建会话且没有最终回答时不能通过', () => {
    const checks = evaluateSmoke({
      runId: 'offline-no-session',
      sessionCreated: false,
      activeTools: [],
      events: [],
      executions: [],
      finalAnswer: '',
      finalStopReason: undefined,
    });
    expect(checks).toHaveLength(9);
    expect(checks.every((check) => !check.passed)).toBe(true);
  });
});
