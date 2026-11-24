import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadSettings, type Settings } from '../../src/config/settings.ts';
import { Store } from '../../src/storage/store.ts';
import { ModelBrain } from '../../src/agent/brain.ts';
import { tick } from '../../src/app/runtime.ts';
import { initialWorld } from '../../src/world/world.ts';
import { ExperienceStore } from '../../src/experience/store.ts';
import type { ExperienceInput } from '../../src/experience/types.ts';
import { actionIdOf } from '../../src/experience/facts.ts';
import { reportModel } from './model.ts';

// 联合实验：一次跑完经验系统的四个问题（E2 增量、E3 重启、E4 跨世界、E5 误导）。
// 唯一受控变量是 memory.experience.enabled（及对应的经验文件内容）；
// 世界、模型、种子、步数在同一对比组内完全一致。
// 非严格模式：单次推理失败退回规则并记录 source，不中断整组。

const quick = process.env.EXPERIMENT_QUICK === '1';
// 每次运行使用独立目录，避免上一次运行的存档和经验文件污染本次对照。
const RUN_ID = `${new Date().toISOString().replace(/[:.]/g, '-')}${quick ? '-quick' : ''}`;
const OUT_DIR = `data/experiments/experience-loop/combined/${RUN_ID}`;
const EVIDENCE_PATH = quick ? 'data/experiments/experience-loop/combined-quick.json' : 'docs/evidence/self-system/experience-loop-combined.json';
const BASE = loadSettings().settings;
const envInt = (name: string, fallback: number) => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${name} 必须是正整数`);
  return Number(raw);
};
const SEEDS = quick ? [42] : [42, 43, 44];
const PHASE1_STEPS = envInt('E2_STEPS', quick ? 4 : 30);
const RESTART_STEPS = envInt('E3_STEPS', quick ? 3 : 20);
const WORLD_B_STEPS = envInt('E4_STEPS', quick ? 3 : 16);
const MISLEAD_STEPS = envInt('E5_STEPS', quick ? 4 : 12);
const WORLD_B_SEEDS = quick ? [42] : [42, 43];

type StepRecord = {
  tick: number; action: string; choice: string; source: string; hints: number;
  hungerBefore: number; hungerAfter: number; energyBefore: number; energyAfter: number;
  foodBefore: number; foodAfter: number; x: number; y: number; place: string | null;
  outcome: string; latencyMs: number;
};

type RunSummary = {
  foodGained: number; firstFoodTick: number | null; exploreCount: number; eatCount: number;
  eatCountWhenHungry: number; reversals: number; fallbackCount: number; modelCount: number;
  hintsSteps: number; hintsTotal: number; avgLatencyMs: number;
  hungryActions: Record<string, number>; endState: { hunger: number; energy: number; food: number; x: number; y: number };
};

type RunResult = { phase: string; label: string; seed: number; steps: StepRecord[]; summary: RunSummary; error?: string };

function stamp() { return new Date().toISOString(); }

function settingsFor(base: Settings, overrides: Partial<Settings> & { seed?: number } = {}): Settings {
  const s = structuredClone(base) as Settings;
  if (overrides.seed !== undefined) s.model.seed = overrides.seed;
  if (overrides.storage) s.storage = overrides.storage;
  if (overrides.memory) s.memory = overrides.memory;
  if (overrides.initialWorld) s.initialWorld = overrides.initialWorld;
  return s;
}

function exploreFoundPlace(steps: StepRecord[]): Set<string> {
  const found = new Set<string>();
  for (const step of steps) if (step.foodAfter > step.foodBefore && step.place) found.add(step.place);
  return found;
}

function summarize(steps: StepRecord[]): RunSummary {
  if (steps.length === 0) {
    return { foodGained: 0, firstFoodTick: null, exploreCount: 0, eatCount: 0, eatCountWhenHungry: 0, reversals: 0, fallbackCount: 0, modelCount: 0, hintsSteps: 0, hintsTotal: 0, avgLatencyMs: 0, hungryActions: {}, endState: { hunger: 0, energy: 0, food: 0, x: 0, y: 0 } };
  }
  let reversals = 0;
  let previous: StepRecord | null = null;
  for (const step of steps) {
    if (previous && step.action.startsWith('move:') && previous.action.startsWith('move:')) {
      // 折返：这一步回到上一步的出发位置
      // 通过 place 变化近似：outcome 含“移动到”且 action 与上一步方向相反
      const opposite: Record<string, string> = { east: 'west', west: 'east', north: 'south', south: 'north' };
      const here = step.action.slice(5); const prev = previous.action.slice(5);
      if (opposite[prev] === here) reversals += 1;
    }
    previous = step;
  }
  const hungryActions: Record<string, number> = {};
  for (const step of steps) if (step.hungerBefore >= BASE.life.hungryAt) hungryActions[step.action] = (hungryActions[step.action] || 0) + 1;
  const firstFood = steps.find(s => s.foodAfter > s.foodBefore);
  const latencies = steps.filter(s => s.source !== 'rule').map(s => s.latencyMs);
  return {
    foodGained: steps.reduce((sum, s) => sum + Math.max(0, s.foodAfter - s.foodBefore), 0),
    firstFoodTick: firstFood ? firstFood.tick : null,
    exploreCount: steps.filter(s => s.action === 'explore').length,
    eatCount: steps.filter(s => s.action === 'eat').length,
    eatCountWhenHungry: steps.filter(s => s.action === 'eat' && s.hungerBefore >= BASE.life.hungryAt).length,
    reversals,
    fallbackCount: steps.filter(s => s.source === 'fallback').length,
    modelCount: steps.filter(s => s.source === 'ollama').length,
    hintsSteps: steps.filter(s => s.hints > 0).length,
    hintsTotal: steps.reduce((sum, s) => sum + s.hints, 0),
    avgLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
    hungryActions,
    endState: { hunger: steps.at(-1)!.hungerAfter, energy: steps.at(-1)!.energyAfter, food: steps.at(-1)!.foodAfter, x: steps.at(-1)!.x, y: steps.at(-1)!.y },
  };
}

async function runSegment(options: {
  phase: string; label: string; seed: number; steps: number;
  settings: Settings; experience?: ExperienceStore; startTick?: number;
}): Promise<RunResult> {
  const { phase, label, seed, steps, settings } = options;
  const result: RunResult = { phase, label, seed, steps: [], summary: summarize([]) };
  try {
    mkdirSync(dirname(settings.storage.path), { recursive: true });
    const store = new Store(settings.storage.path);
    store.initialize(initialWorld(settings.initialWorld));
    const brain = new ModelBrain({ modelConfig: settings.model, life: settings.life, character: settings.character });
    for (let i = 0; i < steps; i++) {
      const { event, world } = await tick(store, { brain, settings, experience: options.experience });
      const before = event.experience!.before;
      const after = event.experience!.after;
      const record: StepRecord = {
        tick: event.tick, action: actionIdOf(event.action), choice: event.reason, source: event.cognition!.source,
        hints: event.cognition!.offeredExperienceHints?.length || 0,
        hungerBefore: before.hunger, hungerAfter: after.hunger,
        energyBefore: before.energy, energyAfter: after.energy,
        foodBefore: before.food, foodAfter: after.food,
        x: after.x, y: after.y,
        place: event.observation?.place || null,
        outcome: event.outcome, latencyMs: event.cognition!.latencyMs || 0,
      };
      result.steps.push(record);
      console.log(`[${phase}#${label}/s${seed}] ${i + 1}/${steps} t${event.tick} ${record.action} src=${record.source} hints=${record.hints} 饥饿${record.hungerBefore}→${record.hungerAfter} 食物${record.foodBefore}→${record.foodAfter} ${Math.round(record.latencyMs)}ms`);
    }
    store.close();
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    console.log(`[${phase}#${label}/s${seed}] 异常：${result.error}`);
  }
  result.summary = summarize(result.steps);
  return result;
}

function dirname(path: string) { return resolve(path).split('/').slice(0, -1).join('/') || '.'; }

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
  });
  await Promise.all(workers);
}

const WORLD_B = {
  width: 5, height: 5,
  places: [
    { x: 2, y: 2, name: '岩洞', food: 0, capacity: 0 },
    { x: 1, y: 0, name: '果园', food: 3, capacity: 3 },
    { x: 4, y: 4, name: '蜂巢', food: 2, capacity: 2 },
    { x: 0, y: 3, name: '溪边', food: 0, capacity: 0 },
  ],
};

function misleadInputs(): ExperienceInput[] {
  const now = stamp();
  // 为实验人为注入的错误事实：真实世界里 eat 使饥饿 -35，这里声称 +30；
  // explore 声称饥饿 +15。报告会明确标注这些是伪造输入，不是观察。
  return [
    { tick: 1, action: 'eat', situation: { hunger: 65, energy: 60, condition: 'can_move', place: '草地', inventory: [{ id: 'food', name: '随身食物', count: 2 }] }, effect: { hungerDelta: 30, energyDelta: 0, foodDelta: -1, conditionAfter: 'can_move', outcome: '吃掉一份食物' }, recordedAt: now },
    { tick: 2, action: 'eat', situation: { hunger: 85, energy: 55, condition: 'can_move', place: '草地', inventory: [{ id: 'food', name: '随身食物', count: 3 }] }, effect: { hungerDelta: 30, energyDelta: 0, foodDelta: -1, conditionAfter: 'can_move', outcome: '吃掉一份食物' }, recordedAt: now },
    { tick: 3, action: 'explore', situation: { hunger: 70, energy: 65, condition: 'can_move', place: '草地' }, effect: { hungerDelta: 15, energyDelta: -5, foodDelta: 0, conditionAfter: 'can_move', outcome: '探索草地，没有找到食物' }, recordedAt: now },
  ];
}

function compact(runs: RunResult[]) {
  return runs.map(r => ({ phase: r.phase, label: r.label, seed: r.seed, error: r.error, summary: r.summary }));
}

const runs: RunResult[] = [];
const meta = {
  title: '经验系统接入正式循环的联合对照实验（E2+E3+E4+E5）',
  startedAt: stamp(), finishedAt: null as string | null,
  model: reportModel(BASE.model),
  variables: {
    controlled: 'memory.experience.enabled（及经验文件内容）；其余：世界、阈值、步数、种子、提示词、检索规则全部一致',
    note: '关闭组仍保留原有地点记忆与 4 条原始行动经历；本实验只测新增经验线索的增量',
  },
  design: {
    e2: `全新存档 × 3 种子(${SEEDS.join('/')}) × 开/关经验，各 ${PHASE1_STEPS} 步，默认世界`,
    e3: `同一存档与经验文件，模拟重启（重建 Store/经验库/Brain）后继续 ${RESTART_STEPS} 步 × 开/关`,
    e4: `新世界布局（果园/蜂巢/岩洞/溪边），2 种子 × 无经验/带前两阶段经验文件，各 ${WORLD_B_STEPS} 步`,
    e5: `注入 3 条错误事实（eat 声称饥饿+30、explore 声称饥饿+15），初始饥饿 65、随身食物 2，2 种子 × ${MISLEAD_STEPS} 步`,
  },
};

// ── 阶段 1：E2 经验增量 ─────────────────────────────────────────────
{
  console.log(`=== 阶段 1（E2）：${SEEDS.length} 种子 × 开/关 × ${PHASE1_STEPS} 步 ===`);
  const jobs = SEEDS.flatMap(seed => [false, true].map(enabled => ({ seed, enabled })));
  await pool(jobs, 3, async ({ seed, enabled }) => {
    const label = enabled ? 'exp' : 'base';
    const settings = settingsFor(BASE, {
      seed,
      storage: { path: join(OUT_DIR, `e2-${label}-${seed}.sqlite`) },
      memory: { ...BASE.memory, experience: { ...BASE.memory.experience, path: join(OUT_DIR, `experience-e2-${label}-${seed}.json`) } },
    });
    const experience = enabled ? new ExperienceStore() : undefined;
    const run = await runSegment({ phase: 'E2', label, seed, steps: PHASE1_STEPS, settings, experience });
    runs.push(run);
  });
}

// ── 阶段 2：E3 重启延续（同存档、重建实例） ────────────────────────────
{
  console.log(`=== 阶段 2（E3）：重建实例后继续 ${RESTART_STEPS} 步 ===`);
  const jobs = SEEDS.flatMap(seed => [false, true].map(enabled => ({ seed, enabled })));
  await pool(jobs, 3, async ({ seed, enabled }) => {
    const label = enabled ? 'exp' : 'base';
    const settings = settingsFor(BASE, {
      seed,
      storage: { path: join(OUT_DIR, `e2-${label}-${seed}.sqlite`) },
      memory: { ...BASE.memory, experience: { ...BASE.memory.experience, path: join(OUT_DIR, `experience-e2-${label}-${seed}.json`) } },
    });
    // 重启语义：Store、经验库、Brain 全部重新构造，只依赖磁盘上的文件。
    const experience = enabled ? ExperienceStore.load(settings.memory.experience.path) : undefined;
    const run = await runSegment({ phase: 'E3', label, seed, steps: RESTART_STEPS, settings, experience });
    runs.push(run);
  });
}

// ── 阶段 3：E4 跨世界迁移 ───────────────────────────────────────────
{
  console.log(`=== 阶段 3（E4）：新世界 × 无经验/带旧经验 × ${WORLD_B_STEPS} 步 ===`);
  const jobs = WORLD_B_SEEDS.flatMap(seed => [false, true].map(enabled => ({ seed, enabled })));
  await pool(jobs, 2, async ({ seed, enabled }) => {
    const label = enabled ? 'carry' : 'fresh';
    const settings = settingsFor(BASE, {
      seed,
      storage: { path: join(OUT_DIR, `e4-${label}-${seed}.sqlite`) },
      memory: { ...BASE.memory, experience: { ...BASE.memory.experience, path: join(OUT_DIR, `experience-e2-${enabled ? 'exp' : 'exp'}-${seed}.json`) } },
      initialWorld: { width: WORLD_B.width, height: WORLD_B.height, agent: { name: '小鹿', x: 2, y: 2, hunger: 30, energy: 70, curiosity: 50, food: 0 }, places: WORLD_B.places },
    });
    // 迁移组带旧世界的经验文件；fresh 组干脆不启用经验（无文件可带）。
    const experience = enabled ? ExperienceStore.load(settings.memory.experience.path) : undefined;
    const run = await runSegment({ phase: 'E4', label, seed, steps: WORLD_B_STEPS, settings, experience });
    runs.push(run);
  });
}

// ── 阶段 4：E5 误导经验抵抗力 ────────────────────────────────────────
{
  console.log(`=== 阶段 4（E5）：错误经验 × ${MISLEAD_STEPS} 步 ===`);
  const jobs = WORLD_B_SEEDS.map(seed => ({ seed }));
  await pool(jobs, 2, async ({ seed }) => {
    const settings = settingsFor(BASE, {
      seed,
      storage: { path: join(OUT_DIR, `e5-${seed}.sqlite`) },
      memory: { ...BASE.memory, experience: { ...BASE.memory.experience, path: join(OUT_DIR, `experience-e5-${seed}.json`) } },
      initialWorld: { width: 5, height: 5, agent: { name: '小鹿', x: 2, y: 2, hunger: 65, energy: 70, curiosity: 30, food: 2 }, places: BASE.initialWorld.places },
    });
    const experience = new ExperienceStore();
    const injected = experience.recordMany(misleadInputs());
    console.log(`[E5#s${seed}] 注入 ${injected.length} 条错误事实：eat→饥饿+30 ×2，explore→饥饿+15 ×1`);
    const run = await runSegment({ phase: 'E5', label: 'mislead', seed, steps: MISLEAD_STEPS, settings, experience });
    (run as RunResult & { injected?: ExperienceInput[] }).injected = misleadInputs();
    runs.push(run);
  });
}

// ── 汇总 ───────────────────────────────────────────────────────────
meta.finishedAt = stamp();
const byKey = (phase: string, label: string) => runs.filter(r => r.phase === phase && r.label === label);
const pairs = (phase: string, a: string, b: string) => SEEDS.slice(0, phase === 'E4' || phase === 'E5' ? WORLD_B_SEEDS.length : SEEDS.length).map(seed => ({
  seed,
  [a]: byKey(phase, a).find(r => r.seed === seed)?.summary,
  [b]: byKey(phase, b).find(r => r.seed === seed)?.summary,
}));
const report = {
  ...meta,
  comparisons: {
    e2_base_vs_exp: pairs('E2', 'base', 'exp'),
    e3_restart_base_vs_exp: pairs('E3', 'base', 'exp'),
    e4_fresh_vs_carry: pairs('E4', 'fresh', 'carry'),
    e5_mislead: byKey('E5', 'mislead').map(r => ({
      seed: r.seed, summary: r.summary,
      steps: r.steps.map(s => ({ tick: s.tick, action: s.action, source: s.source, hints: s.hints, hunger: `${s.hungerBefore}→${s.hungerAfter}`, food: `${s.foodBefore}→${s.foodAfter}`, outcome: s.outcome })),
      injected: (r as RunResult & { injected?: ExperienceInput[] }).injected,
    })),
  },
  runs: compact(runs),
};
mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
writeFileSync(EVIDENCE_PATH, JSON.stringify({ ...report, runs: runs.map(r => ({ ...r, steps: r.steps })) }, null, 2) + '\n');
console.log(`\n报告已写入 ${EVIDENCE_PATH}`);
console.log(JSON.stringify(report.comparisons, null, 2));
