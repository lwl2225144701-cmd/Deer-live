import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OllamaBrain, decisionRequest, compactDecisionRequest } from '../src/agent/brain.ts';
import { initialWorld } from '../src/world/world.ts';
import { Store } from '../src/storage/store.ts';
import { tick } from '../src/app/runtime.ts';

const response = (content: unknown, extra = {}) => (async () => new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: JSON.stringify(content) }, ...extra }))) as typeof fetch;

test('模型只看到近处环境和检索出的记忆，不泄漏远处资源', () => {
  const world = initialWorld();
  const request = decisionRequest(world, []);
  const context = JSON.parse(request.messages[0].content);
  assert.ok(!context.observation.nearby.some((p: {name:string}) => p.name === '浆果丛'));
  assert.ok(!request.messages[0].content.includes('苹果树'));
  const memory = { id: 'event:3', tick: 3, x: 0, y: 2, place: '浆果丛', foodRemaining: 2, text: '发现浆果' };
  assert.deepEqual(JSON.parse(decisionRequest(world, [memory]).messages[0].content).memories, [{ ...memory, nextAction: 'west' }]);
});

test('空地点的记忆仅为事实，不会附带重复探索或返回该地的指令', () => {
  const world = initialWorld();
  const memories = [
    { id: 'event:1', tick: 1, x: world.agent.x, y: world.agent.y, place: '草地', foodRemaining: 0, text: '没有找到食物' },
    { id: 'event:2', tick: 2, x: 0, y: 2, place: '草地', foodRemaining: 0, text: '没有找到食物' },
  ];
  const payload = JSON.parse(decisionRequest(world, memories).messages[0].content);
  assert.deepEqual(payload.memories, memories);
  assert.ok(payload.observation.choices.some((c: {id:string}) => c.id === 'explore'));
  assert.ok(payload.observation.choices.some((c: {id:string}) => c.id === 'west'));
});

test('精简提示中的经历描述来自实际状态，资源恢复后仍提供眼前食物与合法探索', () => {
  const world = initialWorld(); world.tick = 60;
  world.agent.x = 0; world.agent.y = 2;
  const before = { ...world.agent, energy: 80, food: 0 };
  const after = { ...before, energy: 75 };
  const payload = JSON.parse(compactDecisionRequest(world, [], { experiences: [
    { tick: 59, action: { type: 'explore' }, outcome: '探索浆果丛，没有找到食物', before, after },
  ], learning: { goal: null, recentMoves: [], immediateReversals: 0, facts: [
    { x: 0, y: 2, attempts: 1, emptyAttempts: 1, foodCollected: 0, energySpent: 5, firstTick: 59, lastTick: 59, lastFoodRemaining: 0 },
  ] } }).messages[0].content);
  assert.match(payload.lastExperienceInWords, /第59步.*食物从0变为0，精力从80变为75/);
  assert.equal(payload.observation.nearby.find((p: any) => p.x === 0 && p.y === 2).food, 3);
  assert.ok(payload.observation.choices.some((c: any) => c.id === 'explore'));
  assert.equal(payload.explorationFacts[0].emptyAttempts, 1);
  const noHistory = JSON.parse(compactDecisionRequest(initialWorld(), []).messages[0].content);
  assert.equal(noHistory.lastExperienceInWords, '尚无可提供的行动经历。');
});

test('合法动作可解析；幻造动作、多余字段、截断响应均拒绝', async () => {
  const world = initialWorld();
  const ok = new OllamaBrain({ fetcher: response({ choice: 'west' }) });
  assert.deepEqual((await ok.decide(world, [])).action, { type: 'move', dx: -1, dy: 0 });
  for (const output of [
    { choice: 'teleport', reason: '飞过去', memoryIds: [] },
    { choice: 'west', reason: '凭空记忆', memoryIds: ['event:999'] },
    null,
  ]) await assert.rejects(() => new OllamaBrain({ fetcher: response(output) }).decide(world, []));
  await assert.rejects(() => new OllamaBrain({ fetcher: response({}, { done_reason: 'length' }) }).decide(world, []), /不完整/);
});

test('请求超时会中止等待', async () => {
  const fetcher = (async (_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('test timeout failed')), 200);
    init.signal!.addEventListener('abort', () => { clearTimeout(timeout); reject(init.signal!.reason); }, { once: true });
  })) as typeof fetch;
  await assert.rejects(() => new OllamaBrain({ timeoutMs: 10, fetcher }).decide(initialWorld(), []), { name: 'TimeoutError' });
});

test('偶发推理失败自动重试一次；中止信号不做重试', async () => {
  const world = initialWorld();
  let calls = 0;
  const flaky = (async () => {
    calls += 1;
    if (calls === 1) return new Response(JSON.stringify({ done: false, error: '偶发错误' }), { status: 500 });
    return new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ choice: 'explore' }) } }));
  }) as typeof fetch;
  const decision = await new OllamaBrain({ fetcher: flaky, timeoutMs: 5000 }).decide(world, []);
  assert.equal(calls, 2);
  assert.equal(decision.choice, 'explore');
  // 两次都失败才交给上层
  let attempts = 0;
  const alwaysFails = (async () => { attempts += 1; return new Response('{"error":"服务不可用"}', { status: 503 }); }) as typeof fetch;
  await assert.rejects(() => new OllamaBrain({ fetcher: alwaysFails, timeoutMs: 5000 }).decide(world, []), /服务不可用/);
  assert.equal(attempts, 2);
  // 已中止的请求不重试
  let abortedCalls = 0;
  const aborting = (async () => { abortedCalls += 1; throw new Error('stopped'); }) as typeof fetch;
  await assert.rejects(() => new OllamaBrain({ fetcher: aborting, timeoutMs: 5000 }).decide(world, [], AbortSignal.abort()));
  assert.equal(abortedCalls, 1);
});

test('推理失败明确接管；严格模式与停止信号不写入新状态', async () => {
  const store = new Store(':memory:'); store.initialize();
  const brain = new OllamaBrain({ fetcher: response({}, { error: '模型不可用' }) });
  try {
    const result = await tick(store, { brain });
    assert.equal(result.event.cognition?.source, 'fallback');
    assert.equal(result.event.cognition?.error, '模型不可用');
    assert.equal(store.load()?.tick, 1);
    await assert.rejects(() => tick(store, { brain, strict: true }));
    assert.equal(store.load()?.tick, 1);
    await assert.rejects(() => tick(store, { signal: AbortSignal.abort() }));
    assert.equal(store.load()?.tick, 1);
  } finally { store.close(); }
});

test('模型动作和决策记录原子保存', async () => {
  const store = new Store(':memory:'); store.initialize();
  try {
    const brain = new OllamaBrain({ fetcher: response({ choice: 'explore', goal: 'none' }) });
    const result = await tick(store, { brain, strict: true });
    assert.equal(result.event.cognition?.source, 'ollama');
    assert.deepEqual(store.recentEvents()[0], result.event);
    assert.equal(store.recall(result.world)[0].place, '小屋');
  } finally { store.close(); }
});

test('经验线索进入提示词；未提供时不出现该字段', async () => {
  const world = initialWorld();
  const without = JSON.parse(decisionRequest(world, []).messages[0].content);
  assert.equal(without.experienceHints, undefined);
  const hints = [
    { action: 'explore', text: '在小屋，可以移动、饥饿 50–74、精力 50–74 时，explore：观察到 2 次（饥饿+2，精力-5，食物+0，之后可以移动）' },
    { action: 'rest', text: '在小屋，可以移动、饥饿 50–74、精力 50–74 时，rest：观察到 1 次（饥饿+2，精力+15，食物+0，之后可以移动）' },
  ];
  const payload = JSON.parse(decisionRequest(world, [], { experienceHints: hints }).messages[0].content);
  assert.deepEqual(payload.experienceHints, hints);
  assert.match(payload.task, /experienceHints/);
  assert.match(payload.task, /不限制你的选择/);
});
