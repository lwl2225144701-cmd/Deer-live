import type { World } from '../world/world.ts';

export type BlankScene = { label: string; world: World };
export type BlankReply = { think: string; do: string };
export type Vocabulary = 'original' | 'neutral';

// 两组实验共用同一段身体描述，只更换世界词汇，保证只有一个变量。
const PARTS = '你有四条腿，能走到相邻的一格；有一双眼睛，能看到身边一格里的东西；有一张嘴，能嚼碎身边能吃的东西；也可以原地不动。';

const NEUTRAL_NAME: Record<string, string> = {
  小屋: '一间屋子', 浆果丛: '一丛矮植物', 苹果树: '一棵高树', 池塘: '一片水', 草地: '空地',
};

function cells(world: World, vocabulary: Vocabulary) {
  const around: Record<string, unknown>[] = [];
  for (let y = Math.max(0, world.agent.y - 1); y <= Math.min(world.height - 1, world.agent.y + 1); y++) {
    for (let x = Math.max(0, world.agent.x - 1); x <= Math.min(world.width - 1, world.agent.x + 1); x++) {
      const place = world.places.find(p => p.x === x && p.y === y);
      const name = place?.name ?? '草地';
      around.push(vocabulary === 'neutral'
        ? { x, y, kind: NEUTRAL_NAME[name] ?? '空地', count: place?.food ?? 0 }
        : { x, y, name, food: place?.food ?? 0 });
    }
  }
  return around;
}

// 纯续写：只有场景与身体事实，没有任何指令、没有 JSON 格式要求。
export function blankRawPrompt(world: World, vocabulary: Vocabulary = 'original') {
  const lines = [`你在一个 ${world.width}x${world.height} 的网格里，坐标 (${world.agent.x},${world.agent.y})。`, '周围一格：'];
  for (const c of cells(world, vocabulary)) {
    lines.push(vocabulary === 'neutral'
      ? `(${c.x},${c.y}) ${c.kind} ${c.count}`
      : `(${c.x},${c.y}) ${c.name} ${c.food}`);
  }
  const a = world.agent;
  lines.push(vocabulary === 'neutral'
    ? `身体：a=${a.hunger} b=${a.energy} c=${a.curiosity} d=${a.food}`
    : `身体：饥饿=${a.hunger} 精力=${a.energy} 好奇心=${a.curiosity} 食物=${a.food}`);
  lines.push(PARTS);
  return lines.join('\n');
}

export function blankRequest(world: World, vocabulary: Vocabulary = 'original') {
  const around = cells(world, vocabulary);
  const body = vocabulary === 'neutral'
    ? { a: world.agent.hunger, b: world.agent.energy, c: world.agent.curiosity, d: world.agent.food, parts: PARTS }
    : { hunger: world.agent.hunger, energy: world.agent.energy, curiosity: world.agent.curiosity, food: world.agent.food, parts: PARTS };
  return {
    messages: [{ role: 'user', content: JSON.stringify({
      where: { x: world.agent.x, y: world.agent.y, width: world.width, height: world.height },
      around,
      body,
    }) }],
    format: {
      type: 'object', additionalProperties: false,
      properties: {
        think: { type: 'string', description: '你此刻的念头' },
        do: { type: 'string', description: '你想做的事；不想做就写 nothing' },
      },
      required: ['think', 'do'],
    },
  };
}

// schema 约束下通常就是纯 JSON；模型偶尔会多裹一层说明，取第一段花括号。
export function parseBlank(raw: unknown): BlankReply {
  const text = typeof raw === 'string' ? raw : '';
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) throw new Error(`没有找到 JSON：${text.slice(0, 80)}`);
  const parsed = JSON.parse(match[0]) as Partial<BlankReply>;
  if (typeof parsed.think !== 'string' || typeof parsed.do !== 'string') throw new Error('think/do 字段缺失');
  return { think: parsed.think, do: parsed.do };
}
