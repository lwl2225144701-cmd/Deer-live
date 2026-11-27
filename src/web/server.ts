import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync, realpathSync } from 'node:fs';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { loadSettings } from '../config/settings.ts';
import { Store } from '../storage/store.ts';
import { ModelBrain } from '../agent/brain.ts';
import { ExperienceStore } from '../experience/store.ts';
import { ThinkingStore } from '../thinking/store.ts';
import { CalibrationStore } from '../calibration/store.ts';
import { MotivationStore } from '../motivation/store.ts';
import { WorldController } from './controller.ts';

const webRoot = fileURLToPath(new URL('../../web/', import.meta.url));
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data));
}
export function createWebServer(controller: WorldController) {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      // Local-only UI: block DNS rebinding and cross-site state-changing calls.
      const host = req.headers.host;
      if (!host || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) { json(res, 403, { error: '仅支持本机访问' }); return; }
      const url = new URL(req.url || '/', `http://${host}`);
      if (url.pathname === '/api/state' && req.method === 'GET') { json(res, 200, controller.snapshot()); return; }
      if (url.pathname === '/api/control' && req.method === 'POST') {
        if ((req.headers.origin && req.headers.origin !== url.origin) || req.headers['sec-fetch-site'] === 'cross-site' || !req.headers['content-type']?.startsWith('application/json')) { json(res, 403, { error: '请求来源无效' }); return; }
        let body = '';
        for await (const chunk of req) { body += chunk.toString(); if (body.length > 1024) { json(res, 413, { error: '请求过大' }); return; } }
        const action = JSON.parse(body).action;
        if (action === 'pause') controller.pause();
        else if (action === 'run') controller.start();
        else if (action === 'step') void controller.step();
        else { json(res, 400, { error: '未知操作' }); return; }
        json(res, 200, controller.snapshot()); return;
      }
      if (url.pathname.startsWith('/api/')) { json(res, 404, { error: '接口不存在' }); return; }
      if (!['GET', 'HEAD'].includes(req.method || '')) { res.writeHead(405); res.end(); return; }
      const file = resolve(webRoot, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
      if (!file.startsWith(webRoot)) { res.writeHead(403); res.end(); return; }
      let actual: string;
      try { actual = realpathSync(file); } catch { res.writeHead(404); res.end('Not found'); return; }
      if (!actual.startsWith(resolve(webRoot) + sep)) { res.writeHead(403); res.end(); return; }
      const data = await readFile(actual);
      res.writeHead(200, { 'Content-Type': types[extname(actual)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'" });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) { json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
  });
}

async function main() {
  const { settings } = loadSettings();
  const port = Number(process.env.DEER_LIVE_PORT || 4317);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('DEER_LIVE_PORT 必须是 1–65535 的整数');
  const path = resolve(settings.storage.path); mkdirSync(dirname(path), { recursive: true });
  const store = new Store(path);
  const experience = settings.memory.experience.enabled ? ExperienceStore.load(resolve(settings.memory.experience.path)) : undefined;
  const thinking = settings.thinking.enabled && experience ? ThinkingStore.load(resolve(settings.thinking.path)) : undefined;
  const calibration = thinking && settings.calibration.enabled ? CalibrationStore.load(resolve(settings.calibration.path)) : undefined;
  const motivation = settings.motivation.enabled && experience ? MotivationStore.load(resolve(settings.motivation.path)) : undefined;
  const controller = new WorldController(store, settings, new ModelBrain({ modelConfig: settings.model, life: settings.life, character: settings.character }), experience, thinking, calibration, motivation);
  const server = createWebServer(controller);
  const stop = async () => { await controller.close(); server.close(() => { store.close(); process.exit(0); }); server.closeIdleConnections(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  server.on('error', async error => { console.error(error.message); await controller.close(); store.close(); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`DeerLive 2D：http://127.0.0.1:${port}\n存档：${path}${experience ? `\n经验库：${resolve(settings.memory.experience.path)}（事实 ${experience.facts().length} 条）` : '\n经验系统未启用'}${thinking ? `\n思考库：${resolve(settings.thinking.path)}（自我判断 ${thinking.beliefs('active').length} 条）` : ''}\n当前已暂停；在页面点击“开始生活”后才会推进。`));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main().catch(error => { console.error(error.message); process.exitCode = 1; });
