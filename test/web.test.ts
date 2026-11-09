import { test } from 'node:test';
import { request } from 'node:http';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.ts';
import { DEFAULT_SETTINGS } from '../src/config/settings.ts';
import { WorldController } from '../src/web/controller.ts';
import type { Brain } from '../src/agent/brain.ts';
import { createWebServer } from '../src/web/server.ts';

const decision = { action: { type: 'rest' as const }, choice: 'rest', model: 'test', latencyMs: 1, reason: 'test choice' };
function fixture(brain: Brain) {
  const store = new Store(':memory:');
  const settings = structuredClone(DEFAULT_SETTINGS); settings.run.intervalMs = 5;
  return { store, settings, controller: new WorldController(store, settings, brain) };
}

test('2D观察不推进存档；模型单步仍经现有循环原子保存', async () => {
  const f = fixture({ decide: async () => decision });
  try {
    assert.equal(f.controller.snapshot().world.tick, 0);
    assert.equal(f.controller.snapshot().simulation.running, false);
    await f.controller.step();
    assert.equal(f.controller.snapshot().world.tick, 1);
    assert.equal(f.controller.snapshot().events[0].cognition?.source, 'ollama');
  } finally { await f.controller.close(); f.store.close(); }
});

test('2D连续运行串行推理，拒绝并发单步，暂停取消推理且不提交', async () => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let concurrent = 0, maxConcurrent = 0;
  const f = fixture({ decide: async (_w, _m, signal) => {
    concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent); entered();
    try { return await new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })); }
    finally { concurrent--; }
  } });
  try {
    f.controller.start(); await started;
    assert.throws(() => f.controller.step(), /正在行动/);
    f.controller.start();
    f.controller.pause(); await f.controller.close();
    assert.equal(f.controller.snapshot().world.tick, 0);
    assert.equal(f.controller.snapshot().simulation.busy, false);
    assert.equal(f.controller.snapshot().simulation.running, false);
    assert.equal(maxConcurrent, 1);
  } finally { await f.controller.close(); f.store.close(); }
});

test('2D保留严格模式与规则接管边界，异常后可以重新操作', async () => {
  const f = fixture({ model: 'broken', decide: async () => { throw new Error('测试推理失败'); } });
  try {
    f.settings.run.strict = true;
    await f.controller.step();
    assert.equal(f.controller.snapshot().world.tick, 0);
    assert.equal(f.controller.snapshot().simulation.error, '测试推理失败');
    f.settings.run.strict = false;
    await f.controller.step();
    assert.equal(f.controller.snapshot().world.tick, 1);
    assert.equal(f.controller.snapshot().events[0].cognition?.source, 'fallback');
    assert.equal(f.controller.snapshot().simulation.busy, false);
  } finally { await f.controller.close(); f.store.close(); }
});

test('2D HTTP只允许本机同源控制，静态资源不泄漏源码和存档', async () => {
  const f = fixture({ decide: async () => decision });
  const server = createWebServer(f.controller);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(url + '/')).status, 200);
    assert.match(await (await fetch(url + '/')).text(), /小鹿的森林/);
    assert.equal((await fetch(url + '/assets/deer.png')).headers.get('content-type'), 'image/png');
    const first = await (await fetch(url + '/api/state')).json() as any;
    assert.equal(first.world.tick, 0);
    const blocked = await fetch(url + '/api/control', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' }, body: '{"action":"run"}' });
    assert.equal(blocked.status, 403);
    const badHost = await new Promise<number>(resolve => {
      const req = request(url + '/api/state', { headers: { Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode!); }); req.end();
    });
    assert.equal(badHost, 403);
    for (const path of ['/data/newborn.sqlite', '/src/web/server.ts', '/%2e%2e%2fpackage.json']) assert.notEqual((await fetch(url + path)).status, 200);
    const step = await fetch(url + '/api/control', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: '{"action":"step"}' });
    assert.equal(step.status, 200); await f.controller.close();
    assert.equal(f.controller.snapshot().world.tick, 1);
  } finally { await f.controller.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); f.store.close(); }
});
