import type { ModelSettings } from '../config/settings.ts';

// 统一模型调用：本机 Ollama 与 OpenAI 兼容的 Chat Completions 服务
// （例如 StepFun 的 https://api.stepfun.com/step_plan/v1）。
// 这个模块只负责协议差异，不决定动作，也不解释世界。

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };
export type ChatOptions = {
  messages: ChatMessage[];
  format?: unknown;
  think?: boolean | null;
  keepAlive?: string;
  seed?: number;
};
export type ChatReply = { content: string; thinking: string | null; doneReason: string; tokens: number | null };

const DEFAULT_BASE_URLS: Record<ModelSettings['provider'], string> = {
  ollama: 'http://127.0.0.1:11434',
  'openai-compatible': '',
};

export function resolveBaseUrl(model: ModelSettings): string {
  const raw = model.baseUrl.trim() || DEFAULT_BASE_URLS[model.provider];
  if (!raw) throw new Error('未配置 model.baseUrl');
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('model.baseUrl 必须是 http(s) 地址');
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

export function describeModel(model: ModelSettings): string {
  let baseUrl: string;
  try { baseUrl = resolveBaseUrl(model); } catch { baseUrl = '未配置 baseUrl'; }
  return `${model.provider}｜${baseUrl}｜${model.name}${model.apiKey.trim() ? '｜已配置 Key' : '｜未配置 Key'}`;
}

// 空 Key 时尽早报错，避免静默退回规则模式。
export function assertModelReady(model: ModelSettings): void {
  if (model.provider === 'openai-compatible' && !model.apiKey.trim()) {
    throw new Error('model.apiKey 为空：请在 deerlive.config.json 的 model.apiKey 填入服务商密钥');
  }
}

function ollamaOptions(model: ModelSettings, seed: number) {
  return {
    temperature: model.temperature,
    top_p: model.topP,
    num_predict: model.numPredict,
    num_ctx: model.numCtx,
    seed,
  };
}

export function buildChatRequest(model: ModelSettings, options: ChatOptions): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  assertModelReady(model);
  const baseUrl = resolveBaseUrl(model);
  if (model.provider === 'ollama') {
    return {
      url: `${baseUrl}/api/chat`,
      headers: { 'Content-Type': 'application/json' },
      body: {
        model: model.name, messages: options.messages, stream: false,
        keep_alive: options.keepAlive || '5m',
        ...(options.think === null || options.think === undefined ? {} : { think: options.think }),
        ...(options.format === undefined ? {} : { format: options.format }),
        options: ollamaOptions(model, options.seed ?? model.seed),
      },
    };
  }
  const body: Record<string, unknown> = {
    model: model.name, messages: options.messages, stream: false,
    max_tokens: model.numPredict,
    temperature: model.temperature,
    top_p: model.topP,
  };
  if (options.format !== undefined) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'deer_response', strict: false, schema: options.format },
    };
  }
  if (model.reasoningEffort) body.reasoning_effort = model.reasoningEffort;
  return {
    url: `${baseUrl}/chat/completions`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${model.apiKey.trim()}` },
    body,
  };
}

function errorMessage(value: unknown): string | null {
  if (typeof value === 'string' && value) return value;
  if (value && typeof value === 'object' && typeof (value as { message?: unknown }).message === 'string') return (value as { message: string }).message;
  return null;
}

export function parseChatReply(model: ModelSettings, raw: unknown): ChatReply {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const error = errorMessage(body.error);
  if (error) throw new Error(error.slice(0, 300));
  if (model.provider === 'ollama') {
    if (body.done !== true) throw new Error('响应不完整（done 不为 true）');
    if (body.done_reason === 'length') throw new Error(`模型输出不完整（结束原因：length，thinking ${(body.message?.thinking || '').length} 字）`);
    const content = body.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error(`模型未返回内容（结束原因：${body.done_reason || 'unknown'}）`);
    return {
      content,
      thinking: typeof body.message?.thinking === 'string' && body.message.thinking ? body.message.thinking : null,
      doneReason: body.done_reason || 'stop',
      tokens: typeof body.eval_count === 'number' ? body.eval_count : null,
    };
  }
  const choice = Array.isArray(body.choices) ? body.choices[0] : null;
  const finish = choice?.finish_reason || 'unknown';
  const message = choice?.message || {};
  if (finish === 'length') throw new Error(`模型输出不完整（结束原因：length，reasoning ${(message.reasoning_content || message.reasoning || '').length} 字）`);
  if (typeof message.content !== 'string' || !message.content.trim()) throw new Error(`模型未返回内容（finish_reason=${finish}）`);
  const thinking = typeof message.reasoning_content === 'string' && message.reasoning_content
    ? message.reasoning_content
    : typeof message.reasoning === 'string' && message.reasoning ? message.reasoning : null;
  return {
    content: message.content,
    thinking,
    doneReason: finish,
    tokens: typeof body.usage?.completion_tokens === 'number' ? body.usage.completion_tokens : null,
  };
}

export async function chat(model: ModelSettings, options: ChatOptions, deps: { fetcher?: typeof fetch; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ChatReply> {
  const { url, headers, body } = buildChatRequest(model, options);
  const timeoutMs = deps.timeoutMs ?? model.timeoutMs;
  const response = await (deps.fetcher || fetch)(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(deps.signal ? [deps.signal] : [])]),
  });
  const text = await response.text();
  if (!response.ok) {
    const label = model.provider === 'ollama' ? 'Ollama' : '模型服务';
    throw new Error(`${label} HTTP ${response.status}：${text.slice(0, 200)}`);
  }
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { throw new Error(`响应不是 JSON：${text.slice(0, 120)}`); }
  return parseChatReply(model, payload);
}

// 无指令续写只存在于 Ollama 的 /api/generate；OpenAI 兼容协议没有等价的无提示补全。
export async function rawCompletion(model: ModelSettings, prompt: string, deps: { fetcher?: typeof fetch; timeoutMs?: number; signal?: AbortSignal; think?: boolean | null; seed?: number } = {}) {
  if (model.provider !== 'ollama') throw new Error('无指令续写只在 ollama 模式下可用');
  const baseUrl = resolveBaseUrl(model);
  const response = await (deps.fetcher || fetch)(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model.name, prompt, raw: true, stream: false, keep_alive: '5m',
      ...(deps.think === null || deps.think === undefined ? {} : { think: deps.think }),
      options: ollamaOptions(model, deps.seed ?? model.seed),
    }),
    signal: AbortSignal.any([AbortSignal.timeout(deps.timeoutMs ?? model.timeoutMs), ...(deps.signal ? [deps.signal] : [])]),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Ollama HTTP ${response.status}：${text.slice(0, 200)}`);
  const body = JSON.parse(text) as Record<string, any>;
  const error = errorMessage(body.error);
  if (error) throw new Error(error.slice(0, 300));
  if (body.done !== true) throw new Error('响应不完整（done 不为 true）');
  if (typeof body.response !== 'string') throw new Error('响应缺少续写文本');
  return { text: body.response, doneReason: body.done_reason || 'stop', tokens: typeof body.eval_count === 'number' ? body.eval_count : null };
}
