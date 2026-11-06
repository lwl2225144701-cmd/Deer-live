import { DatabaseSync } from 'node:sqlite';
import { initialWorld, restoreWorld, validateWorld, type Event, type World } from '../world/world.ts';
import { DEFAULT_SETTINGS } from '../config/settings.ts';
import { explorationFacts, type LearningContext } from '../agent/learning.ts';

import type { Memory, Experience } from '../agent/memory.ts';

export class Store {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS world (id INTEGER PRIMARY KEY CHECK (id = 1), tick INTEGER NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (tick INTEGER PRIMARY KEY, data TEXT NOT NULL);`);
  }
  load(): World | null {
    const row = this.db.prepare('SELECT tick, state FROM world WHERE id = 1').get() as { tick: number; state: string } | undefined;
    if (!row) return null;
    const world = restoreWorld(JSON.parse(row.state));
    if (world.tick !== row.tick) throw new Error('保存的世界时间不一致');
    return world;
  }
  initialize(seed: World = initialWorld()): World {
    const existing = this.load();
    if (existing) return existing;
    validateWorld(seed);
    const world = seed;
    this.db.prepare('INSERT OR IGNORE INTO world (id, tick, state) VALUES (1, ?, ?)').run(world.tick, JSON.stringify(world));
    return this.load()!;
  }
  save(world: World, event: Event): void {
    validateWorld(world);
    if (event.tick !== world.tick || world.tick < 1) throw new Error('事件与世界时间不一致');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare('UPDATE world SET tick = ?, state = ? WHERE id = 1 AND tick = ?').run(world.tick, JSON.stringify(world), world.tick - 1);
      if (result.changes !== 1) throw new Error('世界状态已变化，请重新加载后再试');
      this.db.prepare('INSERT INTO events (tick, data) VALUES (?, ?)').run(event.tick, JSON.stringify(event));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  recentEvents(limit = 10): Event[] {
    return (this.db.prepare('SELECT data FROM events ORDER BY tick DESC LIMIT ?').all(limit) as { data: string }[]).map(row => JSON.parse(row.data) as Event).reverse();
  }
  recall(world: World, limit = DEFAULT_SETTINGS.memory.maxRecall, hungryAt = DEFAULT_SETTINGS.life.hungryAt): Memory[] {
    // Keep only the latest observation at each location; an empty-site observation
    // supersedes an older positive discovery. No semantic/vector memory yet.
    const rows = this.db.prepare(`SELECT data FROM (
      SELECT data, ROW_NUMBER() OVER (
        PARTITION BY json_extract(data, '$.observation.x'), json_extract(data, '$.observation.y') ORDER BY tick DESC
      ) AS observation_rank FROM events WHERE json_type(data, '$.observation') = 'object'
    ) WHERE observation_rank = 1`).all() as { data: string }[];
    const latest = rows.map(({ data }) => {
      const event = JSON.parse(data) as Event;
      return { id: `event:${event.tick}`, tick: event.tick, ...event.observation!, text: event.outcome };
    });
    const a = world.agent;
    const score = (m: Memory) => (a.hunger >= hungryAt && m.foodRemaining > 0 ? 100 : 0) - Math.abs(m.x - a.x) - Math.abs(m.y - a.y) - (world.tick - m.tick) / 100;
    return latest.sort((a, b) => score(b) - score(a)).slice(0, limit);
  }
  experiences(limit = DEFAULT_SETTINGS.memory.maxExperiences): Experience[] {
    // Preserve an example of each action's effect, rather than letting repeated
    // movement displace every past feeding/resting experience from context.
    const rows = this.db.prepare(`SELECT data FROM (
      SELECT tick, data, ROW_NUMBER() OVER (PARTITION BY json_extract(data, '$.action.type') ORDER BY tick DESC) AS action_rank
      FROM events WHERE json_type(data, '$.experience') = 'object'
    ) WHERE action_rank = 1 ORDER BY tick DESC LIMIT ?`).all(limit) as { data: string }[];
    return rows.map(({ data }) => {
      const e = JSON.parse(data) as Event;
      return { tick: e.tick, action: e.action, outcome: e.outcome, ...e.experience! };
    }).reverse();
  }
  learning(world: World): LearningContext {
    const rows = this.db.prepare(`SELECT data FROM events WHERE json_extract(data, '$.action.type') = 'explore' ORDER BY tick`).all() as { data: string }[];
    const allFacts = explorationFacts(rows.map(r => JSON.parse(r.data)));
    const recent = this.recentEvents(6);
    const goal = recent.at(-1)?.learning?.goalAfter || null;
    // Bound model context; prioritize current/target sites, then nearby/recent
    // evidence. The underlying event history is retained in full.
    const priority = (f: { x: number; y: number; lastTick: number }) =>
      (f.x === world.agent.x && f.y === world.agent.y ? -1000000 : 0) +
      (goal && f.x === goal.x && f.y === goal.y ? -1000000 : 0) +
      Math.abs(f.x - world.agent.x) + Math.abs(f.y - world.agent.y) - f.lastTick / Math.max(1, world.tick);
    const facts = allFacts.sort((a, b) => priority(a) - priority(b)).slice(0, 6);
    const recentMoves = recent.filter(e => e.action.type === 'move' && e.experience).map(e => ({ tick: e.tick, from: { x: e.experience!.before.x, y: e.experience!.before.y }, to: { x: e.experience!.after.x, y: e.experience!.after.y }, source: e.cognition?.source || 'unknown' }));
    const immediateReversals = recentMoves.slice(1).filter((m, i) => {
      const p = recentMoves[i];
      return m.tick === p.tick + 1 && m.to.x === p.from.x && m.to.y === p.from.y;
    }).length;
    return { facts, recentMoves, immediateReversals, goal };
  }
  close(): void { this.db.close(); }
}
