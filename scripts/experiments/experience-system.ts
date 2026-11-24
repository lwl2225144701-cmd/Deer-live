import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ExperienceStore, describePattern } from '../../src/experience/store.ts';
import type { ExperienceInput, InventoryItem, Situation } from '../../src/experience/types.ts';

// 独立演示：把归档的生活报告转成事实，演示聚合、检索和持久化。
// 不调用模型，不读写正式 SQLite 存档。

const REPORT_PATHS = (process.env.EXPERIENCE_REPORTS
  || 'docs/evidence/self-system/life-history-4.json, docs/evidence/self-system/life-history-8.json')
  .split(',').map(path => path.trim()).filter(Boolean);
const STORE_PATH = process.env.EXPERIENCE_STORE || 'data/experiments/experience-system/experiences.json';

function totalCount(items: { count: number }[] | undefined): number {
  return (items || []).reduce((sum, item) => sum + item.count, 0);
}

function inventoryOf(items: { id?: string; name: string; count: number }[] | undefined): InventoryItem[] {
  return (items || []).map(item => ({ id: String(item.id ?? item.name), name: item.name, count: item.count }));
}

function inputsFromReport(report: Record<string, any>, tickOffset: number): ExperienceInput[] {
  const inputs: ExperienceInput[] = [];
  let previousCollapsed = false;
  let skipped = 0;
  for (const step of report.steps || []) {
    const before = step?.prompt?.body;
    const after = step?.body;
    if (!before || !after || !step.action || step.error) { skipped += 1; continue; }
    const situation: Situation = {
      hunger: before.hunger,
      energy: before.energy,
      condition: previousCollapsed ? 'cannot_move' : 'can_move',
      ...(step.at ? { place: step.at } : {}),
      inventory: inventoryOf(before.inventory),
    };
    const item = step.action.includes(':') ? step.action.split(':')[1] : undefined;
    inputs.push({
      tick: tickOffset + Number(step.step),
      action: step.action,
      situation,
      effect: {
        hungerDelta: after.hunger - before.hunger,
        energyDelta: after.energy - before.energy,
        foodDelta: totalCount(after.inventory) - totalCount(before.inventory),
        conditionAfter: step.collapsed ? 'cannot_move' : 'can_move',
        outcome: String(step.outcome ?? ''),
        ...(item ? { item } : {}),
      },
      recordedAt: new Date().toISOString(),
    });
    previousCollapsed = Boolean(step.collapsed);
  }
  if (skipped) console.log(`  （跳过 ${skipped} 条无动作或失败的记录）`);
  return inputs;
}

const store = new ExperienceStore();
for (const [index, path] of REPORT_PATHS.entries()) {
  const report = JSON.parse(readFileSync(resolve(path), 'utf8')) as Record<string, any>;
  const inputs = inputsFromReport(report, index * 10000);
  const recorded = store.recordMany(inputs);
  console.log(`${path}：${report.world ?? '未知世界'}，${report.model ?? '未知模型'}，记录 ${recorded.length} 条事实`);
}

const facts = store.facts();
const patterns = store.patterns().sort((a, b) => b.total - a.total || b.lastTick - a.lastTick);
console.log(`\n事实 ${facts.length} 条，聚合为 ${patterns.length} 个模式。前 8 个：`);
for (const pattern of patterns.slice(0, 8)) console.log(`- [${pattern.total} 次] ${describePattern(pattern)}`);

const query: Situation = {
  hunger: 100, energy: 48, condition: 'cannot_move', place: '空地',
  inventory: [{ id: 'mushroom-1', name: '蘑菇丛', count: 3 }],
};
console.log(`\n查询情境：饥饿 ${query.hunger}、精力 ${query.energy}、${query.condition === 'cannot_move' ? '不能移动' : '可以移动'}、在${query.place}、随身蘑菇 3 份`);
const matches = store.retrieve(query, { limit: 5 });
for (const [index, match] of matches.entries()) {
  console.log(`${index + 1}. 相关度 ${match.score}｜${describePattern(match.pattern)}`);
}
const eatMatches = store.retrieve(query, { action: 'use:mushroom-1:eat', limit: 3 });
console.log(`\n只看“吃蘑菇”这个动作：${eatMatches.length} 条`);
for (const match of eatMatches) console.log(`- 相关度 ${match.score}｜${describePattern(match.pattern)}`);

store.save(STORE_PATH);
const loaded = ExperienceStore.load(STORE_PATH);
console.log(`\n已保存到 ${STORE_PATH}`);
console.log(`重新加载：事实 ${loaded.facts().length} 条，模式 ${loaded.patterns().length} 个，假设 ${loaded.hypotheses().length} 条`);
console.log('事实检索不会返回假设；假设需要模型另行生成并显式引用事实 ID。');
