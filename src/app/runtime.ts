import { advance, decide, type Cognition } from '../world/world.ts';
import { Store } from '../storage/store.ts';
import type { Brain } from '../agent/brain.ts';
import { updateGoal, goalCandidates } from '../agent/learning.ts';
import { DEFAULT_SETTINGS, type Settings } from '../config/settings.ts';

export async function tick(store: Store, options: { brain?: Brain; strict?: boolean; signal?: AbortSignal; settings?: Settings } = {}) {
  const world = store.load();
  if (!world) throw new Error('请先初始化世界');
  const settings = options.settings || DEFAULT_SETTINGS;
  const memories = store.recall(world, settings.memory.maxRecall, settings.life.hungryAt);
  const experiences = store.experiences(settings.memory.maxExperiences);
  const learning = store.learning(world);
  let goal = learning.goal;
  let selected;
  let cognition: Cognition;
  if (options.brain) {
    const started = performance.now();
    try {
      const decision = await options.brain.decide(world, memories, options.signal, experiences, learning);
      if (!goal && decision.goal) {
        if (!goalCandidates(world, learning, settings.life).some(c => c.x === decision.goal!.x && c.y === decision.goal!.y)) throw new Error('模型目标不在已观察的地点内');
        goal = { ...decision.goal, source: 'ollama', selectedAt: world.tick + 1, stalledMoves: 0, bestDistance: Math.abs(decision.goal.x - world.agent.x) + Math.abs(decision.goal.y - world.agent.y) };
      }
      selected = decision;
      cognition = { source: 'ollama', model: decision.model, latencyMs: decision.latencyMs, offeredMemoryIds: memories.map(m => m.id), offeredExperienceTicks: experiences.map(e => e.tick) };
    } catch (error) {
      if (options.strict || options.signal?.aborted) throw error;
      selected = decide(world, settings.life);
      cognition = { source: 'fallback', model: options.brain.model, latencyMs: Math.round(performance.now() - started), offeredMemoryIds: memories.map(m => m.id), offeredExperienceTicks: experiences.map(e => e.tick), error: error instanceof Error ? error.message : String(error) };
    }
  } else {
    selected = decide(world, settings.life);
    cognition = { source: 'rule' };
  }
  // A failed or aborted inference must never commit a partially selected action.
  options.signal?.throwIfAborted();
  const result = advance(world, selected.action, selected.reason, settings.life);
  result.event.cognition = cognition;
  result.event.learning = { offered: learning, goalBeforeAction: goal, ...updateGoal(goal, result.event) };
  store.save(result.world, result.event);
  return result;
}
