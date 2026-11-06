import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.ts';
import { advance, initialWorld, choices, type Action } from '../src/world.ts';
import { OllamaBrain, decisionRequest } from '../src/brain.ts';
import { tick } from '../src/runtime.ts';
import { updateGoal, type ExplorationGoal } from '../src/learning.ts';

const mock = (output: unknown) => new OllamaBrain({ fetcher: (async () => new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: JSON.stringify(output) } }))) as typeof fetch });
function act(store: Store, action: Action) {
  const next = advance(store.load()!, action, 'fixture');
  store.save(next.world, next.event);
  return next;
}

test('累计空探索与成本，采完最后一份不误计失败，旧经历不会补造', () => {
  const store = new Store(':memory:'); store.initialize();
  try {
    act(store, { type: 'explore' }); act(store, { type: 'explore' });
    act(store, { type: 'move', dx: -1, dy: 0 }); act(store, { type: 'move', dx: -1, dy: 0 });
    for (let i = 0; i < 4; i++) act(store, { type: 'explore' });
    const old = advance(store.load()!, { type: 'explore' }, 'legacy');
    delete old.event.experience; store.save(old.world, old.event);
    const facts = store.learning(store.load()!).facts;
    const home = facts.find(f => f.x === 2)!;
    assert.equal(home.attempts, 2); assert.equal(home.emptyAttempts, 2); assert.equal(home.energySpent, 10);
    const food = facts.find(f => f.x === 0)!;
    assert.equal(food.attempts, 4); assert.equal(food.emptyAttempts, 1); assert.equal(food.foodCollected, 3);
    assert.equal(food.lastFoodRemaining, 0); assert.equal(food.lastTick, 8);
  } finally { store.close(); }
});

test('短期原路折返可见且保留行为来源，休息不计为连续移动折返', async () => {
  const store = new Store(':memory:'); store.initialize();
  try {
    await tick(store, { brain: mock({ choice: 'east', goal: 'none' }), strict: true });
    act(store, { type: 'move', dx: -1, dy: 0 });
    act(store, { type: 'rest' }); act(store, { type: 'move', dx: 1, dy: 0 });
    const context = store.learning(store.load()!);
    assert.equal(context.immediateReversals, 1);
    assert.equal(context.recentMoves[0].source, 'ollama');
    assert.equal(context.recentMoves[1].source, 'unknown');
  } finally { store.close(); }
});

test('模型选定目标跨重启、休息和规则接管保留，探索后完成', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deerlive-goal-'));
  const path = join(dir, 'world.sqlite');
  let store = new Store(path); store.initialize();
  try {
    await tick(store, { brain: mock({ choice: 'rest', goal: '3,2' }), strict: true });
    const goal = store.learning(store.load()!).goal!;
    assert.equal(goal.source, 'ollama'); assert.equal(goal.selectedAt, 1);
    store.close(); store = new Store(path);
    assert.deepEqual(store.learning(store.load()!).goal, goal);
    await tick(store, { brain: mock({ choice: 'rest' }), strict: true });
    const fallback = await tick(store, { brain: mock({ choice: 'invalid' }) });
    assert.equal(fallback.event.cognition!.source, 'fallback');
    assert.equal(fallback.world.agent.x, 3);
    assert.ok(fallback.event.learning!.goalAfter, '到达仍需探索');
    const completed = await tick(store, { brain: mock({ choice: 'explore' }), strict: true });
    assert.equal(completed.event.learning!.goalEnd, 'explored');
    assert.equal(store.learning(store.load()!).goal, null);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('四次移动未改善距离时释放目标，吃饭休息不消耗移动预算', () => {
  let world = initialWorld();
  let goal: ExplorationGoal | null = { x: 3, y: 2, source: 'ollama', selectedAt: 1, stalledMoves: 0, bestDistance: 1 };
  for (const action of [{ type: 'rest' }, { type: 'move', dx: -1, dy: 0 }, { type: 'move', dx: 1, dy: 0 }, { type: 'rest' }, { type: 'move', dx: -1, dy: 0 }, { type: 'move', dx: 1, dy: 0 }] as Action[]) {
    const next = advance(world, action, 'test'); world = next.world;
    const result = updateGoal(goal, next.event); goal = result.goalAfter;
    if (world.tick < 6) assert.ok(goal);
    else { assert.equal(goal, null); assert.equal(result.goalEnd, 'stalled'); }
  }
});

test('目标不得引用未知远处，失败或中止不写入；累计信息不删减合法动作', async () => {
  const store = new Store(':memory:'); store.initialize();
  try {
    act(store, { type: 'explore' }); act(store, { type: 'explore' });
    const world = store.load()!, learning = store.learning(world);
    const req = decisionRequest(world, [], { learning });
    const input = JSON.parse(req.messages[0].content);
    assert.deepEqual(req.format.properties.choice.enum, choices(world).map(c => c.id));
    assert.equal(input.learning.facts[0].emptyAttempts, 2);
    assert.ok(!input.goalCandidates.some((c: { id: string }) => c.id === '4,0'));
    await assert.rejects(() => tick(store, { brain: mock({ choice: 'east', goal: '4,0' }), strict: true }));
    await assert.rejects(() => tick(store, { brain: mock({ choice: 'east', goal: '3,2' }), signal: AbortSignal.abort() }));
    assert.deepEqual(store.load(), world); assert.equal(store.learning(world).goal, null);
    // Repeating a known empty exploration is still a legal model decision.
    await tick(store, { brain: mock({ choice: 'explore', goal: 'none' }), strict: true });
    assert.equal(store.learning(store.load()!).facts[0].emptyAttempts, 3);
  } finally { store.close(); }
});
