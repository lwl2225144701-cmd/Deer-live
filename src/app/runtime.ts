import { advance, decide, type Cognition } from '../world/world.ts';
import { Store } from '../storage/store.ts';
import type { Brain } from '../agent/brain.ts';
import { updateGoal, goalCandidates } from '../agent/learning.ts';
import { DEFAULT_SETTINGS, type Settings } from '../config/settings.ts';
import { eventFactInput, retrieveHints, candidateActionIds } from '../experience/facts.ts';
import type { ExperienceStore } from '../experience/store.ts';
import { reviewThinking } from '../thinking/generate.ts';
import type { ThinkingStore } from '../thinking/store.ts';
import { CalibrationStore } from '../calibration/store.ts';
import { resolve } from 'node:path';

export async function tick(store: Store, options: { brain?: Brain; strict?: boolean; signal?: AbortSignal; settings?: Settings; experience?: ExperienceStore; thinking?: ThinkingStore; calibration?: CalibrationStore; fetcher?: typeof fetch } = {}) {
  const world = store.load();
  if (!world) throw new Error('请先初始化世界');
  const settings = options.settings || DEFAULT_SETTINGS;
  const memories = store.recall(world, settings.memory.maxRecall, settings.life.hungryAt);
  const experiences = store.experiences(settings.memory.maxExperiences);
  const learning = store.learning(world);
  let goal = learning.goal;
  let selected;
  let cognition: Cognition;
  // 经验线索只在模型决策前检索；规则决策不需要，失败接管也不回退线索。
  const experienceEnabled = Boolean(options.experience && settings.memory.experience.enabled);
  const thinkingEnabled = Boolean(experienceEnabled && options.thinking && settings.thinking.enabled);
  const calibrationEnabled = Boolean(thinkingEnabled && options.calibration && settings.calibration.enabled);
  const beliefs = thinkingEnabled && options.brain
    ? options.thinking!.selfBeliefs(settings.thinking.maxBeliefsInPrompt).map(b => b.statement)
    : [];
  const hints = experienceEnabled && options.brain
    ? retrieveHints(options.experience!, world, candidateActionIds(world, settings.life), settings.memory.experience)
    : [];
  if (options.brain) {
    const started = performance.now();
    try {
      const decision = await options.brain.decide(world, memories, options.signal, experiences, learning, hints, beliefs);
      if (!goal && decision.goal) {
        if (!goalCandidates(world, learning, settings.life).some(c => c.x === decision.goal!.x && c.y === decision.goal!.y)) throw new Error('模型目标不在已观察的地点内');
        goal = { ...decision.goal, source: 'ollama', selectedAt: world.tick + 1, stalledMoves: 0, bestDistance: Math.abs(decision.goal.x - world.agent.x) + Math.abs(decision.goal.y - world.agent.y) };
      }
      selected = decision;
      cognition = { source: 'ollama', model: decision.model, latencyMs: decision.latencyMs, offeredMemoryIds: memories.map(m => m.id), offeredExperienceTicks: experiences.map(e => e.tick), ...(experienceEnabled ? { offeredExperienceHints: hints.map(h => h.action) } : {}), ...(thinkingEnabled ? { offeredSelfBeliefs: beliefs.length } : {}) };
    } catch (error) {
      if (options.strict || options.signal?.aborted) throw error;
      selected = decide(world, settings.life);
      cognition = { source: 'fallback', model: options.brain.model, latencyMs: Math.round(performance.now() - started), offeredMemoryIds: memories.map(m => m.id), offeredExperienceTicks: experiences.map(e => e.tick), ...(experienceEnabled ? { offeredExperienceHints: hints.map(h => h.action) } : {}), ...(thinkingEnabled ? { offeredSelfBeliefs: beliefs.length } : {}), error: error instanceof Error ? error.message : String(error) };
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
  // 行动结束后把观察到的身体变化记入经验库；无论决策来自模型还是规则，
  // 事实只描述“实际发生了什么”。每次记录后原子落盘，保证重启可恢复。
  if (experienceEnabled) {
    options.experience!.record(eventFactInput(world, result.event));
    options.experience!.save(resolve(settings.memory.experience.path));
  }
  // 校准对账：判断写下之后的实际遭遇，机械比对，不经模型。失败不阻塞生存。
  if (calibrationEnabled) {
    try {
      options.calibration!.update(options.thinking!, options.experience!, result.event.tick, { placeNames: settings.initialWorld.places.map(p => p.name) });
      options.calibration!.save(resolve(settings.calibration.path));
    } catch (error) {
      console.log(`[校准] 第 ${result.event.tick} 步对账失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // 思考复核：定期让模型面对自己的事实，复核旧判断并写下新判断。
  // 复核失败不阻塞生存循环，只在日志可见。
  if (thinkingEnabled && result.event.tick % settings.thinking.everyTicks === 0) {
    try {
      const review = await reviewThinking(settings.model, {
        experience: options.experience!,
        thinking: options.thinking!,
        maxActive: settings.thinking.maxActive,
        signal: options.signal,
        ...(options.calibration && settings.calibration.enabled ? { calibration: options.calibration } : {}),
        ...(options.fetcher ? { fetcher: options.fetcher } : {}),
      });
      console.log(`[思考] 第 ${result.event.tick} 步复核：新增 ${review.added.length}，保留 ${review.kept}，放弃 ${review.dropped}，未处理 ${review.skipped}${review.unknownIds.length ? `，未知ID ${review.unknownIds.length}` : ''}`);
      for (const belief of review.added) console.log(`[思考] 新判断：${belief.statement}（置信度 ${belief.confidence}）`);
      options.thinking!.save(resolve(settings.thinking.path));
    } catch (error) {
      if (options.signal?.aborted) throw error;
      console.log(`[思考] 第 ${result.event.tick} 步复核失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}
