import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadSettings, DEFAULT_SETTINGS } from '../src/settings.ts';
import { initialWorld, advance, decide, perceive } from '../src/world.ts';
import { Store } from '../src/store.ts';
import { OllamaBrain, decisionRequest } from '../src/brain.ts';
import { tick } from '../src/runtime.ts';

const write = (path: string, data: unknown) => writeFileSync(path, JSON.stringify(data));
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'deerlive-settings-'));
  const world = { width: 3, height: 3, foodRegrowEveryTicks: 2, places: [{ x: 0, y: 1, name: '嫩叶丛', food: 1, capacity: 1 }] };
  const deer = { name: '鹿宝宝', initial: { x: 1, y: 1, food: 0 } };
  const runtime = { worldFile: 'world.json', characterFile: 'deer.json', life: { hungryAt: 30, hungerPerTick: 7, moveEnergyCost: 8, visionRadius: 0 }, storage: { path: join(dir, 'world.sqlite') } };
  write(join(dir, 'world.json'), world); write(join(dir, 'deer.json'), deer); write(join(dir, 'runtime.json'), runtime);
  return { dir, world, deer, runtime, load: () => loadSettings({ DEER_LIVE_CONFIG: 'runtime.json' }, dir).settings };
}

test('世界与角色分开加载，设定实际改变视野、资源和身体规则', () => {
  const f = fixture();
  try {
    const s = f.load();
    let world = initialWorld(s.initialWorld);
    assert.equal(world.width, 3); assert.equal(world.agent.name, '鹿宝宝'); assert.equal(world.agent.food, 0);
    assert.equal(perceive(world, s.life).nearby.length, 1);
    world = advance(world, { type: 'move', dx: -1, dy: 0 }, 'test', s.life).world;
    assert.equal(world.agent.energy, 72); assert.equal(world.agent.hunger, 27);
    world = advance(world, { type: 'explore' }, 'test', s.life).world;
    assert.equal(world.agent.food, 1); assert.equal(world.places[0].food, 0);
    assert.equal(decide(world, s.life).action.type, 'eat');
    world = advance(world, { type: 'eat' }, 'test', s.life).world;
    assert.equal(world.agent.food, 0);
    world = advance(world, { type: 'rest' }, 'test', s.life).world;
    assert.equal(world.places[0].food, 1);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('错误设定被拒绝；环境变量优先且不会改变内置默认值', () => {
  const f = fixture();
  try {
    const loaded = loadSettings({ DEER_LIVE_CONFIG: 'runtime.json', DEER_LIVE_MODEL: 'another-local:2b', DEER_LIVE_TIMEOUT_MS: '1000', DEER_LIVE_STRICT: '0' }, f.dir);
    assert.equal(loaded.settings.model.name, 'another-local:2b'); assert.equal(loaded.settings.model.timeoutMs, 1000); assert.equal(loaded.settings.run.strict, false);
    assert.equal(DEFAULT_SETTINGS.model.name, 'deepseek-r1:1.5b');
    write(join(f.dir, 'runtime.json'), { life: { hungryAt: 101 } });
    assert.throws(f.load, /hungryAt/);
    write(join(f.dir, 'runtime.json'), { life: { hungrAt: 10 } });
    assert.throws(f.load, /未知设定/);
    write(join(f.dir, 'runtime.json'), { worldFile: 'world.json', characterFile: 'deer.json' });
    write(join(f.dir, 'world.json'), { ...f.world, places: [...f.world.places, f.world.places[0]] });
    assert.throws(f.load, /坐标重复/);
    assert.throws(() => loadSettings({ DEER_LIVE_CONFIG: 'missing.json' }, f.dir), /无法读取/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('查看设定不创建存档；新配置不重置已有角色，运行规则可更新', () => {
  const f = fixture();
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('DEER_LIVE_')));
  const run = (command: string) => execFileSync(process.execPath, [cli, command], { cwd: f.dir, env: { ...cleanEnv, DEER_LIVE_CONFIG: 'runtime.json', NODE_NO_WARNINGS: '1' }, encoding: 'utf8' });
  try {
    run('settings'); assert.equal(existsSync(f.runtime.storage.path), false);
    run('init');
    write(join(f.dir, 'deer.json'), { ...f.deer, name: '新的初始名字', initial: { ...f.deer.initial, food: 99 } });
    write(join(f.dir, 'runtime.json'), { ...f.runtime, life: { ...f.runtime.life, hungerPerTick: 9 } });
    run('step');
    const store = new Store(f.runtime.storage.path);
    assert.equal(store.load()?.agent.name, '鹿宝宝'); assert.equal(store.load()?.agent.food, 0);
    assert.equal(store.load()?.tick, 1); assert.equal(store.load()?.agent.hunger, 29);
    store.close();
    const before = readFileSync(f.runtime.storage.path);
    write(join(f.dir, 'runtime.json'), { life: { hungryAt: -1 }, storage: f.runtime.storage });
    assert.throws(() => run('step'));
    assert.deepEqual(readFileSync(f.runtime.storage.path), before);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('模型接收新生小鹿身份、当前阈值和真实行动经历；采样配置生效', async () => {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.life.hungryAt = 45; s.model.numPredict = 512; s.model.temperature = 0.55;
  const store = new Store(':memory:'); store.initialize(initialWorld(s.initialWorld));
  const requests: any[] = [];
  const fetcher = (async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(init.body as string));
    return new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: '{"choice":"explore","goal":"none"}' } }));
  }) as typeof fetch;
  try {
    const brain = new OllamaBrain({ modelConfig: s.model, life: s.life, character: s.character, fetcher });
    await tick(store, { brain, settings: s, strict: true });
    await tick(store, { brain, settings: s, strict: true });
    const context = JSON.parse(requests[1].messages[0].content);
    assert.equal(context.identity.species, 'deer'); assert.equal(context.identity.lifeStage, 'newborn');
    assert.match(context.identity.motivation, /养活自己/); assert.equal(context.observation.thresholds.hungryAt, 45);
    assert.equal(context.experiences.length, 1); assert.equal(context.experiences[0].bodyChange.energy, -s.life.exploreEnergyCost);
    assert.equal(context.experiences[0].bodyChange.hunger, s.life.hungerPerTick);
    assert.equal(requests[0].options.num_predict, 512); assert.equal(requests[0].options.temperature, 0.55);
    const before = store.experiences()[0];
    for (let i = 0; i < 10; i++) await tick(store, { settings: s });
    assert.ok(store.experiences().some(e => e.action.type === 'explore'));
    assert.ok(before.before.energy > before.after.energy);
    const contextWithoutHistory = JSON.parse(decisionRequest(initialWorld(), []).messages[0].content);
    assert.deepEqual(contextWithoutHistory.experiences, []);
  } finally { store.close(); }
});
