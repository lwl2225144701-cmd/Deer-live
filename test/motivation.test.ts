import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MotivationStore } from '../src/motivation/store.ts';
import { reviewMotivation } from '../src/motivation/generate.ts';
import { ExperienceStore } from '../src/experience/store.ts';
import { DEFAULT_SETTINGS, type Settings } from '../src/config/settings.ts';
import { Store } from '../src/storage/store.ts';
import { tick } from '../src/app/runtime.ts';
import { initialWorld } from '../src/world/world.ts';
import type { Brain, Decision } from '../src/agent/brain.ts';
import type { World, Memory } from '../src/agent/memory.ts';
import type { ExperienceHint } from '../src/experience/types.ts';
import type { LearningContext } from '../src/agent/learning.ts';
import type { SelfDesire } from '../src/motivation/types.ts';

const body = { hunger: 40, energy: 60, food: 0, health: 100 };

test('动机库：写入、相同文本去重、进度核算、达成留档、持久化', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deerlive-motivation-'));
  try {
    const motivation = new MotivationStore();
    const context = { tick: 5, body, visits: { '3,3': 2 }, exploreCount: 4 };
    const first = motivation.add({ statement: '我想囤够 3 份食物防荒年', measure: { kind: 'food', target: 3 }, priority: 80 }, context);
    const again = motivation.add({ statement: '我想囤够 3 份食物防荒年', measure: { kind: 'food', target: 4 }, priority: 90 }, context);
    assert.equal(again.id, first.id); // 相同文本 = 再次确认，不重复
    assert.equal(motivation.desires('active').length, 1);
    // 非法输入
    assert.throws(() => motivation.add({ statement: '', measure: { kind: 'food', target: 2 }, priority: 50 }, context), /心愿文本/);
    assert.throws(() => motivation.add({ statement: 'x', measure: { kind: 'food', target: 0 }, priority: 50 }, context), /target/);
    assert.throws(() => motivation.add({ statement: 'x', measure: { kind: 'food', target: 2 }, priority: 120 }, context), /优先级/);
    // 进度核算：0 份食物 → 0%；攒到 3 份 → 100% 并 fulfilled 留档
    motivation.update({ ...context, body: { ...body, food: 1 } });
    assert.equal(motivation.desires('active')[0].progress, 25); // 复核写入时把 target 更新为 4
    motivation.update({ ...context, body: { ...body, food: 4 } });
    const fulfilled = motivation.desires('fulfilled');
    assert.equal(fulfilled.length, 1);
    assert.equal(fulfilled[0].fulfilledAtTick, 5);
    assert.equal(motivation.desires('active').length, 0);
    // 持久化往返
    const path = join(dir, 'motivation.json');
    motivation.save(path);
    const loaded = MotivationStore.load(path);
    assert.equal(loaded.desires('fulfilled')[0].statement, '我想囤够 3 份食物防荒年');
    writeFileSync(path, '{"version":9}');
    assert.throws(() => MotivationStore.load(path), /版本/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('visit/explore 心愿按基线差值核算；selfDesires 按优先级排序截断', () => {
  const motivation = new MotivationStore();
  const context = { tick: 1, body, visits: { '2,2': 1 }, exploreCount: 10 };
  motivation.add({ statement: '去洞口看看', measure: { kind: 'visit', place: '洞口' }, priority: 70 }, context);
  motivation.add({ statement: '多探索几次', measure: { kind: 'explore', count: 5 }, priority: 50 }, context);
  assert.deepEqual(motivation.selfDesires(5).map(d => d.statement), ['去洞口看看', '多探索几次']);
  // visit 度量按地点名对账：洞口到访 2 次（基线 0）→ fulfilled；探索 12 次（基线 10）→ 进度 40%
  motivation.update({ tick: 5, body, visits: { '洞口': 2 }, exploreCount: 12 });
  assert.equal(motivation.desires('fulfilled').length, 1);
  assert.equal(motivation.desires('active')[0].progress, 40);
  assert.deepEqual(motivation.selfDesires(1).map(d => d.statement), ['多探索几次']);
  // 复核：keep/drop/adjust
  const active = motivation.desires('active');
  const review = motivation.review([{ id: active[0].id, verdict: 'adjust', priority: 30 }, { id: 'ghost', verdict: 'keep' }]);
  assert.deepEqual(review, { kept: 0, adjusted: 1, dropped: 0, unknownIds: ['ghost'] });
  assert.equal(motivation.desires('active')[0].priority, 30);
});

test('动机复核：模型生成心愿并复核旧心愿；非法输出被丢弃', async () => {
  const experience = new ExperienceStore();
  experience.record({ tick: 1, action: 'explore', situation: { hunger: 40, energy: 60, condition: 'can_move', place: '洞口' }, effect: { hungerDelta: 3, energyDelta: -5, foodDelta: 0, conditionAfter: 'can_move', outcome: '探索洞口，没有找到食物' } });
  const motivation = new MotivationStore();
  const requests: any[] = [];
  const fetcher = (async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(init.body as string));
    const payload = JSON.parse(init.body as string);
    const content = JSON.parse(payload.messages[0].content);
    if (content.currentDesires !== undefined) {
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
        desires: [
          { statement: '去洞口看看里面有什么', measure: { kind: 'visit', place: '洞口' }, priority: 70 },
          { statement: '这条度量非法', measure: { kind: 'food', target: 0 }, priority: 50 },
        ],
        review: [],
      }) } }] }));
    }
    return new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: '{"choice":"explore"}' } }));
  }) as typeof fetch;
  const model = { ...DEFAULT_SETTINGS.model, provider: 'openai-compatible' as const, baseUrl: 'https://api.example.com', apiKey: 'test' };
  const result = await reviewMotivation(model, { experience, motivation, body, visits: { '2,2': 1 }, exploreCount: 0, tick: 3, fetcher, timeoutMs: 5000 });
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 1);
  assert.equal(motivation.desires('active').length, 1);
  assert.deepEqual(motivation.desires('active')[0].measure, { kind: 'visit', place: '洞口' });
  // 复核提示包含身体、已有心愿和经历模式
  const payload = JSON.parse(requests[0].messages[0].content);
  assert.deepEqual(payload.body, body);
  assert.match(payload.patterns[0].text, /洞口/);
});

test('正式循环：desires 进入决策提示、身体信号降级为输入', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deerlive-motivation-loop-'));
  try {
    const settings = structuredClone(DEFAULT_SETTINGS) as Settings;
    settings.storage.path = join(dir, 'world.sqlite');
    settings.memory.experience.path = join(dir, 'experience.json');
    settings.thinking = { ...settings.thinking, path: join(dir, 'thinking.json'), enabled: false };
    settings.calibration = { ...settings.calibration, path: join(dir, 'calibration.json'), enabled: false };
    settings.motivation = { ...settings.motivation, path: join(dir, 'motivation.json'), everyTicks: 2, maxInPrompt: 3 };
    settings.model = { ...settings.model, provider: 'openai-compatible', baseUrl: 'https://api.example.com', apiKey: 'test' };
    const store = new Store(settings.storage.path);
    store.initialize(initialWorld(settings.initialWorld));
    const experience = new ExperienceStore();
    const motivation = new MotivationStore();
    const decideCalls: { desires: SelfDesire[] }[] = [];
    const brain: Brain = {
      model: 'fake',
      async decide(world: World, _m: Memory[], _s?: AbortSignal, _e?: unknown, _l?: LearningContext, _h?: ExperienceHint[], _b?: string[], desires: SelfDesire[] = []): Promise<Decision> {
        decideCalls.push({ desires: structuredClone(desires) });
        return { action: { type: 'explore' }, reason: '测试', model: 'fake', latencyMs: 1, choice: 'explore' };
      },
    };
    // 复核调用的假响应：写下一条心愿
    const fetcher = (async (_url: unknown, init: RequestInit) => {
      const payload = JSON.parse(init.body as string);
      const content = JSON.parse(payload.messages[0].content);
      if (content.currentDesires !== undefined) {
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
          desires: [{ statement: '我想囤够 2 份食物', measure: { kind: 'food', target: 2 }, priority: 80 }],
          review: [],
        }) } }] }));
      }
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"choice":"explore"}' } }] }));
    }) as typeof fetch;
    await tick(store, { brain, settings, experience, motivation, fetcher });
    assert.equal(decideCalls[0].desires.length, 0); // 第 1 步还没有心愿（复核在第 2 步触发）
    await tick(store, { brain, settings, experience, motivation, fetcher });
    assert.deepEqual(decideCalls[1].desires.map(d => d.statement), []); // 复核发生在决策之后
    assert.ok(motivation.desires('active').length >= 1);
    await tick(store, { brain, settings, experience, motivation, fetcher });
    assert.equal(decideCalls[2].desires.length, 1);
    assert.equal(decideCalls[2].desires[0].statement, '我想囤够 2 份食物');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
