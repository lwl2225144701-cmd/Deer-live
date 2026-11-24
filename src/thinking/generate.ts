import { chat } from '../agent/client.ts';
import type { ModelSettings } from '../config/settings.ts';
import { describePattern, type ExperienceStore } from '../experience/store.ts';
import { ThinkingStore } from './store.ts';
import type { ReviewVerdict, ThinkingBelief } from './types.ts';
import type { CalibrationStore } from '../calibration/store.ts';

// 思考系统的唯一模型调用：定期把经验事实交给模型，
// 让它复核已有自我判断（keep/drop）并补充新判断。
// 调用失败向上抛出，由调用方决定是否忽略——思考不阻塞生存。

const MAX_NEW_BELIEFS = 3;
const MAX_FACTS_IN_PROMPT = 20;
const MAX_PATTERNS_IN_PROMPT = 15;

const responseSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    beliefs: {
      type: 'array', maxItems: MAX_NEW_BELIEFS, items: {
        type: 'object', additionalProperties: false,
        properties: { statement: { type: 'string' }, basisFactIds: { type: 'array', items: { type: 'string' } }, confidence: { type: 'number' } },
        required: ['statement', 'basisFactIds', 'confidence'],
      },
    },
    review: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        properties: { id: { type: 'string' }, verdict: { type: 'string', enum: ['keep', 'drop'] } },
        required: ['id', 'verdict'],
      },
    },
  },
  required: ['beliefs', 'review'],
};

export type ThinkingReviewResult = { added: ThinkingBelief[]; kept: number; dropped: number; unknownIds: string[]; skipped: number };

export async function reviewThinking(model: ModelSettings, deps: {
  experience: ExperienceStore;
  thinking: ThinkingStore;
  calibration?: CalibrationStore;
  maxActive?: number;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ThinkingReviewResult> {
  const { experience, thinking } = deps;
  const facts = experience.facts().sort((a, b) => b.tick - a.tick).slice(0, MAX_FACTS_IN_PROMPT);
  const patterns = experience.patterns().sort((a, b) => b.lastTick - a.lastTick).slice(0, MAX_PATTERNS_IN_PROMPT);
  const beliefs = thinking.beliefs('active');
  const calibrationByBelief = new Map((deps.calibration?.summaries() || []).map(s => [s.beliefId, s]));
  const payload = {
    task: 'recentFacts 是你亲身经历的事实（带ID），patterns 是按情境聚合的模式，currentBeliefs 是你此前写下的自我判断，calibration 是每条判断写下之后的现实对账记录（violated 表示判断写下后现实仍在反着发生）。请：1) 对照 calibration 与事实，对每条已有判断给出 verdict：仍成立 keep，不再成立或与现实冲突 drop；2) 若事实中存在值得长期记住、可被后续经历检验的规律，补充最多 3 条新判断：statement 不超过 100 字、必须引用 recentFacts 里的ID、confidence 0–1；如果判断是关于某个地点的回避或偏好，请填写 claim（kind: avoid|prefer，place），现实会持续对账。不要复述事实，不要空泛口号，判断要能指导以后的行动。只按 responseSchema 输出 JSON。',
    recentFacts: facts.map(f => ({ id: f.id, tick: f.tick, action: f.action, situation: f.situation, effect: f.effect })),
    patterns: patterns.map(p => ({ action: p.action, text: describePattern(p) })),
    currentBeliefs: beliefs.map(b => ({ id: b.id, statement: b.statement, confidence: b.confidence, claim: b.claim, ...(calibrationByBelief.get(b.id) ? { calibration: calibrationByBelief.get(b.id) } : {}) })),
    responseSchema,
  };
  const reply = await chat(model, {
    messages: [{ role: 'user', content: JSON.stringify(payload) }],
    format: responseSchema,
    think: model.name.startsWith('deepseek-r1') ? null : false,
    keepAlive: '5m',
    seed: model.seed,
  }, { fetcher: deps.fetcher, timeoutMs: deps.timeoutMs ?? model.timeoutMs, signal: deps.signal });
  const parsed = JSON.parse(reply.content) as { beliefs?: unknown; review?: unknown };
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.beliefs) || !Array.isArray(parsed.review)) throw new Error('思考复核输出缺少 beliefs 或 review 数组');

  thinking.syncFactIds(experience.facts().map(f => f.id));
  const verdicts: ReviewVerdict[] = parsed.review.map(v => v as ReviewVerdict);
  const reviewResult = thinking.review(verdicts);

  const maxActive = deps.maxActive ?? 20;
  const added: ThinkingBelief[] = [];
  let skipped = 0;
  for (const raw of parsed.beliefs.slice(0, MAX_NEW_BELIEFS)) {
    const activeCount = thinking.beliefs('active').length;
    if (activeCount >= maxActive) { skipped += 1; continue; }
    try {
      added.push(thinking.add(raw as { statement: string; basisFactIds: string[]; confidence: number }));
    } catch { skipped += 1; }
  }
  return { added, ...reviewResult, skipped };
}
