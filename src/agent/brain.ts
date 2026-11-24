import { choices, perceive, type Action, type World } from '../world/world.ts';
import type { Memory, Experience } from './memory.ts';
import { goalCandidates, type LearningContext } from './learning.ts';
import { DEFAULT_SETTINGS, type LifeSettings, type CharacterSettings, type ModelSettings } from '../config/settings.ts';
import { chat, resolveBaseUrl } from './client.ts';
import type { ExperienceHint } from '../experience/types.ts';
import { setTimeout as delay } from 'node:timers/promises';

// 一次性推理失败（超时、偶发 5xx、输出截断）不立即交给规则接管，
// 先原样重试一次；中止信号始终立即生效。
const RETRY_DELAY_MS = 1000;

export type Decision = { action: Action; reason: string; model: string; latencyMs: number; choice: string; goal?: { x: number; y: number } | null };
export type Brain = { readonly model?: string; decide(world: World, memories: Memory[], signal?: AbortSignal, experiences?: Experience[], learning?: LearningContext, hints?: ExperienceHint[], beliefs?: string[]): Promise<Decision> };

export function compactDecisionRequest(world: World, memories: Memory[], context: { life?: LifeSettings; character?: CharacterSettings; experiences?: Experience[]; learning?: LearningContext; experienceHints?: ExperienceHint[]; selfBeliefs?: string[] } = {}) {
  const life = context.life || DEFAULT_SETTINGS.life;
  const character = context.character || DEFAULT_SETTINGS.character;
  const candidates = context.learning && !context.learning.goal ? goalCandidates(world, context.learning, life) : null;
  const format = {
    type: 'object', additionalProperties: false,
    properties: { choice: { type: 'string', enum: choices(world, life).map(c => c.id) }, ...(candidates ? { goal: { type: 'string', enum: ['none', ...candidates.map(c => c.id)] } } : {}) }, required: candidates ? ['choice', 'goal'] : ['choice'],
  };
  // Route hints apply only to a remembered food source. An empty-place fact
  // must not become an instruction to return there or explore it again.
  // All legal actions remain available, including revisiting an empty site.
  const recalled = memories.map(m => m.foodRemaining > 0
    ? { ...m, nextAction: m.x < world.agent.x ? 'west' : m.x > world.agent.x ? 'east' : m.y < world.agent.y ? 'north' : m.y > world.agent.y ? 'south' : 'explore' }
    : { ...m });
  const experiences = (context.experiences || []).map(e => ({
    tick: e.tick, action: e.action, outcome: e.outcome,
    from: { x: e.before.x, y: e.before.y }, to: { x: e.after.x, y: e.after.y },
    bodyChange: { hunger: e.after.hunger - e.before.hunger, energy: e.after.energy - e.before.energy, curiosity: e.after.curiosity - e.before.curiosity, food: e.after.food - e.before.food },
  }));
  const latest = (context.experiences || []).reduce<Experience | undefined>((a, b) => !a || b.tick > a.tick ? b : a, undefined);
  const lastExperienceInWords = latest
    ? `第${latest.tick}步在(${latest.before.x},${latest.before.y})执行${latest.action.type}，结果：${latest.outcome}。随后位于(${latest.after.x},${latest.after.y})，随身食物从${latest.before.food}变为${latest.after.food}，精力从${latest.before.energy}变为${latest.after.energy}。`
    : '尚无可提供的行动经历。';
  return {
    messages: [{ role: 'user', content: JSON.stringify({
      identity: { name: world.agent.name, species: character.species, lifeStage: character.lifeStage, description: character.description, motivation: character.motivation },
      task: '根据真实经历和眼前环境选择行动。hunger越高越饿，energy越低越累；先照顾身体需求，再探索少去的地方。explore只检查脚下不移动；脚下没有食物且已探索过时，尝试其他地方。历史无食物不代表永久没有，资源可能恢复。' + (context.selfBeliefs?.length ? 'selfBeliefs是你此前基于亲身经历写下的自我判断，像自己的经验之谈一样对待它们，可以用新的经历修正。' : '') + '只按responseSchema输出JSON，不解释。' + (candidates ? 'goal是计划探索的目的地，从goalCandidates选择坐标，也可none暂不设目标。' : context.learning?.goal ? 'goal是你此前选定的目的地，照顾身体后继续前往并探索，到达不算完成。' : '') + (context.experienceHints?.length ? 'experienceHints是按当前身体状态、位置和候选动作，从过去实际发生的事情里检索到的摘要，只描述过去的观察，不保证现在适用，也不限制你的选择。' : ''),
      observation: perceive(world, life),
      // Keep food-location recall and action effects when simplifying the input;
      // removing these would discard useful evidence beyond the failed scene.
      memories: recalled, experiences, lastExperienceInWords,
      ...(context.experienceHints?.length ? { experienceHints: context.experienceHints } : {}),
      ...(context.selfBeliefs?.length ? { selfBeliefs: context.selfBeliefs } : {}),
      ...(context.learning ? {
        explorationFacts: context.learning.facts,
        recentMoves: context.learning.recentMoves,
        immediateReversals: context.learning.immediateReversals,
        goal: context.learning.goal,
        ...(candidates ? { goalCandidates: candidates } : {}),
      } : {}),
      responseSchema: format,
    }) }], format,
  };
}

// The compact candidate remains opt-in for experiments: its cross-scenario
// checks did not establish a reliable improvement over the default prompt.
export function decisionRequest(world: World, memories: Memory[], context: Parameters<typeof compactDecisionRequest>[2] = {}) {
  const request = compactDecisionRequest(world, memories, context);
  const payload = JSON.parse(request.messages[0].content);
  request.messages[0].content = JSON.stringify({
    identity: payload.identity,
    task: "根据眼前观察、地点记忆和行动经历选择下一步。hunger越高越饿，energy越低越累，food是随身食物数量。以自身生存为首要目标：有基本的寻找食物和休息本能，依据身体阈值照顾需求。通过experiences里的实际身体变化和探索结果积累经验，调整下一步；不要虚构没有发生过的经历。" + (payload.selfBeliefs ? "selfBeliefs是你此前基于亲身经历写下的自我判断，像自己的经验之谈一样对待它们，可以用新的经历修正。" : "") + (payload.experienceHints ? "experienceHints是按当前身体状态、位置和候选动作从过往经历检索到的事实摘要，只描述过去的观察，不保证现在适用，也不限制你的选择。" : "") + "状态良好时尝试少去的地方。explore只检查脚下，不移动；脚下没食物且已探索过时，尝试其他地方。记忆可能过期；nextAction是前往该记忆位置的第一步。只输出动作JSON，例如{\"choice\":\"rest\"}，不要解释。",
    observation: payload.observation, memories: payload.memories, experiences: payload.experiences,
    ...(payload.experienceHints ? { experienceHints: payload.experienceHints } : {}),
    ...(context.learning ? { learning: context.learning, learningGuide: "facts是累计实际探索结果，emptyAttempts是没采到食物的次数，不代表永远无食物；资源可能恢复。recentMoves含模型和规则来源，immediateReversals是最近六步内原路折返次数。参考代价与收获，避免反复空跑。goal是你此前选定、尚未探索的目的地；先照顾饥饿和精力，再继续前往并探索，移动到达不算完成。动作始终由你决定。若schema要求goal，从goalCandidates选择打算前往探索的坐标，或none暂不设目标。" } : {}),
    ...(payload.goalCandidates ? { goalCandidates: payload.goalCandidates } : {}),
    responseSchema: request.format,
  });
  return request;
}

export class ModelBrain implements Brain {
  readonly model: string;
  private timeoutMs: number;
  private fetcher: typeof fetch;
  private modelConfig: ModelSettings;
  private life: LifeSettings;
  private character: CharacterSettings;
  constructor(options: { model?: string; baseUrl?: string; timeoutMs?: number; fetcher?: typeof fetch; modelConfig?: ModelSettings; life?: LifeSettings; character?: CharacterSettings } = {}) {
    this.modelConfig = structuredClone(options.modelConfig || DEFAULT_SETTINGS.model);
    if (options.model) this.modelConfig.name = options.model;
    if (options.baseUrl) this.modelConfig.baseUrl = options.baseUrl;
    this.life = structuredClone(options.life || DEFAULT_SETTINGS.life);
    this.character = structuredClone(options.character || DEFAULT_SETTINGS.character);
    this.model = this.modelConfig.name;
    const baseUrl = resolveBaseUrl(this.modelConfig);
    if (this.modelConfig.provider === 'ollama') {
      const url = new URL(baseUrl);
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || this.model.endsWith(':cloud')) throw new Error('ollama 模式仅支持本机模型');
    }
    this.timeoutMs = options.timeoutMs ?? this.modelConfig.timeoutMs;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) throw new Error('模型超时必须是正整数毫秒');
    this.fetcher = options.fetcher || fetch;
  }
  async decide(world: World, memories: Memory[], signal?: AbortSignal, experiences: Experience[] = [], learning?: LearningContext, hints: ExperienceHint[] = [], beliefs: string[] = []): Promise<Decision> {
    const started = performance.now();
    const request = decisionRequest(world, memories, { life: this.life, character: this.character, experiences, learning, experienceHints: hints, selfBeliefs: beliefs });
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await delay(RETRY_DELAY_MS, undefined, { signal });
      try {
        const reply = await chat(this.modelConfig, {
          messages: request.messages,
          format: request.format,
          think: this.model.startsWith('deepseek-r1') ? null : false,
          keepAlive: '5m',
          seed: this.modelConfig.seed,
        }, { fetcher: this.fetcher, timeoutMs: this.timeoutMs, signal });
        const parsed = JSON.parse(reply.content) as { choice?: unknown; goal?: unknown };
        const choice = choices(world, this.life).find(c => c.id === parsed?.choice);
        const candidates = learning && !learning.goal ? goalCandidates(world, learning, this.life) : null;
        const goal = candidates?.find(c => c.id === parsed?.goal);
        if (!choice || Object.keys(parsed).length !== (candidates ? 2 : 1) || (candidates && parsed.goal !== 'none' && !goal) || (!candidates && 'goal' in parsed)) throw new Error('模型输出了非法动作、目标或多余字段');
        // Labels describe the selected action, never a fabricated model rationale.
        return { action: choice.action, choice: choice.id, ...(candidates ? { goal: goal ? { x: goal.x, y: goal.y } : null } : {}), reason: `模型选择：${choice.label}`, model: this.model, latencyMs: Math.round(performance.now() - started) };
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }
}

// 历史名称保留给既有调用方；实现已支持本机 Ollama 和 OpenAI 兼容服务。
export const OllamaBrain = ModelBrain;
