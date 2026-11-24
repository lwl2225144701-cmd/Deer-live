export type BodyAction = 'north' | 'south' | 'east' | 'west' | 'take' | 'eat' | 'wait';
export type DiscoveryPlace = { x: number; y: number; name: string; food: number };
export type DiscoveryWorld = {
  width: number; height: number;
  agent: { x: number; y: number; hunger: number; energy: number; food: number };
  places: DiscoveryPlace[];
};
export type Attempt = { step: number; act: BodyAction; at: string; outcome: string };

export const ACTIONS: BodyAction[] = ['north', 'south', 'east', 'west', 'take', 'eat', 'wait'];
const clamp = (n: number) => Math.max(0, Math.min(100, n));
const DELTA: Record<string, [number, number]> = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };

export function initialWorld(start: [number, number] = [2, 2], food = 0): DiscoveryWorld {
  return {
    width: 5, height: 5,
    agent: { x: start[0], y: start[1], hunger: 40, energy: 80, food },
    places: [{ x: 1, y: 1, name: '甲地', food: 3 }, { x: 3, y: 3, name: '乙地', food: 2 }],
  };
}

export function nameAt(world: DiscoveryWorld, x = world.agent.x, y = world.agent.y): string {
  return world.places.find(p => p.x === x && p.y === y)?.name ?? '空地';
}

// 只给地点名字，不给份数：要知道哪里还有东西，只能去试。
export function discoveryRequest(world: DiscoveryWorld, attempts: Attempt[], visible = false) {
  const around: Record<string, unknown>[] = [];
  for (let y = Math.max(0, world.agent.y - 1); y <= Math.min(world.height - 1, world.agent.y + 1); y++) {
    for (let x = Math.max(0, world.agent.x - 1); x <= Math.min(world.width - 1, world.agent.x + 1); x++) {
      around.push(visible
        ? { x, y, name: nameAt(world, x, y), food: world.places.find(p => p.x === x && p.y === y)?.food ?? 0 }
        : { x, y, name: nameAt(world, x, y) });
    }
  }
  return {
    messages: [{ role: 'user', content: JSON.stringify({
      where: { x: world.agent.x, y: world.agent.y },
      around,
      body: { hunger: world.agent.hunger, energy: world.agent.energy, food: world.agent.food },
      last: attempts.slice(-4),
    }) }],
    format: {
      type: 'object', additionalProperties: false,
      properties: {
        think: { type: 'string', description: '你此刻的念头' },
        do: { type: 'string', enum: ACTIONS, description: '你下一步要做的动作' },
      },
      required: ['think', 'do'],
    },
  };
}

export function parseDiscovery(raw: string): { think: string; do: BodyAction } {
  const match = /\{[\s\S]*\}/.exec(raw);
  if (!match) throw new Error(`没有找到 JSON：${raw.slice(0, 80)}`);
  const parsed = JSON.parse(match[0]) as { think?: unknown; do?: unknown };
  if (typeof parsed.think !== 'string') throw new Error('缺少 think');
  if (typeof parsed.do !== 'string' || !ACTIONS.includes(parsed.do as BodyAction)) throw new Error(`非法动作：${String(parsed.do)}`);
  return { think: parsed.think, do: parsed.do as BodyAction };
}

export function step(world: DiscoveryWorld, action: BodyAction, hungerPerStep = 2): { world: DiscoveryWorld; outcome: string; at: string; collapsed: boolean } {
  const next = structuredClone(world);
  const a = next.agent;
  const place = next.places.find(p => p.x === a.x && p.y === a.y);
  const at = place?.name ?? '空地';
  // 身体后果：饥饿到 100 就动不了。只说后果，不说原因；进食仍然可以做。
  const collapsed = a.hunger >= 100;
  let outcome: string;
  const delta = DELTA[action];
  if (collapsed && action !== 'eat') {
    outcome = '身体动不了，这一步什么也没做成';
    a.hunger = clamp(a.hunger + hungerPerStep);
    return { world: next, outcome, at, collapsed };
  }
  if (delta) {
    const nx = a.x + delta[0], ny = a.y + delta[1];
    if (nx < 0 || ny < 0 || nx >= next.width || ny >= next.height) outcome = '走不出这个边界';
    else { a.x = nx; a.y = ny; a.energy = clamp(a.energy - 3); outcome = `走到(${nx},${ny})`; }
  } else if (action === 'take') {
    if (place && place.food > 0) { place.food--; a.food++; outcome = `在${at}取到 1 份`; }
    else outcome = `在${at}什么也没有`;
  } else if (action === 'eat') {
    if (a.food < 1) outcome = '随身没有食物';
    else { a.food--; a.hunger = clamp(a.hunger - 35); outcome = '吃掉 1 份'; }
  } else {
    a.energy = clamp(a.energy + 10);
    outcome = '原地等待';
  }
  a.hunger = clamp(a.hunger + hungerPerStep);
  return { world: next, outcome, at, collapsed };
}
