import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadSettings, type ModelSettings } from '../../src/config/settings.ts';
import { askModel, reportModel } from './model.ts';
import { discoveryRequest, initialWorld, nameAt, parseDiscovery, step, type Attempt, type BodyAction, type DiscoveryWorld } from '../../src/agent/discovery.ts';

const STEPS = Number(process.env.DISCOVERY_STEPS || 15);
const VISIBLE = process.env.DISCOVERY_VISIBLE === '1';
const DRY_STEP = Number(process.env.DISCOVERY_DRY_STEP || 6);
const RESTORE_STEP = Number(process.env.DISCOVERY_RESTORE_STEP || 12);
const THINK = process.env.DISCOVERY_THINK === '1' ? true : process.env.DISCOVERY_THINK === '0' ? false : null;
const START: [number, number] = (process.env.DISCOVERY_START || '2,2').split(',').map(Number) as [number, number];
const START_FOOD = Number(process.env.DISCOVERY_START_FOOD || 0);
const START_HUNGER = Number(process.env.DISCOVERY_HUNGER_START || 40);
const HUNGER_PER_STEP = Number(process.env.DISCOVERY_HUNGER_PER_STEP || 2);
const DRY = process.env.DISCOVERY_DRY === '1';

type Step = {
  step: number;
  prompt: unknown;
  raw: string;
  thinking: string | null;
  think: string | null;
  act: BodyAction | null;
  at: string | null;
  outcome: string | null;
  hiddenFoodAtA: number | null;
  durationMs: number;
  error: string | null;
};

// 时间线：第 6 步甲地枯竭，第 12 步恢复。模型看不到这一行。
function tickTimeline(world: DiscoveryWorld, stepIndex: number) {
  const a = world.places.find(p => p.name === '甲地')!;
  if (stepIndex === DRY_STEP) { a.food = 0; console.log('  [世界变化] 甲地枯竭'); }
  if (stepIndex === RESTORE_STEP) { a.food = 2; console.log('  [世界变化] 甲地恢复'); }
}

async function ask(world: DiscoveryWorld, attempts: Attempt[], timeoutMs: number, modelConfig: ModelSettings) {
  const request = discoveryRequest(world, attempts, VISIBLE);
  const started = performance.now();
  const body = await askModel(modelConfig, { messages: request.messages, format: request.format, think: THINK }, timeoutMs);
  const content = body.message.content;
  const reply = parseDiscovery(content);
  return { request, reply, raw: content, thinking: body.message.thinking ?? null, durationMs: Math.round(performance.now() - started) };
}

function evaluate(steps: Step[]) {
  const ok = steps.filter(s => !s.error);
  const dirs: BodyAction[] = ['north', 'south', 'east', 'west'];
  const word: Record<string, string> = { north: '北', south: '南', east: '东', west: '西' };
  // C1：动作为方向时，叙述里出现的方向词与动作不一致 → 记一次冲突。
  const conflicts = ok.filter(s => dirs.includes(s.act as BodyAction))
    .filter(s => {
      const mentioned = dirs.filter(d => (s.think || '').includes(word[d]));
      return mentioned.length > 0 && !mentioned.includes(s.act as BodyAction);
    })
    .map(s => ({ step: s.step, act: s.act, think: s.think }));
  const tookAtA = ok.filter(s => s.act === 'take' && s.at === '甲地');
  const successA = tookAtA.filter(s => (s.outcome || '').includes('取到'));
  const before = successA.filter(s => s.step < 6);
  const c2window = ok.filter(s => s.step >= 6 && s.step <= 9 && s.act === 'take' && s.at === '甲地');
  const c3window = ok.filter(s => s.step >= 12 && s.step <= 15 && s.act === 'take' && s.at === '甲地');
  const everTookA = tookAtA.length > 0;
  return {
    c1: { status: conflicts.length ? 'fail' as const : 'pass' as const, conflicts },
    c2: {
      status: !everTookA ? 'untested' as const : c2window.length ? 'fail' as const : 'pass' as const,
      detail: `枯竭前在甲地取到过 ${before.length} 次；第 6–9 步在甲地又取 ${c2window.length} 次`,
      repeat: c2window.map(s => ({ step: s.step, outcome: s.outcome })),
    },
    c3: {
      status: !everTookA ? 'untested' as const : c3window.length ? 'pass' as const : 'fail' as const,
      detail: `第 12–15 步在甲地取 ${c3window.length} 次`,
    },
    summary: {
      steps: steps.length, ok: ok.length, failures: steps.length - ok.length,
      tookAtA: tookAtA.length, successAtA: successA.length,
      tookAtB: ok.filter(s => s.act === 'take' && s.at === '乙地').length,
      collapsed: ok.filter(s => s.collapsed).length,
      ateWhileCollapsed: ok.filter(s => s.collapsed && s.act === 'eat').length,
      tookAtAWithFood: ok.filter(s => s.act === 'take' && s.at === '甲地').length,
      avgSeconds: ok.length ? +(ok.reduce((n, s) => n + s.durationMs / 1000, 0) / ok.length).toFixed(1) : null,
    },
  };
}

async function main() {
  const { settings } = loadSettings();
  const model = settings.model.name;
  const seed = settings.model.seed;
  let world = initialWorld(START, START_FOOD);
  world.agent.hunger = START_HUNGER;
  const attempts: Attempt[] = [];
  const steps: Step[] = [];
  console.log(`模型：${model}｜${STEPS} 步｜起点 ${START.join(',')}｜饥饿 ${START_HUNGER}(+${HUNGER_PER_STEP}/步)｜随身 ${START_FOOD}｜份数${VISIBLE ? '可见' : '不可见'}｜think=${THINK === null ? '默认' : THINK}｜种子 ${seed}\n`);
  for (let i = 1; i <= STEPS; i++) {
    tickTimeline(world, i);
    if (DRY) {
      const request = discoveryRequest(world, attempts, VISIBLE);
      console.log(JSON.stringify(JSON.parse(request.messages[0].content), null, 1));
      return;
    }
    const at0 = nameAt(world);
    let result: Awaited<ReturnType<typeof ask>> | null = null;
    let error: string | null = null;
    try { result = await ask(world, attempts, settings.model.timeoutMs, settings.model); }
    catch (e) { error = e instanceof Error ? e.message : String(e); }
    if (result) {
      const applied = step(world, result.reply.do, HUNGER_PER_STEP);
      steps.push({
        step: i, collapsed: applied.collapsed, prompt: JSON.parse(result.request.messages[0].content), raw: result.raw, thinking: result.thinking,
        think: result.reply.think, act: result.reply.do, at: applied.at, outcome: applied.outcome,
        hiddenFoodAtA: world.places.find(p => p.name === '甲地')!.food, durationMs: result.durationMs, error: null,
      });
      attempts.push({ step: i, act: result.reply.do, at: applied.at, outcome: applied.outcome });
      world = applied.world;
      console.log(`[${i}] ${at0}${applied.collapsed ? '（昏倒中）' : ''}｜${result.reply.do} → ${applied.outcome}｜饥饿 ${world.agent.hunger} 精力 ${world.agent.energy} 随身 ${world.agent.food}`);
      console.log(`   想：${(result.reply.think || '').replace(/\s+/g, ' ').slice(0, 100)}`);
    } else {
      steps.push({ step: i, prompt: null, raw: '', thinking: null, think: null, act: null, at: null, outcome: null, hiddenFoodAtA: world.places.find(p => p.name === '甲地')!.food, durationMs: 0, error });
      console.log(`[${i}] 失败：${error}`);
    }
  }
  const criteria = evaluate(steps);
  const dir = resolve(`data/experiments/discovery-${new Date().toISOString().replace(/:/g, '-')}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'report.json'), JSON.stringify({
    kind: 'discovery', at: new Date().toISOString(), model, modelSettings: reportModel(settings.model), seed,
    timeline: { '甲地': { start: 3, dryAt: DRY_STEP, restoreAt: RESTORE_STEP }, '乙地': { constant: 2 } }, visible: VISIBLE, start: START, startFood: START_FOOD, startHunger: START_HUNGER, hungerPerStep: HUNGER_PER_STEP,
    criteria, steps,
  }, null, 2) + '\n');
  console.log(`\n判据：C1 ${criteria.c1.status}（冲突 ${criteria.c1.conflicts.length}）｜C2 ${criteria.c2.status}｜C3 ${criteria.c3.status}`);
  console.log(`原文已写入：${dir}/report.json`);
  if (steps.some(s => s.error)) process.exitCode = 1;
}

await main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
