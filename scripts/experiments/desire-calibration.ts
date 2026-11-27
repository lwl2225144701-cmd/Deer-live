import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadSettings, type Settings, type WorldSettings } from '../../src/config/settings.ts';
import { Store } from '../../src/storage/store.ts';
import { ModelBrain } from '../../src/agent/brain.ts';
import { tick } from '../../src/app/runtime.ts';
import { initialWorld } from '../../src/world/world.ts';
import { ExperienceStore } from '../../src/experience/store.ts';
import { ThinkingStore } from '../../src/thinking/store.ts';
import { CalibrationStore } from '../../src/calibration/store.ts';
import { MotivationStore } from '../../src/motivation/store.ts';
import { actionIdOf } from '../../src/experience/facts.ts';
import { reportModel } from './model.ts';

// 荒年世界 × 心愿校准对照（E10）：两组都开启动机系统，
// 唯一变量是 calibration.enabled——心愿账本是否进入复核提示词。
// 上一轮 E9 发现心愿会把鹿引向危险区；这一轮看"现实账本"能否纠正它。

const BASE = loadSettings().settings;
const quick = process.env.EXPERIMENT_QUICK === '1';
const RUN_ID = `${new Date().toISOString().replace(/[:.]/g, '-')}${quick ? '-quick' : ''}`;
const OUT_DIR = `data/experiments/desire-calibration/${RUN_ID}`;
const EVIDENCE_PATH = quick ? 'data/experiments/desire-calibration/quick.json' : 'docs/evidence/self-system/desire-calibration.json';
const SEEDS = quick ? [42] : [42, 43, 44];
const MAX_STEPS = quick ? 16 : 60;

type StepRecord = {
  tick: number; action: string; source: string; hints: number; beliefs: number; desires: number;
  hunger: number; energy: number; food: number; health: number; x: number; y: number;
  place: string | null; outcome: string; hazardPlace: string | null; dead: boolean;
};

type RunSummary = {
  survivedTicks: number; died: boolean; deathTick: number | null;
  foodGained: number; firstFoodTick: number | null; stockpileMax: number; eatCount: number;
  hazardHits: number; hazardHungerDamage: number; starvingTicks: number;
  distinctFoodPlaces: string[]; distinctPlacesVisited: number;
  fallbackCount: number; hintsTotal: number; beliefsTotal: number; desiresTotal: number;
  endState: { hunger: number; energy: number; food: number; health: number };
};

type RunResult = { phase: string; label: string; seed: number; steps: StepRecord[]; summary: RunSummary; error?: string };

function summarize(steps: StepRecord[]): RunSummary {
  if (steps.length === 0) {
    return { survivedTicks: 0, died: false, deathTick: null, foodGained: 0, firstFoodTick: null, stockpileMax: 0, eatCount: 0, hazardHits: 0, hazardHungerDamage: 0, starvingTicks: 0, distinctFoodPlaces: [], distinctPlacesVisited: 0, fallbackCount: 0, hintsTotal: 0, beliefsTotal: 0, desiresTotal: 0, endState: { hunger: 0, energy: 0, food: 0, health: 100 } };
  }
  const hazardSteps = steps.filter(s => s.hazardPlace);
  const damageOf = (s: StepRecord) => {
    const m = /饥饿\+(\d+)，精力-(\d+)/.exec(s.outcome);
    return m ? { hunger: Number(m[1]), energy: Number(m[2]) } : { hunger: 0, energy: 0 };
  };
  const last = steps.at(-1)!;
  const foodGains = steps.filter((s, i) => s.food > (steps[i - 1]?.food ?? s.food));
  return {
    survivedTicks: last.tick,
    died: Boolean(last.dead),
    deathTick: last.dead ? last.tick : null,
    foodGained: steps.reduce((sum, s, i) => sum + Math.max(0, s.food - (steps[i - 1]?.food ?? s.food)), 0),
    firstFoodTick: foodGains[0]?.tick ?? null,
    stockpileMax: Math.max(...steps.map(s => s.food)),
    eatCount: steps.filter(s => s.action === 'eat').length,
    hazardHits: hazardSteps.length,
    hazardHungerDamage: hazardSteps.reduce((sum, s) => sum + damageOf(s).hunger, 0),
    starvingTicks: steps.filter(s => s.hunger >= 100).length,
    distinctFoodPlaces: [...new Set(foodGains.map(s => s.place).filter(Boolean) as string[])],
    distinctPlacesVisited: new Set(steps.map(s => s.place).filter(Boolean)).size,
    fallbackCount: steps.filter(s => s.source === 'fallback').length,
    hintsTotal: steps.reduce((sum, s) => sum + s.hints, 0),
    beliefsTotal: steps.reduce((sum, s) => sum + s.beliefs, 0),
    desiresTotal: steps.reduce((sum, s) => sum + s.desires, 0),
    endState: { hunger: last.hunger, energy: last.energy, food: last.food, health: last.health },
  };
}

function hardWorld(): { world: WorldSettings; start: { x: number; y: number } } {
  const world = JSON.parse(readFileSync(resolve('config/world-hard.json'), 'utf8')) as WorldSettings;
  return { world, start: { x: 4, y: 3 } };
}

function settingsFor(base: Settings, seed: number, label: string): Settings {
  const { world, start } = hardWorld();
  const s = structuredClone(base) as Settings;
  s.model.seed = seed;
  s.world = world;
  s.life = { ...s.life, hungerPerTick: 3 };
  s.initialWorld = { width: world.width, height: world.height, places: structuredClone(world.places), agent: { name: '小鹿', x: start.x, y: start.y, hunger: 20, energy: 80, curiosity: 40, food: 0 } };
  const mind = true;
  s.memory = { ...s.memory, experience: { ...s.memory.experience, enabled: mind } };
  s.thinking = { ...s.thinking, enabled: mind };
  s.calibration = { ...s.calibration, enabled: label === 'mot-cal' };
  s.motivation = { ...s.motivation, enabled: true };
  return s;
}

async function runSegment(label: string, seed: number, steps: number, settings: Settings, experience: ExperienceStore, thinking: ThinkingStore, calibration: CalibrationStore, motivation?: MotivationStore): Promise<RunResult> {
  const result: RunResult = { phase: 'E10', label, seed, steps: [], summary: summarize([]) };
  try {
    mkdirSync(dirname(settings.storage.path), { recursive: true });
    const store = new Store(settings.storage.path);
    store.initialize(initialWorld(settings.initialWorld));
    const brain = new ModelBrain({ modelConfig: settings.model, life: settings.life, character: settings.character });
    let previousPosition: { x: number; y: number } | null = null;
    for (let i = 0; i < steps; i++) {
      const { event, world } = await tick(store, { brain, settings, experience, thinking, calibration, motivation });
      const before = event.experience!.before;
      const after = event.experience!.after;
      const at = previousPosition || { x: before.x, y: before.y };
      const hazardHere = hardWorld().world.places.find(p => p.x === at.x && p.y === at.y && p.hazard);
      const record: StepRecord = {
        tick: event.tick, action: actionIdOf(event.action), source: event.cognition!.source,
        hints: event.cognition!.offeredExperienceHints?.length || 0,
        beliefs: event.cognition!.offeredSelfBeliefs || 0,
        desires: event.cognition!.offeredDesires || 0,
        hunger: after.hunger, energy: after.energy, food: after.food, health: after.health ?? 100,
        x: after.x, y: after.y, place: event.observation?.place || null,
        outcome: event.outcome, hazardPlace: hazardHere?.name || null,
        dead: Boolean(world.dead),
      };
      result.steps.push(record);
      previousPosition = { x: after.x, y: after.y };
      console.log(`[${label}/s${seed}] ${i + 1}/${steps} t${event.tick} ${record.action} src=${record.source} hints=${record.hints} 信念=${record.beliefs} 心愿=${record.desires} 饥${record.hunger} 食${record.food} 体${record.health}${record.hazardPlace ? ' ⚠' + record.hazardPlace : ''}${record.dead ? ' ☠' : ''}`);
      if (world.dead) break;
    }
    store.close();
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    console.log(`[${label}/s${seed}] 异常：${result.error}`);
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
    thinking: { ...BASE.thinking, path: join(OUT_DIR, `thinking-${label}-${seed}.json`) },
    calibration: { ...BASE.calibration, path: join(OUT_DIR, `calibration-${label}-${seed}.json`) },
    motivation: { ...BASE.motivation, path: join(OUT_DIR, `motivation-${label}-${seed}.json`) },
  });
}

const runs: RunResult[] = [];
const meta = {
  title: '荒年世界 × 心愿校准对照实验（E10）',
  startedAt: new Date().toISOString(), finishedAt: null as string | null,
  model: reportModel(BASE.model),
  world: { ...hardWorld().world, lifeOverride: { hungerPerTick: 3 }, comment: '两组均为完整心智+动机，唯一变量是 calibration.enabled（心愿账本）' },
  design: `${SEEDS.length} 种子 × mot(无心愿账本)/mot-cal(有心愿账本) × 最多 ${MAX_STEPS} 步，死亡即止`,
};

console.log(`=== E10：${SEEDS.length} 种子 × mot/mot-cal × 最多 ${MAX_STEPS} 步 ===`);
await pool(SEEDS.flatMap(seed => (['mot', 'mot-cal'] as const).map(label => ({ seed, label }))), 3, async ({ seed, label }) => {
  const settings = structuredClone(settingsFor(BASE, seed, label)) as Settings;
  const p = paths(seed)(label);
  Object.assign(settings.storage, p.storage);
  settings.memory = structuredClone(p.memory);
  settings.thinking = structuredClone(p.thinking);
  settings.calibration = structuredClone(p.calibration);
  settings.motivation = structuredClone(p.motivation);
  const experience = new ExperienceStore();
  const thinking = new ThinkingStore();
  const calibration = new CalibrationStore();
  const motivation = new MotivationStore();
  runs.push(await runSegment(label, seed, MAX_STEPS, settings, experience, thinking, calibration, motivation));
});

meta.finishedAt = new Date().toISOString();
const motivationSnapshots = SEEDS.map(seed => ({
  seed,
  mot: MotivationStore.load(join(OUT_DIR, `motivation-mot-${seed}.json`)).desires().map(d => ({ statement: d.statement, priority: d.priority, status: d.status, progress: d.progress, measure: d.measure })),
  motCal: MotivationStore.load(join(OUT_DIR, `motivation-mot-cal-${seed}.json`)).desires().map(d => ({ statement: d.statement, priority: d.priority, status: d.status, progress: d.progress, measure: d.measure })),
}));
const auditSnapshots = SEEDS.map(seed => ({
  seed,
  audits: CalibrationStore.load(join(OUT_DIR, `calibration-mot-cal-${seed}.json`)).desireAudits().map(a => ({ verdict: a.verdict, measure: a.measure, note: a.note })),
}));
const report = {
  ...meta,
  comparisons: {
    mot_vs_mot_cal: SEEDS.map(seed => ({
      seed,
      mot: runs.find(r => r.label === 'mot' && r.seed === seed)?.summary,
      motCal: runs.find(r => r.label === 'mot-cal' && r.seed === seed)?.summary,
    })),
  },
  motivationSnapshots,
  auditSnapshots,
  runs: runs.map(r => ({ phase: r.phase, label: r.label, seed: r.seed, error: r.error, summary: r.summary })),
};
mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
writeFileSync(EVIDENCE_PATH, JSON.stringify({ ...report, runs: runs.map(r => ({ ...r, steps: r.steps })) }, null, 2) + '\n');
console.log(`\n报告已写入 ${EVIDENCE_PATH}`);
console.log(JSON.stringify({ comparisons: report.comparisons, auditSnapshots }, null, 2));
