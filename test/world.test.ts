import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advance, initialWorld, step } from '../src/world/world.ts';

test('自动行为持续推进，需求与位置保持在合法范围', () => {
  let world = initialWorld();
  const seen = new Set<string>();
  for (let i = 0; i < 10000; i++) {
    const result = step(world);
    seen.add(result.event.action.type);
    world = result.world;
    assert.ok(world.agent.x >= 0 && world.agent.x < world.width);
    assert.ok(world.agent.y >= 0 && world.agent.y < world.height);
    assert.ok([world.agent.hunger, world.agent.energy, world.agent.curiosity].every(n => n >= 0 && n <= 100));
    assert.ok(world.agent.food >= 0);
  }
  assert.equal(world.tick, 10000);
  assert.deepEqual(seen, new Set(['move', 'explore', 'rest', 'eat']));
});

test('非法行动失败且不修改原状态', () => {
  const world = initialWorld();
  const before = structuredClone(world);
  assert.throws(() => advance(world, { type: 'move', dx: 3, dy: 0 }, 'test'), /非法移动/);
  assert.throws(() => advance({ ...world, agent: { ...world.agent, x: 0 } }, { type: 'move', dx: -1, dy: 0 }, 'test'), /非法移动/);
  assert.throws(() => advance({ ...world, agent: { ...world.agent, food: 0 } }, { type: 'eat' }, 'test'), /没有食物/);
  assert.deepEqual(world, before);
});

test('相同初始状态生成可重复的行动序列', () => {
  let a = initialWorld(); let b = initialWorld();
  for (let i = 0; i < 100; i++) {
    const x = step(a); const y = step(b);
    assert.deepEqual(x, y);
    a = x.world; b = y.world;
  }
});
