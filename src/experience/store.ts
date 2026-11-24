import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  Condition, EffectVariant, ExperienceFact, ExperienceInput, ExperienceMatch, ExperiencePattern,
  Hypothesis, HypothesisInput, InventoryItem, ObservedEffect, Situation,
} from './types.ts';

const VERSION = 1;
const BUCKET = 25;

const clone = <T>(value: T): T => structuredClone(value);
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function integerIn(value: unknown, min: number, max: number, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${field} 必须是 ${min}–${max} 的整数`);
  return value as number;
}

function textIn(value: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (allowEmpty ? value.length > max : !value.trim() || value.length > max)) throw new Error(`${field} 必须是不超过 ${max} 字符的${allowEmpty ? '' : '非空'}字符串`);
  return value;
}

function dateText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || Number.isNaN(Date.parse(value))) throw new Error(`${field} 必须是有效时间字符串`);
  return value;
}

function conditionOf(value: unknown, field: string): Condition {
  if (value !== 'can_move' && value !== 'cannot_move') throw new Error(`${field} 必须是 can_move 或 cannot_move`);
  return value;
}

function inventoryOf(value: unknown, field: string): InventoryItem[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) throw new Error(`${field} 必须是不超过 50 项的数组`);
  return value.map((item, index) => {
    if (!isObject(item)) throw new Error(`${field}[${index}] 必须是对象`);
    return {
      id: textIn(item.id, `${field}[${index}].id`, 80),
      name: textIn(item.name, `${field}[${index}].name`, 80),
      count: integerIn(item.count, 0, 1000000, `${field}[${index}].count`),
    };
  });
}

function situationOf(value: unknown, field = 'situation'): Situation {
  if (!isObject(value)) throw new Error(`${field} 必须是对象`);
  return {
    hunger: integerIn(value.hunger, 0, 100, `${field}.hunger`),
    energy: integerIn(value.energy, 0, 100, `${field}.energy`),
    condition: conditionOf(value.condition, `${field}.condition`),
    ...(value.place === undefined ? {} : { place: textIn(value.place, `${field}.place`, 80, true) }),
    ...(value.inventory === undefined ? {} : { inventory: inventoryOf(value.inventory, `${field}.inventory`) }),
  };
}

function effectOf(value: unknown, field = 'effect'): ObservedEffect {
  if (!isObject(value)) throw new Error(`${field} 必须是对象`);
  return {
    hungerDelta: integerIn(value.hungerDelta, -100, 100, `${field}.hungerDelta`),
    energyDelta: integerIn(value.energyDelta, -100, 100, `${field}.energyDelta`),
    foodDelta: integerIn(value.foodDelta, -1000, 1000, `${field}.foodDelta`),
    conditionAfter: conditionOf(value.conditionAfter, `${field}.conditionAfter`),
    outcome: textIn(value.outcome, `${field}.outcome`, 300),
    ...(value.item === undefined ? {} : { item: textIn(value.item, `${field}.item`, 80) }),
  };
}

function factOf(value: unknown): ExperienceFact {
  if (!isObject(value)) throw new Error('经验事实必须是对象');
  if (value.source !== 'observed') throw new Error('经验事实的 source 必须是 observed，模型推测不得写入事实');
  return {
    id: textIn(value.id, 'fact.id', 100),
    tick: integerIn(value.tick, 0, 1000000000, 'fact.tick'),
    action: textIn(value.action, 'fact.action', 120),
    situation: situationOf(value.situation, 'fact.situation'),
    effect: effectOf(value.effect, 'fact.effect'),
    source: 'observed',
    recordedAt: dateText(value.recordedAt, 'fact.recordedAt'),
  };
}

function hypothesisOf(value: unknown): Hypothesis {
  if (!isObject(value)) throw new Error('假设必须是对象');
  if (value.source !== 'model') throw new Error('假设的 source 必须是 model，实际事实不得写入假设');
  const basisFactIds = value.basisFactIds;
  if (!Array.isArray(basisFactIds) || basisFactIds.length < 1 || basisFactIds.length > 50) throw new Error('hypothesis.basisFactIds 必须是 1–50 项数组');
  for (const [index, id] of basisFactIds.entries()) textIn(id, `hypothesis.basisFactIds[${index}]`, 100);
  const confidence = value.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('hypothesis.confidence 必须是 0–1 的数');
  return {
    id: textIn(value.id, 'hypothesis.id', 100),
    statement: textIn(value.statement, 'hypothesis.statement', 1000),
    basisFactIds: basisFactIds.map(String),
    confidence,
    source: 'model',
    createdAt: dateText(value.createdAt, 'hypothesis.createdAt'),
    updatedAt: dateText(value.updatedAt, 'hypothesis.updatedAt'),
  };
}

export function bucketOf(value: number): number {
  return Math.min(3, Math.floor(value / BUCKET));
}

export function situationKey(situation: Situation): string {
  const inventory = (situation.inventory || []).map(item => item.id).sort();
  return JSON.stringify([situation.condition, bucketOf(situation.hunger), bucketOf(situation.energy), situation.place || '', inventory]);
}

function effectKey(effect: ObservedEffect): string {
  return JSON.stringify([effect.conditionAfter, effect.hungerDelta, effect.energyDelta, effect.foodDelta]);
}

function sharedInventory(a?: InventoryItem[], b?: InventoryItem[]): number {
  if (!a || !b) return 0;
  const ids = new Set(a.map(item => item.id));
  return b.filter(item => ids.has(item.id)).length;
}

function scoreOf(pattern: ExperiencePattern, situation: Situation): number {
  const distance = (a: number, b: number) => Math.abs(bucketOf(a) - bucketOf(b));
  let score = 100 - distance(pattern.situation.hunger, situation.hunger) * 20 - distance(pattern.situation.energy, situation.energy) * 10;
  if (pattern.situation.place && situation.place && pattern.situation.place === situation.place) score += 10;
  score += Math.min(sharedInventory(pattern.situation.inventory, situation.inventory), 3) * 3;
  score += Math.min(pattern.total, 5) * 2;
  return score;
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

export function describePattern(pattern: ExperiencePattern): string {
  const condition = pattern.situation.condition === 'cannot_move' ? '不能移动' : '可以移动';
  const range = (value: number) => {
    const bucket = bucketOf(value);
    return `${bucket * BUCKET}–${bucket === 3 ? 100 : bucket * BUCKET + BUCKET - 1}`;
  };
  const place = pattern.situation.place ? `在${pattern.situation.place}，` : '';
  const variants = pattern.variants.map(variant => {
    const delta = [`饥饿${signed(variant.effect.hungerDelta)}`, `精力${signed(variant.effect.energyDelta)}`, `食物${signed(variant.effect.foodDelta)}`].join('，');
    const after = variant.effect.conditionAfter === 'cannot_move' ? '不能移动' : '可以移动';
    return `观察到 ${variant.count} 次（${delta}，之后${after}）`;
  }).join('；');
  return `${place}${condition}、饥饿 ${range(pattern.situation.hunger)}、精力 ${range(pattern.situation.energy)} 时，${pattern.action}：${variants}`;
}

function makeFact(input: ExperienceInput): ExperienceFact {
  return factOf({
    id: randomUUID(), tick: input.tick, action: input.action, situation: input.situation,
    effect: input.effect, source: 'observed', recordedAt: input.recordedAt ?? new Date().toISOString(),
  });
}

// 单独的经验系统：记录事实、按情境聚合、检索相似经历、持久化。
// 不调用模型，不解释因果；模型解释通过 addHypothesis 单独存放，检索永远不返回假设。
export class ExperienceStore {
  private factList: ExperienceFact[] = [];
  private hypothesisList: Hypothesis[] = [];

  record(input: ExperienceInput): ExperienceFact {
    const fact = makeFact(input);
    this.factList.push(fact);
    return clone(fact);
  }

  recordMany(inputs: ExperienceInput[]): ExperienceFact[] {
    if (!Array.isArray(inputs)) throw new Error('recordMany 需要经验输入数组');
    // 先整体校验再写入，避免批量导入中途失败留下半份记录。
    const facts = inputs.map(makeFact);
    this.factList.push(...facts);
    return facts.map(clone);
  }

  facts(): ExperienceFact[] {
    return clone(this.factList);
  }

  patterns(): ExperiencePattern[] {
    const groups = new Map<string, { action: string; situation: Situation; situationKey: string; variants: Map<string, EffectVariant>; total: number; firstTick: number; lastTick: number }>();
    for (const fact of this.factList) {
      const key = situationKey(fact.situation);
      const groupKey = `${fact.action}\u0000${key}`;
      let group = groups.get(groupKey);
      if (!group) {
        group = { action: fact.action, situation: clone(fact.situation), situationKey: key, variants: new Map(), total: 0, firstTick: fact.tick, lastTick: fact.tick };
        groups.set(groupKey, group);
      }
      const variantKey = effectKey(fact.effect);
      const variant = group.variants.get(variantKey);
      if (variant) {
        variant.count += 1;
        variant.firstTick = Math.min(variant.firstTick, fact.tick);
        variant.lastTick = Math.max(variant.lastTick, fact.tick);
        variant.factIds.push(fact.id);
      } else {
        group.variants.set(variantKey, { effect: clone(fact.effect), count: 1, firstTick: fact.tick, lastTick: fact.tick, factIds: [fact.id] });
      }
      group.total += 1;
      group.firstTick = Math.min(group.firstTick, fact.tick);
      group.lastTick = Math.max(group.lastTick, fact.tick);
    }
    return [...groups.values()]
      .map(group => ({
        action: group.action, situation: group.situation, situationKey: group.situationKey,
        variants: [...group.variants.values()].map(variant => clone(variant)),
        total: group.total, firstTick: group.firstTick, lastTick: group.lastTick,
      }))
      .sort((a, b) => b.lastTick - a.lastTick || a.action.localeCompare(b.action));
  }

  retrieve(situation: Situation, options: { action?: string; limit?: number; minObservations?: number } = {}): ExperienceMatch[] {
    const query = situationOf(situation, 'query');
    const limit = options.limit ?? 5;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('retrieve.limit 必须是 1–50 的整数');
    const minObservations = options.minObservations ?? 1;
    if (!Number.isSafeInteger(minObservations) || minObservations < 1) throw new Error('retrieve.minObservations 必须是正整数');
    if (options.action !== undefined) textIn(options.action, 'retrieve.action', 120);
    const matches = this.patterns()
      .filter(pattern => pattern.situation.condition === query.condition)
      .filter(pattern => options.action === undefined || pattern.action === options.action)
      .filter(pattern => pattern.total >= minObservations)
      .map(pattern => ({ pattern, score: scoreOf(pattern, query) }))
      .sort((a, b) => b.score - a.score || b.pattern.lastTick - a.pattern.lastTick || a.pattern.action.localeCompare(b.pattern.action));
    return matches.slice(0, limit).map(match => ({ pattern: clone(match.pattern), score: match.score }));
  }

  addHypothesis(input: HypothesisInput): Hypothesis {
    const statement = textIn(input.statement, 'hypothesis.statement', 1000);
    if (!Array.isArray(input.basisFactIds) || input.basisFactIds.length < 1 || input.basisFactIds.length > 50) throw new Error('假设必须基于 1–50 条已记录事实');
    const ids = new Set(this.factList.map(fact => fact.id));
    for (const id of input.basisFactIds) {
      textIn(id, 'hypothesis.basisFactIds', 100);
      if (!ids.has(id)) throw new Error(`假设引用了不存在的经验事实：${id}`);
    }
    if (typeof input.confidence !== 'number' || !Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) throw new Error('假设置信度必须是 0–1 的数');
    const now = new Date().toISOString();
    const hypothesis = hypothesisOf({
      id: randomUUID(), statement, basisFactIds: input.basisFactIds, confidence: input.confidence,
      source: 'model', createdAt: now, updatedAt: now,
    });
    this.hypothesisList.push(hypothesis);
    return clone(hypothesis);
  }

  hypotheses(): Hypothesis[] {
    return clone(this.hypothesisList);
  }

  clear(): void {
    this.factList = [];
    this.hypothesisList = [];
  }

  toJSON() {
    return { version: VERSION, facts: clone(this.factList), hypotheses: clone(this.hypothesisList) };
  }

  save(path: string): void {
    if (typeof path !== 'string' || !path.trim()) throw new Error('保存路径不能为空');
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.toJSON(), null, 2) + '\n');
    renameSync(temporary, path);
  }

  static load(path: string): ExperienceStore {
    if (!existsSync(path)) return new ExperienceStore();
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      throw new Error(`无法读取经验文件 ${path}：${error instanceof Error ? error.message : String(error)}`);
    }
    return ExperienceStore.fromJSON(raw);
  }

  static fromJSON(raw: unknown): ExperienceStore {
    if (!isObject(raw)) throw new Error('经验文件必须是对象');
    if (raw.version !== VERSION) throw new Error(`经验文件版本必须是 ${VERSION}`);
    if (!Array.isArray(raw.facts) || !Array.isArray(raw.hypotheses)) throw new Error('经验文件必须包含 facts 和 hypotheses 数组');
    const store = new ExperienceStore();
    store.factList = raw.facts.map(factOf);
    store.hypothesisList = raw.hypotheses.map(hypothesisOf);
    return store;
  }
}
