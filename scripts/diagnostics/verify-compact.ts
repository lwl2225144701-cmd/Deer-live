import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { initialWorld, advance, type World } from '../../src/world/world.ts';
import { Store } from '../../src/storage/store.ts';
import { OllamaBrain, compactDecisionRequest } from '../../src/agent/brain.ts';
import { loadSettings } from '../../src/config/settings.ts';

const baseline = JSON.parse(readFileSync(resolve(process.argv[2] || 'docs/evidence/diagnostics/step18-2026-11-06T07-20-36-596Z/report.json'), 'utf8'));
const { settings } = loadSettings();
const sourceHash = () => createHash('sha256').update(readFileSync(baseline.sourcePath)).digest('hex');
const before = sourceHash();
const dir = resolve('data/diagnostics', `compact-verification-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(dir, { recursive: true });
const report: any = { scope: '最终生产提示验证；第18步使用已核对的历史状态和当时输入，其余为独立合成身体需求与实际资源恢复场景。每场景不执行模型动作、无规则接管。新增种子仅用于提示改动后的检查，不是统计证明。', model: settings.model, sourcePath: baseline.sourcePath, results: [], requests: [] };
const output = resolve(dir, 'report.json');
const save = () => writeFileSync(output, JSON.stringify(report, null, 2));
const input = baseline.conditions.find((c: any) => c.name === 'current').payload;
const previousPrompt = process.argv.includes('--previous');
report.condition = previousPrompt ? 'previous-prompt' : 'candidate-compact';
// Read original before/after bodies for the experience ticks captured in the
// baseline input; do not infer missing bodies from deltas.
const originalDb = await import('node:sqlite');
const db = new originalDb.DatabaseSync(baseline.sourcePath, { readOnly: true });
const historical = input.experiences.map((e: any) => {
  const event = JSON.parse((db.prepare('SELECT data FROM events WHERE tick = ?').get(e.tick) as {data:string}).data);
  return { tick: event.tick, action: event.action, outcome: event.outcome, ...event.experience };
});
db.close();
const scenarios: any[] = [{ name: 'step18-empty', world: baseline.world, memories: input.memories, experiences: historical, learning: input.learning, expected: ['west', 'north'], seeds: [45, 46, 47] }];
for (const name of ['hungry-with-food', 'tired', 'regrown-food']) {
  const seed: World = initialWorld(settings.initialWorld);
  if (name === 'hungry-with-food') { seed.agent.hunger = 80; seed.agent.food = 1; }
  if (name === 'tired') seed.agent.energy = 15;
  if (name === 'regrown-food') { seed.agent.x = 0; seed.agent.y = 2; seed.visits = { '0,2': 1 }; seed.places.find(p => p.x === 0 && p.y === 2)!.food = 0; }
  const store = new Store(':memory:'); let world = store.initialize(seed);
  if (name === 'regrown-food') {
    for (let i = 0; i < 60; i++) {
      const next = advance(world, { type: i === 0 ? 'explore' : 'rest' }, 'synthetic-regrowth', settings.life);
      store.save(next.world, next.event); world = next.world;
    }
  }
  scenarios.push({ name, world, memories: store.recall(world), experiences: store.experiences(), learning: store.learning(world), expected: [name === 'hungry-with-food' ? 'eat' : name === 'tired' ? 'rest' : 'explore'], seeds: [45, 46] });
  store.close();
}
report.scenarios = scenarios;
try {
  for (const scene of scenarios.filter(s => !previousPrompt || s.name !== 'step18-empty')) for (const seed of scene.seeds) {
    const fetcher = (async (url: any, init: any) => {
      const request = JSON.parse(init.body);
      if (!previousPrompt) {
        Object.assign(request, compactDecisionRequest(scene.world, scene.memories, { life: settings.life, character: settings.character, experiences: scene.experiences, learning: scene.learning }));
        init = { ...init, body: JSON.stringify(request) };
      }
      if (previousPrompt) {
        const current = JSON.parse(request.messages[0].content);
        request.messages[0].content = JSON.stringify({
          identity: current.identity, task: input.task, observation: current.observation,
          memories: current.memories, experiences: current.experiences,
          learning: scene.learning, learningGuide: input.learningGuide,
          goalCandidates: current.goalCandidates, responseSchema: current.responseSchema,
        });
        init = { ...init, body: JSON.stringify(request) };
      }
      const response = await fetch(url, init);
      const body = await response.clone().json() as any;
      report.requests.push({ scene: scene.name, seed, request, finishReason: body.done_reason, finalOutput: body.message?.content, promptTokens: body.prompt_eval_count, generatedTokens: body.eval_count });
      save(); return response;
    }) as typeof fetch;
    try {
      const brain = new OllamaBrain({ modelConfig: { ...settings.model, seed }, life: settings.life, character: settings.character, fetcher });
      const decision = await brain.decide(scene.world, scene.memories, undefined, scene.experiences, scene.learning);
      const result = { scene: scene.name, seed, ...decision, expectedChoice: scene.expected.includes(decision.choice) };
      report.results.push(result); console.log(JSON.stringify(result));
    } catch (error) { const result = { scene: scene.name, seed, error: String(error) }; report.results.push(result); console.log(JSON.stringify(result)); }
    save();
  }
} finally {
  report.sourceFileUnchanged = before === sourceHash(); save();
  console.log(JSON.stringify({ output, sourceFileUnchanged: report.sourceFileUnchanged }));
}
