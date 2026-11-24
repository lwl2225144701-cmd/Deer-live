import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advance, foodAvailable, initialWorld, perceive, restoreWorld, step } from '../src/world/world.ts';
import { DEFAULT_SETTINGS } from '../src/config/settings.ts';

test('自动行为保持在合法范围；纯反射策略在默认世界终有一死', () => {
  let world = initialWorld();
  const seen = new Set<string>();
  for (let i = 0; i < 100000 && !world.dead; i++) {
    const result = step(world);
    seen.add(result.event.action.type);
    world = result.world;
    assert.ok(world.agent.x >= 0 && world.agent.x < world.width);
    assert.ok(world.agent.y >= 0 && world.agent.y < world.height);
    assert.ok([world.agent.hunger, world.agent.energy, world.agent.curiosity].every(n => n >= 0 && n <= 100));
    assert.ok(world.agent.food >= 0);
    assert.ok((world.agent.health ?? 100) >= 0);
  }
  // 死亡 enabled 后，只靠反射不囤粮的规则鹿会饿死（实测 ~240 步）；
  // 能活着多久成为衡量心智价值的指标。
  assert.equal(world.dead, true);
  assert.ok(world.tick >= 100 && world.tick <= 10000, `反射鹿死亡时间应在合理区间，实际 ${world.tick}`);
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

test('每个地点可以有独立再生节奏：0 永不再生，未声明沿用世界级节奏', () => {
  let world = initialWorld({ width: 3, height: 3, places: [
    { x: 0, y: 0, name: '浆果丛', food: 0, capacity: 2, foodRegrowEveryTicks: 2 },
    { x: 1, y: 0, name: '蘑菇圈', food: 1, capacity: 1, foodRegrowEveryTicks: 0 },
    { x: 2, y: 0, name: '果园', food: 0, capacity: 1 },
  ], agent: { name: '小鹿', x: 2, y: 2, hunger: 20, energy: 80, curiosity: 0, food: 0 } });
  const life = { ...DEFAULT_SETTINGS.life, foodRegrowEveryTicks: 3 };
  // t1: 无再生；t2: 浆果丛 +1（自己的节奏 2）；t3: 果园 +1（世界节奏 3），蘑菇圈不再生；t4: 浆果丛再次 +1
  world = advance(world, { type: 'rest' }, 't', life).world;
  assert.deepEqual(world.places.map(p => p.food), [0, 1, 0]);
  world = advance(world, { type: 'rest' }, 't', life).world;
  assert.deepEqual(world.places.map(p => p.food), [1, 1, 0]);
  world = advance(world, { type: 'rest' }, 't', life).world;
  assert.deepEqual(world.places.map(p => p.food), [1, 1, 1]);
  world = advance(world, { type: 'rest' }, 't', life).world;
  assert.deepEqual(world.places.map(p => p.food), [2, 1, 1]);
  // 非法节奏被拒绝
  assert.throws(() => initialWorld({ width: 1, height: 1, places: [{ x: 0, y: 0, name: 'x', food: 0, capacity: 1, foodRegrowEveryTicks: -1 }], agent: { name: '小鹿', x: 0, y: 0, hunger: 0, energy: 0, curiosity: 0, food: 0 } }), /无效的地点或资源状态/);
});

test('隐形危害：在危害地点行动时受伤并写进结果，视野里看不到', () => {
  const makeWorld = () => initialWorld({ width: 3, height: 3, places: [
    { x: 1, y: 1, name: '雾泽', food: 0, capacity: 0, hazard: { hunger: 10, energy: 6 } },
    { x: 2, y: 1, name: '蜜树', food: 1, capacity: 1 },
  ], agent: { name: '小鹿', x: 1, y: 1, hunger: 20, energy: 80, curiosity: 0, food: 1 } });
  let world = makeWorld();
  // 视野里看不到危害
  const seen = JSON.stringify(perceive(world));
  assert.ok(!seen.includes('hazard') && !seen.includes('危险'));
  // 在危害地点 explore：额外损失写进 outcome 与前后状态
  const result = advance(world, { type: 'explore' }, 't');
  assert.equal(result.world.agent.hunger, 20 + 10 + 2);
  assert.equal(result.world.agent.energy, 80 - 5 - 6);
  assert.match(result.event.outcome, /雾泽的危险在消耗身体：饥饿\+10，精力-6/);
  // 离开危害地点的行动也承受损失（当时还站在上面）
  world = makeWorld();
  const moved = advance(world, { type: 'move', dx: 1, dy: 0 }, 't');
  assert.equal(moved.world.agent.hunger, 20 + 10 + 2);
  assert.match(moved.event.outcome, /雾泽的危险/);
  // 安全地点无额外损失
  const safe = advance(initialWorld(), { type: 'rest' }, 't');
  assert.ok(!safe.event.outcome.includes('危险'));
  // 非法危害被拒绝
  assert.throws(() => initialWorld({ width: 1, height: 1, places: [{ x: 0, y: 0, name: 'x', food: 0, capacity: 0, hazard: { hunger: 101 } }], agent: { name: '小鹿', x: 0, y: 0, hunger: 0, energy: 0, curiosity: 0, food: 0 } }), /无效的地点或资源状态/);
});

test('饥饿顶格持续耗体力，归零死亡；进食恢复体力；旧存档默认满体力', () => {
  const life = { ...DEFAULT_SETTINGS.life, hungerPerTick: 30 };
  let world = initialWorld();
  world.agent.hunger = 70; world.agent.health = 100;
  // 第 1 步饥饿到顶 100，立刻开始流失
  world = advance(world, { type: 'rest' }, 't', life).world;
  assert.equal(world.agent.hunger, 100);
  assert.equal(world.agent.health, 96);
  world = advance(world, { type: 'rest' }, 't', life).world;
  world = advance(world, { type: 'rest' }, 't', life).world;
  assert.equal(world.agent.health, 88);
  assert.ok(!world.dead);
  // 归零 → 死亡，世界进入终态
  world.agent.health = 8;
  world = advance(world, { type: 'rest' }, 't', life).world;
  world = advance(world, { type: 'rest' }, 't', life).world;
  assert.equal(world.agent.health, 0);
  assert.equal(world.dead, true);
  // 死亡后不可再行动
  assert.throws(() => advance(world, { type: 'rest' }, 't', life), /终局/);
  // 进食且饥饿低于 60 → 体力回升
  const healed = initialWorld();
  healed.agent.hunger = 30; healed.agent.health = 50; healed.agent.food = 1;
  const after = advance(healed, { type: 'eat' }, 't', life).world;
  assert.equal(after.agent.health, 51);
});

test('旧存档无 health 字段恢复为满；季节性食物对鹿隐形', () => {
  const old = { version: 1, tick: 3, width: 3, height: 3, agent: { name: '小鹿', x: 1, y: 1, hunger: 20, energy: 80, curiosity: 10, food: 0 } };
  assert.equal(restoreWorld(old).agent.health, 100);
  // 季节性食物：phase=1, period=4, open=2
  const world = initialWorld({ width: 3, height: 3, places: [{ x: 0, y: 0, name: '果丛', food: 2, capacity: 2, foodCycle: { period: 4, open: 2, phase: 1 } }], agent: { name: '小鹿', x: 0, y: 0, hunger: 20, energy: 80, curiosity: 0, food: 0 } });
  const place = world.places[0];
  // t3 → (3+1)%4=0 <2 可采；t4 → 1<2 可采；t5 → 2 不可采
  assert.equal(foodAvailable(place, 3), true);
  assert.equal(foodAvailable(place, 4), true);
  assert.equal(foodAvailable(place, 5), false);
  // perception 在关闭期显示 0
  assert.equal(perceive(world).nearby[0].food, 2);
  world.tick = 5;
  assert.equal(perceive(world).nearby[0].food, 0);
  // 关闭期 explore 不产出，观察也显示 0
  const closed = advance(world, { type: 'explore' }, 't', DEFAULT_SETTINGS.life);
  assert.equal(closed.event.observation!.foodRemaining, 0);
  assert.equal(closed.world.agent.food, 0);
  assert.equal(closed.world.places[0].food, 2); // 季节外的存量保留在地下
});
