import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadSettings, type ModelSettings } from '../../src/config/settings.ts';
import { askModel, askRaw, reportModel, seedSeries } from './model.ts';
import { initialWorld, type World } from '../../src/world/world.ts';
import { blankRequest, blankRawPrompt, parseBlank, type BlankScene, type Vocabulary } from '../../src/agent/blank.ts';

type Mode = 'chat' | 'completion';

function makeScene(base: World, label: string, x: number, y: number): BlankScene {
  const world = structuredClone(base);
  world.agent.x = x; world.agent.y = y;
  world.visits = { [`${x},${y}`]: 1 };
  return { label, world };
}

type Sample = {
  scene: string;
  seed: number;
  vocabulary: Vocabulary;
  mode: Mode;
  request: unknown;
  raw: string;
  thinking: string | null;
  think: string | null;
  do: string | null;
  error: string | null;
  doneReason: string | null;
  evalCount: number | null;
  durationMs: number;
};

type Options = { modelConfig: ModelSettings; think: boolean | null; timeoutMs: number; vocabulary: Vocabulary; mode: Mode };

async function ask(scene: BlankScene, seed: number, options: Options): Promise<Sample> {
  const started = performance.now();
  const sampled = { scene: scene.label, seed, vocabulary: options.vocabulary, mode: options.mode };
  const empty = { ...sampled, request: null, raw: '', thinking: null, think: null, do: null, doneReason: null, evalCount: null };
  try {
    // completion：只有场景与身体，不带任何指令，只让它续写（仅 Ollama 支持）。
    if (options.mode === 'completion') {
      const request = { prompt: blankRawPrompt(scene.world, options.vocabulary) };
      const reply = await askRaw(options.modelConfig, request.prompt, { think: options.think, seed }, options.timeoutMs);
      return {
        ...empty, request, raw: reply.text, thinking: null, think: null, do: null,
        doneReason: reply.doneReason, evalCount: reply.tokens,
        durationMs: Math.round(performance.now() - started),
      };
    }
    const request = blankRequest(scene.world, options.vocabulary);
    const body = await askModel(options.modelConfig, { messages: request.messages, format: request.format, think: options.think, seed }, options.timeoutMs);
    const reply = parseBlank(body.message.content);
    return {
      ...empty, request, raw: body.message.content, thinking: body.message.thinking ?? null,
      think: reply.think, do: reply.do, doneReason: body.done_reason,
      evalCount: body.eval_count, durationMs: Math.round(performance.now() - started),
    };
  } catch (error) {
    return { ...empty, error: error instanceof Error ? error.message : String(error), durationMs: Math.round(performance.now() - started) };
  }
}

const clip = (text: string | null, n = 60) => !text ? '—' : text.replace(/\s+/g, ' ').slice(0, n) + (text.length > n ? '…' : '');

async function main() {
  const { settings } = loadSettings();
  const model = settings.model.name;
  const mode: Mode = process.env.BLANK_MODE === 'completion' ? 'completion' : 'chat';
  if (mode === 'completion' && settings.model.provider !== 'ollama') throw new Error('无指令续写只在 ollama 模式下可用；请用 BLANK_MODE=chat 或切换本机模型');
  const vocabulary: Vocabulary = process.env.BLANK_VARIANT === 'neutral' ? 'neutral' : 'original';
  const think = process.env.BLANK_THINK === '0' ? false : process.env.BLANK_THINK === '1' ? true : null;
  const base = initialWorld(settings.initialWorld);
  const allScenes = [
    makeScene(base, '小屋', 2, 2),
    makeScene(base, '浆果丛', 0, 2),
    makeScene(base, '苹果树', 4, 0),
  ];
  const only = process.env.BLANK_ONLY === '1';
  const scenes = only ? allScenes.slice(0, 1) : allScenes;
  const seeds = seedSeries(settings.model, only ? 1 : 3);
  const samples: Sample[] = [];
  console.log(`模型：${model}｜模式=${mode}｜词汇=${vocabulary}｜${scenes.length} 场景 × ${seeds.length} 种子 = ${scenes.length * seeds.length} 条\n`);
  for (const scene of scenes) {
    for (const seed of seeds) {
      const sample = await ask(scene, seed, { modelConfig: settings.model, think, timeoutMs: settings.model.timeoutMs, vocabulary, mode });
      samples.push(sample);
      console.log(`[${scene.label} seed=${seed}] ${sample.error ? '失败：' + sample.error : `${(sample.durationMs / 1000).toFixed(0)}s ${sample.doneReason}${sample.evalCount ? ` / ${sample.evalCount} tokens` : ''}`}`);
      if (sample.thinking) console.log(`  thinking（${sample.thinking.length} 字）：${clip(sample.thinking, 160)}`);
      if (mode === 'completion') console.log(`  续写：${clip(sample.raw, 220)}\n`);
      else {
        console.log(`  想：${clip(sample.think, 90)}`);
        console.log(`  做：${clip(sample.do, 90)}\n`);
      }
    }
  }
  const dir = resolve(`data/experiments/blank-probe-${mode}-${vocabulary}-${new Date().toISOString().replace(/:/g, '-')}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'report.json'), JSON.stringify({
    kind: 'blank-probe', at: new Date().toISOString(), model, mode, vocabulary,
    options: { ...reportModel(settings.model), think, seeds },
    note: '不推进世界。chat：不含任务/动机/阈值/菜单；completion：只有场景与身体，无任何指令。',
    samples,
  }, null, 2) + '\n');
  console.log(`原文已写入：${dir}/report.json`);
  if (samples.some(s => s.error)) process.exitCode = 1;
}

await main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
