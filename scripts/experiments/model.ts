import { chat, rawCompletion } from '../../src/agent/client.ts';
import type { ChatMessage } from '../../src/agent/client.ts';
import type { ModelSettings } from '../../src/config/settings.ts';

// 所有本机实验共用同一份模型配置；种子只是实验中的显式变量。
// 协议差异由 src/agent/client.ts 处理，实验只关心内容与结束原因。
export type ModelReply = {
  done: true;
  done_reason: string;
  message: { content: string; thinking?: string };
  eval_count: number | null;
};

export async function askModel(model: ModelSettings, options: { messages: unknown[]; format?: unknown; think?: boolean | null; seed?: number }, timeoutMs = model.timeoutMs): Promise<ModelReply> {
  const reply = await chat(model, {
    messages: options.messages as ChatMessage[],
    format: options.format,
    think: options.think ?? null,
    keepAlive: '10m',
    seed: options.seed ?? model.seed,
  }, { timeoutMs });
  return {
    done: true,
    done_reason: reply.doneReason,
    message: { content: reply.content, ...(reply.thinking ? { thinking: reply.thinking } : {}) },
    eval_count: reply.tokens,
  };
}

export async function askRaw(model: ModelSettings, prompt: string, options: { think?: boolean | null; seed?: number } = {}, timeoutMs = model.timeoutMs) {
  return rawCompletion(model, prompt, { think: options.think ?? null, seed: options.seed ?? model.seed, timeoutMs });
}

// 报告里不保存密钥明文，只记录是否已配置。
export function reportModel(model: ModelSettings) {
  return { ...model, apiKey: model.apiKey ? '已配置（未写入报告）' : '' };
}

export function seedSeries(model: ModelSettings, count: number): number[] {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('实验种子数量必须是正整数');
  return Array.from({ length: count }, (_, index) => {
    const seed = model.seed + index;
    if (!Number.isSafeInteger(seed) || seed > 2147483647) throw new Error('实验种子超出允许范围');
    return seed;
  });
}
