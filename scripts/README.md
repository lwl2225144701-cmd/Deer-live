# 实验脚本

所有命令均从项目根目录执行；本地模型调用需要 Ollama 正在运行。普通启动使用 `npm start -- …`，自动化测试使用 `npm test`。

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

这些是实际调用模型的实验，不属于 `npm test`。诊断不会执行模型选择的动作；`evaluate:learning` 只推进独立副本。单次或少量选择变化不能证明持续学习，历史结论与证据见 [文档索引](../docs/README.md)。
