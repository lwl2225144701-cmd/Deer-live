// 世界是变量：只有"有什么、能被怎么作用、作用后发生什么"。规则判断不认识名字。
import { BODY, clamp, collapsed, readField, writeField, type Body } from './body.ts';

export type Affordance = { verb: 'use' | 'take'; manner?: string; label: string; requires?: string };
export type Effect = {
  on: 'body' | 'self' | 'inventory';
  field: string; delta: number;
};
export type Entity = {
  id: string; name: string; kind: string; at: [number, number]; count?: number;
  affordances: Affordance[]; effects: Record<string, Effect[]>;
};
export type WorldData = {
  name: string; width: number; height: number; start: [number, number];
  body: { hunger: number; energy: number }; entities: Entity[];
};

export type Position = [number, number];
export type Outcome = { step: number; did: string; result: string };

const DIRS: Record<string, Position> = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };

export function validateWorld(data: unknown): WorldData {
  const w = data as WorldData;
  if (!w || typeof w.name !== 'string' || !Number.isInteger(w.width) || !Number.isInteger(w.height) || w.width < 1 || w.height < 1) throw new Error('世界数据无效：缺少 name/width/height');
  if (!Array.isArray(w.entities)) throw new Error('世界数据无效：entities 必须是数组');
  const seen = new Set<string>();
  for (const e of w.entities) {
    if (!e || typeof e.id !== 'string' || !e.id || seen.has(e.id)) throw new Error(`实体 id 无效或重复：${e?.id}`);
    seen.add(e.id);
    if (!Array.isArray(e.at) || e.at.length !== 2 || !Number.isInteger(e.at[0]) || !Number.isInteger(e.at[1])) throw new Error(`实体 ${e.id} 坐标无效`);
    if (e.at[0] < 0 || e.at[1] < 0 || e.at[0] >= w.width || e.at[1] >= w.height) throw new Error(`实体 ${e.id} 坐标越界`);
    if (!Array.isArray(e.affordances)) throw new Error(`实体 ${e.id} 缺少 affordances`);
    if (!e.effects || typeof e.effects !== 'object') throw new Error(`实体 ${e.id} 缺少 effects`);
  }
  if (!Array.isArray(w.start) || w.start.length !== 2) throw new Error('世界数据无效：缺少 start');
  return w;
}

export function entityAt(world: WorldData, pos: Position): Entity | undefined {
  return world.entities.find(e => e.at[0] === pos[0] && e.at[1] === pos[1]);
}

export function nameAt(world: WorldData, pos: Position): string {
  return entityAt(world, pos)?.name ?? '空地';
}

export function affordanceOf(entity: Entity | undefined, verb: string, manner?: string): Affordance | undefined {
  return entity?.affordances.find(a => a.verb === verb && (a.manner ?? '') === (manner ?? ''));
}

function requiresHolds(requires: string | undefined, count: number): boolean {
  if (!requires) return true;
  const match = /^count>=(\d+)$/.exec(requires);
  if (!match) throw new Error(`无法识别的条件：${requires}`);
  return count >= Number(match[1]);
}

function addInventory(body: Body, entity: Entity, delta = 1): void {
  const item = body.inventory.find(i => i.id === entity.id);
  if (item) item.count += delta;
  else body.inventory.push({ id: entity.id, name: entity.name, count: delta });
}

function removeFromInventory(body: Body, id: string, delta = 1): void {
  const item = body.inventory.find(i => i.id === id);
  if (!item) return;
  item.count -= delta;
  if (item.count <= 0) body.inventory.splice(body.inventory.indexOf(item), 1);
}

type SelfHandle = { get: () => number; set: (n: number) => void };

function selfWorld(entity: Entity): SelfHandle {
  return { get: () => entity.count ?? 0, set: n => { entity.count = n; } };
}

function selfInventory(item: { count: number }): SelfHandle {
  return { get: () => item.count, set: n => { item.count = n; } };
}

function applyEffects(effects: Effect[], self: SelfHandle, body: Body, entity: Entity): void {
  for (const effect of effects) {
    if (effect.on === 'body') writeField(body, effect.field, readField(body, effect.field) + effect.delta);
    else if (effect.on === 'self') self.set(self.get() + effect.delta);
    else if (effect.on === 'inventory') addInventory(body, entity, effect.delta);
    else throw new Error(`未知的效果落点：${(effect as Effect).on}`);
  }
}

export function legalActions(world: WorldData, body: Body, pos: Position): string[] {
  const eats = new Set<string>();
  const other = new Set<string>(['wait']);

  const addEntityActions = (entity: Entity, count: number, fromHand: boolean) => {
    for (const a of entity.affordances) {
      if (fromHand && a.verb === 'take') continue;
      if (!requiresHolds(a.requires, count)) continue;
      const action = `${a.verb}:${entity.id}${a.manner ? ':' + a.manner : ''}`;
      if (a.verb === 'use' && a.manner === 'eat') eats.add(action);
      else other.add(action);
    }
  };
  for (const item of body.inventory) {
    const entity = world.entities.find(e => e.id === item.id);
    if (entity) addEntityActions(entity, item.count, true);
  }
  // 昏倒时只剩"等"和"吃"；观察本身不需要花一步，由系统每步自动提供。
  if (collapsed(body)) return [...new Set(['wait', ...eats])];
  for (const [dir, d] of Object.entries(DIRS)) {
    const nx = pos[0] + d[0], ny = pos[1] + d[1];
    if (nx >= 0 && ny >= 0 && nx < world.width && ny < world.height) other.add(`move:${dir}`);
  }
  for (const entity of world.entities) {
    if (Math.abs(entity.at[0] - pos[0]) > 1 || Math.abs(entity.at[1] - pos[1]) > 1) continue;
    addEntityActions(entity, entity.count ?? 0, false);
  }
  return [...other, ...eats];
}

export function apply(world: WorldData, body: Body, pos: Position, action: string): {
  world: WorldData; body: Body; position: Position; outcome: string; collapsed: boolean;
} {
  const nextWorld = structuredClone(world);
  const nextBody = structuredClone(body) as Body;
  const at = nameAt(nextWorld, pos);
  const wasCollapsed = collapsed(nextBody);
  let position = structuredClone(pos) as Position;
  let outcome: string;

  const [verb, targetId, manner] = action.split(':');
  if (wasCollapsed && !(verb === 'use' && manner === 'eat')) {
    nextBody.hunger = clamp(nextBody.hunger + BODY.hungerPerStep);
    return { world: nextWorld, body: nextBody, position, outcome: '身体动不了，这一步什么也没做成', collapsed: true };
  }
  if (verb === 'move') {
    const d = DIRS[targetId];
    const nx = position[0] + (d?.[0] ?? 0), ny = position[1] + (d?.[1] ?? 0);
    if (!d || nx < 0 || ny < 0 || nx >= nextWorld.width || ny >= nextWorld.height) outcome = '走不过去';
    else {
      position = [nx, ny];
      nextBody.energy = clamp(nextBody.energy - BODY.moveEnergy);
      outcome = `走到(${nx},${ny})`;
    }
  } else if (verb === 'wait') {
    nextBody.energy = clamp(nextBody.energy + BODY.waitEnergy);
    outcome = '原地等待';
  } else if (verb === 'take') {
    const target = nextWorld.entities.find(e => e.id === targetId);
    const affordance = target ? affordanceOf(target, 'take') : undefined;
    const near = target ? Math.abs(target.at[0] - pos[0]) + Math.abs(target.at[1] - pos[1]) <= 1 : false;
    if (!target || !affordance || !near) outcome = '这个动作做不成';
    else if (!requiresHolds(affordance.requires, target.count ?? 0)) outcome = `${target.name}已经没有可用的了`;
    else {
      applyEffects(target.effects['take'] ?? [], selfWorld(target), nextBody, target);
      outcome = `${affordance.label}（${target.name}）`;
      if (target.id && nextBody.inventory.find(i => i.id === target.id)) {
        for (const item of nextBody.inventory) if (item.id === target.id && item.count < 1) removeFromInventory(nextBody, target.id, 1);
      }
    }
  } else if (verb === 'use') {
    const entity = nextWorld.entities.find(e => e.id === targetId);
    const item = nextBody.inventory.find(i => i.id === targetId);
    const affordance = affordanceOf(entity, 'use', manner);
    const inHand = !!item;
    const near = entity ? Math.abs(entity.at[0] - pos[0]) + Math.abs(entity.at[1] - pos[1]) <= 1 : false;
    if (!entity || !affordance || !(inHand || near)) outcome = '这个动作做不成';
    else {
      const count = inHand ? item!.count : (entity.count ?? 0);
      if (!requiresHolds(affordance.requires, count)) outcome = `${entity.name}已经没有可用的了`;
      else {
        const effects = entity.effects[`use/${manner ?? ''}`];
        if (!effects) outcome = '这个动作没有效果';
        else {
          applyEffects(effects, inHand ? selfInventory(item!) : selfWorld(entity), nextBody, entity);
          if (inHand && item!.count <= 0) removeFromInventory(nextBody, item!.id, 0);
          outcome = `${affordance.label}（${entity.name}）`;
        }
      }
    }
  } else outcome = '不认识的动作';

  nextBody.hunger = clamp(nextBody.hunger + BODY.hungerPerStep);
  return { world: nextWorld, body: nextBody, position, outcome, collapsed: wasCollapsed && collapsed(nextBody) };
}
