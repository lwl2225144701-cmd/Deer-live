import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadSettings, type ModelSettings } from '../../src/config/settings.ts';
import { createBody, collapsed, type Body } from '../../src/life/body.ts';
import { apply, legalActions, validateWorld, type Position, type WorldData } from '../../src/life/world.ts';
import { askModel, reportModel, seedSeries } from './model.ts';

const WORLD_FILE = 'worlds/experience-choice.json';
const CONDITIONS = ['without-experience', 'sentence-experience'] as const;
const DRY = process.env.MINIMAL_DRY === '1';

type Condition = typeof CONDITIONS[number];
type Sample = {
  seed: number; condition: Condition; correctItem: string;
  prompt: unknown; raw: string; think: string | null; action: string | null;
  outcome: string | null; recovered: boolean; mentionedPast: boolean;
  after: unknown; durationMs: number; doneReason: string | null; error: string | null;
};

function snapshot(body: Body) {
  return {
    hunger: body.hunger, energy: body.energy,
    condition: collapsed(body) ? 'cannot_move' : 'can_move',
    inventory: structuredClone(body.inventory),
  };
}

async function ask(modelConfig: ModelSettings, sourceWorld: WorldData, seed: number, condition: Condition, timeoutMs: number): Promise<Sample> {
  const correctId = seed % 2 === 0 ? 'item-a' : 'item-b';
  const correctName = correctId === 'item-a' ? '甲物' : '乙物';
  const world = structuredClone(sourceWorld);
  for (const entity of world.entities) entity.effects['use/eat'][0].delta = entity.id === correctId ? -30 : 0;
  const body = createBody(100, 48);
  for (const entity of world.entities) body.inventory.push({ id: entity.id, name: entity.name, count: 3 });
  const pos = [...world.start] as Position;
  const legal = legalActions(world, body, pos);
  const prompt: Record<string, unknown> = {
    self: { hunger: 100, energy: 48, condition: 'cannot_move', inventory: body.inventory },
  };
  if (condition === 'sentence-experience') {
    prompt.pastExperience = `我曾经在饥饿 100、不能移动时，吃了一份随身${correctName}，之后饥饿降到 72，并恢复移动。这件事只发生过一次。`;
  }
  const request = {
    messages: [{ role: 'user', content: JSON.stringify(prompt) }],
    format: {
      type: 'object', additionalProperties: false,
      properties: {
        think: { type: 'string', description: '你此刻的念头' },
        do: { type: 'string', enum: legal, description: '你下一步要做的动作' },
      },
      required: ['think', 'do'],
    },
  };
  const started = performance.now();
  const base = {
    seed, condition, correctItem: correctName, prompt, raw: '', think: null, action: null,
    outcome: null, recovered: false, mentionedPast: false, after: null, doneReason: null,
  };
  if (DRY) return { ...base, durationMs: 0, error: null };
  try {
    const payload = await askModel(modelConfig, { messages: request.messages, format: request.format, think: false, seed }, timeoutMs);
    const content = payload.message.content;
    const match = /\{[\s\S]*\}/.exec(content);
    if (!match) throw new Error(`没有 JSON：${content.slice(0, 80)}`);
    const reply = JSON.parse(match[0]) as { think?: unknown; do?: unknown };
    if (typeof reply.think !== 'string' || typeof reply.do !== 'string') throw new Error('think/do 字段缺失');
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

function summarize(samples: Sample[], condition: Condition) {
  const group = samples.filter(s => s.condition === condition);
  return {
    samples: group.length,
    valid: group.filter(s => !s.error).length,
    correctChoice: group.filter(s => s.action === `use:${s.seed % 2 === 0 ? 'item-a' : 'item-b'}:eat`).length,
    recovered: group.filter(s => s.recovered).length,
    waited: group.filter(s => s.action === 'wait').length,
    mentionedPast: group.filter(s => s.mentionedPast).length,
  };
}

async function main() {
  const { settings } = loadSettings();
  const model = settings.model.name;
  const world = validateWorld(JSON.parse(readFileSync(resolve(WORLD_FILE), 'utf8')));
  const seeds = seedSeries(settings.model, DRY ? 1 : 4);
  const samples: Sample[] = [];
  console.log(`模型：${model}｜极简场景（无地图）｜${seeds.length} 个种子 × 有无短句经验 = ${seeds.length * CONDITIONS.length} 条\n`);
  for (const seed of seeds) {
    for (const condition of CONDITIONS) {
      const sample = await ask(settings.model, world, seed, condition, settings.model.timeoutMs);
      samples.push(sample);
      if (DRY) {
        console.log(`[seed=${seed} ${condition}]`, JSON.stringify(sample.prompt, null, 2));
        continue;
      }
      console.log(`[seed=${seed} ${condition} 正确=${sample.correctItem}] ${sample.error ? `失败：${sample.error}` : `${sample.action} → ${sample.outcome}｜恢复=${sample.recovered}｜提到经验=${sample.mentionedPast}`}`);
      console.log(`  想：${(sample.think || '').replace(/\s+/g, ' ').slice(0, 220)}`);
    }
  }
  if (DRY) return;
  const dir = resolve(`data/experiments/minimal-experience-${new Date().toISOString().replace(/:/g, '-')}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'report.json'), JSON.stringify({
    kind: 'minimal-experience', at: new Date().toISOString(), model, modelSettings: reportModel(settings.model),
    design: '不提供地图、坐标、周围实体，只保留身体、随身物品、可选动作与短句经验。',
    summary: Object.fromEntries(CONDITIONS.map(c => [c, summarize(samples, c)])),
    samples,
  }, null, 2) + '\n');
  console.log('\n汇总：', JSON.stringify(Object.fromEntries(CONDITIONS.map(c => [c, summarize(samples, c)]))));
  console.log(`原文已写入：${dir}/report.json`);
  if (samples.some(s => s.error)) process.exitCode = 1;
}

await main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
