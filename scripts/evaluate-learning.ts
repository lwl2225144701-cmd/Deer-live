import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from '../src/store.ts';
import { OllamaBrain } from '../src/brain.ts';
import { tick } from '../src/runtime.ts';
import { loadSettings } from '../src/settings.ts';

// Compare the same saved state, then run a separate strict rollout. No writes
// to the source; no fallback or hidden model reasoning in the evidence file.
const sourcePath = resolve(process.argv[2] || 'data/newborn.sqlite');
const hash = () => createHash('sha256').update(readFileSync(sourcePath)).digest('hex');
const before = hash();
const dir = resolve('data/evaluations', `learning-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(dir, { recursive: true });
const source = new DatabaseSync(sourcePath, { readOnly: true });
await backup(source, resolve(dir, 'snapshot.sqlite')); source.close();
const snapshot = new DatabaseSync(resolve(dir, 'snapshot.sqlite'), { readOnly: true });
await backup(snapshot, resolve(dir, 'rollout.sqlite')); snapshot.close();
const store = new Store(resolve(dir, 'snapshot.sqlite'));
const { settings } = loadSettings();
const world = store.load();
if (!world) throw new Error('存档没有世界状态');
const memories = store.recall(world, settings.memory.maxRecall, settings.life.hungryAt);
const experiences = store.experiences(settings.memory.maxExperiences);
const learning = store.learning(world);
const report: any = {
  sourcePath, sourceHash: before, world, settings, learning, comparisons: [], rollout: [], requests: [],
  scope: '同一存档状态，旧输入与累计经历加目标输入，各两个种子。整体改动对照，不能分离各因素。另在副本严格运行四步；不使用规则接管，不训练模型，不证明长期学习。',
};
const output = resolve(dir, 'report.json');
const save = () => writeFileSync(output, JSON.stringify(report, null, 2));
let label = '';
const fetcher = (async (url: any, init: any) => {
  const request = JSON.parse(init.body);
  const response = await fetch(url, init);
  const body = await response.clone().json() as any;
  report.requests.push({ label, request, status: response.status, finishReason: body.done_reason, promptTokens: body.prompt_eval_count, generatedTokens: body.eval_count, finalOutput: body.message?.content });
  save();
  return response;
}) as typeof fetch;
function brain(seed: number) { return new OllamaBrain({ modelConfig: { ...settings.model, seed }, life: settings.life, character: settings.character, fetcher }); }
try {
  for (const seed of [42, 43]) {
    for (const condition of ['previous', 'learning'] as const) {
      label = `${condition}-${seed}`;
      try {
        const decision = await brain(seed).decide(world, memories, undefined, experiences, condition === 'learning' ? learning : undefined);
        const result = { condition, seed, ...decision };
        report.comparisons.push(result); console.log(JSON.stringify(result));
      } catch (error) {
        const result = { condition, seed, error: String(error) };
        report.comparisons.push(result); console.log(JSON.stringify(result));
      }
      save();
    }
  }
  const rollout = new Store(resolve(dir, 'rollout.sqlite'));
  try {
    for (let i = 0; i < 4; i++) {
      label = `rollout-${i + 1}`;
      try {
        const result = await tick(rollout, { brain: brain(42), settings, strict: true });
        report.rollout.push(result);
        console.log(JSON.stringify({ tick: result.event.tick, action: result.event.action, goal: result.event.learning?.goalAfter, goalEnd: result.event.learning?.goalEnd, source: result.event.cognition?.source }));
      } catch (error) {
        report.rolloutError = String(error); console.log(report.rolloutError); break;
      }
      save();
    }
  } finally { rollout.close(); }
} finally {
  store.close(); report.sourceFileUnchanged = hash() === before; save();
  console.log(JSON.stringify({ output, sourceFileUnchanged: report.sourceFileUnchanged }));
}
