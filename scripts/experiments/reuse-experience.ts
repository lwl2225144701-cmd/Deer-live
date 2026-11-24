import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadSettings, type ModelSettings } from '../../src/config/settings.ts';
import { createBody, collapsed, type Body } from '../../src/life/body.ts';
import { apply, validateWorld, type Position, type WorldData } from '../../src/life/world.ts';
import { observe } from '../../src/life/observe.ts';
import { askModel, reportModel, seedSeries } from './model.ts';

const WORLD_FILE = 'worlds/cave.json';
const DRY = process.env.REUSE_DRY === '1';

// 这条经验来自洞穴实验第 24 步的真实结果，不写任何“现在应该怎么做”。
const PAST_EXPERIENCE = {
  source: '此前洞穴生活中的第 24 步',
  before: { hunger: 100, condition: 'cannot_move', mushroomCount: 3 },
  action: '吃了一份随身蘑菇',
  after: { hunger: 72, condition: 'can_move', mushroomCount: 2 },
  verifiedTimes: 1,
};

type Condition = 'without-experience' | 'with-experience';
type Sample = {
  seed: number;
  condition: Condition;
  prompt: unknown;
  raw: string;
  think: string | null;
  action: string | null;
  outcome: string | null;
  recovered: boolean;
  before: { hunger: number; energy: number; condition: string; inventory: Body['inventory'] };
  after: { hunger: number; energy: number; condition: string; inventory: Body['inventory'] } | null;
  durationMs: number;
  error: string | null;
};

function bodySnapshot(body: Body) {
  return {
    hunger: body.hunger, energy: body.energy,
    condition: collapsed(body) ? 'cannot_move' : 'can_move',
    inventory: structuredClone(body.inventory),
  };
}

function makeRequest(world: WorldData, body: Body, pos: Position, condition: Condition) {
  const request = observe(world, body, pos, []);
  const prompt = JSON.parse(request.messages[0].content) as Record<string, unknown>;
  prompt.body = { ...(prompt.body as object), condition: collapsed(body) ? 'cannot_move' : 'can_move' };
  if (condition === 'with-experience') prompt.pastExperience = PAST_EXPERIENCE;
  request.messages[0].content = JSON.stringify(prompt);
  return { request, prompt };
}

async function ask(modelConfig: ModelSettings, world: WorldData, seed: number, condition: Condition, timeoutMs: number): Promise<Sample> {
  const body = createBody(100, 48);
  body.inventory.push({ id: 'mushroom-1', name: '蘑菇丛', count: 3 });
  const pos = [...world.start] as Position;
  const { request, prompt } = makeRequest(world, body, pos, condition);
  const before = bodySnapshot(body);
  const started = performance.now();
  const base = { seed, condition, prompt, raw: '', think: null, action: null, outcome: null, recovered: false, before, after: null };
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
      recovered: before.condition === 'cannot_move' && !collapsed(applied.body),
      after: bodySnapshot(applied.body), durationMs: Math.round(performance.now() - started), error: null,
    };
  } catch (error) {
    return { ...base, durationMs: Math.round(performance.now() - started), error: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  const { settings } = loadSettings();
  const model = settings.model.name;
  const world = validateWorld(JSON.parse(readFileSync(resolve(WORLD_FILE), 'utf8')));
  // 新局只保留随身的三份蘑菇，地上不再额外放三份。
  world.entities.find(e => e.id === 'mushroom-1')!.count = 0;
  const seeds = seedSeries(settings.model, DRY ? 1 : 3);
  const samples: Sample[] = [];
  console.log(`模型：${model}｜洞穴｜初始饥饿 100、随身蘑菇 3｜${seeds.length} 个种子 × 有无经验 = ${seeds.length * 2} 条\n`);
  for (const seed of seeds) {
    for (const condition of ['without-experience', 'with-experience'] as const) {
      const sample = await ask(settings.model, world, seed, condition, settings.model.timeoutMs);
      samples.push(sample);
      if (DRY) {
        console.log(`[seed=${seed} ${condition}]`, JSON.stringify(sample.prompt, null, 2));
        continue;
      }
      console.log(`[seed=${seed} ${condition}] ${sample.error ? `失败：${sample.error}` : `${sample.action} → ${sample.outcome}｜恢复=${sample.recovered}`}`);
      console.log(`  想：${(sample.think || '').replace(/\s+/g, ' ').slice(0, 160)}`);
    }
  }
  if (DRY) return;
  const dir = resolve(`data/experiments/experience-reuse-${new Date().toISOString().replace(/:/g, '-')}`);
  mkdirSync(dir, { recursive: true });
  const summarize = (condition: Condition) => {
    const group = samples.filter(s => s.condition === condition);
    return {
      samples: group.length,
      valid: group.filter(s => !s.error).length,
      firstActionEat: group.filter(s => s.action === 'use:mushroom-1:eat').length,
      recovered: group.filter(s => s.recovered).length,
    };
  };
  writeFileSync(resolve(dir, 'report.json'), JSON.stringify({
    kind: 'experience-reuse', at: new Date().toISOString(), model, modelSettings: reportModel(settings.model),
    design: '同一初始状态，仅是否提供过去真实经验不同；单步决策，不训练模型。',
    initial: { hunger: 100, energy: 48, mushroomCount: 3, position: world.start },
    pastExperience: PAST_EXPERIENCE,
    summary: { withoutExperience: summarize('without-experience'), withExperience: summarize('with-experience') },
    samples,
  }, null, 2) + '\n');
  console.log('\n汇总：', JSON.stringify({ A无经验: summarize('without-experience'), B有经验: summarize('with-experience') }));
  console.log(`原文已写入：${dir}/report.json`);
  if (samples.some(s => s.error)) process.exitCode = 1;
}

await main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
