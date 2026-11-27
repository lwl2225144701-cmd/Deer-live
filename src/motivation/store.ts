import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BodyState, Desire, DesireInput, DesireMeasure, DesireStatus, DesireVerdict, SelfDesire } from './types.ts';

const VERSION = 1;
const MAX_TARGET = 100;

const clone = <T>(value: T): T => structuredClone(value);
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function statementOf(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 150) throw new Error('心愿文本必须是不超过 150 字符的非空字符串');
  return value.trim();
}

function priorityOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) throw new Error('心愿优先级必须是 0–100 的数');
  return value;
}

function measureOf(value: unknown): DesireMeasure {
  if (!isObject(value)) throw new Error('心愿度量必须是对象');
  if (value.kind === 'food') {
    if (!Number.isSafeInteger(value.target) || (value.target as number) < 1 || (value.target as number) > MAX_TARGET) throw new Error(`food 心愿的 target 必须是 1–${MAX_TARGET} 的整数`);
    return { kind: 'food', target: value.target as number };
  }
  if (value.kind === 'visit') {
    if (typeof value.place !== 'string' || !value.place.trim() || value.place.length > 80) throw new Error('visit 心愿的 place 必须是不超过 80 字符的非空字符串');
    if (value.target !== undefined && (!Number.isSafeInteger(value.target) || (value.target as number) < 1 || (value.target as number) > MAX_TARGET)) throw new Error(`visit 心愿的 target 必须是 1–${MAX_TARGET} 的整数`);
    return { kind: 'visit', place: value.place, ...(value.target === undefined ? {} : { target: value.target as number }) };
  }
  if (value.kind === 'explore') {
    if (!Number.isSafeInteger(value.count) || (value.count as number) < 1 || (value.count as number) > MAX_TARGET) throw new Error(`explore 心愿的 count 必须是 1–${MAX_TARGET} 的整数`);
    return { kind: 'explore', count: value.count as number };
  }
  throw new Error('心愿度量 kind 只能是 food、visit 或 explore');
}

function desireOf(value: unknown): Desire {
  if (!isObject(value)) throw new Error('心愿必须是对象');
  if (value.source !== 'model') throw new Error('心愿的 source 必须是 model');
  const status: DesireStatus = value.status === 'fulfilled' ? 'fulfilled' : value.status === 'abandoned' ? 'abandoned' : 'active';
  if (value.status !== status) throw new Error('心愿 status 只能是 active、fulfilled 或 abandoned');
  for (const field of ['createdAt', 'updatedAt'] as const) {
    if (typeof value[field] !== 'string' || Number.isNaN(Date.parse(value[field] as string))) throw new Error(`心愿 ${field} 必须是有效时间`);
  }
  if (!Number.isSafeInteger(value.createdAtTick) || (value.createdAtTick as number) < 0) throw new Error('心愿 createdAtTick 必须是非负整数');
  if (!isObject(value.baselineVisits) || Object.values(value.baselineVisits).some(v => !Number.isSafeInteger(v) || (v as number) < 0)) throw new Error('心愿 baselineVisits 无效');
  if (!Number.isSafeInteger(value.baselineExplores) || (value.baselineExplores as number) < 0) throw new Error('心愿 baselineExplores 必须是非负整数');
  if (!Number.isSafeInteger(value.reviewCount) || (value.reviewCount as number) < 0) throw new Error('心愿 reviewCount 必须是非负整数');
  if (typeof value.progress !== 'number' || !Number.isFinite(value.progress) || value.progress < 0 || value.progress > 100) throw new Error('心愿 progress 必须是 0–100 的数');
  if (status === 'fulfilled' && (!Number.isSafeInteger(value.fulfilledAtTick) || (value.fulfilledAtTick as number) < 0)) throw new Error('已实现的心愿必须有 fulfilledAtTick');
  return {
    id: String(value.id),
    statement: statementOf(value.statement),
    measure: measureOf(value.measure),
    priority: priorityOf(value.priority),
    status, source: 'model',
    createdAt: String(value.createdAt), createdAtTick: value.createdAtTick as number,
    updatedAt: String(value.updatedAt),
    baselineVisits: value.baselineVisits as Record<string, number>,
    baselineExplores: value.baselineExplores as number,
    reviewCount: value.reviewCount as number,
    progress: value.progress as number,
    ...(status === 'fulfilled' ? { fulfilledAtTick: value.fulfilledAtTick as number } : {}),
  };
}

export type UpdateContext = { tick: number; body: BodyState; visits: Record<string, number>; exploreCount: number };

// 动机系统存储：心愿的写入、去重、进度核算、复核与持久化。
// 进度完全由现实数据计算（随身食物 / 到访次数 / 探索次数），不经模型。
// 达成即转为 fulfilled 并留档——它实现过什么愿望，是它自己的历史。
export class MotivationStore {
  private desireList: Desire[] = [];

  add(input: DesireInput, context: UpdateContext): Desire {
    const statement = statementOf(input.statement);
    const measure = measureOf(input.measure);
    const priority = priorityOf(input.priority);
    const now = new Date().toISOString();
    const existing = this.desireList.find(d => d.statement === statement && d.status === 'active');
    if (existing) {
      existing.measure = measure;
      existing.priority = priority;
      existing.updatedAt = now;
      return clone(existing);
    }
    const desire: Desire = {
      id: randomUUID(), statement, measure, priority, status: 'active', source: 'model',
      createdAt: now, createdAtTick: context.tick, updatedAt: now,
      baselineVisits: clone(context.visits), baselineExplores: context.exploreCount,
      reviewCount: 0, progress: 0,
    };
    this.desireList.push(desire);
    return clone(desire);
  }

  // 每步核算进度：心愿写下之后现实里发生了什么。
  update(context: UpdateContext): Desire[] {
    if (!Number.isSafeInteger(context.tick) || context.tick < 0) throw new Error('motivation tick 必须是非负整数');
    const changed: Desire[] = [];
    const now = new Date().toISOString();
    for (const desire of this.desireList) {
      if (desire.status !== 'active') continue;
      const progress = this.progressOf(desire, context);
      if (progress !== desire.progress) {
        desire.progress = progress;
        desire.updatedAt = now;
        changed.push(desire);
      }
      if (progress >= 100) {
        desire.status = 'fulfilled';
        desire.fulfilledAtTick = context.tick;
        desire.updatedAt = now;
        changed.push(desire);
      }
    }
    return changed;
  }

  private progressOf(desire: Desire, context: UpdateContext): number {
    const measure = desire.measure;
    if (measure.kind === 'food') return Math.min(100, Math.round((context.body.food / measure.target) * 100));
    if (measure.kind === 'explore') {
      const gained = Math.max(0, context.exploreCount - desire.baselineExplores);
      return Math.min(100, Math.round((gained / measure.count) * 100));
    }
    const gained = Math.max(0, (context.visits[measure.place] || 0) - (desire.baselineVisits[measure.place] || 0));
    const target = measure.target ?? 1;
    return Math.min(100, Math.round((gained / target) * 100));
  }

  review(verdicts: DesireVerdict[]): { kept: number; adjusted: number; dropped: number; unknownIds: string[] } {
    if (!Array.isArray(verdicts)) throw new Error('心愿复核结果必须是数组');
    let kept = 0, adjusted = 0, dropped = 0;
    const unknownIds: string[] = [];
    const now = new Date().toISOString();
    for (const verdict of verdicts) {
      if (!isObject(verdict) || !['keep', 'drop', 'adjust'].includes(verdict.verdict as string)) throw new Error('心愿复核必须是 { id, verdict: keep|drop|adjust }');
      const desire = this.desireList.find(d => d.id === verdict.id);
      if (!desire || desire.status !== 'active') { unknownIds.push(String(verdict.id)); continue; }
      if (verdict.verdict === 'drop') {
        desire.status = 'abandoned';
        desire.updatedAt = now;
        dropped += 1;
      } else if (verdict.verdict === 'adjust') {
        if (verdict.priority !== undefined) desire.priority = priorityOf(verdict.priority);
        desire.reviewCount += 1;
        desire.updatedAt = now;
        adjusted += 1;
      } else {
        desire.reviewCount += 1;
        desire.updatedAt = now;
        kept += 1;
      }
    }
    return { kept, adjusted, dropped, unknownIds };
  }

  desires(status?: DesireStatus): Desire[] {
    const list = status ? this.desireList.filter(d => d.status === status) : this.desireList;
    return clone(list);
  }

  selfDesires(limit: number): SelfDesire[] {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('selfDesires.limit 必须是非负整数');
    return this.desireList
      .filter(d => d.status === 'active')
      .sort((a, b) => b.priority - a.priority || b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map(d => ({ statement: d.statement, priority: d.priority, progress: d.progress }));
  }

  clear(): void {
    this.desireList = [];
  }

  toJSON() {
    return { version: VERSION, desires: clone(this.desireList) };
  }

  save(path: string): void {
    if (typeof path !== 'string' || !path.trim()) throw new Error('保存路径不能为空');
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.toJSON(), null, 2) + '\n');
    renameSync(temporary, path);
  }

  static load(path: string): MotivationStore {
    if (!existsSync(path)) return new MotivationStore();
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch (error) {
      throw new Error(`无法读取动机文件 ${path}：${error instanceof Error ? error.message : String(error)}`);
    }
    return MotivationStore.fromJSON(raw);
  }

  static fromJSON(raw: unknown): MotivationStore {
    if (!isObject(raw)) throw new Error('动机文件必须是对象');
    if (raw.version !== VERSION) throw new Error(`动机文件版本必须是 ${VERSION}`);
    if (!Array.isArray(raw.desires)) throw new Error('动机文件必须包含 desires 数组');
    const store = new MotivationStore();
    store.desireList = raw.desires.map(desireOf);
    return store;
  }
}
