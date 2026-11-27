import type { ExperienceFact } from '../experience/types.ts';
import type { Desire, DesireMeasure } from '../motivation/types.ts';

// 心愿校准的账本：把"心愿主张什么"和"世界此刻实际如何"机械对账。
// 零模型调用。与信念校准的区别在于它是**动态的**——世界会枯竭、会恢复，
// 因此判定分三层：结构（有没有）、此刻（现在有没有）、节律（多久回来一次）。
// 所有信号都来自鹿自己的观察历史，不读世界配置。

export type DesireVerdict = 'productive' | 'harmful' | 'unfruitful' | 'depleted-now' | 'unknown';

export type DesireAudit = {
  desireId: string;
  measure: DesireMeasure;
  // 结构层：该地点是否被观察过、是否见过食物、是否受过伤
  placeKnown: boolean;
  everHadFood: boolean;
  hazardSeen: boolean;
  // 此刻层：最近一次观察到的存量与已等待步数
  lastFood: number | null;
  lastSeenTick: number | null;
  ticksWaiting: number | null;
  // 节律层：从观察序列推断的补充间隔（鹿自己算出来的）
  estimatedRefillEvery: number | null;
  observedRefills: number;
  // 代价层：心愿写下到现在的窗口账
  windowTicks: number;
  hungerCost: number;
  healthCost: number;
  hazardHits: number;
  foodGained: number;
  // 判定
  verdict: DesireVerdict;
  note: string;
};

export type AuditContext = {
  tick: number;
  observations: Record<string, { tick: number; food: number }[]>;
  facts: ExperienceFact[];
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// 从观察序列推断补充节律：取"食物增加"的相邻间隔中位数。
// 只有一次观察不足以推断节律，返回 null。
function refillCadence(timeline: { tick: number; food: number }[]): { every: number | null; count: number } {
  const intervals: number[] = [];
  for (let i = 1; i < timeline.length; i++) {
    if (timeline[i].food > timeline[i - 1].food) intervals.push(timeline[i].tick - timeline[i - 1].tick);
  }
  return { every: median(intervals), count: intervals.length };
}

function hazardFactsAt(facts: ExperienceFact[], place: string): number {
  return facts.filter(f => f.situation.place === place && f.effect.outcome.includes('危险')).length;
}

// 心愿的"目标地点"：visit 型直接给出；food/explore 型没有特定地点（返回 null）。
function placeOf(measure: DesireMeasure): string | null {
  return measure.kind === 'visit' ? measure.place : null;
}

export function auditDesire(desire: Desire, context: AuditContext): DesireAudit {
  const place = placeOf(desire.measure);
  const endTick = desire.fulfilledAtTick ?? context.tick;
  const windowFacts = context.facts.filter(f => f.tick > desire.createdAtTick && f.tick <= endTick);
  const windowTicks = Math.max(0, endTick - desire.createdAtTick);
  // 代价用"窗口内每步的饥饿增量累计"表示
  const hungerCostSum = windowFacts.reduce((sum, f) => sum + Math.max(0, f.effect.hungerDelta), 0);
  const healthLoss = windowFacts.reduce((sum, f) => {
    // 体力不在事实里，用饥饿顶格作为濒死信号
    return sum + (f.situation.hunger >= 100 ? 4 : 0);
  }, 0);
  const hazardHits = windowFacts.filter(f => f.effect.outcome.includes('危险')).length;
  const foodGained = windowFacts.reduce((sum, f) => sum + Math.max(0, f.effect.foodDelta), 0);

  if (!place) {
    // 无地点的心愿（囤粮 / 探索次数）：只报代价与收获，不做结构性判定
    const note = `窗口 ${windowTicks} 步：获得食物 ${foodGained} 份，饥饿 +${hungerCostSum}，受伤 ${hazardHits} 次`;
    return {
      desireId: desire.id, measure: desire.measure,
      placeKnown: false, everHadFood: foodGained > 0, hazardSeen: hazardHits > 0,
      lastFood: null, lastSeenTick: null, ticksWaiting: null,
      estimatedRefillEvery: null, observedRefills: 0,
      windowTicks, hungerCost: hungerCostSum, healthCost: healthLoss, hazardHits, foodGained,
      verdict: hazardHits > 0 ? 'harmful' : foodGained > 0 ? 'productive' : 'unknown',
      note,
    };
  }

  // 只使用此刻之前（含此刻）的观察：账本不能看见未来
  const timeline = (context.observations[place] || []).filter(o => o.tick <= context.tick);
  const placeFacts = context.facts.filter(f => f.situation.place === place);
  const everHadFood = timeline.some(o => o.food > 0) || placeFacts.some(f => f.effect.foodDelta > 0);
  const placeHazardHits = hazardFactsAt(context.facts, place);
  const lastObservation = timeline.at(-1);
  const { every, count } = refillCadence(timeline);
  const ticksWaiting = lastObservation && lastObservation.food === 0 && every !== null
    ? Math.max(0, context.tick - lastObservation.tick)
    : lastObservation && lastObservation.food === 0 ? Math.max(0, context.tick - lastObservation.tick) : null;

  let verdict: DesireVerdict;
  if (placeHazardHits > 0) verdict = 'harmful';
  else if (lastObservation && lastObservation.food === 0 && everHadFood) verdict = 'depleted-now';
  else if (!everHadFood && timeline.length > 0) verdict = 'unfruitful';
  else if (foodGained > 0) verdict = 'productive';
  else verdict = 'unknown';

  const parts: string[] = [];
  if (!timeline.length) parts.push('尚未观察过该地点');
  else {
    parts.push(`最近一次观察：${lastObservation!.food} 份（第 ${lastObservation!.tick} 步）`);
    if (ticksWaiting !== null) parts.push(`已等待 ${ticksWaiting} 步`);
    if (every !== null) parts.push(`观察到 ${count} 次补充，约每 ${every} 步一次`);
    else if (everHadFood) parts.push('尚未积累足够的补充观察');
    if (!everHadFood) parts.push('从未见过该地点有食物');
  }
  if (placeHazardHits > 0) parts.push(`该地点观察到 ${placeHazardHits} 次伤害`);
  parts.push(`追求窗口 ${windowTicks} 步：得食物 ${foodGained} 份、饥饿 +${hungerCostSum}、受伤 ${hazardHits} 次`);

  return {
    desireId: desire.id, measure: desire.measure,
    placeKnown: timeline.length > 0, everHadFood, hazardSeen: placeHazardHits > 0,
    lastFood: lastObservation?.food ?? null,
    lastSeenTick: lastObservation?.tick ?? null,
    ticksWaiting,
    estimatedRefillEvery: every, observedRefills: count,
    windowTicks, hungerCost: hungerCostSum, healthCost: healthLoss, hazardHits, foodGained,
    verdict, note: parts.join('；'),
  };
}

export function auditDesires(desires: Desire[], context: AuditContext): DesireAudit[] {
  return desires.map(desire => auditDesire(desire, context));
}