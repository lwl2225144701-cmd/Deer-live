import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from '../src/store.ts';
import { initialWorld, advance, type Event } from '../src/world.ts';
import { decisionRequest } from '../src/brain.ts';
import { loadSettings } from '../src/settings.ts';

// Historical reconstruction only. All calls observe the same pre-step-18
// state; no action is executed and the original database is read-only.
const sourcePath = resolve(process.argv[2] || 'data/newborn.sqlite');
const hash = () => createHash('sha256').update(readFileSync(sourcePath)).digest('hex');
const sourceHash = hash();
const source = new DatabaseSync(sourcePath, { readOnly: true });
const events = (source.prepare('SELECT data FROM events WHERE tick <= 18 ORDER BY tick').all() as { data: string }[]).map(r => JSON.parse(r.data) as Event);
source.close();
assert.equal(events.length, 18, '需要完整的前18步记录');
const { settings } = loadSettings();
const store = new Store(':memory:');
let world = store.initialize(initialWorld(settings.initialWorld));
for (const event of events.slice(0, 17)) {
  const next = advance(world, event.action, event.reason, settings.life);
  assert.deepEqual(next.event.experience, event.experience, `第${event.tick}步身体变化与配置不符`);
  assert.deepEqual(next.event.observation, event.observation, `第${event.tick}步地点观察与配置不符`);
  store.save(next.world, event); world = next.world;
}
assert.deepEqual(world.agent, events[17].experience!.before);
const learning = store.learning(world);
assert.deepEqual(learning, events[17].learning!.offered, '重建的累计事实必须与当时实际提供的记录相同');
const memories = store.recall(world, settings.memory.maxRecall, settings.life.hungryAt);
const experiences = store.experiences(settings.memory.maxExperiences);
const request = decisionRequest(world, memories, { life: settings.life, character: settings.character, experiences, learning });
store.close();
const full = JSON.parse(request.messages[0].content);
const last = events[16].experience!;
const factText = `上一步（第17步）在(${last.after.x},${last.after.y})探索，随身食物从${last.before.food}变为${last.after.food}，精力从${last.before.energy}变为${last.after.energy}。现在仍在同一位置，眼前该位置的食物为0。这个位置已实际探索1次，未采到食物1次。`;
assert.equal(events[16].action.type, 'explore');
assert.equal(last.after.food - last.before.food, 0);
assert.equal(learning.facts.find(f => f.x === world.agent.x && f.y === world.agent.y)?.emptyAttempts, 1);
const compact = {
  identity: full.identity,
  task: '根据真实经历和眼前环境选择行动。hunger越高越饿，energy越低越累；先照顾身体需求，再探索少去的地方。explore只检查脚下不移动；脚下没有食物且已探索过时，尝试其他地方。历史无食物不代表永久没有，资源可能恢复。只按responseSchema输出JSON，不解释。goal是计划探索的目的地，从goalCandidates选择坐标，也可none暂不设目标。',
  observation: full.observation,
  lastExperienceInWords: factText,
  explorationFacts: learning.facts,
  recentMoves: learning.recentMoves,
  immediateReversals: learning.immediateReversals,
  goal: learning.goal,
  goalCandidates: full.goalCandidates,
  responseSchema: full.responseSchema,
};
const actionOnly: any = structuredClone(compact);
actionOnly.task = actionOnly.task.replace('goal是计划探索的目的地，从goalCandidates选择坐标，也可none暂不设目标。', '');
delete actionOnly.goalCandidates;
delete actionOnly.responseSchema.properties.goal;
actionOnly.responseSchema.required = ['choice'];
const conditions = [
  { name: 'current', payload: full },
  { name: 'current-plus-plain-fact', payload: { ...full, lastExperienceInWords: factText } },
  { name: 'compact', payload: compact },
  { name: 'compact-action-only', payload: actionOnly },
];
for (const c of conditions) assert.deepEqual(c.payload.responseSchema.properties.choice.enum, full.responseSchema.properties.choice.enum);
const dir = resolve('data/diagnostics', `step18-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(dir, { recursive: true });
const output = resolve(dir, 'report.json');
const report: any = {
  sourcePath, sourceHash, world, model: settings.model, conditions, results: [],
  scope: '按当前配置重建第18步决策前状态，逐步核对实际身体变化和观察，累计事实与当时事件输入一致；并非历史HTTP抓包。四种提示、三个种子轮换顺序，同一模型/状态/动作集合。compact同时精简信息和重写指令，不能单独归因。所有动作合法，不执行、不接管、不训练，不保存隐藏思考。',
};
const save = () => writeFileSync(output, JSON.stringify(report, null, 2));
save();
try {
  for (const [i, seed] of [42, 43, 44].entries()) {
    for (const c of [...conditions.slice(i), ...conditions.slice(0, i)]) {
      const started = performance.now();
      try {
        const response = await fetch('http://127.0.0.1:11434/api/chat', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(settings.model.timeoutMs),
          body: JSON.stringify({ model: settings.model.name, messages: [{ role: 'user', content: JSON.stringify(c.payload) }], format: c.payload.responseSchema, stream: false, ...(settings.model.name.startsWith('deepseek-r1') ? {} : { think: false }), keep_alive: '5m', options: { temperature: settings.model.temperature, top_p: settings.model.topP, num_predict: settings.model.numPredict, num_ctx: settings.model.numCtx, seed } }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json() as any;
        let parsed: any; try { parsed = JSON.parse(body.message?.content || ''); } catch {}
        const schema = c.payload.responseSchema;
        const valid = body.done === true && body.done_reason !== 'length' && parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length === schema.required.length && schema.required.every((k: string) => schema.properties[k].enum.includes(parsed[k]));
        const result = { condition: c.name, seed, valid: Boolean(valid), choice: valid ? parsed.choice : null, goal: valid ? parsed.goal ?? null : null, repeatedEmptyExplore: valid ? parsed.choice === 'explore' : null, movesAway: valid ? ['north', 'south', 'east', 'west'].includes(parsed.choice) : null, finishReason: body.done_reason, finalOutput: body.message?.content, promptTokens: body.prompt_eval_count, generatedTokens: body.eval_count, latencyMs: Math.round(performance.now() - started) };
        report.results.push(result); console.log(JSON.stringify(result));
      } catch (error) {
        const result = { condition: c.name, seed, valid: false, error: String(error), latencyMs: Math.round(performance.now() - started) };
        report.results.push(result); console.log(JSON.stringify(result));
      }
      save();
    }
  }
} finally {
  report.sourceFileUnchanged = hash() === sourceHash;
  report.summary = conditions.map(c => {
    const rows = report.results.filter((r: any) => r.condition === c.name);
    return { condition: c.name, calls: rows.length, valid: rows.filter((r: any) => r.valid).length, repeatedEmptyExplore: rows.filter((r: any) => r.repeatedEmptyExplore).length, movesAway: rows.filter((r: any) => r.movesAway).length, rests: rows.filter((r: any) => r.choice === 'rest').length };
  });
  save(); console.log(JSON.stringify({ summary: report.summary, output, sourceFileUnchanged: report.sourceFileUnchanged }));
}
