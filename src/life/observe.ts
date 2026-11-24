import type { Body } from './body.ts';
import { entityAt, legalActions, type Outcome, type Position, type WorldData } from './world.ts';

// 模型只看到：身体、周围实体与"能怎么作用"、自己最近几步的真实结果。
// 效果的数值不进输入——规则要它自己从结果里总结。
export function observe(world: WorldData, body: Body, pos: Position, history: Outcome[], historyLimit = 4) {
  const around: Record<string, unknown>[] = [];
  for (let y = Math.max(0, pos[1] - 1); y <= Math.min(world.height - 1, pos[1] + 1); y++) {
    for (let x = Math.max(0, pos[0] - 1); x <= Math.min(world.width - 1, pos[0] + 1); x++) {
      const entity = entityAt(world, [x, y]);
      around.push({
        id: entity?.id ?? `cell:${x},${y}`,
        name: entity?.name ?? '空地',
        ...(entity?.count !== undefined ? { count: entity.count } : {}),
        can: entity ? entity.affordances.map(a => a.label) : [],
      });
    }
  }
  const legal = legalActions(world, body, pos);
  return {
    messages: [{ role: 'user', content: JSON.stringify({
      body: { hunger: body.hunger, energy: body.energy, inventory: body.inventory, position: pos },
      around,
      last: history.slice(-historyLimit),
    }) }],
    format: {
      type: 'object', additionalProperties: false,
      properties: {
        think: { type: 'string', description: '你此刻的念头' },
        do: { type: 'string', enum: legal, description: '你下一步要做的动作' },
      },
      required: ['think', 'do'],
    },
  };
}
