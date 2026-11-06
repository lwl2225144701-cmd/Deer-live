import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type AgentSettings = { name: string; x: number; y: number; hunger: number; energy: number; curiosity: number; food: number };
export type PlaceSettings = { x: number; y: number; name: string; food: number; capacity: number };
export type InitialWorldSettings = { width: number; height: number; agent: AgentSettings; places: PlaceSettings[] };
export type WorldSettings = { width: number; height: number; foodRegrowEveryTicks: number; places: PlaceSettings[] };
export type CharacterSettings = {
  name: string; species: string; lifeStage: string; description: string; motivation: string;
  initial: Omit<AgentSettings, 'name'>;
};
export type LifeSettings = {
  hungryAt: number; tiredAt: number; curiousAt: number;
  hungerPerTick: number; curiosityPerTick: number;
  moveEnergyCost: number; exploreEnergyCost: number; restEnergyGain: number;
  eatHungerRelief: number; exploreCuriosityRelief: number;
  foodRegrowEveryTicks: number; visionRadius: number;
};
export type ModelSettings = { name: string; timeoutMs: number; numPredict: number; numCtx: number; temperature: number; topP: number; seed: number };
export type RuntimeSettings = {
  worldFile: string; characterFile: string;
  life: Omit<LifeSettings, 'foodRegrowEveryTicks'>;
  memory: { maxRecall: number; maxExperiences: number }; model: ModelSettings;
  run: { liveSteps: number; intervalMs: number; strict: boolean }; storage: { path: string };
};
export type Settings = Omit<RuntimeSettings, 'worldFile' | 'characterFile' | 'life'> & {
  world: WorldSettings; character: CharacterSettings; initialWorld: InitialWorldSettings; life: LifeSettings;
};
export const DEFAULT_WORLD: WorldSettings = {
  width: 5, height: 5, foodRegrowEveryTicks: 60,
  places: [
    { x: 2, y: 2, name: '小屋', food: 0, capacity: 0 },
    { x: 0, y: 2, name: '浆果丛', food: 3, capacity: 3 },
    { x: 4, y: 0, name: '苹果树', food: 2, capacity: 2 },
    { x: 1, y: 4, name: '池塘', food: 0, capacity: 0 },
  ],
};
export const DEFAULT_CHARACTER: CharacterSettings = {
  name: '小鹿', species: 'deer', lifeStage: 'newborn',
  description: '一只刚出生的小鹿，有基本生存本能，对这个世界尚不熟悉。',
  motivation: '首先养活自己，在探索、进食和休息的经历中学习如何应对世界的规则。',
  initial: { x: 2, y: 2, hunger: 20, energy: 80, curiosity: 40, food: 0 },
};
export const DEFAULT_RUNTIME: RuntimeSettings = {
  worldFile: '', characterFile: '',
  life: { hungryAt: 60, tiredAt: 30, curiousAt: 60, hungerPerTick: 2, curiosityPerTick: 3, moveEnergyCost: 3, exploreEnergyCost: 5, restEnergyGain: 15, eatHungerRelief: 35, exploreCuriosityRelief: 35, visionRadius: 1 },
  memory: { maxRecall: 6, maxExperiences: 4 },
  model: { name: 'deepseek-r1:1.5b', timeoutMs: 30000, numPredict: 1024, numCtx: 4096, temperature: 0.6, topP: 0.95, seed: 42 },
  run: { liveSteps: 10, intervalMs: 1000, strict: false }, storage: { path: 'data/deer-live.sqlite' },
};
function assemble(runtime: RuntimeSettings, world: WorldSettings, character: CharacterSettings): Settings {
  return structuredClone({
    world, character, initialWorld: { width: world.width, height: world.height, places: world.places, agent: { name: character.name, ...character.initial } },
    life: { ...runtime.life, foodRegrowEveryTicks: world.foodRegrowEveryTicks },
    memory: runtime.memory, model: runtime.model, run: runtime.run, storage: runtime.storage,
  });
}
export const DEFAULT_SETTINGS = assemble(DEFAULT_RUNTIME, DEFAULT_WORLD, DEFAULT_CHARACTER);

function mergeKnown(base: unknown, override: unknown, path: string): unknown {
  if (Array.isArray(base)) {
    if (!Array.isArray(override)) throw new Error(`${path} 必须是数组`);
    return structuredClone(override);
  }
  if (base && typeof base === 'object') {
    if (!override || typeof override !== 'object' || Array.isArray(override)) throw new Error(`${path} 必须是对象`);
    const result = structuredClone(base) as Record<string, unknown>;
    for (const [key, value] of Object.entries(override)) {
      if (!Object.hasOwn(result, key)) throw new Error(`未知设定：${path}.${key}`);
      result[key] = mergeKnown(result[key], value, `${path}.${key}`);
    }
    return result;
  }
  if (typeof override !== typeof base) throw new Error(`${path} 类型错误，应为 ${typeof base}`);
  return override;
}
function number(value: number, field: string, min: number, max: number, integer = true) {
  if (!Number.isFinite(value) || (integer && !Number.isSafeInteger(value)) || value < min || value > max) throw new Error(`${field} 必须是 ${min}–${max} 范围内的${integer ? '整数' : '数字'}`);
}
function text(value: unknown, field: string, max = 100) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${field} 必须是非空字符串，最多 ${max} 字符`);
}
export function validateSettings(s: Settings): void {
  const w = s.initialWorld;
  number(w.width, 'world.width', 1, 100); number(w.height, 'world.height', 1, 100);
  const point = (p: { x: number; y: number }, field: string) => { number(p.x, `${field}.x`, 0, w.width - 1); number(p.y, `${field}.y`, 0, w.height - 1); };
  text(w.agent.name, 'character.name'); point(w.agent, 'character.initial');
  for (const k of ['hunger', 'energy', 'curiosity'] as const) number(w.agent[k], `character.initial.${k}`, 0, 100);
  number(w.agent.food, 'character.initial.food', 0, 1000000);
  for (const key of ['species', 'lifeStage', 'description', 'motivation'] as const) text(s.character[key], `character.${key}`, 2000);
  const occupied = new Set<string>();
  for (const p of w.places) {
    if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).some(k => !['x', 'y', 'name', 'food', 'capacity'].includes(k))) throw new Error('world.places 地点字段无效');
    text(p.name, 'world.places.name'); point(p, 'world.places');
    number(p.capacity, 'world.places.capacity', 0, 1000000); number(p.food, 'world.places.food', 0, p.capacity);
    const key = `${p.x},${p.y}`;
    if (occupied.has(key)) throw new Error(`地点坐标重复：${key}`);
    occupied.add(key);
  }
  for (const [k, v] of Object.entries(s.life)) number(v, `life.${k}`, k === 'foodRegrowEveryTicks' ? 1 : 0, k === 'foodRegrowEveryTicks' ? 1000000 : k === 'visionRadius' ? 5 : 100);
  number(s.memory.maxRecall, 'memory.maxRecall', 0, 25); number(s.memory.maxExperiences, 'memory.maxExperiences', 0, 20);
  text(s.model.name, 'model.name');
  if (s.model.name.trim() !== s.model.name || s.model.name.endsWith(':cloud')) throw new Error('model.name 必须为本机模型名称');
  number(s.model.timeoutMs, 'model.timeoutMs', 1, 300000); number(s.model.numPredict, 'model.numPredict', 16, 32768);
  number(s.model.numCtx, 'model.numCtx', 512, 131072); number(s.model.temperature, 'model.temperature', 0, 2, false);
  number(s.model.topP, 'model.topP', 0.001, 1, false); number(s.model.seed, 'model.seed', 0, 2147483647);
  number(s.run.liveSteps, 'run.liveSteps', 1, 1000); number(s.run.intervalMs, 'run.intervalMs', 1, 3600000);
  if (typeof s.run.strict !== 'boolean') throw new Error('run.strict 必须为 true 或 false');
  if (typeof s.storage.path !== 'string' || !s.storage.path.trim()) throw new Error('storage.path 必须为非空路径');
}
function readConfig<T>(path: string, defaults: T): T {
  let input: unknown;
  try { input = JSON.parse(readFileSync(path, 'utf8')); } catch (error) { throw new Error(`无法读取设定文件 ${path}：${error instanceof Error ? error.message : String(error)}`); }
  return mergeKnown(defaults, input, path) as T;
}
export function loadSettings(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()) {
  const path = resolve(cwd, env.DEER_LIVE_CONFIG || 'deerlive.config.json');
  const loaded = env.DEER_LIVE_CONFIG || existsSync(path) ? path : null;
  const runtime = loaded ? readConfig(path, DEFAULT_RUNTIME) : structuredClone(DEFAULT_RUNTIME);
  const worldPath = runtime.worldFile ? resolve(dirname(path), runtime.worldFile) : null;
  const characterPath = runtime.characterFile ? resolve(dirname(path), runtime.characterFile) : null;
  const world = worldPath ? readConfig(worldPath, DEFAULT_WORLD) : structuredClone(DEFAULT_WORLD);
  const character = characterPath ? readConfig(characterPath, DEFAULT_CHARACTER) : structuredClone(DEFAULT_CHARACTER);
  const settings = assemble(runtime, world, character);
  if (env.DEER_LIVE_MODEL !== undefined) settings.model.name = env.DEER_LIVE_MODEL;
  if (env.DEER_LIVE_DB !== undefined) settings.storage.path = env.DEER_LIVE_DB;
  if (env.DEER_LIVE_TIMEOUT_MS !== undefined) {
    if (!/^\d+$/.test(env.DEER_LIVE_TIMEOUT_MS)) throw new Error('DEER_LIVE_TIMEOUT_MS 必须为正整数');
    settings.model.timeoutMs = Number(env.DEER_LIVE_TIMEOUT_MS);
  }
  if (env.DEER_LIVE_STRICT !== undefined) {
    if (!['0', '1'].includes(env.DEER_LIVE_STRICT)) throw new Error('DEER_LIVE_STRICT 必须为 0 或 1');
    settings.run.strict = env.DEER_LIVE_STRICT === '1';
  }
  validateSettings(settings);
  return { settings, path: loaded, worldPath, characterPath };
}
