import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CalibrationStore } from '../src/calibration/store.ts';
import { DEFAULT_SETTINGS } from '../src/config/settings.ts';
import { ThinkingStore } from '../src/thinking/store.ts';
import { ExperienceStore } from '../src/experience/store.ts';

function fact(tick: number, place: string, action: string, effect: { hungerDelta?: number; energyDelta?: number; foodDelta?: number; outcome: string }) {
  return {
    tick, action,
    situation: { hunger: 40, energy: 60, condition: 'can_move' as const, place },
    effect: { hungerDelta: effect.hungerDelta ?? 2, energyDelta: effect.energyDelta ?? -3, foodDelta: effect.foodDelta ?? 0, conditionAfter: 'can_move' as const, outcome: effect.outcome },
  };
}

function setup() {
  const experience = new ExperienceStore();
  const thinking = new ThinkingStore();
  thinking.syncFactIds(experience.facts().map(f => f.id));
  return { experience, thinking };
}

test('校准：avoid 判断写下后仍在危害地点受伤 → violated', () => {
  const { experience, thinking } = setup();
  const thinking2 = thinking;
  const calibration = new CalibrationStore();
  // 第 5 步：模型写下“避开雾泽”
  const fact1 = experience.record(fact(5, '雾泽', 'move:south', { hungerDelta: 12, energyDelta: -9, outcome: '移动到 (6, 2)（雾泽的危险在消耗身体：饥饿+10，精力-6）' }));
  thinking2.syncFactIds([fact1.id]);
  const belief = thinking2.add({ statement: '避开雾泽', basisFactIds: [fact1.id], confidence: 0.8, claim: { kind: 'avoid', place: '雾泽' } });
  // 建立基线
  calibration.update(thinking2, experience, 5);
  assert.equal(calibration.records()[0].status, 'untested');
  // 第 6-7 步：又在雾泽受伤
  experience.record(fact(6, '雾泽', 'rest', { hungerDelta: 12, energyDelta: 9, outcome: '休息并恢复精力（雾泽的危险在消耗身体：饥饿+10，精力-6）' }));
  calibration.update(thinking2, experience, 7);
  const record = calibration.records()[0];
  assert.equal(record.status, 'violated');
  assert.equal(record.visitsSince, 1);
  assert.equal(record.hazardDamageEventsSince, 1);
  // 之后不再受伤：violation 是累计事实，不会自动洗白——恢复须经模型复核 drop/keep
  calibration.update(thinking2, experience, 8);
  assert.equal(calibration.records()[0].status, 'violated');
});

test('校准：prefer 判断在拿到食物时确认、空手探索时违反', () => {
  const { experience, thinking } = setup();
  const calibration = new CalibrationStore();
  const fact1 = experience.record(fact(3, '蜜果园', 'explore', { foodDelta: 1, outcome: '在蜜果园找到一份食物，还剩 2 份' }));
  thinking.syncFactIds([fact1.id]);
  thinking.add({ statement: '优先去蜜果园', basisFactIds: [fact1.id], confidence: 0.8, claim: { kind: 'prefer', place: '蜜果园' } });
  calibration.update(thinking, experience, 3);
  experience.record(fact(4, '蜜果园', 'explore', { foodDelta: 1, outcome: '在蜜果园找到一份食物，还剩 1 份' }));
  calibration.update(thinking, experience, 4);
  assert.equal(calibration.records()[0].status, 'consistent');
  assert.equal(calibration.records()[0].foodGainsSince, 1);
  experience.record(fact(5, '蜜果园', 'explore', { foodDelta: 0, outcome: '探索蜜果园，没有找到食物' }));
  calibration.update(thinking, experience, 5);
  const record = calibration.records()[0];
  assert.equal(record.status, 'consistent'); // 曾被确认过，累计事实不变
  assert.equal(record.emptyExploresSince, 1); // 但空手探索也留在记录里，供模型复核参考
});

test('校准：没有 claim 的判断不参与对账；文件可持久化', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deerlive-calibration-'));
  try {
    const { experience, thinking } = setup();
    const calibration = new CalibrationStore();
    const fact1 = experience.record(fact(1, '草地', 'rest', { outcome: '休息并恢复精力' }));
    thinking.syncFactIds([fact1.id]);
    thinking.add({ statement: '精力低就休息', basisFactIds: [fact1.id], confidence: 0.7 });
    calibration.update(thinking, experience, 1);
    assert.equal(calibration.records().length, 0);
    // 持久化往返
    const withClaim = experience.record(fact(2, '雾泽', 'explore', { hungerDelta: 12, outcome: '探索雾泽（雾泽的危险在消耗身体：饥饿+10，精力-6）' }));
    thinking.syncFactIds([fact1.id, withClaim.id]);
    thinking.add({ statement: '避开雾泽', basisFactIds: [withClaim.id], confidence: 0.8, claim: { kind: 'avoid', place: '雾泽' } });
    calibration.update(thinking, experience, 2);
    const path = join(dir, 'calibration.json');
    calibration.save(path);
    const loaded = CalibrationStore.load(path);
    assert.equal(loaded.records().length, 1);
    assert.equal(loaded.records()[0].claim.place, '雾泽');
    // 损坏文件被拒绝
    writeFileSync(path, '{"version":9}');
    assert.throws(() => CalibrationStore.load(path), /版本/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('思考复核提示词携带校准记录', async () => {
  const { experience, thinking } = setup();
  const calibration = new CalibrationStore();
  const fact1 = experience.record(fact(5, '雾泽', 'move:south', { hungerDelta: 12, energyDelta: -9, outcome: '移动（雾泽的危险在消耗身体：饥饿+10，精力-6）' }));
  thinking.syncFactIds([fact1.id]);
  thinking.add({ statement: '避开雾泽', basisFactIds: [fact1.id], confidence: 0.8, claim: { kind: 'avoid', place: '雾泽' } });
  calibration.update(thinking, experience, 5);
  experience.record(fact(6, '雾泽', 'rest', { hungerDelta: 12, energyDelta: 9, outcome: '休息（雾泽的危险在消耗身体：饥饿+10，精力-6）' }));
  calibration.update(thinking, experience, 6);
  const requests: any[] = [];
  const fetcher = (async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(init.body as string));
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ beliefs: [], review: [] }) } }] }));
  }) as typeof fetch;
  const { reviewThinking } = await import('../src/thinking/generate.ts');
  const model = { ...DEFAULT_SETTINGS.model, provider: 'openai-compatible' as const, baseUrl: 'https://api.example.com', apiKey: 'test' };
  await reviewThinking(model, { experience, thinking, calibration, fetcher, timeoutMs: 5000 });
  const payload = JSON.parse(requests[0].messages[0].content);
  const entry = payload.currentBeliefs.find((b: any) => b.statement === '避开雾泽');
  assert.ok(entry.calibration, '复核提示应包含校准记录');
  assert.equal(entry.calibration.status, 'violated');
  assert.equal(entry.calibration.hazardDamageEventsSince, 1);
  assert.match(payload.task, /现实对账/);
});


test('机械提取：文本涉及单一地点且有回避/偏好语气时自动登记 claim', () => {
  const { experience, thinking } = setup();
  const calibration = new CalibrationStore();
  const fact1 = experience.record(fact(1, '雾泽', 'move:south', { hungerDelta: 12, energyDelta: -9, outcome: '移动（雾泽的危险在消耗身体：饥饿+10，精力-6）' }));
  const fact2 = experience.record(fact(2, '蜜果园', 'explore', { foodDelta: 1, outcome: '在蜜果园找到一份食物，还剩 2 份' }));
  thinking.syncFactIds([fact1.id, fact2.id]);
  thinking.add({ statement: '雾泽非必要不进入，穿越前先备足精力', basisFactIds: [fact1.id], confidence: 0.8 });
  thinking.add({ statement: '觅食时优先去蜜果园，那里稳定获得食物', basisFactIds: [fact2.id], confidence: 0.8 });
  // 涉及两个地点或语气不明 → 不提取
  thinking.add({ statement: '蜜果园和雾泽都值得注意', basisFactIds: [fact1.id, fact2.id], confidence: 0.6 });
  calibration.update(thinking, experience, 2, { placeNames: ['雾泽', '蜜果园', '草地'] });
  const records = calibration.records();
  assert.equal(records.length, 2);
  assert.deepEqual(records.find(r => r.statement.includes('雾泽'))!.claim, { kind: 'avoid', place: '雾泽' });
  assert.equal(records.find(r => r.statement.includes('雾泽'))!.claimSource, 'derived');
  assert.deepEqual(records.find(r => r.statement.includes('蜜果园'))!.claim, { kind: 'prefer', place: '蜜果园' });
  // 提取的 claim 也参与对账：之后在雾泽受伤 → violated
  experience.record(fact(3, '雾泽', 'rest', { hungerDelta: 12, energyDelta: 9, outcome: '休息（雾泽的危险在消耗身体：饥饿+10，精力-6）' }));
  calibration.update(thinking, experience, 3, { placeNames: ['雾泽', '蜜果园', '草地'] });
  assert.equal(calibration.records().find(r => r.statement.includes('雾泽'))!.status, 'violated');
});

// ── 心愿账本：动态判定 ────────────────────────────────────────────

import { auditDesire, auditDesires } from '../src/calibration/desire-audit.ts';
import { MotivationStore } from '../src/motivation/store.ts';

function desireAt(place: string, statement = `去${place}找食物`) {
  const motivation = new MotivationStore();
  return motivation.add(
    { statement, measure: { kind: 'visit', place }, priority: 70 },
    { tick: 1, body: { hunger: 30, energy: 80, food: 0, health: 100 }, visits: {}, exploreCount: 0 },
  );
}

test('心愿账本：枯竭判定会随世界恢复而翻转', () => {
  const desire = desireAt('蜜树');
  const facts: any[] = [];
  // 第 5 步观察：蜜树 1 份；第 20 步：0 份；第 32 步：又 1 份
  const obs = { '蜜树': [{ tick: 5, food: 1 }, { tick: 20, food: 0 }, { tick: 32, food: 1 }] };
  // 此刻第 22 步：刚变 0，已等 2 步，还没看到恢复 → depleted-now
  const early = auditDesire(desire, { tick: 22, observations: obs, facts });
  assert.equal(early.verdict, 'depleted-now');
  assert.equal(early.everHadFood, true);
  assert.equal(early.ticksWaiting, 2);
  // 同一份观察历史，此刻第 33 步：已观察到恢复 → 不再是 depleted
  const later = auditDesire(desire, { tick: 33, observations: obs, facts });
  assert.notEqual(later.verdict, 'depleted-now');
  assert.equal(later.lastFood, 1);
});

test('心愿账本：受伤地点判 harmful，从未有食物的地点判 unfruitful', () => {
  const hazardDesire = desireAt('雾泽东');
  const hazardFacts: any[] = [{
    id: 'f1', tick: 8, action: 'move:south',
    situation: { hunger: 40, energy: 60, condition: 'can_move', place: '雾泽东' },
    effect: { hungerDelta: 12, energyDelta: -8, foodDelta: 0, conditionAfter: 'can_move', outcome: '移动（雾泽东的危险在消耗身体：饥饿+12，精力-8）' },
    source: 'observed', recordedAt: new Date().toISOString(),
  }];
  const harmful = auditDesire(hazardDesire, { tick: 10, observations: { '雾泽东': [{ tick: 8, food: 0 }] }, facts: hazardFacts });
  assert.equal(harmful.verdict, 'harmful');
  assert.match(harmful.note, /伤害/);

  const grassDesire = desireAt('草地');
  const unfruitful = auditDesire(grassDesire, { tick: 10, observations: { '草地': [{ tick: 3, food: 0 }, { tick: 7, food: 0 }] }, facts: [] });
  assert.equal(unfruitful.verdict, 'unfruitful');
  assert.equal(unfruitful.everHadFood, false);
  assert.match(unfruitful.note, /从未见过该地点有食物/);
});

test('心愿账本：窗口内拿到食物判 productive，并记录代价', () => {
  const desire = desireAt('苹果树');
  const facts: any[] = [
    { id: 'f1', tick: 6, action: 'explore', situation: { hunger: 40, energy: 60, condition: 'can_move', place: '苹果树' }, effect: { hungerDelta: 3, energyDelta: -5, foodDelta: 1, conditionAfter: 'can_move', outcome: '在苹果树找到一份食物，还剩 2 份' }, source: 'observed', recordedAt: new Date().toISOString() },
    { id: 'f2', tick: 9, action: 'explore', situation: { hunger: 55, energy: 55, condition: 'can_move', place: '苹果树' }, effect: { hungerDelta: 3, energyDelta: -5, foodDelta: 1, conditionAfter: 'can_move', outcome: '在苹果树找到一份食物，还剩 1 份' }, source: 'observed', recordedAt: new Date().toISOString() },
  ];
  const audit = auditDesire(desire, { tick: 12, observations: { '苹果树': [{ tick: 6, food: 2 }, { tick: 9, food: 1 }] }, facts });
  assert.equal(audit.verdict, 'productive');
  assert.equal(audit.foodGained, 2);
  assert.equal(audit.windowTicks, 11);
  assert.match(audit.note, /得食物 2 份/);
});

test('心愿账本：补充节律从中位数推断，无地点心愿只报代价', () => {
  const desire = desireAt('浆果丛');
  // 观察序列：0→1 间隔 10，1→0 后 0→1 间隔 20 → 中位数 15
  const obs = { '浆果丛': [{ tick: 2, food: 0 }, { tick: 12, food: 1 }, { tick: 20, food: 0 }, { tick: 40, food: 1 }] };
  const audit = auditDesire(desire, { tick: 41, observations: obs, facts: [] });
  assert.equal(audit.observedRefills, 2);
  assert.equal(audit.estimatedRefillEvery, 15);
  assert.match(audit.note, /约每 15 步一次/);
  // 无地点心愿（囤粮）：不判结构，只报窗口
  const motivation = new MotivationStore();
  const stock = motivation.add({ statement: '囤够 3 份', measure: { kind: 'food', target: 3 }, priority: 80 }, { tick: 1, body: { hunger: 30, energy: 80, food: 0, health: 100 }, visits: {}, exploreCount: 0 });
  const stockAudit = auditDesire(stock, { tick: 20, observations: {}, facts: [] });
  assert.equal(stockAudit.placeKnown, false);
  assert.equal(stockAudit.verdict, 'unknown');
  assert.match(stockAudit.note, /窗口 19 步/);
});

test('校准文件版本 1 自动迁移到版本 2（空心愿账本）', () => {
  const legacy = JSON.stringify({ version: 1, records: [] });
  const store = CalibrationStore.fromJSON(JSON.parse(legacy));
  assert.deepEqual(store.desireAudits(), []);
  store.setDesireAudits([{ desireId: 'd1', verdict: 'productive', note: 'x', measure: { kind: 'visit', place: '苹果树' } } as any]);
  assert.equal(store.auditOf('d1')?.verdict, 'productive');
  const roundTrip = CalibrationStore.fromJSON(JSON.parse(JSON.stringify(store.toJSON())));
  assert.equal(roundTrip.desireAudits().length, 1);
});
