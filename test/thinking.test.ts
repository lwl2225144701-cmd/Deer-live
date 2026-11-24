import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ThinkingStore } from '../src/thinking/store.ts';
import { reviewThinking } from '../src/thinking/generate.ts';
import { ExperienceStore } from '../src/experience/store.ts';
import { DEFAULT_SETTINGS, type Settings } from '../src/config/settings.ts';
import { Store } from '../src/storage/store.ts';
import { tick } from '../src/app/runtime.ts';
import { initialWorld } from '../src/world/world.ts';
import { ModelBrain, type Brain, type Decision } from '../src/agent/brain.ts';
import type { World, Memory } from '../src/agent/memory.ts';
import type { ExperienceHint } from '../src/experience/types.ts';
import type { LearningContext } from '../src/agent/learning.ts';

function seedExperience(count = 3): ExperienceStore {
  const experience = new ExperienceStore();
  for (let i = 0; i < count; i++) {
    experience.record({
      tick: i + 1, action: 'explore',
      situation: { hunger: 40 + i, energy: 60, condition: 'can_move', place: '雾泽' },
      effect: { hungerDelta: 12, energyDelta: -11, foodDelta: 0, conditionAfter: 'can_move', outcome: '雾泽的危险在消耗身体：饥饿+10，精力-6' },
    });
  }
  return experience;
}

test('思考库：写入、以相同文本去重、复核保留与放弃、持久化', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deerlive-thinking-'));
  try {
    const experience = seedExperience();
    const thinking = new ThinkingStore();
    thinking.syncFactIds(experience.facts().map(f => f.id));
    const first = thinking.add({ statement: '雾泽附近不要停留', basisFactIds: [experience.facts()[0].id], confidence: 0.7 });
    // 相同文本：确认而非重复
    const again = thinking.add({ statement: '雾泽附近不要停留', basisFactIds: [experience.facts()[1].id], confidence: 0.9 });
    assert.equal(again.id, first.id);
    assert.deepEqual(again.basisFactIds.length, 2);
    assert.equal(again.confidence, 0.9);
    assert.equal(thinking.beliefs('active').length, 1);
    // 引用未知事实被拒绝
    assert.throws(() => thinking.add({ statement: '另一条', basisFactIds: ['nope'], confidence: 0.5 }), /未知的经验事实/);
    // 复核：keep 累计 reviewCount，drop 转入 retired
    const review = thinking.review([{ id: first.id, verdict: 'keep' }, { id: first.id, verdict: 'drop' }]);
    assert.deepEqual(review, { kept: 1, dropped: 1, unknownIds: [] });
    assert.equal(thinking.beliefs('active').length, 0);
    assert.equal(thinking.beliefs('retired')[0].reviewCount, 1);
    // unknown id 被记录但不抛错
    const withUnknown = thinking.review([{ id: 'ghost', verdict: 'keep' }]);
    assert.deepEqual(withUnknown.unknownIds, ['ghost']);
    // 非法输入
    assert.throws(() => thinking.add({ statement: '', basisFactIds: [experience.facts()[0].id], confidence: 0.5 }), /判断文本/);
    assert.throws(() => thinking.add({ statement: 'x', basisFactIds: [experience.facts()[0].id], confidence: 2 }), /置信度/);
    // 持久化：retired 状态与字段都保留
    const path = join(dir, 'thinking.json');
    thinking.save(path);
    const loaded = ThinkingStore.load(path);
    assert.equal(loaded.beliefs().length, 1);
    assert.equal(loaded.beliefs()[0].status, 'retired');
    assert.equal(loaded.beliefs()[0].source, 'model');
    // 损坏文件被拒绝
    writeFileSync(path, '{"version":2,"beliefs":[]}');
    assert.throws(() => ThinkingStore.load(path), /版本/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('selfBeliefs 只返回 active 并按置信度排序、截断', () => {
  const experience = seedExperience();
  const thinking = new ThinkingStore();
  thinking.syncFactIds(experience.facts().map(f => f.id));
  thinking.add({ statement: '判断甲', basisFactIds: [experience.facts()[0].id], confidence: 0.5 });
  thinking.add({ statement: '判断乙', basisFactIds: [experience.facts()[1].id], confidence: 0.9 });
  const third = thinking.add({ statement: '判断丙', basisFactIds: [experience.facts()[2].id], confidence: 0.3 });
  thinking.review([{ id: third.id, verdict: 'drop' }]);
  assert.deepEqual(thinking.selfBeliefs(5).map(b => b.statement), ['判断乙', '判断甲']);
  assert.deepEqual(thinking.selfBeliefs(1).map(b => b.statement), ['判断乙']);
  assert.deepEqual(thinking.selfBeliefs(0), []);
});

test('思考复核：模型生成新判断并复核旧判断；引用未知事实的输出被丢弃', async () => {
  const experience = seedExperience(3);
  const factIds = experience.facts().map(f => f.id);
  const thinking = new ThinkingStore();
  const old = thinking.syncFactIds(factIds) ?? undefined;
  void old;
  thinking.syncFactIds(factIds);
  thinking.add({ statement: '雾泽不要久留', basisFactIds: [factIds[0]], confidence: 0.6 });
  const requests: any[] = [];
  const fetcher = (async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(init.body as string));
    const payload = JSON.parse(init.body as string);
    const content = JSON.parse(payload.messages[0].content);
    if (content.recentFacts) {
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
        beliefs: [
          { statement: '雾泽附近不要停留', basisFactIds: [factIds[1]], confidence: 0.8 },
          { statement: '凭空判断', basisFactIds: ['ghost'], confidence: 0.9 },
        ],
        review: [{ id: thinking.beliefs('active')[0].id, verdict: 'keep' }],
      }) } }] }));
    }
    return new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: '{"choice":"explore"}' } }));
  }) as typeof fetch;
  const model = { ...DEFAULT_SETTINGS.model, provider: 'openai-compatible' as const, baseUrl: 'https://api.example.com', apiKey: 'test' };
  const result = await reviewThinking(model, { experience, thinking, fetcher, timeoutMs: 5000 });
  assert.equal(result.added.length, 1);
  assert.equal(result.kept, 1);
  assert.equal(result.skipped, 1);
  assert.equal(thinking.beliefs('active').length, 2);
  // 复核请求里带了事实 ID、模式文本与已有判断
  const payload = JSON.parse(requests[0].messages[0].content);
  assert.ok(payload.recentFacts[0].id);
  assert.match(payload.patterns[0].text, /雾泽/);
  assert.equal(payload.currentBeliefs.length, 1);
});

test('正式循环：每 N 步触发思考复核，判断随提示注入', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deerlive-think-loop-'));
  try {
    const settings = structuredClone(DEFAULT_SETTINGS) as Settings;
    settings.storage.path = join(dir, 'world.sqlite');
    settings.memory.experience.path = join(dir, 'experience.json');
    settings.thinking = { ...settings.thinking, path: join(dir, 'thinking.json'), everyTicks: 3, maxBeliefsInPrompt: 5 };
    settings.model = { ...settings.model, provider: 'openai-compatible', baseUrl: 'https://api.example.com', apiKey: 'test' };
    const store = new Store(settings.storage.path);
    store.initialize(initialWorld(settings.initialWorld));
    const experience = new ExperienceStore();
    const thinking = new ThinkingStore();
    const decideCalls: { beliefs: string[] }[] = [];
    const brain: Brain = {
      model: 'fake',
      async decide(world: World, _memories: Memory[], _signal?: AbortSignal, _experiences?: unknown, _learning?: LearningContext, _hints?: ExperienceHint[], beliefs: string[] = []): Promise<Decision> {
        decideCalls.push({ beliefs: [...beliefs] });
        return { action: { type: 'explore' }, reason: '测试', model: 'fake', latencyMs: 1, choice: 'explore' };
      },
    };
    // 复核调用走 openai 兼容形态，返回保留判定
    const fetcher = (async (_url: unknown, init: RequestInit) => {
      const payload = JSON.parse(init.body as string);
      const content = JSON.parse(payload.messages[0].content);
      if (content.recentFacts) {
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
          beliefs: [],
          review: thinking.beliefs('active').map(b => ({ id: b.id, verdict: 'keep' })),
        }) } }] }));
      }
      return new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: '{"choice":"explore"}' } }));
    }) as typeof fetch;
    // 第 1 步：无判断
    await tick(store, { brain, settings, experience, thinking });
    assert.deepEqual(decideCalls[0].beliefs, []);
    // 预置一条判断（模拟此前复核写入），第 3 步应触发复核并把判断注入第 3 步的决策
    thinking.syncFactIds(experience.facts().map(f => f.id));
    thinking.add({ statement: '小屋附近值得探索', basisFactIds: [experience.facts()[0].id], confidence: 0.8 });
    await tick(store, { brain, settings, experience, thinking });
    await tick(store, { brain, settings, experience, thinking, fetcher });
    assert.deepEqual(decideCalls[1].beliefs, ['小屋附近值得探索']);
    // 第 3 步复核成功：判断保留 1 次，文件已落盘
    const loaded = ThinkingStore.load(settings.thinking.path);
    assert.equal(loaded.beliefs('active')[0].reviewCount, 1);
    assert.ok(existsSync(settings.thinking.path));
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('正式循环：思考复核失败不阻塞生存', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deerlive-think-fail-'));
  try {
    const settings = structuredClone(DEFAULT_SETTINGS) as Settings;
    settings.storage.path = join(dir, 'world.sqlite');
    settings.memory.experience.path = join(dir, 'experience.json');
    settings.thinking = { ...settings.thinking, path: join(dir, 'thinking.json'), everyTicks: 1 };
    const store = new Store(settings.storage.path);
    store.initialize(initialWorld(settings.initialWorld));
    const experience = new ExperienceStore();
    const thinking = new ThinkingStore();
    // 复核调用会拿到损坏响应；决策调用走 fake brain 不经过 fetcher
    const brain = new ModelBrain({ modelConfig: settings.model, life: settings.life, character: settings.character, fetcher: (async () => new Response('{"error":"boom"}', { status: 500 })) as typeof fetch });
    const calls: { beliefs: string[] }[] = [];
    const spy: Brain = {
      model: 'fake',
      async decide(world: World, _m: Memory[], _s?: AbortSignal, _e?: unknown, _l?: LearningContext, _h?: ExperienceHint[], beliefs: string[] = []): Promise<Decision> {
        calls.push({ beliefs: [...beliefs] });
        return { action: { type: 'rest' }, reason: '测试', model: 'fake', latencyMs: 1, choice: 'rest' };
      },
    };
    const result = await tick(store, { brain: spy, settings, experience, thinking });
    assert.equal(result.event.tick, 1);
    assert.equal(store.load()?.tick, 1);
    assert.equal(calls.length, 1);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
