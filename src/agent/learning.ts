import { perceive, type Event, type World } from '../world/world.ts';
import { DEFAULT_SETTINGS, type LifeSettings } from '../config/settings.ts';

export type ExplorationFact = {
  x: number; y: number; attempts: number; emptyAttempts: number; foodCollected: number;
  energySpent: number; firstTick: number; lastTick: number; lastFoodRemaining: number;
};
export type ExplorationGoal = { x: number; y: number; selectedAt: number; source: 'ollama'; stalledMoves: number; bestDistance: number };
export type LearningContext = {
  facts: ExplorationFact[];
  recentMoves: { tick: number; from: { x: number; y: number }; to: { x: number; y: number }; source: string }[];
  immediateReversals: number;
  goal: ExplorationGoal | null;
};
export type LearningRecord = { offered: LearningContext; goalBeforeAction?: ExplorationGoal | null; goalAfter: ExplorationGoal | null; goalEnd?: 'explored' | 'stalled' };

// Statistics describe observed outcomes, never inferred permanent world rules.
export function explorationFacts(events: Event[]): ExplorationFact[] {
  const facts = new Map<string, ExplorationFact>();
  for (const e of events) {
    if (e.action.type !== 'explore' || !e.observation || !e.experience) continue;
    const o = e.observation, b = e.experience;
    const food = b.after.food - b.before.food;
    const id = `${o.x},${o.y}`;
    const f = facts.get(id) || { x: o.x, y: o.y, attempts: 0, emptyAttempts: 0, foodCollected: 0, energySpent: 0, firstTick: e.tick, lastTick: e.tick, lastFoodRemaining: o.foodRemaining };
    f.attempts++; if (food === 0) f.emptyAttempts++;
    f.foodCollected += food; f.energySpent += Math.max(0, b.before.energy - b.after.energy);
    f.lastTick = e.tick; f.lastFoodRemaining = o.foodRemaining;
    facts.set(id, f);
  }
  return [...facts.values()];
}

export function goalCandidates(world: World, learning: LearningContext, life: LifeSettings = DEFAULT_SETTINGS.life) {
  const cells = new Map(perceive(world, life).nearby.map(p => [`${p.x},${p.y}`, { id: `${p.x},${p.y}`, x: p.x, y: p.y }]));
  for (const f of learning.facts) if (f.lastFoodRemaining > 0) cells.set(`${f.x},${f.y}`, { id: `${f.x},${f.y}`, x: f.x, y: f.y });
  return [...cells.values()];
}

export function updateGoal(goal: ExplorationGoal | null, event: Event): Pick<LearningRecord, 'goalAfter' | 'goalEnd'> {
  if (!goal) return { goalAfter: null };
  const after = event.experience!.after;
  if (event.action.type === 'explore' && after.x === goal.x && after.y === goal.y) return { goalAfter: null, goalEnd: 'explored' };
  const distance = (a: { x: number; y: number }) => Math.abs(a.x - goal.x) + Math.abs(a.y - goal.y);
  // Rest/eating can interrupt a journey without losing the destination. Four
  // consecutive moves without a new best distance abandon it; actions stay legal.
  const improved = distance(after) < goal.bestDistance;
  const next = { ...goal, bestDistance: Math.min(goal.bestDistance, distance(after)), stalledMoves: event.action.type === 'move' ? (improved ? 0 : goal.stalledMoves + 1) : goal.stalledMoves };
  if (next.stalledMoves >= 4) return { goalAfter: null, goalEnd: 'stalled' };
  return { goalAfter: next };
}
