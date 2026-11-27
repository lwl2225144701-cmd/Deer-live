# 源码结构

| 目录 | 文件 | 职责 |
|---|---|---|
| `app/` | `cli.ts` | 命令入口、启动、日志、停止信号 |
| `app/` | `runtime.ts` | 串起观察、记忆检索、模型决策、规则接管、世界推进和保存 |
| `world/` | `world.ts` | 世界与角色状态、视野、合法动作、身体和资源规则 |
| `agent/` | `brain.ts` | 模型决策接口、提示组织和输出校验，不直接处理协议细节 |
| `agent/` | `client.ts` | Ollama 与 OpenAI 兼容协议的统一调用、鉴权、JSON Schema 和响应解析 |
| `agent/` | `learning.ts` | 探索事实汇总、候选目的地和持续目标的更新 |
| `agent/` | `memory.ts` | 地点记忆与行动经历的数据类型 |
| `agent/` | `blank.ts` / `discovery.ts` | 留白与规则发现实验的提示和动作解析，不进入正式循环 |
| `life/` | `body.ts` / `world.ts` / `observe.ts` | 身体、可替换世界与观察的旁路最小实现，尚未接入正式运行 |
| `experience/` | `types.ts` / `store.ts` / `facts.ts` | 独立经验事实的记录、聚合、检索与 JSON 持久化；`facts.ts` 负责世界事件 ↔ 经验事实的双向转换，不调用模型 |
| `thinking/` | `types.ts` / `store.ts` / `generate.ts` | 思考系统：模型基于事实写下的自我判断——生成、复核（keep/drop）、持久化与自我信念注入；事实归经验，判断归思考 |
| `calibration/` | `types.ts` / `store.ts` / `desire-audit.ts` | 校准系统：信念对账（claim vs 事实）+ 心愿账本（结构/此刻/节律三层动态判定），零模型调用；结果进入思考与动机的复核提示词 |
| `motivation/` | `types.ts` / `store.ts` / `generate.ts` | 动机系统：模型基于经历定下的心愿（必须带可核对度量），进度由现实数据机械计算，达成留档；存在心愿时决策提示改用自主权衡框架，身体信号降级为输入 |
| `storage/` | `store.ts` | SQLite 存取、事务、历史检索和上下文组装 |
| `web/` | `server.ts` / `controller.ts` | 本机2D服务、状态接口、运行控制和取消 |
| `config/` | `settings.ts` | 配置类型、默认值、JSON 加载、校验和环境变量覆盖 |

每步由 `app/runtime.ts` 调度：读取世界 → 检索经历 → 按候选动作取回经验线索 → 调用模型 → 按世界规则执行 → 原子保存 → 把观察到的身体变化写入经验库。模型失败时是否接管由运行设定决定。

世界状态变化放 `world/`，模型输入输出与目标逻辑放 `agent/`，数据库操作放 `storage/`；入口负责协调这些模块。记忆类型独立于 SQLite 实现，模型代码无需导入存档实现。

根目录的 `config/` 是用户可修改的设定文件，`src/config/` 是读取这些设定的程序。训练模块尚未实现，待有实际代码时再加入。

2D 浏览器页面与地图绘制放在根目录 `web/`，后端继续调用同一个生命循环。

根目录 `worlds/` 保存旁路实验的森林、洞穴和经验选择世界数据；它们与正式 `config/world.json` 无关。经验系统已接入正式循环：决策前按候选动作注入 `experienceHints`，行动后把事实写入 `memory.experience.path`（默认 `data/experience.json`）；持续自我状态仍未实现，不能视为已经完成自我系统。

从项目根目录使用 `npm start -- …` 或 `npm run web`；运行配置、存档和实验输出路径仍相对项目根目录解析。更多说明见 [项目 README](../README.md)。
