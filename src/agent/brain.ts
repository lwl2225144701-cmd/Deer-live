import { choices, perceive, type Action, type World } from '../world/world.ts';
import type { Memory, Experience } from './memory.ts';
import { goalCandidates, type LearningContext } from './learning.ts';
import { DEFAULT_SETTINGS, type LifeSettings, type CharacterSettings, type ModelSettings } from '../config/settings.ts';

export type Decision = { action: Action; reason: string; model: string; latencyMs: number; choice: string; goal?: { x: number; y: number } | null };
export type Brain = { readonly model?: string; decide(world: World, memories: Memory[], signal?: AbortSignal, experiences?: Experience[], learning?: LearningContext): Promise<Decision> };

export function compactDecisionRequest(world: World, memories: Memory[], context: { life?: LifeSettings; character?: CharacterSettings; experiences?: Experience[]; learning?: LearningContext } = {}) {
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
      task: '根据真实经历和眼前环境选择行动。hunger越高越饿，energy越低越累；先照顾身体需求，再探索少去的地方。explore只检查脚下不移动；脚下没有食物且已探索过时，尝试其他地方。历史无食物不代表永久没有，资源可能恢复。只按responseSchema输出JSON，不解释。' + (candidates ? 'goal是计划探索的目的地，从goalCandidates选择坐标，也可none暂不设目标。' : context.learning?.goal ? 'goal是你此前选定的目的地，照顾身体后继续前往并探索，到达不算完成。' : ''),
      observation: perceive(world, life),
      // Keep food-location recall and action effects when simplifying the input;
      // removing these would discard useful evidence beyond the failed scene.
      memories: recalled, experiences, lastExperienceInWords,
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
    task: "根据眼前观察、地点记忆和行动经历选择下一步。hunger越高越饿，energy越低越累，food是随身食物数量。以自身生存为首要目标：有基本的寻找食物和休息本能，依据身体阈值照顾需求。通过experiences里的实际身体变化和探索结果积累经验，调整下一步；不要虚构没有发生过的经历。状态良好时尝试少去的地方。explore只检查脚下，不移动；脚下没食物且已探索过时，尝试其他地方。记忆可能过期；nextAction是前往该记忆位置的第一步。只输出动作JSON，例如{\"choice\":\"rest\"}，不要解释。",
    observation: payload.observation, memories: payload.memories, experiences: payload.experiences,
    ...(context.learning ? { learning: context.learning, learningGuide: "facts是累计实际探索结果，emptyAttempts是没采到食物的次数，不代表永远无食物；资源可能恢复。recentMoves含模型和规则来源，immediateReversals是最近六步内原路折返次数。参考代价与收获，避免反复空跑。goal是你此前选定、尚未探索的目的地；先照顾饥饿和精力，再继续前往并探索，移动到达不算完成。动作始终由你决定。若schema要求goal，从goalCandidates选择打算前往探索的坐标，或none暂不设目标。" } : {}),
    ...(payload.goalCandidates ? { goalCandidates: payload.goalCandidates } : {}),
    responseSchema: request.format,
  });
  return request;
}

export class OllamaBrain implements Brain {
  readonly model: string;
  private baseUrl: string;
  private timeoutMs: number;
  private fetcher: typeof fetch;
  private modelConfig: ModelSettings;
  private life: LifeSettings;
  private character: CharacterSettings;
  constructor(options: { model?: string; baseUrl?: string; timeoutMs?: number; fetcher?: typeof fetch; modelConfig?: ModelSettings; life?: LifeSettings; character?: CharacterSettings } = {}) {
    this.modelConfig = structuredClone(options.modelConfig || DEFAULT_SETTINGS.model);
    this.life = structuredClone(options.life || DEFAULT_SETTINGS.life);
    this.character = structuredClone(options.character || DEFAULT_SETTINGS.character);
    this.model = options.model || this.modelConfig.name;
    const url = new URL(options.baseUrl || 'http://127.0.0.1:11434');
    if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || this.model.endsWith(':cloud')) throw new Error('当前版本仅支持本机 Ollama 的本地模型');
    this.baseUrl = url.origin;
    this.timeoutMs = options.timeoutMs ?? this.modelConfig.timeoutMs;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) throw new Error('模型超时必须是正整数毫秒');
    this.fetcher = options.fetcher || fetch;
  }
  async decide(world: World, memories: Memory[], signal?: AbortSignal, experiences: Experience[] = [], learning?: LearningContext): Promise<Decision> {
    const started = performance.now();
    const response = await this.fetcher(`${this.baseUrl}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]),
      body: JSON.stringify({ model: this.model, ...decisionRequest(world, memories, { life: this.life, character: this.character, experiences, learning }), stream: false, ...(this.model.startsWith('deepseek-r1') ? {} : { think: false }), keep_alive: '5m', options: { temperature: this.modelConfig.temperature, top_p: this.modelConfig.topP, num_predict: this.modelConfig.numPredict, num_ctx: this.modelConfig.numCtx, seed: this.modelConfig.seed } }),
    });
    if (!response.ok) throw new Error(`Ollama HTTP ${response.status}：${(await response.text()).slice(0, 200)}`);
    const body = await response.json() as { done?: boolean; done_reason?: string; error?: string; message?: { content?: string } };
    if (body.error || body.done !== true || body.done_reason === 'length' || typeof body.message?.content !== 'string') throw new Error(body.error || `模型输出不完整（结束原因：${body.done_reason || 'unknown'}）`);
    const parsed = JSON.parse(body.message.content) as { choice?: unknown; goal?: unknown };
    const choice = choices(world, this.life).find(c => c.id === parsed?.choice);
    const candidates = learning && !learning.goal ? goalCandidates(world, learning, this.life) : null;
    const goal = candidates?.find(c => c.id === parsed?.goal);
    if (!choice || Object.keys(parsed).length !== (candidates ? 2 : 1) || (candidates && parsed.goal !== 'none' && !goal) || (!candidates && 'goal' in parsed)) throw new Error('模型输出了非法动作、目标或多余字段');
    // Labels describe the selected action, never a fabricated model rationale.
    return { action: choice.action, choice: choice.id, ...(candidates ? { goal: goal ? { x: goal.x, y: goal.y } : null } : {}), reason: `模型选择：${choice.label}`, model: this.model, latencyMs: Math.round(performance.now() - started) };
  }
}
