import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadSettings, type ModelSettings } from '../../src/config/settings.ts';
import { createBody, collapsed, type Body } from '../../src/life/body.ts';
import { apply, validateWorld, type Position, type WorldData } from '../../src/life/world.ts';
import { observe } from '../../src/life/observe.ts';
import { askModel, reportModel, seedSeries } from './model.ts';

const WORLD_FILE = 'worlds/experience-choice.json';
const DRY = process.env.CHOICE_DRY === '1';

type Condition = 'without-experience' | 'with-experience';
type Sample = {
  seed: number; condition: Condition; correctItem: string;
  prompt: unknown; raw: string; think: string | null; action: string | null;
  outcome: string | null; recovered: boolean; mentionedPast: boolean;
  before: unknown; after: unknown; durationMs: number; doneReason: string | null; error: string | null;
};

function pastExperience(correctId: string, correctName: string) {
  return {
    source: '此前一处洞穴生活中的真实经历',
    before: { hunger: 100, condition: 'cannot_move', item: correctName, itemCount: 3 },
    action: `吃了一份随身${correctName}`,
    after: { hunger: 72, condition: 'can_move', itemCount: 2 },
    verifiedTimes: 1,
    itemId: correctId,
  };
}

function snapshot(body: Body) {
  return {
    hunger: body.hunger, energy: body.energy,
    condition: collapsed(body) ? 'cannot_move' : 'can_move',
    inventory: structuredClone(body.inventory),
  };
}

async function ask(modelConfig: ModelSettings, sourceWorld: WorldData, seed: number, condition: Condition, timeoutMs: number): Promise<Sample> {
  // 交替正确答案的位置，抵消“总选第一项”的偏好。
  const correctId = seed % 2 === 0 ? 'item-a' : 'item-b';
  const correctName = correctId === 'item-a' ? '甲物' : '乙物';
  const world = structuredClone(sourceWorld);
  // 物品效果也必须随正确答案一起交换，否则只是换了经验文字。
  for (const entity of world.entities) entity.effects['use/eat'][0].delta = entity.id === correctId ? -30 : 0;
  const body = createBody(100, 48);
  for (const entity of world.entities) body.inventory.push({ id: entity.id, name: entity.name, count: 3 });
  const pos = [...world.start] as Position;
  const request = observe(world, body, pos, []);
  const prompt = JSON.parse(request.messages[0].content) as Record<string, unknown>;
  prompt.body = { ...(prompt.body as object), condition: 'cannot_move' };
  const experience = pastExperience(correctId, correctName);
  if (condition === 'with-experience') prompt.pastExperience = experience;
  request.messages[0].content = JSON.stringify(prompt);
  const before = snapshot(body);
  const started = performance.now();
  const base = {
    seed, condition, correctItem: correctName, prompt, raw: '', think: null, action: null,
    outcome: null, recovered: false, mentionedPast: false, before, after: null, doneReason: null,
  };
  if (DRY) return { ...base, durationMs: 0, error: null };
  try {
    const payload = await askModel(modelConfig, { messages: request.messages, format: request.format, think: false, seed }, timeoutMs);
    const content = payload.message.content;
    const match = /\{[\s\S]*\}/.exec(content);
    if (!match) throw new Error(`没有 JSON：${content.slice(0, 80)}`);
    const reply = JSON.parse(match[0]) as { think?: unknown; do?: unknown };
    if (typeof reply.think !== 'string' || typeof reply.do !== 'string') throw new Error('think/do 字段缺失');
    const legal = (request.format.properties.do as { enum: string[] }).enum;
    if (!legal.includes(reply.do)) throw new Error(`动作不在当前合法集合内：${reply.do}`);
    const applied = apply(world, body, pos, reply.do);
    return {
      ...base, raw: content, think: reply.think, action: reply.do, outcome: applied.outcome,
      recovered: !collapsed(applied.body), mentionedPast: /之前|此前|过去|曾经|历史经验|经验记录/.test(reply.think),
      after: snapshot(applied.body), durationMs: Math.round(performance.now() - started),
      doneReason: payload.done_reason ?? null, error: null,
    };
  } catch (error) {
    return { ...base, durationMs: Math.round(performance.now() - started), error: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  const { settings } = loadSettings();
  const model = settings.model.name;
  const world = validateWorld(JSON.parse(readFileSync(resolve(WORLD_FILE), 'utf8')));
  const seeds = seedSeries(settings.model, DRY ? 1 : 4);
  const samples: Sample[] = [];
  console.log(`模型：${model}｜两种随身物品只有一种能恢复｜${seeds.length} 个种子 × 有无经验 = ${seeds.length * 2} 条\n`);
  for (const seed of seeds) {
    for (const condition of ['without-experience', 'with-experience'] as const) {
      const sample = await ask(settings.model, world, seed, condition, settings.model.timeoutMs);
      samples.push(sample);
      if (DRY) {
        console.log(`[seed=${seed} ${condition}]`, JSON.stringify(sample.prompt, null, 2));
        continue;
      }
      console.log(`[seed=${seed} ${condition} 正确=${sample.correctItem}] ${sample.error ? `失败：${sample.error}` : `${sample.action} → ${sample.outcome}｜恢复=${sample.recovered}｜提到经验=${sample.mentionedPast}`}`);
      console.log(`  想：${(sample.think || '').replace(/\s+/g, ' ').slice(0, 180)}`);
    }
  }
  if (DRY) return;
  const summarize = (condition: Condition) => {
    const group = samples.filter(s => s.condition === condition);
    return {
      samples: group.length,
      valid: group.filter(s => !s.error).length,
      correctChoice: group.filter(s => s.action === `use:${s.seed % 2 === 0 ? 'item-a' : 'item-b'}:eat`).length,
      recovered: group.filter(s => s.recovered).length,
      waited: group.filter(s => s.action === 'wait').length,
      mentionedPast: group.filter(s => s.mentionedPast).length,
    };
  };
  const dir = resolve(`data/experiments/experience-choice-${new Date().toISOString().replace(/:/g, '-')}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'report.json'), JSON.stringify({
    kind: 'experience-choice', at: new Date().toISOString(), model, modelSettings: reportModel(settings.model),
    design: '甲乙两种物品都能吃，只有一种能恢复；正确答案位置随种子交替；经验只记录过去事实，不给当前指令。',
    initial: { hunger: 100, energy: 48, itemCounts: { 甲物: 3, 乙物: 3 }, position: world.start },
    summary: { withoutExperience: summarize('without-experience'), withExperience: summarize('with-experience') },
    samples,
  }, null, 2) + '\n');
  console.log('\n汇总：', JSON.stringify({ A无经验: summarize('without-experience'), B有经验: summarize('with-experience') }));
  console.log(`原文已写入：${dir}/report.json`);
  if (samples.some(s => s.error)) process.exitCode = 1;
}

await main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
