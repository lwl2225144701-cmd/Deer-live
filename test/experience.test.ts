import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExperienceStore, describePattern } from '../src/experience/store.ts';
import type { InventoryItem, ObservedEffect, Situation } from '../src/experience/types.ts';

const inventory: InventoryItem[] = [
  { id: 'item-a', name: '甲物', count: 3 },
  { id: 'item-b', name: '乙物', count: 3 },
];
const hungry: Situation = { hunger: 100, energy: 48, condition: 'cannot_move', place: '洞穴', inventory };

const eat = (item: string, delta: number, conditionAfter: 'can_move' | 'cannot_move'): ObservedEffect => ({
  hungerDelta: delta, energyDelta: 0, foodDelta: -1, conditionAfter, outcome: `吃一口（${item}）`, item,
});

test('同一情境、同一动作、同一结果聚合成一个模式', () => {
  const store = new ExperienceStore();
  store.record({ tick: 1, action: 'use:item-a:eat', situation: hungry, effect: eat('甲物', -28, 'can_move') });
  store.record({ tick: 2, action: 'use:item-a:eat', situation: hungry, effect: eat('甲物', -28, 'can_move') });
  const patterns = store.patterns();
  assert.equal(patterns.length, 1);
  assert.equal(patterns[0].total, 2);
  assert.equal(patterns[0].variants.length, 1);
  assert.equal(patterns[0].variants[0].count, 2);
  assert.equal(patterns[0].variants[0].factIds.length, 2);
  assert.equal(store.facts().length, 2);
});

test('同一动作出现不同结果时保留为多个变体，不替模型判定成功或失败', () => {
  const store = new ExperienceStore();
  store.record({ tick: 1, action: 'use:item-a:eat', situation: hungry, effect: eat('甲物', -28, 'can_move') });
  store.record({ tick: 2, action: 'use:item-a:eat', situation: hungry, effect: eat('甲物', 0, 'cannot_move') });
  const pattern = store.patterns()[0];
  assert.equal(pattern.total, 2);
  assert.equal(pattern.variants.length, 2);
  assert.ok(pattern.variants.some(variant => variant.effect.conditionAfter === 'can_move'));
  assert.ok(pattern.variants.some(variant => variant.effect.conditionAfter === 'cannot_move'));
});

test('检索只返回同移动状态的情境，按饥饿、精力、地点、库存和证据数排序', () => {
  const store = new ExperienceStore();
  store.record({ tick: 1, action: 'use:item-a:eat', situation: hungry, effect: eat('甲物', -28, 'can_move') });
  store.record({ tick: 2, action: 'use:item-a:eat', situation: hungry, effect: eat('甲物', -28, 'can_move') });
  store.record({ tick: 3, action: 'use:item-b:eat', situation: hungry, effect: eat('乙物', -28, 'can_move') });
  store.record({ tick: 4, action: 'wait', situation: { hunger: 50, energy: 48, condition: 'can_move' }, effect: { hungerDelta: 2, energyDelta: 10, foodDelta: 0, conditionAfter: 'can_move', outcome: '原地等待' } });
  store.record({ tick: 5, action: 'wait', situation: { hunger: 50, energy: 48, condition: 'can_move' }, effect: { hungerDelta: 2, energyDelta: 10, foodDelta: 0, conditionAfter: 'can_move', outcome: '原地等待' } });
  store.record({ tick: 6, action: 'use:item-a:eat', situation: { hunger: 25, energy: 48, condition: 'cannot_move', inventory }, effect: eat('甲物', -28, 'can_move') });

  const matches = store.retrieve(hungry, { limit: 10 });
  assert.deepEqual(matches.map(match => match.pattern.action), ['use:item-a:eat', 'use:item-b:eat', 'use:item-a:eat']);
  assert.ok(matches.every(match => match.pattern.situation.condition === 'cannot_move'));
  assert.equal(matches[0].pattern.total, 2);

  const filtered = store.retrieve(hungry, { action: 'use:item-b:eat' });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].pattern.action, 'use:item-b:eat');

  const repeated = store.retrieve(hungry, { minObservations: 2 });
  assert.deepEqual(repeated.map(match => match.pattern.action), ['use:item-a:eat']);
  assert.equal(store.retrieve(hungry, { limit: 2 }).length, 2);
  assert.match(describePattern(matches[0].pattern), /不能移动.*饥饿 75–100.*观察到 2 次/);
});

test('模型假设与事实严格分离，检索不会返回假设', () => {
  const store = new ExperienceStore();
  const fact = store.record({ tick: 1, action: 'use:item-a:eat', situation: hungry, effect: eat('甲物', -28, 'can_move') });
  const hypothesis = store.addHypothesis({ statement: '饥饿时吃甲物可以恢复移动。', basisFactIds: [fact.id], confidence: 0.4 });
  assert.equal(hypothesis.source, 'model');
  assert.equal(store.hypotheses().length, 1);
  assert.equal(store.patterns().length, 1);
  assert.ok(store.retrieve(hungry).every(match => !('statement' in match.pattern)));
  assert.throws(() => store.addHypothesis({ statement: '无依据的猜测', basisFactIds: ['missing'], confidence: 0.2 }), /不存在/);
  assert.throws(() => store.addHypothesis({ statement: '   ', basisFactIds: [fact.id], confidence: 0.2 }), /statement/);
  assert.throws(() => store.addHypothesis({ statement: '违法置信度', basisFactIds: [fact.id], confidence: 1.5 }), /置信度/);
});

test('保存与重新加载后事实、模式和假设保持不变', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deerlive-experience-'));
  try {
    const path = join(dir, 'experiences.json');
    const store = new ExperienceStore();
    const fact = store.record({ tick: 1, action: 'use:item-a:eat', situation: hungry, effect: eat('甲物', -28, 'can_move'), recordedAt: '2026-11-16T08:00:00.000Z' });
    store.addHypothesis({ statement: '甲物可能有效。', basisFactIds: [fact.id], confidence: 0.5 });
    store.save(path);
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(raw.version, 1);
    const loaded = ExperienceStore.load(path);
    assert.equal(loaded.facts().length, 1);
    assert.equal(loaded.patterns()[0].variants[0].count, 1);
    assert.equal(loaded.hypotheses().length, 1);
    assert.equal(ExperienceStore.load(join(dir, 'missing.json')).facts().length, 0);
    writeFileSync(path, 'not json');
    assert.throws(() => ExperienceStore.load(path), /无法读取经验文件/);
    writeFileSync(path, JSON.stringify({ version: 2, facts: [], hypotheses: [] }));
    assert.throws(() => ExperienceStore.load(path), /版本/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('非法事实和非法假设被拒绝，模型推测不能伪装成事实', () => {
  const store = new ExperienceStore();
  assert.throws(() => store.record({ tick: 1, action: 'wait', situation: { ...hungry, hunger: 101 }, effect: eat('甲物', 0, 'can_move') }), /hunger/);
  assert.throws(() => store.record({ tick: 1, action: 'wait', situation: hungry, effect: { hungerDelta: 0, energyDelta: 0, foodDelta: 0, conditionAfter: 'sleep' as never, outcome: '等待' } }), /conditionAfter/);
  assert.throws(() => ExperienceStore.fromJSON({ version: 1, facts: [{ id: 'x', tick: 1, action: 'wait', situation: hungry, effect: eat('甲物', 0, 'can_move'), source: 'model', recordedAt: '2026-11-16T08:00:00.000Z' }], hypotheses: [] }), /source/);
});

test('批量导入中途失败时不留半份记录', () => {
  const store = new ExperienceStore();
  assert.throws(() => store.recordMany([
    { tick: 1, action: 'wait', situation: hungry, effect: eat('甲物', 0, 'can_move') },
    { tick: 2, action: 'wait', situation: { ...hungry, hunger: 101 }, effect: eat('甲物', 0, 'can_move') },
  ]), /hunger/);
  assert.equal(store.facts().length, 0);
});
