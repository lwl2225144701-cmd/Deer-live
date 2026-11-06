import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { OllamaBrain, decisionRequest, type Decision } from '../src/brain.ts';
import { Store } from '../src/store.ts';
import { advance, initialWorld, type Action } from '../src/world.ts';
import { loadSettings, DEFAULT_SETTINGS } from '../src/settings.ts';

// Controlled scenario: true actions produce a memory of a food site outside
// the current visual radius. Compare identical observations with/without it.
const store = new Store(':memory:');
const seed = initialWorld(); seed.agent.hunger = 95; seed.agent.food = 0;
let world = store.initialize(seed);
const history: Action[] = [
  { type: 'move', dx: -1, dy: 0 }, { type: 'move', dx: -1, dy: 0 },
  { type: 'explore' }, { type: 'eat' },
  { type: 'move', dx: 1, dy: 0 }, { type: 'move', dx: 1, dy: 0 },
];
for (const action of history) { const result = advance(world, action, '预设实验历史'); store.save(result.world, result.event); world = result.world; }
const memories = store.recall(world);
const { settings } = loadSettings();
const brain = new OllamaBrain({ modelConfig: settings.model });
const results: { condition: string; decision?: Decision; movedTowardKnownFood?: boolean; error?: string }[] = [];
let failed = false;
try {
  for (const condition of ['without-memory', 'with-memory'] as const) {
    try {
      const decision = await brain.decide(world, condition === 'with-memory' ? memories : []);
      const result = { condition, decision, movedTowardKnownFood: decision.choice === 'west' };
      results.push(result); console.log(JSON.stringify(result));
    } catch (error) {
      failed = true;
      const result = { condition, error: error instanceof Error ? error.message : String(error) };
      results.push(result); console.error(JSON.stringify(result));
    }
  }
  const withoutMemory = results.find(r => r.condition === 'without-memory');
  const withMemory = results.find(r => r.condition === 'with-memory');
  const memoryEffectObserved = !failed && withoutMemory?.movedTowardKnownFood === false && withMemory?.movedTowardKnownFood === true;
  const verdict = failed ? 'inference-error' : memoryEffectObserved ? 'observed-once' : 'not-demonstrated';
  const report = {
    date: new Date().toISOString(), model: brain.model,
    modelSettings: settings.model, scenarioLifeSettings: DEFAULT_SETTINGS.life,
    scope: '单个受控场景、每种条件一次；无规则接管；不代表长期能力或统计显著性。程序根据记忆位置提供第一步方向提示，模型只选择动作，不生成解释或记忆引用。',
    verdict, memoryEffectObserved, world, memories, results,
    inputs: { withoutMemory: decisionRequest(world, []), withMemory: decisionRequest(world, memories) },
  };
  mkdirSync('data/evaluations', { recursive: true });
  const path = resolve('data/local-evaluation.json');
  const text = JSON.stringify(report, null, 2);
  writeFileSync(path, text);
  writeFileSync(resolve('data/evaluations', `${report.date.replace(/[:.]/g, '-')}.json`), text);
  console.log(`实测结论：${verdict}；记录：${path}`);
  process.exitCode = failed ? 1 : memoryEffectObserved ? 0 : 2;
} finally { store.close(); }
