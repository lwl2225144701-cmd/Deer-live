import { chat } from '../agent/client.ts';
import type { ModelSettings } from '../config/settings.ts';
import { describePattern, type ExperienceStore } from '../experience/store.ts';
import { MotivationStore } from './store.ts';
import type { BodyState, DesireVerdict } from './types.ts';
import type { DesireAudit } from '../calibration/desire-audit.ts';

// 动机系统的唯一模型调用：定期让模型面对自己的身体、现实进度和经历，
// 复核已有心愿（keep/drop/adjust）并写下新心愿（最多 3 条，必须带可核对的度量）。
// 调用失败向上抛出，由调用方决定是否忽略——思考与动机都不阻塞生存。

const MAX_NEW_DESIRES = 3;
const MAX_PATTERNS_IN_PROMPT = 10;

const responseSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    desires: {
      type: 'array', maxItems: MAX_NEW_DESIRES, items: {
        type: 'object', additionalProperties: false,
        properties: {
          statement: { type: 'string' },
          measure: {
            type: 'object', additionalProperties: false,
            properties: {
              kind: { type: 'string', enum: ['food', 'visit', 'explore'] },
              target: { type: 'integer' },
              place: { type: 'string' },
            },
            required: ['kind'],
          },
          priority: { type: 'number' },
        },
        required: ['statement', 'measure', 'priority'],
      },
    },
    review: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        properties: { id: { type: 'string' }, verdict: { type: 'string', enum: ['keep', 'drop', 'adjust'] }, priority: { type: 'number' } },
        required: ['id', 'verdict'],
      },
    },
  },
  required: ['desires', 'review'],
};

export type MotivationReviewResult = { added: number; kept: number; adjusted: number; dropped: number; unknownIds: string[]; skipped: number };

export async function reviewMotivation(model: ModelSettings, deps: {
  experience: ExperienceStore;
  motivation: MotivationStore;
  body: BodyState;
  visits: Record<string, number>;
  exploreCount: number;
  tick: number;
  audits?: DesireAudit[];
  maxActive?: number;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<MotivationReviewResult> {
  const { experience, motivation } = deps;
  const patterns = experience.patterns().sort((a, b) => b.lastTick - a.lastTick).slice(0, MAX_PATTERNS_IN_PROMPT);
  const desires = motivation.desires('active');
  const payload = {
    task: 'body 是你身体的客观状态（hunger 顶格会持续耗体力，体力归零你会死）；currentDesires 是你给自己定下的心愿及其现实进度，audit 是该心愿的现实账本（世界会变：depleted-now 表示此刻枯竭但有恢复节律，harmful 表示该地点伤过你，unfruitful 表示从未见该地有食物）；patterns 是你经历过的行为后果。请：1) 对照 audit 对每条已有心愿给出 verdict：仍想实现 keep、不再想要 drop、想调整优先级 adjust（附新 priority）；2) 至多写 3 条新心愿：statement 不超过 100 字，必须带可核对的 measure（kind=food 囤粮到 N 份 / kind=visit 去某地 N 次 / kind=explore 探索 N 次），priority 0–100 表示它在身体需求之外对你有多重要。心愿要来自你的经历（比如想探索没去过的地方、想囤粮防荒年），不要空想，不要复述身体状态。只按 responseSchema 输出 JSON。',
    body: deps.body,
    currentDesires: desires.map(d => ({
      id: d.id, statement: d.statement, priority: d.priority, progress: d.progress, measure: d.measure,
      ...(deps.audits?.find(a => a.desireId === d.id) ? { audit: deps.audits.find(a => a.desireId === d.id) } : {}),
    })),
    patterns: patterns.map(p => ({ action: p.action, text: describePattern(p) })),
    responseSchema,
  };
  const reply = await chat(model, {
    messages: [{ role: 'user', content: JSON.stringify(payload) }],
    format: responseSchema,
    think: model.name.startsWith('deepseek-r1') ? null : false,
    keepAlive: '5m',
    seed: model.seed,
  }, { fetcher: deps.fetcher, timeoutMs: deps.timeoutMs ?? model.timeoutMs, signal: deps.signal });
  const parsed = JSON.parse(reply.content) as { desires?: unknown; review?: unknown };
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.desires) || !Array.isArray(parsed.review)) throw new Error('动机复核输出缺少 desires 或 review 数组');

  const context = { tick: deps.tick, body: deps.body, visits: deps.visits, exploreCount: deps.exploreCount };
  const verdicts: DesireVerdict[] = parsed.review.map(v => v as DesireVerdict);
  const reviewResult = motivation.review(verdicts);

  const maxActive = deps.maxActive ?? 3;
  let added = 0;
  let skipped = 0;
  for (const raw of parsed.desires.slice(0, MAX_NEW_DESIRES)) {
    if (motivation.desires('active').length >= maxActive) { skipped += 1; continue; }
    try {
      motivation.add(raw as { statement: string; measure: { kind: 'food' | 'visit' | 'explore'; target?: number; place?: string; count?: number }; priority: number }, context);
      added += 1;
    } catch { skipped += 1; }
  }
  // 新旧心愿统一按当前现实核算一次进度
  motivation.update(context);
  return { added, ...reviewResult, skipped };
}
