# 经验系统（独立模块）

位置：`src/experience/`。这是**不调用模型**的纯机制模块，用来回答四个问题：

1. 实际发生过什么；
2. 相似情境下，同一动作出现过哪些结果、各几次；
3. 当前情境应该取回哪些过去的经历；
4. 重启后这些经历是否还在。

它不解释因果、不判断“成功/失败”，也不生成“应该怎么做”。模型生成的解释单独存放为 `Hypothesis`，永远不会出现在事实检索结果里。

## 正式循环接入（2026-11-17 起）

`facts.ts` 是世界与经验系统之间的转换层，`runtime.ts` 每一步调用它两次：

- **决策前（检索）**：`candidateActionIds` 生成与事实命名一致的候选动作（移动带 `move:east` 等方向前缀），`retrieveHints` 按候选动作分别取回相似经验模式，经 `describePattern` 生成中文摘要后作为 `experienceHints` 注入提示词，并附注“只描述过去的观察，不保证现在适用，也不限制选择”；
- **行动后（记录）**：`eventFactInput` 把事件的前后身体状态转换为一条经验事实并落盘，无论决策来自模型、规则还是规则接管。

配置在 `memory.experience` 段：`enabled`、`path`（默认 `data/experience.json`）、`maxPatterns`、`maxPerAction`、`minObservations`。环境变量 `DEER_LIVE_EXPERIENCE=0` 关闭、`DEER_LIVE_EXPERIENCE_PATH` 改路径。`npm start -- patterns` 查看经验库统计、当前情境检索结果和按动作过滤的结果。

认知记录新增 `offeredExperienceHints`（本次注入线索的动作列表）；网页快照带经验库计数。

## 与现有代码的区别

| 现有 | 本模块 |
|---|---|
| `src/agent/memory.ts` 的 `Experience`：正式循环里每一步的原始事件 | `ExperienceFact`：按情境和结果归一化后的经验事实 |
| `src/storage/store.ts`：SQLite 存档与 `experiences()` 检索 | `ExperienceStore`：独立存储、聚合与相似度检索，可写入 JSON 文件 |
| `src/life/`：身体/世界旁路 | 不依赖 `src/life/`，只接收调用方传入的状态和结果 |

本模块的核心（`types.ts` / `store.ts`）仍不依赖世界循环；`facts.ts` 是唯一接触世界类型的转换层。

## 数据模型

- `Situation`：饥饿、精力、能否移动、地点、随身物品。
- `ObservedEffect`：这次动作造成的饥饿/精力/食物变化、行动后能否移动、结果文本。
- `ExperienceFact`：一次真实观察，`source` 固定为 `observed`。
- `ExperiencePattern`：把“同一动作 + 同一情境桶”下的事实聚合；相同结果合并计数，不同结果保留为多个 `variants`。
- `Hypothesis`：模型解释，`source` 固定为 `model`，必须引用已存在的事实 ID。

情境桶按 25 分一段划分饥饿和精力，避免每个具体数值都形成独立模式；事实本身仍保留原始数值。

## API

```ts
import { ExperienceStore, describePattern } from './src/experience/store.ts';

const store = new ExperienceStore();
store.record({ tick, action, situation, effect });   // 或 recordMany
store.patterns();                                     // 聚合后的模式
store.retrieve(situation, { action?, limit?, minObservations? });
store.addHypothesis({ statement, basisFactIds, confidence });
store.save(path);
ExperienceStore.load(path);                           // 文件不存在时返回空系统
describePattern(pattern);                             // 确定性的中文事实摘要
```

## 检索规则

- 只返回与当前 `condition` 相同的模式；不能移动时不会取“可以移动”时的经验。
- 相关度：饥饿桶距离每档 -20，精力桶距离每档 -10；地点相同 +10；共享物品每项 +3（最多 3 项）；证据条数每条 +2（最多 5 条）。
- 同分时按最近一次发生时间排序。
- 检索结果只有事实模式，不包含 `Hypothesis`；`retrieve` 没有“返回假设”的选项。

这是机制上的相似度，不是模型判断；它只决定“取回什么”，不决定“该做什么”。

## 持久化

- JSON，版本号 `1`，包含 `facts` 和 `hypotheses` 两个独立数组。
- 保存时先写临时文件再原子重命名，避免中途损坏。
- 加载时逐条校验；`facts` 里出现 `source: "model"` 或 `hypotheses` 里出现 `source: "observed"` 都会被拒绝。

## 明确不做

- 不调用模型，不生成自然语言建议；
- 不推断因果，不把重复出现自动升级为“规律”；
- 不淘汰矛盾结果，多个变体同时保留；
- 不替代正式 SQLite 的行动经历记录；
- 提示词里的 `experienceHints` 只声明“这是过去观察”，不携带任何行动建议。

## 演示

```bash
node scripts/experiments/experience-system.ts
```

默认读取两份归档生活报告，把每一步转换成事实，打印聚合模式、一个“饥饿 100、不能移动”的检索示例，并保存到 `data/experiments/experience-system/experiences.json` 后重新加载验证。全过程不调用模型，不修改正式存档。

测试：`node --test test/experience.test.ts`。
