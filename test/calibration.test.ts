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
