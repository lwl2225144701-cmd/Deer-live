import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from './store.ts';
import { OllamaBrain } from './brain.ts';
import { tick } from './runtime.ts';
import { initialWorld } from './world.ts';
import { loadSettings } from './settings.ts';

const usage = `DeerLive 本地生命循环
用法：npm start -- <命令>
  init          创建世界；已有存档时安全读取
  status        查看世界状态和最近事件
  memories      查看当前可检索的地点记忆
  experiences   查看已有行动及身体变化经历
  learning      查看累计探索结果、折返和当前目标
  settings      查看生效的世界、角色、身体和模型设定
  step [次数]   使用规则推进，默认 1 次（最多 100000 次）
  live [次数]   使用本地模型推进，默认 10 次（最多 1000 次）
  run [毫秒]    持续使用本地模型，两次决策间隔默认 1000 毫秒
Ctrl+C 安全停止。存档默认 data/deer-live.sqlite，可用 DEER_LIVE_DB 指定。
模型默认 deepseek-r1:1.5b；DEER_LIVE_MODEL 可切换本机已下载模型。
DEER_LIVE_TIMEOUT_MS 设置推理超时（默认 30000）；DEER_LIVE_STRICT=1 禁止规则接管。
设定文件：deerlive.config.json；世界资源：config/world.json；角色：config/deer.json。
DEER_LIVE_CONFIG 可选择其他设定文件；角色与地图初始值仅用于新存档。`;

function positiveInteger(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error('参数必须为正整数');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`参数范围为 1–${max}`);
  return value;
}
async function main() {
  const [command = 'help', arg, ...extra] = process.argv.slice(2);
  if (['help', '--help', '-h'].includes(command)) { console.log(usage); return; }
  if (!['init', 'status', 'memories', 'experiences', 'learning', 'settings', 'step', 'live', 'run'].includes(command) || extra.length || (['init', 'status', 'memories', 'experiences', 'learning', 'settings'].includes(command) && arg !== undefined)) throw new Error('未知命令或参数');
  const loaded = loadSettings();
  const { settings } = loaded;
  if (command === 'settings') {
    const { initialWorld: _initial, ...effective } = settings;
    console.log(JSON.stringify({ sources: { runtime: loaded.path, world: loaded.worldPath, character: loaded.characterPath }, ...effective }, null, 2));
    console.log('世界布局和角色初始值仅用于新存档；身份、动机及运行规则在下次启动时生效。');
    return;
  }
  const count = command === 'step' || command === 'live' ? positiveInteger(arg, command === 'live' ? settings.run.liveSteps : 1, command === 'live' ? 1000 : 100000) : Infinity;
  const interval = command === 'run' ? positiveInteger(arg, settings.run.intervalMs, 3600000) : 0;
  const brain = command === 'live' || command === 'run' ? new OllamaBrain({ modelConfig: settings.model, life: settings.life, character: settings.character }) : undefined;
  const path = resolve(settings.storage.path);
  mkdirSync(dirname(path), { recursive: true });
  const store = new Store(path);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const world = store.initialize(initialWorld(settings.initialWorld));
    if (command === 'init') { console.log(`世界已就绪：${path}`); console.log(JSON.stringify(world, null, 2)); return; }
    if (command === 'status') { console.log(JSON.stringify(store.load(), null, 2)); console.log('最近事件：', JSON.stringify(store.recentEvents(), null, 2)); return; }
    if (command === 'memories') { console.log(JSON.stringify(store.recall(world, settings.memory.maxRecall, settings.life.hungryAt), null, 2)); return; }
    if (command === 'learning') { console.log(JSON.stringify(store.learning(world), null, 2)); return; }
    if (command === 'experiences') { console.log(JSON.stringify(store.experiences(settings.memory.maxExperiences), null, 2)); return; }
    console.log(`角色设定：${settings.character.description} 目标：${settings.character.motivation}`);
    console.log(`身体设定：饥饿 ≥${settings.life.hungryAt}；疲倦精力 ≤${settings.life.tiredAt}；好奇心 ≥${settings.life.curiousAt}（状态范围 0–100）。`);
    if (brain) console.log(`本地模型：${brain.model}；存档：${path}；${settings.run.strict ? '严格模式' : '推理失败时明确记录规则接管'}`);
    for (let i = 0; i < count && !controller.signal.aborted; i++) {
      const { event, world: next } = await tick(store, { brain, strict: settings.run.strict, signal: controller.signal, settings });
      const c = event.cognition!;
      console.log(`[${event.tick}][${c.source}${c.latencyMs !== undefined ? ` ${c.latencyMs}ms` : ''}] ${event.reason}：${event.outcome}${c.offeredMemoryIds?.length ? `（已提供记忆 ${c.offeredMemoryIds.join(', ')}）` : ''}`);
      const learning = event.learning!;
      if (learning.goalAfter) console.log(`  探索目标 (${learning.goalAfter.x},${learning.goalAfter.y})，模型于第 ${learning.goalAfter.selectedAt} 步选定`);
      if (learning.goalEnd) console.log(`  探索目标结束：${learning.goalEnd === 'explored' ? '已实地探索' : '连续四次移动未接近，待模型重选'}`);
      if (c.error) console.error(`  规则接管原因：${c.error}`);
      console.log(`  饥饿 ${next.agent.hunger}/100｜精力 ${next.agent.energy}/100｜好奇心 ${next.agent.curiosity}/100｜食物 ${next.agent.food} 份${c.offeredExperienceTicks?.length ? `｜已提供 ${c.offeredExperienceTicks.length} 类行动经历` : ''}`);
      if (interval) await delay(interval, undefined, { signal: controller.signal });
    }
    console.log(JSON.stringify(store.load(), null, 2));
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    console.log('\n世界已停止，已提交的行动均已保存。');
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    store.close();
  }
}
await main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
