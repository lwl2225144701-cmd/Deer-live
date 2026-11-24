import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/storage/store.ts';
import { tick } from '../src/app/runtime.ts';
import { DEFAULT_SETTINGS, type Settings } from '../src/config/settings.ts';
import { ExperienceStore } from '../src/experience/store.ts';
import { actionIdOf, candidateActionIds, eventFactInput, retrieveHints, situationFromWorld } from '../src/experience/facts.ts';
import { advance, initialWorld } from '../src/world/world.ts';
import type { Decision, Brain } from '../src/agent/brain.ts';
import type { ExperienceHint } from '../src/experience/types.ts';
import type { Memory } from '../src/agent/memory.ts';
import type { LearningContext } from '../src/agent/learning.ts';
import type { World } from '../src/world/world.ts';

function settingsIn(dir: string, overrides: Partial<Settings['memory']['experience']> = {}): Settings {
  const settings = structuredClone(DEFAULT_SETTINGS) as Settings;
  settings.storage.path = join(dir, 'world.sqlite');
  settings.memory.experience = { ...settings.memory.experience, path: join(dir, 'experience.json'), ...overrides };
  return settings;
}

function fakeBrain(calls: { world: World; hints: ExperienceHint[] }[] = []): Brain {
  return {
    model: 'fake-model',
    async decide(world: World, _memories: Memory[], _signal?: AbortSignal, _experiences?: unknown, _learning?: LearningContext, hints: ExperienceHint[] = []): Promise<Decision> {
      calls.push({ world: structuredClone(world), hints: structuredClone(hints) });
      return { action: { type: 'explore' }, reason: '测试决策', model: 'fake-model', latencyMs: 1, choice: 'explore' };
    },
  };
}

test('行动结束后事实被记入经验库并原子落盘', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deerlive-tick-'));
  try {
    const settings = settingsIn(dir);
    const store = new Store(settings.storage.path);
    store.initialize(initialWorld(settings.initialWorld));
    const experience = new ExperienceStore();
    await tick(store, { settings, experience });
    assert.equal(experience.facts().length, 1);
    const fact = experience.facts()[0];
    assert.equal(fact.tick, 1);
    assert.equal(fact.source, 'observed');
    assert.match(fact.action, /^(explore|rest|eat|move:(east|south|west|north))$/);
    assert.equal(fact.effect.conditionAfter, 'can_move');
    assert.equal(fact.effect.hungerDelta, DEFAULT_SETTINGS.life.hungerPerTick);
    // 落盘文件可重新加载
    assert.ok(existsSync(settings.memory.experience.path));
    const loaded = ExperienceStore.load(settings.memory.experience.path);
    assert.equal(loaded.facts().length, 1);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('决策前按候选动作注入经验线索，认知记录已提供的线索动作', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deerlive-hints-'));
  try {
    const settings = settingsIn(dir);
    const store = new Store(settings.storage.path);
    store.initialize(initialWorld(settings.initialWorld));
    const experience = new ExperienceStore();
    const calls: { world: World; hints: ExperienceHint[] }[] = [];
    const brain = fakeBrain(calls);
    // 第一步：经验库为空，没有线索
    const first = await tick(store, { brain, settings, experience });
    assert.equal(calls[0].hints.length, 0);
    assert.deepEqual(first.event.cognition!.offeredExperienceHints, []);
    // 第二步：上一步的观察已成事实，explore 的线索被注入
    await tick(store, { brain, settings, experience });
    assert.ok(calls[1].hints.length >= 1);
    assert.ok(calls[1].hints.every(hint => ['explore', 'rest', 'eat', 'move:east', 'move:south', 'move:west', 'move:north'].includes(hint.action)));
    assert.ok(calls[1].hints.every(hint => hint.text.includes('观察到')));
    assert.ok(first.event.cognition!.offeredExperienceHints!.length === 0);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('经验系统关闭时不记录、不注入、不落盘', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deerlive-off-'));
  try {
    const settings = settingsIn(dir, { enabled: false });
    const store = new Store(settings.storage.path);
    store.initialize(initialWorld(settings.initialWorld));
    const experience = new ExperienceStore();
    const calls: { world: World; hints: ExperienceHint[] }[] = [];
    const result = await tick(store, { brain: fakeBrain(calls), settings, experience });
    assert.equal(calls[0].hints.length, 0);
    assert.equal(experience.facts().length, 0);
    assert.equal(result.event.cognition!.offeredExperienceHints, undefined);
    assert.equal(existsSync(settings.memory.experience.path), false);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('未传入经验库时行为与旧循环一致', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deerlive-none-'));
  try {
    const settings = settingsIn(dir);
    const store = new Store(settings.storage.path);
    store.initialize(initialWorld(settings.initialWorld));
    const calls: { world: World; hints: ExperienceHint[] }[] = [];
    const result = await tick(store, { brain: fakeBrain(calls), settings });
    assert.equal(calls[0].hints.length, 0);
    assert.equal(result.event.cognition!.offeredExperienceHints, undefined);
    assert.equal(existsSync(settings.memory.experience.path), false);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('事件到经验的转换保留动作、位置和身体变化', () => {
  const world = initialWorld();
  const { event } = advance(world, { type: 'explore' }, '测试');
  const input = eventFactInput(world, event);
  assert.equal(input.tick, 1);
  assert.equal(input.action, 'explore');
  assert.equal(input.situation.hunger, world.agent.hunger);
  assert.equal(input.situation.energy, world.agent.energy);
  assert.equal(input.situation.condition, 'can_move');
  assert.equal(input.situation.place, '小屋');
  assert.equal(input.effect.foodDelta, event.experience!.after.food - event.experience!.before.food);
  // 移动动作带方向
  const moved = advance(initialWorld(), { type: 'move', dx: -1, dy: 0 }, '测试');
  assert.equal(actionIdOf(moved.event.action), 'move:west');
  // 候选动作 ID 与事实命名一致：方向动作带 move: 前缀
  const ids = candidateActionIds(initialWorld(), DEFAULT_SETTINGS.life);
  assert.ok(ids.includes('explore') && ids.includes('rest') && ids.includes('move:west') && ids.includes('move:south'));
  assert.ok(!ids.includes('west'));
  // 随身食物进入情境清单
  const rich = structuredClone(initialWorld());
  rich.agent.food = 2;
  const situation = situationFromWorld(rich);
  assert.deepEqual(situation.inventory, [{ id: 'food', name: '随身食物', count: 2 }]);
});

test('按候选动作检索：只返回相关动作、去重并受总量限制', () => {
  const experience = new ExperienceStore();
  for (let i = 0; i < 3; i++) {
    experience.record({
      tick: i + 1, action: 'explore',
      situation: { hunger: 50, energy: 60, condition: 'can_move', place: '浆果丛' },
      effect: { hungerDelta: 2, energyDelta: -5, foodDelta: 1, conditionAfter: 'can_move', outcome: '找到食物' },
    });
  }
  experience.record({
    tick: 4, action: 'rest',
    situation: { hunger: 50, energy: 60, condition: 'can_move', place: '浆果丛' },
    effect: { hungerDelta: 2, energyDelta: 15, foodDelta: 0, conditionAfter: 'can_move', outcome: '休息' },
  });
  const world = structuredClone(initialWorld());
  world.agent.hunger = 55; world.agent.energy = 60; world.agent.x = 0; world.agent.y = 2;
  const hints = retrieveHints(experience, world, ['explore', 'rest', 'eat', 'east'], { maxPatterns: 2, maxPerAction: 1, minObservations: 1 });
  assert.equal(hints.length, 2);
  assert.deepEqual(hints.map(h => h.action).sort(), ['explore', 'rest']);
  assert.ok(hints.find(h => h.action === 'explore')!.text.includes('食物+1'));
  // 无相关动作时不产生线索
  const empty = retrieveHints(experience, world, ['north'], { maxPatterns: 2, maxPerAction: 1, minObservations: 1 });
  assert.equal(empty.length, 0);
  // minObservations 过滤掉只发生过一次的 rest
  const filtered = retrieveHints(experience, world, ['explore', 'rest'], { maxPatterns: 2, maxPerAction: 1, minObservations: 2 });
  assert.deepEqual(filtered.map(h => h.action), ['explore']);
});
