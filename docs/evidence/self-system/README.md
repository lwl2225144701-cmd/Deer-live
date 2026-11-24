# 自我系统实验证据

本目录保存 2026-11-13 至 2026-11-16 的 17 份有效实验报告，内容为本机模型请求、原始响应、动作与结果。报告未改写模型输出。

- `blank-*.json`：留白实验，包含有无中性词和 raw 续写对照；
- `discovery-collapse.json`：身体昏倒后的行为；
- `life-cave.json` / `life-forest.json`：同一套身体/世界代码运行两份世界数据；
- `life-history-*.json`：最近 2、4、8 条历史窗口对照；
- `experience-reuse.json`：单一物品的有无经验对照；
- `experience-choice.json`：修正后的干扰物品对照；
- `experience-format.json`：无经验、JSON 经验、短句经验对照；
- `minimal-experience.json`：去掉地图后的极简经验对照（qwen3:8b）；
- `minimal-experience-step5.json`：同一极简场景改用 step-5-preview 的复测；
- `experience-position-step5.json`：同一条经验放在 100 条无关历史前/中/后的位置对照；
- `experience-position-1000-step5.json`：同一任务扩到 1000 条无关历史（约 2.4 万字符）的复测；
- `experience-loop-smoke.json`：经验系统接入正式循环后的接线冒烟验证（2026-11-17，临时存档）；
- `experience-loop-combined.json`：E2–E5 联合对照实验完整报告，388 步原始记录（2026-11-17）；
- `experience-necessary.json`：稀缺世界 E2'/E3' 对照完整报告，300 步原始记录（2026-11-20；2026-11-18 首次尝试因 Step Plan 额度耗尽作废，记录见进度文档第十节）；
- `experience-hazard.json`：危害世界 E2''/E3'' 对照完整报告，300 步原始记录（2026-11-23；发现描述性净效应事实无法表达“避开”，见进度文档第十节）；
- `experience-thinking.json`：危害世界 × 思考系统对照完整报告，300 步原始记录 + 模型自写判断全文（2026-11-23；规避能力 2/3 种子出现，同时发现自我判断可能误导自身，见进度文档第十一节）；
- `experience-calibration.json`：危害世界 × 校准系统对照完整报告，300 步原始记录 + 对账记录（2026-11-23；校准机制成立但效应小，claim 可选字段被模型跳过改用机械提取，见进度文档第十二节）；
- `experience-hard.json`：荒年世界生存对照（裸奔 vs 完整心智），最多 360 步原始记录（2026-11-23；裸奔组 2/3 种子进入死亡倒计时，完整心智组全部满体力存活，见进度文档第十三节）。

阶段结论、限制与配置差异见 [自我系统实验进度](../../research/自我系统实验进度-20261116.md)。中间调试及作废报告仍只保存在本地 `data/`，不作为结论证据。
