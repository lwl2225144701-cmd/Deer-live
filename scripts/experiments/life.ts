import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadSettings, type ModelSettings } from '../../src/config/settings.ts';
import { askModel, reportModel } from './model.ts';
import { createBody } from '../../src/life/body.ts';
import { apply, nameAt, validateWorld, type Outcome, type Position, type WorldData } from '../../src/life/world.ts';
import { observe } from '../../src/life/observe.ts';

const WORLD_FILE = process.env.LIFE_WORLD || 'worlds/cave.json';
const STEPS = Number(process.env.LIFE_STEPS || 15);
const THINK = process.env.LIFE_THINK === '1' ? true : process.env.LIFE_THINK === '0' ? false : null;
const HISTORY_LIMIT = Number(process.env.LIFE_HISTORY_LIMIT || 4);
if (!Number.isSafeInteger(HISTORY_LIMIT) || HISTORY_LIMIT < 1) throw new Error('LIFE_HISTORY_LIMIT 必须是正整数');

type Recorded = {
  step: number; prompt: unknown; raw: string; thinking: string | null; think: string | null;
  action: string | null; at: string; outcome: string; collapsed: boolean;
  body: { hunger: number; energy: number; inventory: { name: string; count: number }[] };
  position: Position; durationMs: number; error: string | null;
};

async function ask(prompt: unknown, format: unknown, timeoutMs: number, modelConfig: ModelSettings) {
  const started = performance.now();
  const body = await askModel(modelConfig, { messages: (prompt as { messages: unknown[] }).messages, format, think: THINK }, timeoutMs);
  const content = body.message.content;
  const match = /\{[\s\S]*\}/.exec(content);
  if (!match) throw new Error(`没有 JSON：${content.slice(0, 80)}`);
  const reply = JSON.parse(match[0]) as { think?: unknown; do?: unknown };
  if (typeof reply.think !== 'string' || typeof reply.do !== 'string') throw new Error('think/do 字段缺失');
  return { think: reply.think, do: reply.do, raw: content, thinking: body.message.thinking ?? null, durationMs: Math.round(performance.now() - started) };
}

async function main() {
  const { settings } = loadSettings();
  const model = settings.model.name;
  const seed = settings.model.seed;
  const world = validateWorld(JSON.parse(readFileSync(resolve(WORLD_FILE), 'utf8')));
  let body = createBody(world.body.hunger, world.body.energy);
  let pos: Position = [...world.start] as Position;
  const history: Outcome[] = [];
  const steps: Recorded[] = [];
  console.log(`世界：${world.name}（${WORLD_FILE}）｜模型：${model}｜${STEPS} 步｜历史窗口 ${HISTORY_LIMIT}｜种子 ${seed}\n`);
  for (let i = 1; i <= STEPS; i++) {
    const { messages, format } = observe(world, body, pos, history, HISTORY_LIMIT);
    let reply: Awaited<ReturnType<typeof ask>> | null = null;
    let error: string | null = null;
    try { reply = await ask({ messages }, format, settings.model.timeoutMs, settings.model); }
    catch (e) { error = e instanceof Error ? e.message : String(e); }
    const at = nameAt(world, pos);
    if (reply) {
      const applied = apply(world, body, pos, reply.do);
      world.entities.splice(0, world.entities.length, ...applied.world.entities);
      body = applied.body; pos = applied.position;
      const label = reply.do;
      history.push({ step: i, did: label, result: applied.outcome });
      steps.push({
        step: i, prompt: JSON.parse((messages[0] as { content: string }).content), raw: reply.raw, thinking: reply.thinking,
        think: reply.think, action: reply.do, at, outcome: applied.outcome, collapsed: applied.collapsed,
        body: { hunger: body.hunger, energy: body.energy, inventory: body.inventory.map(x => ({ name: x.name, count: x.count })) },
        position: pos, durationMs: reply.durationMs, error: null,
      });
      console.log(`[${i}] ${at}${applied.collapsed ? '（昏倒中）' : ''}｜${label} → ${applied.outcome}｜饥饿 ${body.hunger} 精力 ${body.energy} 随身 ${body.inventory.reduce((n, x) => n + x.count, 0)}`);
      console.log(`   想：${reply.think.replace(/\s+/g, ' ').slice(0, 100)}`);
    } else {
      steps.push({ step: i, prompt: JSON.parse((messages[0] as { content: string }).content), raw: '', thinking: null, think: null, action: null, at, outcome: '', collapsed: false, body: { hunger: body.hunger, energy: body.energy, inventory: body.inventory.map(x => ({ name: x.name, count: x.count })) }, position: pos, durationMs: 0, error });
      console.log(`[${i}] 失败：${error}`);
    }
  }
  const dir = resolve(`data/experiments/life-${world.name}-${new Date().toISOString().replace(/:/g, '-')}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'report.json'), JSON.stringify({
    kind: 'life', world: world.name, worldFile: WORLD_FILE, model, modelSettings: reportModel(settings.model), seed, think: THINK, historyLimit: HISTORY_LIMIT, steps,
  }, null, 2) + '\n');
  console.log(`\n原文已写入：${dir}/report.json`);
  if (steps.some(s => s.error)) process.exitCode = 1;
}

await main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
