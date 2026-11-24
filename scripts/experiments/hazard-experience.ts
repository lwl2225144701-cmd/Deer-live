import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadSettings, type Settings, type WorldSettings } from '../../src/config/settings.ts';
import { Store } from '../../src/storage/store.ts';
import { ModelBrain } from '../../src/agent/brain.ts';
import { tick } from '../../src/app/runtime.ts';
import { initialWorld } from '../../src/world/world.ts';
import { ExperienceStore } from '../../src/experience/store.ts';
import { actionIdOf } from '../../src/experience/facts.ts';
import { reportModel } from './model.ts';

// 危害世界对照实验（E2''/E3''）：危害地点隐形，只有亲身经历（或经验线索）才知道。
// 经验的价值从“多拿一份”变成“避开损失”——指标因此从觅食扩展到危害损失。
// 阶段 1：3 种子 × 开/关经验 × 30 步；阶段 2：同存档重建实例继续 20 步。

const BASE = loadSettings().settings;
const quick = process.env.EXPERIMENT_QUICK === '1';
const RUN_ID = `${new Date().toISOString().replace(/[:.]/g, '-')}${quick ? '-quick' : ''}`;
const OUT_DIR = `data/experiments/experience-hazard/${RUN_ID}`;
const EVIDENCE_PATH = quick ? 'data/experiments/experience-hazard/quick.json' : 'docs/evidence/self-system/experience-hazard.json';
const SEEDS = quick ? [42] : [42, 43, 44];
const PHASE1_STEPS = quick ? 6 : 30;
const RESTART_STEPS = quick ? 4 : 20;

type StepRecord = {
  tick: number; action: string; source: string; hints: number;
  hungerBefore: number; hungerAfter: number; energyBefore: number; energyAfter: number;
  foodBefore: number; foodAfter: number; x: number; y: number; place: string | null;
  outcome: string; hazardPlace: string | null;
};

type RunSummary = {
  foodGained: number; firstFoodTick: number | null; exploreCount: number; emptyExplore: number;
  restCount: number; eatCount: number; distinctFoodPlaces: string[]; reversals: number;
  fallbackCount: number; hintsTotal: number;
  hazardHits: number; hazardHungerDamage: number; hazardEnergyDamage: number;
  firstHazardTick: number | null; hazardHungerDamageAfterFirst: number;
  hungryActions: Record<string, number>; endState: { hunger: number; energy: number; food: number; x: number; y: number };
};

type RunResult = { phase: string; label: string; seed: number; steps: StepRecord[]; summary: RunSummary; error?: string };

function summarize(steps: StepRecord[]): RunSummary {
  if (steps.length === 0) {
    return { foodGained: 0, firstFoodTick: null, exploreCount: 0, emptyExplore: 0, restCount: 0, eatCount: 0, distinctFoodPlaces: [], reversals: 0, fallbackCount: 0, hintsTotal: 0, hazardHits: 0, hazardHungerDamage: 0, hazardEnergyDamage: 0, firstHazardTick: null, hazardHungerDamageAfterFirst: 0, hungryActions: {}, endState: { hunger: 0, energy: 0, food: 0, x: 0, y: 0 } };
  }
  const opposite: Record<string, string> = { east: 'west', west: 'east', north: 'south', south: 'north' };
  let reversals = 0;
  let previous: StepRecord | null = null;
  for (const step of steps) {
    if (previous && step.action.startsWith('move:') && previous.action.startsWith('move:') && opposite[previous.action.slice(5)] === step.action.slice(5)) reversals += 1;
    previous = step;
  }
  const hungryActions: Record<string, number> = {};
  for (const step of steps) if (step.hungerBefore >= BASE.life.hungryAt) hungryActions[step.action] = (hungryActions[step.action] || 0) + 1;
  const firstFood = steps.find(s => s.foodAfter > s.foodBefore);
  const hazardSteps = steps.filter(s => s.hazardPlace);
  const firstHazard = hazardSteps[0];
  // 危害损失从结果文本解析（格式固定：饥饿+N，精力-M）
  const damageOf = (s: StepRecord) => {
    const m = /饥饿\+(\d+)，精力-(\d+)/.exec(s.outcome);
    return m ? { hunger: Number(m[1]), energy: Number(m[2]) } : { hunger: 0, energy: 0 };
  };
  const hungerDamage = hazardSteps.reduce((sum, s) => sum + damageOf(s).hunger, 0);
  return {
    foodGained: steps.reduce((sum, s) => sum + Math.max(0, s.foodAfter - s.foodBefore), 0),
    firstFoodTick: firstFood ? firstFood.tick : null,
    exploreCount: steps.filter(s => s.action === 'explore').length,
    emptyExplore: steps.filter(s => s.action === 'explore' && s.foodAfter === s.foodBefore && s.place !== '岩石' && s.place !== '溪流' && s.place !== '洞口').length,
    restCount: steps.filter(s => s.action === 'rest').length,
    eatCount: steps.filter(s => s.action === 'eat').length,
    distinctFoodPlaces: [...new Set(steps.filter(s => s.foodAfter > s.foodBefore).map(s => s.place).filter(Boolean) as string[])],
    reversals,
    fallbackCount: steps.filter(s => s.source === 'fallback').length,
    hintsTotal: steps.reduce((sum, s) => sum + s.hints, 0),
    hazardHits: hazardSteps.length,
    hazardHungerDamage: hungerDamage,
    hazardEnergyDamage: hazardSteps.reduce((sum, s) => sum + damageOf(s).energy, 0),
    firstHazardTick: firstHazard ? firstHazard.tick : null,
    hazardHungerDamageAfterFirst: hazardSteps.filter(s => firstHazard && s.tick > firstHazard.tick).reduce((sum, s) => sum + damageOf(s).hunger, 0),
    hungryActions,
    endState: { hunger: steps.at(-1)!.hungerAfter, energy: steps.at(-1)!.energyAfter, food: steps.at(-1)!.foodAfter, x: steps.at(-1)!.x, y: steps.at(-1)!.y },
  };
}

function hazardWorld(): { world: WorldSettings; start: { x: number; y: number } } {
  const world = JSON.parse(readFileSync(resolve('config/world-hazard.json'), 'utf8')) as WorldSettings;
  return { world, start: { x: 4, y: 3 } };
}

function settingsFor(base: Settings, seed: number): Settings {
  const { world, start } = hazardWorld();
  const s = structuredClone(base) as Settings;
  s.model.seed = seed;
  s.world = world;
  s.initialWorld = { width: world.width, height: world.height, places: structuredClone(world.places), agent: { name: '小鹿', x: start.x, y: start.y, hunger: 20, energy: 80, curiosity: 40, food: 0 } };
  return s;
}

async function runSegment(phase: string, label: string, seed: number, steps: number, settings: Settings, experience?: ExperienceStore): Promise<RunResult> {
  const result: RunResult = { phase, label, seed, steps: [], summary: summarize([]) };
  try {
    mkdirSync(dirname(settings.storage.path), { recursive: true });
    const store = new Store(settings.storage.path);
    store.initialize(initialWorld(settings.initialWorld));
    const brain = new ModelBrain({ modelConfig: settings.model, life: settings.life, character: settings.character });
    // 危害命中判定用“行动前的位置”：上一步的 after 位置 == 本步 hazard 检查点
    let previousPosition: { x: number; y: number } | null = null;
    for (let i = 0; i < steps; i++) {
      const { event } = await tick(store, { brain, settings, experience });
      const before = event.experience!.before;
      const after = event.experience!.after;
      const at = previousPosition || { x: before.x, y: before.y };
      const hazardHere = hazardWorld().world.places.find(p => p.x === at.x && p.y === at.y && p.hazard);
      const record: StepRecord = {
        tick: event.tick, action: actionIdOf(event.action), source: event.cognition!.source,
        hints: event.cognition!.offeredExperienceHints?.length || 0,
        hungerBefore: before.hunger, hungerAfter: after.hunger,
        energyBefore: before.energy, energyAfter: after.energy,
        foodBefore: before.food, foodAfter: after.food,
        x: after.x, y: after.y, place: event.observation?.place || null,
        outcome: event.outcome, hazardPlace: hazardHere?.name || null,
      };
      result.steps.push(record);
      previousPosition = { x: after.x, y: after.y };
      console.log(`[${phase}#${label}/s${seed}] ${i + 1}/${steps} t${event.tick} ${record.action} src=${record.source} hints=${record.hints} 饥${record.hungerBefore}→${record.hungerAfter} 能${record.energyBefore}→${record.energyAfter} 食${record.foodBefore}→${record.foodAfter} ${record.hazardPlace ? '⚠' + record.hazardPlace : record.place || ''}`);
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
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
  }));
}

function paths(seed: number) {
  return (label: string) => ({
    storage: { path: join(OUT_DIR, `${label}-${seed}.sqlite`) },
    memory: { ...BASE.memory, experience: { ...BASE.memory.experience, path: join(OUT_DIR, `experience-${label}-${seed}.json`) } },
  });
}

const runs: RunResult[] = [];
const meta = {
  title: '危害世界经验对照实验（E2\'\'/E3\'\'）',
  startedAt: new Date().toISOString(), finishedAt: null as string | null,
  model: reportModel(BASE.model),
  world: { ...hazardWorld().world, comment: '危害地点隐形：视野与观察不可见，行动时承受饥饿/精力损失并写入结果文本；y=1 走廊是前往蜜果园的无害路径，学到这一点只能靠亲身经历或经验线索' },
  design: `阶段1：${SEEDS.length} 种子 × 开/关经验 × ${PHASE1_STEPS} 步；阶段2：同存档重建实例（重启延续）× 开/关 × ${RESTART_STEPS} 步。核心指标：危害命中次数与损失，及首次遭遇之后的损失（学习曲线）`,
};

console.log(`=== 阶段 1（E2''）：${SEEDS.length} 种子 × 开/关 × ${PHASE1_STEPS} 步，危害世界 ===`);
await pool(SEEDS.flatMap(seed => [false, true].map(enabled => ({ seed, enabled }))), 3, async ({ seed, enabled }) => {
  const label = enabled ? 'exp' : 'base';
  const settings = structuredClone(settingsFor(BASE, seed)) as Settings;
  const p = paths(seed)(label);
  Object.assign(settings.storage, p.storage);
  settings.memory = structuredClone(p.memory);
  const experience = enabled ? new ExperienceStore() : undefined;
  runs.push(await runSegment("E2''", label, seed, PHASE1_STEPS, settings, experience));
});

console.log(`=== 阶段 2（E3''）：重建实例继续 ${RESTART_STEPS} 步 ===`);
await pool(SEEDS.flatMap(seed => [false, true].map(enabled => ({ seed, enabled }))), 3, async ({ seed, enabled }) => {
  const label = enabled ? 'exp' : 'base';
  const settings = structuredClone(settingsFor(BASE, seed)) as Settings;
  const p = paths(seed)(label);
  Object.assign(settings.storage, p.storage);
  settings.memory = structuredClone(p.memory);
  const experience = enabled ? ExperienceStore.load(settings.memory.experience.path) : undefined;
  runs.push(await runSegment("E3''", label, seed, RESTART_STEPS, settings, experience));
});

meta.finishedAt = new Date().toISOString();
const report = {
  ...meta,
  comparisons: {
    e2_base_vs_exp: SEEDS.map(seed => ({
      seed,
      base: runs.find(r => r.phase === "E2''" && r.label === 'base' && r.seed === seed)?.summary,
      exp: runs.find(r => r.phase === "E2''" && r.label === 'exp' && r.seed === seed)?.summary,
    })),
    e3_restart_base_vs_exp: SEEDS.map(seed => ({
      seed,
      base: runs.find(r => r.phase === "E3''" && r.label === 'base' && r.seed === seed)?.summary,
      exp: runs.find(r => r.phase === "E3''" && r.label === 'exp' && r.seed === seed)?.summary,
    })),
  },
  runs: runs.map(r => ({ phase: r.phase, label: r.label, seed: r.seed, error: r.error, summary: r.summary })),
};
mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
writeFileSync(EVIDENCE_PATH, JSON.stringify({ ...report, runs: runs.map(r => ({ ...r, steps: r.steps })) }, null, 2) + '\n');
console.log(`\n报告已写入 ${EVIDENCE_PATH}`);
console.log(JSON.stringify(report.comparisons, null, 2));
