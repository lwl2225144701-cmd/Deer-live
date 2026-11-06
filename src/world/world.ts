import { DEFAULT_SETTINGS, type InitialWorldSettings, type LifeSettings } from '../config/settings.ts';
import type { LearningRecord } from '../agent/learning.ts';

export type Action = { type: 'move'; dx: number; dy: number } | { type: 'rest' | 'eat' | 'explore' };
export type Agent = { name: string; x: number; y: number; hunger: number; energy: number; curiosity: number; food: number };
export type Place = { x: number; y: number; name: string; food: number; capacity: number };
export type World = { version: 2; tick: number; width: number; height: number; agent: Agent; places: Place[]; visits: Record<string, number> };
export type Cognition = { source: 'rule' | 'ollama' | 'fallback'; model?: string; latencyMs?: number; offeredMemoryIds?: string[]; offeredExperienceTicks?: number[]; error?: string };
export type Event = { tick: number; action: Action; reason: string; outcome: string; observation?: { x: number; y: number; place: string; foodRemaining: number }; experience?: { before: Agent; after: Agent }; cognition?: Cognition; learning?: LearningRecord };
export type Choice = { id: string; label: string; action: Action };
const clamp = (n: number) => Math.max(0, Math.min(100, n));
const key = (x: number, y: number) => `${x},${y}`;
const integer = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n);

function places(width: number, height: number): Place[] {
  return structuredClone(DEFAULT_SETTINGS.initialWorld.places).filter(p => p.x < width && p.y < height);
}
export function initialWorld(initial: InitialWorldSettings = DEFAULT_SETTINGS.initialWorld): World {
  const seed = structuredClone(initial);
  const world: World = { ...seed, version: 2, tick: 0, visits: { [key(seed.agent.x, seed.agent.y)]: 1 } };
  validateWorld(world);
  return world;
}
export function validateWorld(value: unknown): asserts value is World {
  const w = value as World;
  const a = w?.agent;
  if (!w || w.version !== 2 || !integer(w.tick) || w.tick < 0 || !integer(w.width) || w.width < 1 || !integer(w.height) || w.height < 1 || !a || typeof a.name !== 'string' || !a.name.trim() || !integer(a.x) || a.x < 0 || a.x >= w.width || !integer(a.y) || a.y < 0 || a.y >= w.height || !integer(a.food) || a.food < 0 || ![a.hunger, a.energy, a.curiosity].every(n => integer(n) && n >= 0 && n <= 100)) throw new Error('无效的世界状态，无法继续运行');
  if (!Array.isArray(w.places) || w.places.some(p => !p || !integer(p.x) || !integer(p.y) || p.x < 0 || p.x >= w.width || p.y < 0 || p.y >= w.height || typeof p.name !== 'string' || !p.name.trim() || !integer(p.food) || !integer(p.capacity) || p.food < 0 || p.food > p.capacity) || new Set(w.places.map(p => key(p.x, p.y))).size !== w.places.length) throw new Error('无效的地点或资源状态');
  if (!w.visits || typeof w.visits !== 'object' || Array.isArray(w.visits) || Object.entries(w.visits).some(([position, count]) => {
    const match = /^(\d+),(\d+)$/.exec(position);
    return !match || Number(match[1]) >= w.width || Number(match[2]) >= w.height || !integer(count) || count < 1;
  })) throw new Error('无效的探索记录');
}
// Old M0 snapshots keep all existing agent attributes and simulation time.
export function restoreWorld(value: unknown): World {
  if (value && typeof value === 'object' && 'version' in value && value.version === 1) {
    const old = value as Omit<World, 'version' | 'places' | 'visits'>;
    value = { ...old, version: 2, places: places(old.width, old.height), visits: { [key(old.agent?.x, old.agent?.y)]: 1 } };
  }
  validateWorld(value);
  return value;
}
export function choices(world: World, life: LifeSettings = DEFAULT_SETTINGS.life): Choice[] {
  const { agent: a } = world;
  const result: Choice[] = [{ id: 'explore', label: '仔细探索脚下的位置，有食物时采集一份', action: { type: 'explore' } }, { id: 'rest', label: `休息恢复精力 +${life.restEnergyGain}`, action: { type: 'rest' } }];
  if (a.food > 0) result.push({ id: 'eat', label: `吃一份随身食物，饥饿 -${life.eatHungerRelief}`, action: { type: 'eat' } });
  for (const [id, dx, dy] of [['east', 1, 0], ['south', 0, 1], ['west', -1, 0], ['north', 0, -1]] as const) {
    if (a.x + dx >= 0 && a.x + dx < world.width && a.y + dy >= 0 && a.y + dy < world.height) result.push({ id, label: `移动到 (${a.x + dx},${a.y + dy})，到访 ${world.visits[key(a.x + dx, a.y + dy)] || 0} 次`, action: { type: 'move', dx, dy } });
  }
  return result;
}
export function perceive(world: World, life: LifeSettings = DEFAULT_SETTINGS.life) {
  const a = world.agent;
  const nearby = [];
  for (let y = Math.max(0, a.y - life.visionRadius); y <= Math.min(world.height - 1, a.y + life.visionRadius); y++) {
    for (let x = Math.max(0, a.x - life.visionRadius); x <= Math.min(world.width - 1, a.x + life.visionRadius); x++) {
      const p = world.places.find(p => p.x === x && p.y === y);
      nearby.push({ x, y, name: p?.name || '草地', food: p?.food || 0, visits: world.visits[key(x, y)] || 0 });
    }
  }
  return { tick: world.tick, self: { ...a }, thresholds: { hungryAt: life.hungryAt, tiredAt: life.tiredAt, curiousAt: life.curiousAt }, nearby, choices: choices(world, life).map(({ id, label }) => ({ id, label })) };
}
export function decide(world: World, life: LifeSettings = DEFAULT_SETTINGS.life): { action: Action; reason: string } {
  const a = world.agent;
  if (a.hunger >= life.hungryAt && a.food > 0) return { action: { type: 'eat' }, reason: '饥饿，需要补充食物' };
  if (a.energy <= life.tiredAt) return { action: { type: 'rest' }, reason: '精力不足，需要休息' };
  const here = world.places.find(p => p.x === a.x && p.y === a.y);
  if ((a.hunger >= life.hungryAt && here && here.food > 0) || a.curiosity >= life.curiousAt) return { action: { type: 'explore' }, reason: '探索当前位置并寻找食物' };
  const moves = choices(world, life).filter(c => c.action.type === 'move');
  moves.sort((aChoice, bChoice) => {
    const aMove = aChoice.action as Extract<Action, { type: 'move' }>; const bMove = bChoice.action as Extract<Action, { type: 'move' }>;
    return (world.visits[key(a.x + aMove.dx, a.y + aMove.dy)] || 0) - (world.visits[key(a.x + bMove.dx, a.y + bMove.dy)] || 0);
  });
  return moves.length ? { action: moves[0].action, reason: '前往较少到访的地方' } : { action: { type: 'rest' }, reason: '当前位置无法移动' };
}
export function advance(world: World, action: Action, reason: string, life: LifeSettings = DEFAULT_SETTINGS.life): { world: World; event: Event } {
  validateWorld(world);
  const next: World = structuredClone(world);
  const a = next.agent;
  if ((next.tick + 1) % life.foodRegrowEveryTicks === 0) for (const p of next.places) p.food = Math.min(p.capacity, p.food + 1);
  let outcome: string;
  let observation: Event['observation'];
  switch (action?.type) {
    case 'move':
      if (!Number.isInteger(action.dx) || !Number.isInteger(action.dy) || Math.abs(action.dx) + Math.abs(action.dy) !== 1 || a.x + action.dx < 0 || a.x + action.dx >= next.width || a.y + action.dy < 0 || a.y + action.dy >= next.height) throw new Error('非法移动');
      a.x += action.dx; a.y += action.dy; a.energy = clamp(a.energy - life.moveEnergyCost);
      next.visits[key(a.x, a.y)] = (next.visits[key(a.x, a.y)] || 0) + 1;
      outcome = `移动到 (${a.x}, ${a.y})`; break;
    case 'rest': a.energy = clamp(a.energy + life.restEnergyGain); outcome = '休息并恢复精力'; break;
    case 'eat':
      if (a.food < 1) throw new Error('没有食物');
      a.food--; a.hunger = clamp(a.hunger - life.eatHungerRelief); outcome = '吃掉一份食物'; break;
    case 'explore': {
      a.curiosity = clamp(a.curiosity - life.exploreCuriosityRelief); a.energy = clamp(a.energy - life.exploreEnergyCost);
      const p = next.places.find(p => p.x === a.x && p.y === a.y);
      const found = p && p.food > 0;
      if (found) { p.food--; a.food++; }
      outcome = found ? `在${p.name}找到一份食物，还剩 ${p.food} 份` : `探索${p?.name || '草地'}，没有找到食物`;
      observation = { x: a.x, y: a.y, place: p?.name || '草地', foodRemaining: p?.food || 0 }; break;
    }
    default: throw new Error('未知行动');
  }
  a.hunger = clamp(a.hunger + life.hungerPerTick); a.curiosity = clamp(a.curiosity + life.curiosityPerTick); next.tick++;
  validateWorld(next);
  return { world: next, event: { tick: next.tick, action: structuredClone(action), reason, outcome, experience: { before: structuredClone(world.agent), after: structuredClone(a) }, ...(observation ? { observation } : {}) } };
}
export function step(world: World, life: LifeSettings = DEFAULT_SETTINGS.life) { const { action, reason } = decide(world, life); return advance(world, action, reason, life); }
