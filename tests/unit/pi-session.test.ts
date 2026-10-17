import { describe, expect, it } from 'vitest';
import { createHotelSession, DEFAULT_MODEL_ID } from '../../src/agent/pi-session.js';

describe('真实 SDK 的离线会话配置（不调用模型）', () => {
  it('只注册并开放业务工具，选择指定 DeepSeek 模型，不加载默认工具', async () => {
    const session = await createHotelSession({
      runId: 'offline-registration-only',
      recordExecution: () => { throw new Error('本测试禁止执行工具'); },
    });
    try {
      expect(session.getActiveToolNames()).toEqual(['query_orders_by_date']);
      expect(session.getAllTools().map((tool) => tool.name)).toEqual(['query_orders_by_date']);
      expect(session.model?.provider).toBe('deepseek');
      expect(session.model?.id).toBe(DEFAULT_MODEL_ID);
    } finally {
      session.dispose();
    }
  });

  it('拒绝不存在的模型 ID，不回退其他模型或 Provider', async () => {
    await expect(createHotelSession({
      runId: 'offline-invalid-model',
      modelId: 'nonexistent-hotel-model',
      recordExecution: () => {},
    })).rejects.toThrow(/DeepSeek.*模型/);
  });
});
