import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ExperienceFact } from '../experience/types.ts';
import type { ThinkingBelief } from '../thinking/types.ts';
import type { BeliefClaim, CalibrationRecord, CalibrationStatus } from './types.ts';
import type { DesireAudit } from './desire-audit.ts';

const AVOID_KEYWORDS = ['回避', '避开', '避免', '不要', '不宜', '远离', '绕开', '非必要不', '别在', '别去'];
const PREFER_KEYWORDS = ['优先', '值得', '应去', '前往', '先去', '稳定获得', '可稳定', '产出', '换到食物'];

// 机械提取 claim：判断文本只涉及一个已知地点、且回避/偏好语气明确时，
// 系统替它登记可校验的声明。提取是确定性的，来源标记为 derived。
function deriveClaim(statement: string, placeNames: string[]): BeliefClaim | undefined {
  const matched = placeNames.filter(p => statement.includes(p));
  if (matched.length !== 1) return undefined;
  const avoid = AVOID_KEYWORDS.some(k => statement.includes(k));
  const prefer = PREFER_KEYWORDS.some(k => statement.includes(k));
  if (avoid === prefer) return undefined;
  return { kind: avoid ? 'avoid' : 'prefer', place: matched[0] };
}

const VERSION = 2;

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function recordOf(value: unknown): CalibrationRecord {
  if (!isObject(value)) throw new Error('校准记录必须是对象');
  const claim = value.claim as BeliefClaim;
  if (!claim || (claim.kind !== 'avoid' && claim.kind !== 'prefer') || typeof claim.place !== 'string') throw new Error('校准记录缺少有效 claim');
  const status: CalibrationStatus = value.status === 'violated' ? 'violated' : value.status === 'consistent' ? 'consistent' : 'untested';
  if (value.status !== status) throw new Error('校准 status 只能是 untested、consistent 或 violated');
  for (const field of ['sinceTick', 'lastCheckedTick', 'visitsSince', 'hazardDamageEventsSince', 'emptyExploresSince', 'foodGainsSince'] as const) {
    if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0) throw new Error(`校准记录 ${field} 必须是非负整数`);
  }
  if (typeof value.updatedAt !== 'string' || Number.isNaN(Date.parse(value.updatedAt))) throw new Error('校准记录 updatedAt 必须是有效时间');
  const claimSource = value.claimSource === 'derived' ? 'derived' : 'model';
  return {
    beliefId: String(value.beliefId), statement: String(value.statement), claim, claimSource,
    status, sinceTick: value.sinceTick as number, lastCheckedTick: value.lastCheckedTick as number,
    visitsSince: value.visitsSince as number, hazardDamageEventsSince: value.hazardDamageEventsSince as number,
    emptyExploresSince: value.emptyExploresSince as number, foodGainsSince: value.foodGainsSince as number,
    updatedAt: value.updatedAt,
  };
}

// 判定一条事实在该地点是否构成与 claim 相反的证据（纯机械规则，不调用模型）：
// - 危害损失（结果文本带“危险”）；
// - 空手探索（explore 却没有找到食物）。
function isBadEvent(fact: ExperienceFact, outcome: string): boolean {
  return outcome.includes('危险') || (fact.action === 'explore' && fact.effect.foodDelta <= 0);
}

// 校准系统：把自我判断与其写下之后的实际遭遇对账。
// avoid：该地点出现危害损失或空手探索 = 言行不一；
// prefer：该地点拿到食物 = 得到确认，空手探索 = 未能确认。
function auditOf(value: unknown): DesireAudit {
  if (!isObject(value)) throw new Error('心愿账本条目必须是对象');
  if (typeof value.desireId !== 'string' || !value.desireId.trim()) throw new Error('心愿账本缺少 desireId');
  const verdicts = ['productive', 'harmful', 'unfruitful', 'depleted-now', 'unknown'];
  if (!verdicts.includes(value.verdict as string)) throw new Error('心愿账本 verdict 非法');
  return structuredClone(value) as unknown as DesireAudit;
}

export class CalibrationStore {
  private recordList: CalibrationRecord[] = [];
  private auditList: DesireAudit[] = [];

  update(thinking: { beliefs(status: 'active'): ThinkingBelief[] }, experience: { facts(): ExperienceFact[] }, tick: number, options: { placeNames?: string[] } = {}): CalibrationRecord[] {
    if (!Number.isSafeInteger(tick) || tick < 0) throw new Error('校准 tick 必须是非负整数');
    const facts = experience.facts();
    const changed: CalibrationRecord[] = [];
    const now = new Date().toISOString();
    for (const belief of thinking.beliefs('active')) {
      // claim 来源：模型显式声明优先；否则按文本与已知地点机械提取
      const claim = belief.claim ?? deriveClaim(belief.statement, options.placeNames || []);
      if (!claim) continue;
      const claimSource = belief.claim ? 'model' : 'derived';
      let record = this.recordList.find(r => r.beliefId === belief.id);
      if (!record) {
        record = { beliefId: belief.id, statement: belief.statement, claim, claimSource, status: 'untested', sinceTick: tick, lastCheckedTick: tick, visitsSince: 0, hazardDamageEventsSince: 0, emptyExploresSince: 0, foodGainsSince: 0, updatedAt: now };
        this.recordList.push(record);
        continue; // 首次登记只建立基线，从下一步开始对账
      }
      if (!record.claim && belief.claim) { record.claim = belief.claim; record.claimSource = 'model'; }
      const relevant = facts.filter(f => f.tick > record!.lastCheckedTick && f.tick <= tick && f.situation.place === record!.claim.place);
      if (relevant.length === 0) continue;
      record.visitsSince += relevant.length;
      for (const fact of relevant) {
        const bad = isBadEvent(fact, fact.effect.outcome);
        if (fact.effect.foodDelta > 0) record.foodGainsSince += 1;
        if (bad && fact.effect.hungerDelta > 0) record.hazardDamageEventsSince += 1;
        if (bad && fact.action === 'explore' && fact.effect.foodDelta <= 0) record.emptyExploresSince += 1;
      }
      if (record.claim.kind === 'avoid') {
        record.status = (record.hazardDamageEventsSince > 0 || record.emptyExploresSince > 0) ? 'violated' : 'consistent';
      } else {
        record.status = record.foodGainsSince > 0 ? 'consistent' : (record.emptyExploresSince > 0 ? 'violated' : 'untested');
      }
      record.lastCheckedTick = tick;
      record.updatedAt = now;
      changed.push(record);
    }
    return changed;
  }

  records(): CalibrationRecord[] {
    return structuredClone(this.recordList);
  }

  // 给思考复核用的摘要：只有与判断相关的对照结果
  summaries(): { beliefId: string; status: CalibrationStatus; claim: BeliefClaim; claimSource?: 'model' | 'derived'; visitsSince: number; hazardDamageEventsSince: number; emptyExploresSince: number; foodGainsSince: number }[] {
    return this.recordList.map(r => ({ beliefId: r.beliefId, status: r.status, claim: r.claim, claimSource: r.claimSource, visitsSince: r.visitsSince, hazardDamageEventsSince: r.hazardDamageEventsSince, emptyExploresSince: r.emptyExploresSince, foodGainsSince: r.foodGainsSince }));
  }

  // 心愿账本：每步按当前世界状态重算，覆盖旧记录（判定会随世界变化翻转）
  setDesireAudits(audits: DesireAudit[]): void {
    if (!Array.isArray(audits)) throw new Error('心愿账本必须是数组');
    this.auditList = structuredClone(audits);
  }

  desireAudits(): DesireAudit[] {
    return structuredClone(this.auditList);
  }

  auditOf(desireId: string): DesireAudit | undefined {
    const found = this.auditList.find(a => a.desireId === desireId);
    return found ? structuredClone(found) : undefined;
  }

  clear(): void {
    this.recordList = [];
    this.auditList = [];
  }

  toJSON() {
    return { version: VERSION, records: structuredClone(this.recordList), desireAudits: structuredClone(this.auditList) };
  }

  save(path: string): void {
    if (typeof path !== 'string' || !path.trim()) throw new Error('保存路径不能为空');
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.toJSON(), null, 2) + '\n');
    renameSync(temporary, path);
  }

  static load(path: string): CalibrationStore {
    if (!existsSync(path)) return new CalibrationStore();
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch (error) {
      throw new Error(`无法读取校准文件 ${path}：${error instanceof Error ? error.message : String(error)}`);
    }
    return CalibrationStore.fromJSON(raw);
  }

  static fromJSON(raw: unknown): CalibrationStore {
    if (!isObject(raw)) throw new Error('校准文件必须是对象');
    // 版本 1 = 只有信念对账；版本 2 增加心愿账本。旧文件按空账本迁移。
    if (raw.version !== 1 && raw.version !== VERSION) throw new Error(`校准文件版本必须是 1 或 ${VERSION}`);
    if (!Array.isArray(raw.records)) throw new Error('校准文件必须包含 records 数组');
    const store = new CalibrationStore();
    store.recordList = raw.records.map(recordOf);
    if (raw.version === VERSION) {
      if (raw.desireAudits !== undefined && !Array.isArray(raw.desireAudits)) throw new Error('校准文件的 desireAudits 必须是数组');
      store.auditList = (raw.desireAudits as DesireAudit[] | undefined)?.map(auditOf) ?? [];
    }
    return store;
  }
}
