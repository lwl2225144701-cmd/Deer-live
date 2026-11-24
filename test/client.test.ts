import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, type ModelSettings } from '../src/config/settings.ts';
import { buildChatRequest, chat, parseChatReply } from '../src/agent/client.ts';
import { ModelBrain } from '../src/agent/brain.ts';
import { initialWorld } from '../src/world/world.ts';
import { Store } from '../src/storage/store.ts';
import { tick } from '../src/app/runtime.ts';

const cloud = (): ModelSettings => ({
  ...DEFAULT_SETTINGS.model,
  provider: 'openai-compatible',
  name: 'step-5-preview',
  baseUrl: 'https://api.stepfun.com/step_plan/v1',
  apiKey: 'test-key',
  timeoutMs: 1000,
});

test('OpenAI 兼容请求：路径、鉴权、参数与 JSON Schema', () => {
  const model = cloud();
  const format = { type: 'object', properties: { choice: { type: 'string' } }, required: ['choice'], additionalProperties: false };
  const request = buildChatRequest(model, { messages: [{ role: 'user', content: 'hi' }], format });
  assert.equal(request.url, 'https://api.stepfun.com/step_plan/v1/chat/completions');
  assert.equal(request.headers.Authorization, 'Bearer test-key');
  assert.equal(request.body.model, 'step-5-preview');
  assert.equal(request.body.max_tokens, model.numPredict);
  assert.equal(request.body.temperature, model.temperature);
  assert.equal(request.body.top_p, model.topP);
  assert.deepEqual(request.body.response_format, {
    type: 'json_schema',
    json_schema: { name: 'deer_response', strict: false, schema: format },
  });
  assert.ok(!('seed' in request.body) && !('num_ctx' in request.body));
});

test('OpenAI 兼容响应：reasoning_content 计入思考，length 视为不完整', () => {
  const model = cloud();
  const reply = parseChatReply(model, {
    choices: [{ finish_reason: 'stop', message: { content: '{"choice":"west"}', reasoning_content: '先看看西边' } }],
    usage: { completion_tokens: 12 },
  });
  assert.equal(reply.content, '{"choice":"west"}');
  assert.equal(reply.thinking, '先看看西边');
  assert.equal(reply.tokens, 12);
  assert.throws(() => parseChatReply(model, { choices: [{ finish_reason: 'length', message: { content: '' } }] }), /不完整/);
  assert.throws(() => parseChatReply(model, { error: { message: 'invalid api key' } }), /invalid api key/);
});

test('空 API Key 在发请求前报错', async () => {
  const model = { ...cloud(), apiKey: '' };
  await assert.rejects(() => chat(model, { messages: [{ role: 'user', content: 'hi' }] }), /apiKey/);
});

test('Brain 在 OpenAI 兼容协议下解析动作并保留模型名', async () => {
  const model = cloud();
  let seen: RequestInit | null = null;
  const fetcher = (async (_url: unknown, init: RequestInit) => {
    seen = init;
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"choice":"west"}' } }] }));
  }) as typeof fetch;
  const brain = new ModelBrain({ modelConfig: model, fetcher });
  const decision = await brain.decide(initialWorld(), []);
  assert.deepEqual(decision.action, { type: 'move', dx: -1, dy: 0 });
  assert.equal(decision.model, 'step-5-preview');
  const payload = JSON.parse(seen!.body as string);
  assert.equal(payload.model, 'step-5-preview');
  assert.equal(payload.messages[0].role, 'user');
});

test('云端模型在完整 tick 中完成决策并原子保存', async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.model = cloud();
  const store = new Store(':memory:');
  store.initialize(initialWorld(settings.initialWorld));
  try {
    const fetcher = (async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"choice":"west","goal":"none"}' } }] }))) as typeof fetch;
    const brain = new ModelBrain({ modelConfig: settings.model, life: settings.life, character: settings.character, fetcher });
    const result = await tick(store, { brain, settings, strict: true });
    assert.equal(result.event.cognition?.source, 'ollama');
    assert.equal(result.event.cognition?.model, 'step-5-preview');
    assert.equal(store.load()?.tick, 1);
    assert.equal(store.load()?.agent.x, 1);
  } finally { store.close(); }
});
