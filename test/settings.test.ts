import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadSettings, DEFAULT_SETTINGS } from '../src/config/settings.ts';
import { initialWorld, advance, decide, perceive } from '../src/world/world.ts';
import { Store } from '../src/storage/store.ts';
import { OllamaBrain, decisionRequest } from '../src/agent/brain.ts';
import { tick } from '../src/app/runtime.ts';

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
    // 地点允许独立再生节奏；非法值被拒绝
    write(join(f.dir, 'world.json'), { ...f.world, places: [{ ...f.world.places[0], foodRegrowEveryTicks: 0 }] });
    assert.equal(f.load().world.places[0].foodRegrowEveryTicks, 0);
    write(join(f.dir, 'world.json'), { ...f.world, places: [{ ...f.world.places[0], foodRegrowEveryTicks: -1 }] });
    assert.throws(f.load, /foodRegrowEveryTicks/);
    assert.throws(() => loadSettings({ DEER_LIVE_CONFIG: 'missing.json' }, f.dir), /无法读取/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('查看设定不创建存档；新配置不重置已有角色，运行规则可更新', () => {
  const f = fixture();
  const cli = fileURLToPath(new URL('../src/app/cli.ts', import.meta.url));
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

test('模型服务设置：协议、地址与密钥校验', () => {
  const f = fixture();
  try {
    const withModel = (model: unknown) => write(join(f.dir, 'runtime.json'), { ...f.runtime, model });
    withModel({ provider: 'openai-compatible', name: 'step-5-preview', baseUrl: 'https://api.stepfun.com/step_plan/v1', apiKey: '' });
    assert.equal(f.load().model.provider, 'openai-compatible');
    assert.equal(f.load().model.baseUrl, 'https://api.stepfun.com/step_plan/v1');
    withModel({ provider: 'cloud' });
    assert.throws(f.load, /provider/);
    withModel({ provider: 'ollama', baseUrl: 'https://example.com' });
    assert.throws(f.load, /本机/);
    withModel({ baseUrl: 'ftp://example.com' });
    assert.throws(f.load, /http/);
    withModel({ apiKey: 'a\nb' });
    assert.throws(f.load, /apiKey/);
    withModel({ reasoningEffort: 'max' });
    assert.throws(f.load, /reasoningEffort/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('经验系统设定：默认开启、校验与环境变量覆盖', () => {
  const f = fixture();
  try {
    // 未配置时使用默认值：开启，路径 data/experience.json
    const defaults = f.load();
    assert.equal(defaults.memory.experience.enabled, true);
    assert.equal(defaults.memory.experience.path, 'data/experience.json');
    assert.equal(defaults.memory.experience.maxPatterns, 8);
    assert.equal(defaults.memory.experience.maxPerAction, 1);
    const withExperience = (experience: unknown) => write(join(f.dir, 'runtime.json'), { ...f.runtime, memory: { experience } });
    withExperience({ enabled: 'yes' });
    assert.throws(f.load, /experience\.enabled/);
    withExperience({ path: '' });
    assert.throws(f.load, /experience\.path/);
    withExperience({ maxPatterns: 21 });
    assert.throws(f.load, /maxPatterns/);
    withExperience({ maxPerAction: 6 });
    assert.throws(f.load, /maxPerAction/);
    withExperience({ minObservations: 0 });
    assert.throws(f.load, /minObservations/);
    // 环境变量优先，且不污染默认值
    write(join(f.dir, 'runtime.json'), f.runtime);
    const env = loadSettings({ DEER_LIVE_CONFIG: 'runtime.json', DEER_LIVE_EXPERIENCE: '0', DEER_LIVE_EXPERIENCE_PATH: 'custom/experience.json' }, f.dir);
    assert.equal(env.settings.memory.experience.enabled, false);
    assert.equal(env.settings.memory.experience.path, 'custom/experience.json');
    assert.equal(DEFAULT_SETTINGS.memory.experience.enabled, true);
    assert.throws(() => loadSettings({ DEER_LIVE_CONFIG: 'runtime.json', DEER_LIVE_EXPERIENCE: '2' }, f.dir), /DEER_LIVE_EXPERIENCE/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
