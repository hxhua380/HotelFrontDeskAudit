import { fileURLToPath } from 'node:url';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import {
  createAgentSession, createExtensionRuntime, ModelRuntime,
  SessionManager, SettingsManager, type ResourceLoader,
} from '@earendil-works/pi-coding-agent';
import type { ToolEvidenceRecord } from './evidence.js';
import { AUDIT_TOOL_NAME, createAuditDayTool, createQueryOrdersTool, QUERY_TOOL_NAME } from './tools.js';

export const DEFAULT_MODEL_ID = 'deepseek-flash';
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

interface HotelSessionOptions {
  runId: string;
  recordExecution: (record: ToolEvidenceRecord) => void;
  apiKey?: string;
  modelId?: string;
  auditEnabled?: boolean;
}

/** 显式替换默认资源发现，避免加载全局扩展、技能或其他项目上下文。 */
function hotelResources(): ResourceLoader {
  const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => '你是酒店前台业务助手。工具结果是业务事实的唯一来源。只查询订单时调用 query_orders_by_date；核对订单录音、解释当天异常或字段差异时必须调用 audit_day，日期按北京时间办理日理解，不能用入住日代替。用户未提供可确定日期时先澄清，不猜日期。业务状态由核对工具决定，不重新计算匹配或覆盖结果。不得编造订单号、录音号、金额或证据。金额为人民币整数分，展示元时正确换算。严格区分确定匹配和候选关联，needs_review 必须称为待复核，不能说已经匹配；标量编号可能只是唯一候选。缺少证据或无法确认时如实说明。转写只有整句时间范围，不能说成词级精确时间。用简洁中文解释冲突字段、双方值、录音编号及原句时间范围。',
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

export async function createHotelSession(options: HotelSessionOptions) {
  // 所有认证、设置、会话均在内存；不读写 ~/.pi，不刷新远程模型目录。
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const modelId = options.modelId ?? DEFAULT_MODEL_ID;
  const model = modelRuntime.getModel('deepseek', modelId);
  if (!model) throw new Error(`DeepSeek 模型未在已安装 SDK 中注册：${modelId}；禁止静默回退。`);
  if (options.apiKey) await modelRuntime.setRuntimeApiKey('deepseek', options.apiKey);

  const { session, modelFallbackMessage } = await createAgentSession({
    cwd: projectRoot,
    agentDir: fileURLToPath(new URL('../../.cache/pi/', import.meta.url)),
    modelRuntime,
    model,
    thinkingLevel: 'off',
    tools: options.auditEnabled ? [QUERY_TOOL_NAME, AUDIT_TOOL_NAME] : [QUERY_TOOL_NAME],
    customTools: options.auditEnabled
      ? [createQueryOrdersTool(options.runId, options.recordExecution), createAuditDayTool(options.runId, options.recordExecution)]
      : [createQueryOrdersTool(options.runId, options.recordExecution)],
    resourceLoader: hotelResources(),
    sessionManager: SessionManager.inMemory(projectRoot),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false, provider: { maxRetries: 0, timeoutMs: 30_000 } },
      cacheWarming: 'off',
    }),
  });
  if (modelFallbackMessage || session.model?.provider !== 'deepseek' || session.model.id !== modelId) {
    session.dispose();
    throw new Error('Pi 实际模型与指定的 DeepSeek 模型不符，已拒绝回退。');
  }
  return session;
}
