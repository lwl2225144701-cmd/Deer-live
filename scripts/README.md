# 实验脚本

所有命令均从项目根目录执行；模型调用按 `deerlive.config.json` 的 `model.provider` 选择本机 Ollama 或 OpenAI 兼容服务。普通启动使用 `npm start -- …`，自动化测试使用 `npm test`。

## 评测：`evaluation/`

| 命令 | 作用 | 输入与输出 |
|---|---|---|
| `npm run evaluate:local` | 比较提供和移除食物记忆后的单步选择 | 使用固定默认场景；输出 `data/local-evaluation.json` 和 `data/evaluations/` 归档 |
| `npm run evaluate:learning -- data/newborn.sqlite` | 在存档副本上比较累计经历输入，并严格运行四步 | 原存档只读；副本与结果写入 `data/evaluations/learning-…/` |

## 诊断：`diagnostics/`

| 命令 | 作用 | 输入与输出 |
|---|---|---|
| `npm run diagnose:learning -- data/newborn.sqlite` | 重建第 3 步，排查空地点路线提示 | 要求前两步历史与当前配置一致；输出 `data/diagnostics/learning-….json` |
| `npm run diagnose:step18 -- data/newborn.sqlite` | 重建第 18 步，对照四种提示 | 要求完整前 18 步历史与配置一致；输出 `data/diagnostics/step18-…/report.json` |
| `npm run verify:compact` | 用精简候选提示检查空探索、进食、休息和资源恢复 | 读取已归档的第 18 步基线和本地历史存档；输出 `data/diagnostics/compact-verification-…/report.json` |

对照旧提示可执行：

```bash
npm run verify:compact -- docs/evidence/diagnostics/step18-2026-11-06T07-20-36-596Z/report.json --previous
```

历史诊断依赖对应的本地 `data/newborn.sqlite`。仓库不包含该存档；重新创建同名世界不等于恢复原历史。脚本的路径参数和配置路径相对项目根目录解析。

这些是实际调用模型的实验，不属于 `npm test`。诊断不会执行模型选择的动作；`evaluate:learning` 只推进独立副本。`diagnose-learning`、`diagnose-step18` 和 `verify-compact` 固定在本机 Ollama 上重放历史请求，当 `model.provider` 为 `openai-compatible` 时会直接拒绝运行。单次或少量选择变化不能证明持续学习，历史结论与证据见 [文档索引](../docs/README.md)。

## 自我系统旁路：`experiments/`

这些脚本用于留白、身体/世界分离和经验复用探索，不进入正式生命循环，也不修改正式 SQLite 存档。

所有脚本统一读取根目录 `deerlive.config.json` 的 `model` 配置：`provider`、`name`、`baseUrl`、`apiKey`、超时、输出长度、温度和 `topP`。共享实现见 `experiments/model.ts` 与 `src/agent/client.ts`；多种子实验从配置的 `seed` 开始递增，但 `seed` 只对 Ollama 生效。`numCtx` 同样只对 Ollama 生效。

- `openai-compatible` 模式下，运行前需在 `model.apiKey` 填入密钥；留空时第一条样本会报 `apiKey` 错误。
- `BLANK_MODE=completion` 使用 Ollama 的无指令续写，云协议没有等价接口，会直接拒绝。
- 报告中的 `modelSettings` 会把密钥替换为“已配置”标记，不保存明文。
- `DEER_LIVE_CONFIG`、`DEER_LIVE_MODEL`、`DEER_LIVE_TIMEOUT_MS` 仍按正式配置的覆盖规则生效，但日常实验不需要设置。

| 命令 | 作用 |
|---|---|
| `node scripts/experiments/probe-blank.ts` | 留白输入探针；`BLANK_VARIANT=neutral` 换中性词，`BLANK_MODE=completion` 用 raw 续写 |
| `node scripts/experiments/discovery.ts` | 资源变化和身体后果实验；场景由 `DISCOVERY_*` 控制 |
| `LIFE_WORLD=worlds/cave.json node scripts/experiments/life.ts` | 在身体/世界旁路中连续生活；`LIFE_STEPS`、`LIFE_HISTORY_LIMIT` 控制步数和窗口 |
| `node scripts/experiments/reuse-experience.ts` | 单一物品的有无经验对照 |
| `node scripts/experiments/reuse-experience-choice.ts` | 两种干扰物品的经验选择对照 |
| `node scripts/experiments/reuse-experience-format.ts` | 无经验、JSON 经验和短句经验对照 |
| `node scripts/experiments/minimal-experience.ts` | 去掉地图后的极简经验对照 |
| `node scripts/experiments/experience-position.ts` | 同一条经验放在 100 条无关历史的前/中/后；`POSITION_NOISE`、`POSITION_SEEDS` 控制历史条数和种子数 |

`think` 是独立实验开关，不在现有 `ModelSettings` 中：`LIFE_THINK`、`DISCOVERY_THINK`、`BLANK_THINK` 分别控制对应实验。部分脚本提供干跑开关，只打印输入、不调用模型：`MINIMAL_DRY=1`、`FORMAT_DRY=1`、`CHOICE_DRY=1`、`REUSE_DRY=1`、`DISCOVERY_DRY=1`、`POSITION_DRY=1`。

`node scripts/experiments/experience-system.ts` 不调用模型：它从归档生活报告构建经验事实（模块说明见 [经验系统](../src/experience/README.md)），演示聚合、检索和 JSON 持久化，结果写入 `data/experiments/experience-system/`，不修改正式存档。

新结果写入被 Git 忽略的 `data/experiments/`。需要长期保留的报告整理到 `docs/evidence/self-system/`；当前结论和旧脚本参数差异见 [自我系统实验进度](../docs/research/自我系统实验进度-20261116.md)。
