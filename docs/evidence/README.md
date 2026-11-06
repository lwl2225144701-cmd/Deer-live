# 本机实验记录

本目录保存 2026-11-06 的阶段性实验输入、最终动作、状态与统计，用于复核 README 和学习行为排查中的结论。记录不是训练数据集，也不证明自主生存或持续学习达标。

整理时仅将本机绝对项目路径改成项目相对路径，未改动实验输入、动作或数值。原始生成文件保留在本地 `data/`，运行时新报告仍写入 `data/`；SQLite 活存档、模型权重和训练产物不纳入 Git。

- `newborn-smoke.json`：新生角色与行动经历接入。
- `evaluations/2026-11-06T03-09-19-687Z.json`：早期有无记忆对照。
- `diagnostics/learning-2026-11-06T03-39-30-619Z.json`：空地点路线提示对照。
- `evaluations/learning-2026-11-06T06-57-19-880Z/report.json`：累计事实与持续目标对照。
- `diagnostics/step18-2026-11-06T07-20-36-596Z/report.json`：第18步四种提示对照。
- `diagnostics/compact-verification-2026-11-06T07-56-46-033Z/report.json`：精简候选的四场景验证。
- `diagnostics/compact-verification-2026-11-06T07-59-09-133Z/report.json`：旧提示的三个合成场景检查。

读取这些归档无需本地模型；重新执行历史诊断需要本机 Ollama 和与记录相符的 `data/newborn.sqlite`，克隆仓库不会带入原有小鹿存档。`npm test` 不依赖模型或存档。
