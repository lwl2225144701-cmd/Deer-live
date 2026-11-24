import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../storage/store.ts';
import { ModelBrain } from '../agent/brain.ts';
import { assertModelReady, describeModel } from '../agent/client.ts';
import { tick } from './runtime.ts';
import { initialWorld } from '../world/world.ts';
import { loadSettings } from '../config/settings.ts';
import { ExperienceStore, describePattern } from '../experience/store.ts';
import { situationFromWorld, candidateActionIds } from '../experience/facts.ts';
import { ThinkingStore } from '../thinking/store.ts';
import { CalibrationStore } from '../calibration/store.ts';

const usage = `DeerLive 本地生命循环
用法：npm start -- <命令>
  init          创建世界；已有存档时安全读取
  status        查看世界状态和最近事件
  memories      查看当前可检索的地点记忆
  experiences   查看已有行动及身体变化经历
  patterns      查看经验库统计和当前情境可检索的经验线索
  thinking      查看自我判断：模型基于经历写下的信念与复核状态
  calibration   查看自我判断的现实对账记录（言行是否一致）
  learning      查看累计探索结果、折返和当前目标
  settings      查看生效的世界、角色、身体和模型设定
  step [次数]   使用规则推进，默认 1 次（最多 100000 次）
  live [次数]   使用配置的模型推进，默认 10 次（最多 1000 次）
  run [毫秒]    持续使用配置的模型，两次决策间隔默认 1000 毫秒
Ctrl+C 安全停止。存档默认 data/deer-live.sqlite，可用 DEER_LIVE_DB 指定。
模型在 deerlive.config.json 的 model 段配置：provider、name、baseUrl、apiKey，
本机 Ollama 与 OpenAI 兼容服务（如 StepFun）共用同一份参数。
经验库默认 data/experience.json，思考库默认 data/thinking.json，
可用 DEER_LIVE_EXPERIENCE_PATH / DEER_LIVE_THINKING_PATH 指定，
DEER_LIVE_EXPERIENCE=0 关闭经验记录，DEER_LIVE_THINKING=0 关闭思考复核。
DEER_LIVE_TIMEOUT_MS 可覆盖推理超时；DEER_LIVE_STRICT=1 禁止规则接管。
DEER_LIVE_MODEL 仍是模型名的临时覆盖入口，不建议长期使用。
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
  if (!['init', 'status', 'memories', 'experiences', 'patterns', 'thinking', 'calibration', 'learning', 'settings', 'step', 'live', 'run'].includes(command) || extra.length || (['init', 'status', 'memories', 'experiences', 'patterns', 'thinking', 'calibration', 'learning', 'settings'].includes(command) && arg !== undefined)) throw new Error('未知命令或参数');
  const loaded = loadSettings();
  const { settings } = loaded;
  if (command === 'settings') {
    const { initialWorld: _initial, ...effective } = settings;
    const shown = { ...effective, model: { ...effective.model, apiKey: effective.model.apiKey ? '已配置（未显示）' : '' } };
    console.log(JSON.stringify({ sources: { runtime: loaded.path, world: loaded.worldPath, character: loaded.characterPath }, ...shown }, null, 2));
    console.log(`模型服务：${describeModel(settings.model)}`);
    console.log('世界布局和角色初始值仅用于新存档；身份、动机及运行规则在下次启动时生效。');
    return;
  }
  const count = command === 'step' || command === 'live' ? positiveInteger(arg, command === 'live' ? settings.run.liveSteps : 1, command === 'live' ? 1000 : 100000) : Infinity;
  const interval = command === 'run' ? positiveInteger(arg, settings.run.intervalMs, 3600000) : 0;
  let brain: ModelBrain | undefined;
  if (command === 'live' || command === 'run') {
    // 未配置密钥时尽早停止，避免每一步静默退回规则。
    assertModelReady(settings.model);
    brain = new ModelBrain({ modelConfig: settings.model, life: settings.life, character: settings.character });
  }
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
    if (command === 'patterns') {
      const experience = ExperienceStore.load(resolve(settings.memory.experience.path));
      const situation = situationFromWorld(world);
      const experienceOptions = settings.memory.experience;
      console.log(JSON.stringify({
        store: resolve(experienceOptions.path), enabled: experienceOptions.enabled,
        facts: experience.facts().length, patterns: experience.patterns().length, hypotheses: experience.hypotheses().length,
        situation,
        general: experience.retrieve(situation, { limit: experienceOptions.maxPatterns, minObservations: experienceOptions.minObservations }).map(m => ({ score: m.score, action: m.pattern.action, text: describePattern(m.pattern) })),
        byAction: candidateActionIds(world, settings.life).map(action => ({
          action,
          matches: experience.retrieve(situation, { action, limit: experienceOptions.maxPerAction, minObservations: experienceOptions.minObservations }).map(m => ({ score: m.score, pattern: m.pattern })),
        })),
      }, null, 2));
      return;
    }
    if (command === 'thinking') {
      const thinking = ThinkingStore.load(resolve(settings.thinking.path));
      console.log(JSON.stringify({
        store: resolve(settings.thinking.path), enabled: settings.thinking.enabled,
        active: thinking.beliefs('active').length, retired: thinking.beliefs('retired').length,
        beliefs: thinking.beliefs(),
        promptPreview: thinking.selfBeliefs(settings.thinking.maxBeliefsInPrompt),
      }, null, 2));
      return;
    }
    if (command === 'calibration') {
      const calibration = CalibrationStore.load(resolve(settings.calibration.path));
      const records = calibration.records();
      console.log(JSON.stringify({
        store: resolve(settings.calibration.path), enabled: settings.calibration.enabled,
        records: records.length,
        violated: records.filter(r => r.status === 'violated').length,
        entries: records,
      }, null, 2));
      return;
    }
    console.log(`角色设定：${settings.character.description} 目标：${settings.character.motivation}`);
    console.log(`身体设定：饥饿 ≥${settings.life.hungryAt}；疲倦精力 ≤${settings.life.tiredAt}；好奇心 ≥${settings.life.curiousAt}（状态范围 0–100）。`);
    if (brain) console.log(`模型：${describeModel(settings.model)}；存档：${path}；${settings.run.strict ? '严格模式' : '推理失败时明确记录规则接管'}`);
    const experience = settings.memory.experience.enabled ? ExperienceStore.load(resolve(settings.memory.experience.path)) : undefined;
    if (experience) console.log(`经验库：${resolve(settings.memory.experience.path)}（事实 ${experience.facts().length} 条，模式 ${experience.patterns().length} 个）`);
    const thinking = settings.thinking.enabled && experience ? ThinkingStore.load(resolve(settings.thinking.path)) : undefined;
    const calibration = thinking && settings.calibration.enabled ? CalibrationStore.load(resolve(settings.calibration.path)) : undefined;
    if (thinking) {
      const active = thinking.beliefs('active');
      console.log(`思考库：${resolve(settings.thinking.path)}（自我判断 ${active.length} 条，每 ${settings.thinking.everyTicks} 步复核一次）`);
      for (const belief of active.slice(0, 3)) console.log(`  · ${belief.statement}`);
    }
    for (let i = 0; i < count && !controller.signal.aborted; i++) {
      const { event, world: next } = await tick(store, { brain, strict: settings.run.strict, signal: controller.signal, settings, experience, thinking, calibration });
      if (next.dead) {
        console.log(`[${event.tick}] ${event.outcome}`);
        console.log('世界进入终局，循环结束。');
        break;
      }
      const c = event.cognition!;
      console.log(`[${event.tick}][${c.source}${c.latencyMs !== undefined ? ` ${c.latencyMs}ms` : ''}] ${event.reason}：${event.outcome}${c.offeredMemoryIds?.length ? `（已提供记忆 ${c.offeredMemoryIds.join(', ')}）` : ''}`);
      const learning = event.learning!;
      if (learning.goalAfter) console.log(`  探索目标 (${learning.goalAfter.x},${learning.goalAfter.y})，模型于第 ${learning.goalAfter.selectedAt} 步选定`);
      if (learning.goalEnd) console.log(`  探索目标结束：${learning.goalEnd === 'explored' ? '已实地探索' : '连续四次移动未接近，待模型重选'}`);
      if (c.error) console.error(`  规则接管原因：${c.error}`);
      console.log(`  饥饿 ${next.agent.hunger}/100｜精力 ${next.agent.energy}/100｜好奇心 ${next.agent.curiosity}/100｜食物 ${next.agent.food} 份${c.offeredExperienceTicks?.length ? `｜已提供 ${c.offeredExperienceTicks.length} 类行动经历` : ''}${c.offeredExperienceHints?.length ? `｜已提供经验线索 ${c.offeredExperienceHints.length} 条` : ''}${c.offeredSelfBeliefs ? `｜自我信念 ${c.offeredSelfBeliefs} 条` : ''}`);
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
