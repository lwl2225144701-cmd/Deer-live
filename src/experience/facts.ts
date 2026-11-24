import { choices, type Action, type Event, type World } from '../world/world.ts';
import type { LifeSettings } from '../config/settings.ts';
import type { ExperienceHint } from './types.ts';
import { describePattern, type ExperienceStore } from './store.ts';
import type { ExperienceInput, Situation } from './types.ts';

// 正式循环与经验系统之间的转换层：
// 世界事件 → 经验事实（只含观察到的变化），世界状态 → 检索情境。

export function actionIdOf(action: Action): string {
  if (action.type === 'move') {
    return `move:${action.dx > 0 ? 'east' : action.dx < 0 ? 'west' : action.dy > 0 ? 'south' : 'north'}`;
  }
  return action.type;
}

// 候选动作的动作 ID：与经验事实中的 action 命名一致（移动带方向），
// 否则按动作过滤的检索会永远为空。
export function candidateActionIds(world: World, life: LifeSettings): string[] {
  return choices(world, life).map(c => c.action.type === 'move' ? actionIdOf(c.action) : c.id);
}

export function placeAt(world: World, x: number, y: number): string {
  return world.places.find(p => p.x === x && p.y === y)?.name || '草地';
}

export function situationFromWorld(world: World): Situation {
  return {
    hunger: world.agent.hunger,
    energy: world.agent.energy,
    condition: 'can_move',
    place: placeAt(world, world.agent.x, world.agent.y),
    inventory: world.agent.food > 0 ? [{ id: 'food', name: '随身食物', count: world.agent.food }] : [],
  };
}

export function eventFactInput(world: World, event: Event): ExperienceInput {
  const before = event.experience!.before;
  const after = event.experience!.after;
  return {
    tick: event.tick,
    action: actionIdOf(event.action),
    situation: {
      hunger: before.hunger,
      energy: before.energy,
      condition: 'can_move',
      place: placeAt(world, before.x, before.y),
      inventory: before.food > 0 ? [{ id: 'food', name: '随身食物', count: before.food }] : [],
    },
    effect: {
      hungerDelta: after.hunger - before.hunger,
      energyDelta: after.energy - before.energy,
      foodDelta: after.food - before.food,
      conditionAfter: 'can_move',
      outcome: event.outcome,
    },
  };
}

// 按候选动作分别取回经验线索：动作过滤返回与“如果做这个动作”直接相关的模式，
// 再按相关度合并截断。检索只返回事实聚合，不返回模型假设。
export function retrieveHints(
  experience: ExperienceStore,
  world: World,
  actionIds: string[],
  options: { maxPatterns: number; maxPerAction: number; minObservations: number },
): ExperienceHint[] {
  if (options.maxPatterns < 1) return [];
  const situation = situationFromWorld(world);
  const collected: { hint: ExperienceHint; score: number; lastTick: number }[] = [];
  const seen = new Set<string>();
  for (const action of actionIds) {
    for (const match of experience.retrieve(situation, { action, limit: options.maxPerAction, minObservations: options.minObservations })) {
      const key = `${match.pattern.action}\u0000${match.pattern.situationKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push({ hint: { action: match.pattern.action, text: describePattern(match.pattern) }, score: match.score, lastTick: match.pattern.lastTick });
    }
  }
  return collected
    .sort((a, b) => b.score - a.score || b.lastTick - a.lastTick)
    .slice(0, options.maxPatterns)
    .map(entry => entry.hint);
}
