import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.ts';
import { step, advance } from '../src/world.ts';
import { DatabaseSync } from 'node:sqlite';

test('关闭后恢复状态和事件，且从上次位置继续', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deerlive-'));
  try {
    const path = join(dir, 'world.sqlite');
    const first = new Store(path);
    let world = first.initialize();
    for (let i = 0; i < 15; i++) { const next = step(world); first.save(next.world, next.event); world = next.world; }
    first.close();
    const second = new Store(path);
    assert.deepEqual(second.initialize(), world);
    assert.equal(second.recentEvents().length, 10);
    assert.equal(second.recentEvents().at(-1)?.tick, 15);
    const next = step(second.load()!); second.save(next.world, next.event);
    assert.equal(second.load()?.tick, 16);
    second.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('过期写入被拒绝，不会覆盖新状态或写入重复事件', () => {
  const store = new Store(':memory:');
  try {
    const original = store.initialize();
    const next = step(original);
    store.save(next.world, next.event);
    assert.throws(() => store.save(next.world, next.event), /已变化/);
    assert.deepEqual(store.load(), next.world);
    assert.equal(store.recentEvents().length, 1);
  } finally { store.close(); }
});

test('拒绝损坏的世界状态及不匹配的事件', () => {
  const store = new Store(':memory:');
  try {
    const next = step(store.initialize());
    assert.throws(() => store.save({ ...next.world, agent: { ...next.world.agent, hunger: 101 } }, next.event), /无效的世界状态/);
    assert.throws(() => store.save(next.world, { ...next.event, tick: 99 }), /时间不一致/);
    assert.equal(store.load()?.tick, 0);
    assert.equal(store.recentEvents().length, 0);
  } finally { store.close(); }
});

test('新的空地点观察取代旧资源记忆，记忆在重启后仍可检索', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deerlive-memory-'));
  const path = join(dir, 'world.sqlite');
  try {
    const store = new Store(path);
    let world = store.initialize();
    const actions = [
      { type: 'move' as const, dx: -1, dy: 0 }, { type: 'move' as const, dx: -1, dy: 0 },
      { type: 'explore' as const }, { type: 'explore' as const }, { type: 'explore' as const },
      { type: 'explore' as const },
    ];
    for (const action of actions) { const next = advance(world, action, 'test'); store.save(next.world, next.event); world = next.world; }
    assert.equal(world.agent.food, 3);
    const memories = store.recall(world);
    assert.equal(memories.length, 1);
    assert.equal(memories[0].foodRemaining, 0);
    assert.equal(memories[0].id, 'event:6');
    store.close();
    const reopened = new Store(path);
    assert.deepEqual(reopened.recall(reopened.load()!), memories);
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('旧版存档迁移保留生命属性和时间，并可继续保存', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deerlive-migrate-'));
  try {
    const path = join(dir, 'world.sqlite');
    const old = { version: 1, tick: 42, width: 5, height: 5, agent: { name: '旧小鹿', x: 1, y: 1, hunger: 44, energy: 65, curiosity: 55, food: 8 } };
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE world (id INTEGER PRIMARY KEY, tick INTEGER NOT NULL, state TEXT NOT NULL)');
    db.prepare('INSERT INTO world VALUES (1, 42, ?)').run(JSON.stringify(old)); db.close();
    const store = new Store(path);
    const loaded = store.load()!;
    assert.equal(loaded.version, 2);
    assert.equal(loaded.tick, old.tick);
    assert.deepEqual(loaded.agent, old.agent);
    const next = step(loaded); store.save(next.world, next.event);
    assert.equal(store.load()?.tick, 43); store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('很久以前的地点发现仍可检索，普通行动不会挤掉长期观察', () => {
  const store = new Store(':memory:');
  try {
    let world = store.initialize();
    for (const action of [{ type: 'explore' as const }, ...Array.from({ length: 1100 }, () => ({ type: 'rest' as const }))]) {
      const next = advance(world, action, 'test'); store.save(next.world, next.event); world = next.world;
    }
    assert.equal(store.recall(world)[0].id, 'event:1');
  } finally { store.close(); }
});

test('事件插入失败时回滚快照更新', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deerlive-atomic-'));
  try {
    const path = join(dir, 'world.sqlite');
    const store = new Store(path);
    const original = store.initialize();
    const db = new DatabaseSync(path);
    db.prepare('INSERT INTO events (tick, data) VALUES (1, ?)').run(JSON.stringify({ tick: 1 })); db.close();
    const next = step(original);
    assert.throws(() => store.save(next.world, next.event));
    assert.deepEqual(store.load(), original);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
