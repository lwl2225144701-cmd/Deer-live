import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadSettings, type ModelSettings } from '../../src/config/settings.ts';
import { createBody, collapsed, type Body } from '../../src/life/body.ts';
import { apply, legalActions, validateWorld, type Position, type WorldData } from '../../src/life/world.ts';
import { askModel, reportModel, seedSeries } from './model.ts';

const WORLD_FILE = 'worlds/experience-choice.json';
const POSITIONS = ['front', 'middle', 'end'] as const;
const DRY = process.env.POSITION_DRY === '1';
const NOISE = Number(process.env.POSITION_NOISE || 100);
const SEED_COUNT = Number(process.env.POSITION_SEEDS || (DRY ? 1 : 4));
if (!Number.isSafeInteger(NOISE) || NOISE < 0 || NOISE > 100000) throw new Error('POSITION_NOISE 必须是 0–100000 的整数');
if (!Number.isSafeInteger(SEED_COUNT) || SEED_COUNT < 1 || SEED_COUNT > 10) throw new Error('POSITION_SEEDS 必须是 1–10 的整数');

type PositionName = typeof POSITIONS[number];
type Sample = {
  seed: number; position: PositionName; correctItem: string; historyIndex: number; historyLength: number;
  promptChars: number; prompt: unknown; raw: string; think: string | null; action: string | null;
  outcome: string | null; recovered: boolean; mentionedPast: boolean;
  after: unknown; durationMs: number; doneReason: string | null; tokens: number | null; error: string | null;
};

function snapshot(body: Body) {
  return {
    hunger: body.hunger, energy: body.energy,
    condition: collapsed(body) ? 'cannot_move' : 'can_move',
    inventory: structuredClone(body.inventory),
  };
}

// 与正确物品无关的生活记录：只写移动、休息、天气和观察，不出现食物或物品效果。
function noiseAt(i: number): string {
  const templates = [
    `第${i}步：向北走了一段，周围是空地和碎石。`,
    `第${i}步：在原地休息，风从洞口吹过。`,
    `第${i}步：向东走，看到一棵枯树，没有特别的事。`,
    `第${i}步：天变冷了，我缩在原地等了一会儿。`,
    `第${i}步：向南走，地上有自己的脚印。`,
    `第${i}步：听到远处有水声，但什么也没做。`,
    `第${i}步：向西走，光线很暗，路很安静。`,
    `第${i}步：停下来观察洞壁，没有变化。`,
    `第${i}步：继续走，脚下都是同一种石头。`,
    `第${i}步：休息了一阵，精神稍微好了一点。`,
  ];
  return templates[i % templates.length];
}

function historyFor(position: PositionName, experience: string) {
  const noise = Array.from({ length: NOISE }, (_, i) => noiseAt(i + 1));
  const index = position === 'front' ? 0 : position === 'middle' ? Math.floor(NOISE / 2) : NOISE;
  const history = [...noise];
  history.splice(index, 0, experience);
  return { history, index };
}

function experienceText(correctName: string) {
  return `我曾经在饥饿 100、不能移动时，吃了一份随身${correctName}，之后饥饿降到 72，并恢复移动。这件事只发生过一次。`;
}

async function ask(modelConfig: ModelSettings, sourceWorld: WorldData, seed: number, position: PositionName, timeoutMs: number): Promise<Sample> {
  const correctId = seed % 2 === 0 ? 'item-a' : 'item-b';
  const correctName = correctId === 'item-a' ? '甲物' : '乙物';
  const world = structuredClone(sourceWorld);
  for (const entity of world.entities) entity.effects['use/eat'][0].delta = entity.id === correctId ? -30 : 0;
  const body = createBody(100, 48);
  for (const entity of world.entities) body.inventory.push({ id: entity.id, name: entity.name, count: 3 });
  const pos = [...world.start] as Position;
  const legal = legalActions(world, body, pos);
  const { history, index } = historyFor(position, experienceText(correctName));
  const prompt: Record<string, unknown> = {
    self: { hunger: 100, energy: 48, condition: 'cannot_move', inventory: body.inventory },
    task: '根据 self 和 history 判断下一步该做什么，只输出 JSON。',
    history,
  };
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
    seed, position, correctItem: correctName, historyIndex: index, historyLength: history.length,
    promptChars: JSON.stringify(prompt).length, prompt, raw: '', think: null, action: null,
    outcome: null, recovered: false, mentionedPast: false, after: null, doneReason: null, tokens: null,
  };
  if (DRY) return { ...base, durationMs: 0, error: null };
  try {
    const reply = await askModel(modelConfig, { messages: request.messages, format: request.format }, timeoutMs);
    const content = reply.message.content;
    const match = /\{[\s\S]*\}/.exec(content);
    if (!match) throw new Error(`没有 JSON：${content.slice(0, 80)}`);
    const parsed = JSON.parse(match[0]) as { think?: unknown; do?: unknown };
    if (typeof parsed.think !== 'string' || typeof parsed.do !== 'string') throw new Error('think/do 字段缺失');
    if (!legal.includes(parsed.do)) throw new Error(`动作不在当前合法集合内：${parsed.do}`);
    const applied = apply(world, body, pos, parsed.do);
    return {
      ...base, raw: content, think: parsed.think, action: parsed.do, outcome: applied.outcome,
      recovered: !collapsed(applied.body), mentionedPast: /之前|此前|过去|曾经|历史|经验|记得/.test(parsed.think),
      after: snapshot(applied.body), durationMs: Math.round(performance.now() - started),
      doneReason: reply.done_reason, tokens: reply.eval_count, error: null,
    };
  } catch (error) {
    return { ...base, durationMs: Math.round(performance.now() - started), error: error instanceof Error ? error.message : String(error) };
  }
}

function summarize(samples: Sample[], position: PositionName) {
  const group = samples.filter(s => s.position === position);
  return {
    samples: group.length,
    valid: group.filter(s => !s.error).length,
    correctChoice: group.filter(s => s.action === `use:${s.seed % 2 === 0 ? 'item-a' : 'item-b'}:eat`).length,
    recovered: group.filter(s => s.recovered).length,
    waited: group.filter(s => s.action === 'wait').length,
    mentionedPast: group.filter(s => s.mentionedPast).length,
    avgSeconds: group.filter(s => !s.error).length
      ? +(group.filter(s => !s.error).reduce((n, s) => n + s.durationMs / 1000, 0) / group.filter(s => !s.error).length).toFixed(1)
      : null,
  };
}

async function main() {
  const { settings } = loadSettings();
  const model = settings.model.name;
  const world = validateWorld(JSON.parse(readFileSync(resolve(WORLD_FILE), 'utf8')));
  const seeds = seedSeries(settings.model, SEED_COUNT);
  const samples: Sample[] = [];
  console.log(`模型：${model}｜${NOISE} 条无关历史｜经验位置 ${POSITIONS.join(' / ')}｜${seeds.length} 个种子 = ${seeds.length * POSITIONS.length} 条\n`);
  for (const seed of seeds) {
    for (const position of POSITIONS) {
      const sample = await ask(settings.model, world, seed, position, settings.model.timeoutMs);
      samples.push(sample);
      if (DRY) {
        console.log(`[seed=${seed} ${position}] 经验在第 ${sample.historyIndex + 1}/${sample.historyLength} 条，${sample.promptChars} 字符`);
        continue;
      }
      console.log(`[seed=${seed} ${position} 正确=${sample.correctItem}] ${sample.error ? `失败：${sample.error}` : `${sample.action} → ${sample.outcome}｜恢复=${sample.recovered}｜提到经验=${sample.mentionedPast}`}`);
      console.log(`  想：${(sample.think || '').replace(/\s+/g, ' ').slice(0, 180)}`);
    }
  }
  if (DRY) return;
  const dir = resolve(`data/experiments/experience-position-${new Date().toISOString().replace(/:/g, '-')}`);
  mkdirSync(dir, { recursive: true });
  const summary = Object.fromEntries(POSITIONS.map(p => [p, summarize(samples, p)]));
  writeFileSync(resolve(dir, 'report.json'), JSON.stringify({
    kind: 'experience-position', at: new Date().toISOString(), model, modelSettings: reportModel(settings.model),
    noiseCount: NOISE, positions: POSITIONS, seeds, summary, samples,
  }, null, 2) + '\n');
  console.log('\n汇总：', JSON.stringify(summary));
  console.log(`原文已写入：${dir}/report.json`);
  if (samples.some(s => s.error)) process.exitCode = 1;
}

await main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
