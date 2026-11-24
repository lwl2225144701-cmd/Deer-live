// 身体是常量：需求、能力、代价、后果。世界数据不能直接改写这里。
export type InventoryItem = { id: string; name: string; count: number };
export type Body = { hunger: number; energy: number; inventory: InventoryItem[] };

export const BODY = {
  hungerPerStep: 2,
  moveEnergy: 3,
  waitEnergy: 10,
  max: 100,
  min: 0,
  collapseAt: 100,
} as const;

export const CAPABILITIES = ['move', 'take', 'use', 'wait'] as const;
export type Capability = typeof CAPABILITIES[number];

export const clamp = (n: number) => Math.max(BODY.min, Math.min(BODY.max, n));
export const collapsed = (body: Body) => body.hunger >= BODY.collapseAt;

export function createBody(hunger: number, energy: number): Body {
  return { hunger: clamp(hunger), energy: clamp(energy), inventory: [] };
}

// 每一步的固定变化只属于身体；世界只能通过 effects 间接影响。
export function tickBody(body: Body): void {
  body.hunger = clamp(body.hunger + BODY.hungerPerStep);
}

export function readField(body: Body, field: string): number {
  if (field === 'hunger') return body.hunger;
  if (field === 'energy') return body.energy;
  throw new Error(`身体没有这个字段：${field}`);
}

export function writeField(body: Body, field: string, value: number): void {
  if (field === 'hunger') body.hunger = clamp(value);
  else if (field === 'energy') body.energy = clamp(value);
  else throw new Error(`身体没有这个字段：${field}`);
}
