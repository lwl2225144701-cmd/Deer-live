import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BeliefClaim, BeliefInput, ReviewVerdict, SelfBelief, ThinkingBelief, ThinkingStatus } from './types.ts';

const VERSION = 1;
const MAX_BASIS = 50;

const clone = <T>(value: T): T => structuredClone(value);
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function statementOf(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error('判断文本必须是不超过 200 字符的非空字符串');
  return value.trim();
}

function confidenceOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error('判断置信度必须是 0–1 的数');
  return value;
}

function basisOf(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_BASIS) throw new Error(`判断必须基于 1–${MAX_BASIS} 条经验事实`);
  return value.map((id, index) => {
    if (typeof id !== 'string' || !id.trim() || id.length > 100) throw new Error(`basisFactIds[${index}] 必须是不超过 100 字符的非空字符串`);
    return id;
  });
}

function claimOf(value: unknown): BeliefClaim | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value) || (value.kind !== 'avoid' && value.kind !== 'prefer')) throw new Error('判断 claim 必须是 { kind: avoid|prefer, place }');
  if (typeof value.place !== 'string' || !value.place.trim() || value.place.length > 80) throw new Error('判断 claim.place 必须是不超过 80 字符的非空字符串');
  return { kind: value.kind, place: value.place };
}

function beliefOf(value: unknown): ThinkingBelief {
  if (!isObject(value)) throw new Error('自我判断必须是对象');
  if (value.source !== 'model') throw new Error('自我判断的 source 必须是 model，事实不得写入思考系统');
  const status: ThinkingStatus = value.status === 'retired' ? 'retired' : 'active';
  if (value.status !== status) throw new Error('判断 status 只能是 active 或 retired');
  for (const field of ['createdAt', 'updatedAt'] as const) {
    if (typeof value[field] !== 'string' || Number.isNaN(Date.parse(value[field] as string))) throw new Error(`判断 ${field} 必须是有效时间字符串`);
  }
  if (!Number.isSafeInteger(value.reviewCount) || (value.reviewCount as number) < 0) throw new Error('判断 reviewCount 必须是非负整数');
  return {
    id: String(value.id),
    statement: statementOf(value.statement),
    basisFactIds: basisOf(value.basisFactIds),
    confidence: confidenceOf(value.confidence),
    status,
    source: 'model',
    createdAt: String(value.createdAt),
    updatedAt: String(value.updatedAt),
    reviewCount: value.reviewCount as number,
    ...(claimOf(value.claim) ? { claim: claimOf(value.claim) } : {}),
  };
}

// 思考系统存储：自我判断的写入、去重、复核与持久化。
// 不记录事实，不调用模型；判断内容完全来自模型，系统只负责结构与约束。
export class ThinkingStore {
  private beliefList: ThinkingBelief[] = [];
  private knownFactIds: Set<string> = new Set();

  // 事实 ID 由经验系统同步进来；判断只能引用已知事实。
  syncFactIds(ids: string[]): void {
    this.knownFactIds = new Set(ids);
  }

  private assertBasisKnown(basisFactIds: string[]): void {
    for (const id of basisFactIds) {
      if (!this.knownFactIds.has(id)) throw new Error(`判断引用了未知的经验事实：${id}`);
    }
  }

  add(input: BeliefInput): ThinkingBelief {
    const statement = statementOf(input.statement);
    const basisFactIds = basisOf(input.basisFactIds);
    this.assertBasisKnown(basisFactIds);
    const confidence = confidenceOf(input.confidence);
    const now = new Date().toISOString();
    // 完全相同的判断文本：视为同一条判断的再次确认，更新证据与置信度，不产生重复。
    const existing = this.beliefList.find(b => b.statement === statement && b.status === 'active');
    if (existing) {
      existing.basisFactIds = [...new Set([...existing.basisFactIds, ...basisFactIds])].slice(0, MAX_BASIS);
      existing.confidence = confidence;
      existing.updatedAt = now;
      if (!existing.claim && input.claim) existing.claim = claimOf(input.claim);
      return clone(existing);
    }
    const belief: ThinkingBelief = {
      id: randomUUID(), statement, basisFactIds, confidence, status: 'active',
      source: 'model', createdAt: now, updatedAt: now, reviewCount: 0,
      ...(claimOf(input.claim) ? { claim: claimOf(input.claim) } : {}),
    };
    this.beliefList.push(belief);
    return clone(belief);
  }

  review(verdicts: ReviewVerdict[]): { kept: number; dropped: number; unknownIds: string[] } {
    if (!Array.isArray(verdicts)) throw new Error('复核结果必须是数组');
    let kept = 0;
    let dropped = 0;
    const unknownIds: string[] = [];
    const now = new Date().toISOString();
    for (const verdict of verdicts) {
      if (!isObject(verdict) || (verdict.verdict !== 'keep' && verdict.verdict !== 'drop')) throw new Error('复核结果必须是 { id, verdict: keep|drop }');
      const belief = this.beliefList.find(b => b.id === verdict.id);
      if (!belief) { unknownIds.push(String(verdict.id)); continue; }
      if (verdict.verdict === 'keep') {
        belief.reviewCount += 1;
        belief.updatedAt = now;
        kept += 1;
      } else {
        belief.status = 'retired';
        belief.updatedAt = now;
        dropped += 1;
      }
    }
    return { kept, dropped, unknownIds };
  }

  beliefs(status?: ThinkingStatus): ThinkingBelief[] {
    const list = status ? this.beliefList.filter(b => b.status === status) : this.beliefList;
    return clone(list);
  }

  // 进入提示词的自我信念：只取 active，按置信度和最近更新排序，截断到上限。
  selfBeliefs(limit: number): SelfBelief[] {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('selfBeliefs.limit 必须是非负整数');
    return this.beliefList
      .filter(b => b.status === 'active')
      .sort((a, b) => b.confidence - a.confidence || b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map(b => ({ statement: b.statement, confidence: b.confidence }));
  }

  clear(): void {
    this.beliefList = [];
    this.knownFactIds = new Set();
  }

  toJSON() {
    return { version: VERSION, beliefs: clone(this.beliefList) };
  }

  save(path: string): void {
    if (typeof path !== 'string' || !path.trim()) throw new Error('保存路径不能为空');
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.toJSON(), null, 2) + '\n');
    renameSync(temporary, path);
  }

  static load(path: string): ThinkingStore {
    if (!existsSync(path)) return new ThinkingStore();
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch (error) {
      throw new Error(`无法读取思考文件 ${path}：${error instanceof Error ? error.message : String(error)}`);
    }
    return ThinkingStore.fromJSON(raw);
  }

  static fromJSON(raw: unknown): ThinkingStore {
    if (!isObject(raw)) throw new Error('思考文件必须是对象');
    if (raw.version !== VERSION) throw new Error(`思考文件版本必须是 ${VERSION}`);
    if (!Array.isArray(raw.beliefs)) throw new Error('思考文件必须包含 beliefs 数组');
    const store = new ThinkingStore();
    store.beliefList = raw.beliefs.map(beliefOf);
    return store;
  }
}
