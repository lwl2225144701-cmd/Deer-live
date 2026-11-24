# DeerLive

DeerLive 是一个生活在小世界里、能够逐渐熟悉用户的数字小生命项目。当前为 **v0.5 本地 2D 实验原型**：角色定位是一只刚出生的小鹿，首要目标是养活自己，在真实行动经历中逐步适应世界。模型选择动作，世界规则执行，SQLite 保存状态、地点观察和行动前后的身体变化。行为质量与学习效果仍在验证中。

## 运行

需要 Node.js 22.18 或更新版本，无需安装第三方依赖。Node.js 22 的内置 SQLite 可能显示 ExperimentalWarning。模型选择动作有两种接法：本机 Ollama（默认，需要已下载对应模型），或 OpenAI 兼容的云端服务（见下文「模型服务」）。程序不会自动下载模型。

```bash
DEER_LIVE_DB=data/newborn.sqlite npm run web  # 打开本地2D世界：http://127.0.0.1:4317
npm start -- init         # 初始化或读取已有世界
npm start -- live 6       # 让配置的模型选择并执行 6 次动作
npm start -- run 1000     # 持续运行，每次决策完成后等待 1000 毫秒
npm start -- status       # 查看世界和最近 10 条事件
npm start -- memories     # 查看当前可检索的地点记忆
npm start -- experiences  # 查看行动经历及前后身体状态
npm start -- patterns     # 查看经验库统计和当前情境可检索的经验线索
npm start -- thinking     # 查看自我判断：模型基于经历写下的信念
npm start -- calibration  # 查看自我判断的现实对账记录
npm start -- learning     # 查看累计探索事实、最近折返和当前目标
npm start -- settings     # 查看配置来源和实际设定值，不创建或修改存档
npm start -- step 20      # 规则驱动推进 20 次，不调用模型
npm test                  # 自动化测试，不需要 Ollama
npm run evaluate:local    # 有无记忆的单场景本机对照实验
npm run evaluate:learning # 在 newborn.sqlite 副本对照新旧输入，并严格运行四步
```

2D 页面打开时先暂停，可观察现有存档、让模型走一步或连续生活。详见 [2D 使用说明](docs/product/2D原型使用说明.md)。

按 `Ctrl+C` 停止：未提交的推理会取消，已经完成的行动均有存档。持续运行会串行等待模型，避免多个推理重叠。

默认存档为 `data/deer-live.sqlite`，重复启动会恢复；可用 `DEER_LIVE_DB` 指定其他路径。旧 M0 存档会保留角色属性和时间，读取时补入默认地点和探索记录，下一次行动时保存为新版本。

| 环境变量 | 默认值 | 作用 |
|---|---|---|
| `DEER_LIVE_MODEL` | 配置里的 `model.name` | 临时覆盖模型名，不改变 provider/baseUrl；不建议长期使用 |
| `DEER_LIVE_TIMEOUT_MS` | 配置里的 `model.timeoutMs` | 单次推理超时毫秒数 |
| `DEER_LIVE_STRICT` | 未设置 | 设置为 `1` 时，推理失败直接停止，不使用规则接管 |
| `DEER_LIVE_DB` | `data/deer-live.sqlite` | 指定世界存档 |
| `DEER_LIVE_EXPERIENCE` | 配置里的 `memory.experience.enabled` | 设置为 `0` 关闭经验记录与线索注入，`1` 开启 |
| `DEER_LIVE_EXPERIENCE_PATH` | `data/experience.json` | 指定经验库文件路径 |
| `DEER_LIVE_THINKING` | 配置里的 `thinking.enabled` | 设置为 `0` 关闭思考复核，`1` 开启 |
| `DEER_LIVE_THINKING_PATH` | `data/thinking.json` | 指定思考库文件路径 |
| `DEER_LIVE_CALIBRATION` | 配置里的 `calibration.enabled` | 设置为 `0` 关闭现实对账，`1` 开启 |
| `DEER_LIVE_CALIBRATION_PATH` | `data/calibration.json` | 指定校准库文件路径 |
| `DEER_LIVE_CONFIG` | `deerlive.config.json` | 选择另一份运行配置文件 |

## 模型服务

模型只在一个地方配置：[deerlive.config.json](deerlive.config.json) 的 `model` 段。`provider` 决定协议：

| provider | 请求 | 必需字段 |
|---|---|---|
| `ollama` | `POST /api/chat` | `name` 必须是本机已下载模型 |
| `openai-compatible` | `POST /chat/completions` | `name`、`baseUrl`、`apiKey` |

Step Plan 通道示例（订阅额度，OpenAI 协议）：

```json
"model": {
  "provider": "openai-compatible",
  "name": "step-5-preview",
  "baseUrl": "https://api.stepfun.com/step_plan/v1",
  "apiKey": "",
  "timeoutMs": 120000,
  "numPredict": 2048,
  "temperature": 0.6,
  "topP": 0.95,
  "reasoningEffort": ""
}
```

- `baseUrl` 的路径会保留，请求发往 `${baseUrl}/chat/completions`；不要在末尾再写 `/chat/completions`。
- `apiKey` 留空时，`live`、`run` 和实验会在发请求前明确报错，不会静默退回规则模式。填入后即可运行，不需要设置环境变量。
- `numPredict` 映射为云服务的 `max_tokens`；思考内容也占用这一额度，推理模型建议留足余量。
- `numCtx` 和 `seed` 只对 Ollama 生效；OpenAI 兼容协议不发送这两个字段，云端采样不由种子控制。
- `reasoningEffort`（`low` / `medium` / `high` / 留空）只对支持推理强度的云模型发送。
- 配置里的 `apiKey` 是本机明文。`deerlive.config.json` 受 Git 跟踪，**不要把真实 Key 提交到远程仓库**；提交前请清空，或仅在本地保存。

## 世界、角色和运行设定

| 文件 | 内容 | 生效方式 |
|---|---|---|
| [config/world.json](config/world.json) | 地图大小、地点、食物初始库存及容量、资源恢复周期 | 地图及初始库存用于新存档；恢复周期在下次运行生效 |
| [config/deer.json](config/deer.json) | 新生小鹿的身份、描述、动机，以及初始位置和身体状态 | 身份与动机从下次决策使用；初始名字、位置和数值仅用于新存档 |
| [deerlive.config.json](deerlive.config.json) | 两份配置的路径、身体规则、记忆数量、模型服务、运行及存档位置 | 下次启动读取；环境变量可临时覆盖同名运行设置 |

角色默认设为 `species: deer`、`lifeStage: newborn`，初始食物为 **0 份**。它具有寻找食物与休息的基本本能，具体地点和行动结果通过经历积累。目前没有自动年龄增长、受伤或死亡机制；“养活自己”是其行动目标。

常用默认设定如下，状态均限制在 0–100：

| 参数 | 默认值 | 含义 |
|---|---:|---|
| `life.hungryAt` | 60 | 饥饿达到此值时需要进食或找食物 |
| `life.tiredAt` | 30 | 精力低于或等于此值时需要休息 |
| `life.curiousAt` | 60 | 好奇心达到此值时倾向探索 |
| `life.hungerPerTick` / `curiosityPerTick` | 2 / 3 | 每步饥饿和好奇心增长 |
| `life.moveEnergyCost` / `exploreEnergyCost` | 3 / 5 | 移动和探索消耗的精力 |
| `life.restEnergyGain` | 15 | 一次休息恢复的精力 |
| `life.eatHungerRelief` | 35 | 一份食物减少的饥饿 |
| `life.exploreCuriosityRelief` | 35 | 一次探索减少的好奇心 |
| `life.visionRadius` | 1 | 能观察到周围多远 |
| 世界配置的 `foodRegrowEveryTicks` | 60 | 每隔多少个模拟 tick 恢复一份资源 |
| `memory.maxRecall` / `maxExperiences` | 6 / 4 | 最多提供多少条地点记忆和行动经历 |
| `memory.experience.enabled` | `true` | 是否记录经验事实并在决策前注入经验线索 |
| `memory.experience.path` | `data/experience.json` | 经验库文件，跨重启、跨存档保留 |
| `memory.experience.maxPatterns` / `maxPerAction` | 8 / 1 | 每次注入的线索总数上限 / 每个候选动作取回上限 |
| `memory.experience.minObservations` | 1 | 模式至少被观察到多少次才会被取回 |
| `thinking.enabled` | `true` | 是否定期复核自我判断并把判断注入决策提示 |
| `thinking.path` | `data/thinking.json` | 思考库文件，跨重启保留模型写下的判断 |
| `thinking.everyTicks` | 10 | 每隔多少步做一次思考复核 |
| `thinking.maxBeliefsInPrompt` | 5 | 每次决策最多携带多少条自我信念 |
| `calibration.enabled` | `true` | 是否对带 claim 的自我判断做现实对账 |
| `calibration.path` | `data/calibration.json` | 校准库文件，跨重启保留言行记录 |

死亡与季节性食物（`foodCycle`、饥饿顶格耗体力、体力归零终局）已进入世界规则：旧存档自动补满体力，规则反射鹿在默认世界约 240 步饿死——想活多久，取决于心智。

阈值由规则模式采用，并提供给模型参考；不保证模型始终作出合理选择。配置只需填写要覆盖的字段，省略的字段使用内置默认值；地点数组整体替换。文件引用路径相对运行配置文件解析，存档路径相对当前工作目录解析。未知字段、越界位置或无效数值会报错，不会重置现有存档。

要体验从出生状态开始的新世界，请使用一个尚未使用过的存档路径，例如：

```bash
DEER_LIVE_DB=data/newborn.sqlite npm start -- live 6
```

已有存档会保留现有角色、时间和资源，不会因更换初始设定而重新出生。

## 当前世界与记忆

- 5×5 网格，包含小屋、浆果丛、苹果树、池塘和草地；角色有饥饿、精力、好奇心及随身食物。
- 探索只作用于脚下位置；只有地点存在食物时才会采集。地点资源每 60 个模拟 tick 恢复一份，不超过容量。
- 模型只看到周围一格和检索出的记忆，不接收整张世界地图。动作由固定 ID 选择，并由世界规则校验。
- 每次探索产生真实地点观察；检索按需求、距离和时间排序，最多提供六条，同一地点的新观察替代旧观察。原始事件保留在数据库中。
- 每次行动还保存角色的前后状态，模型可看到实际饥饿、精力、好奇心和食物变化。检索保留每类行动的最新经历，避免重复走动挤掉过去的进食或休息经验。旧事件没有记录过的身体变化不会补造。
- 程序仅为记忆中尚有食物的地点提供第一步方向提示；模型决定是否采用。控制台中的“模型选择”是动作说明，不是模型的思考过程；“已提供记忆”也不代表模型实际利用了它。
- 状态与事件在同一 SQLite 事务内保存；过期写入被拒绝，防止两个实例覆盖同一存档。

模型异常时，默认使用基础规则维持活动，日志和事件标为 `fallback` 并记录错误；模型执行标为 `ollama`（历史命名，表示“由模型决定”，与使用哪种协议无关），主动规则模式标为 `rule`。严格模式可用于检验模型自身的表现。提供经历代表信息已进入模型上下文，不等于已验证它学会世界规则，也不表示在训练模型权重。

采样参数统一从配置读取：Ollama 发送 temperature、top_p、num_predict、num_ctx 和 seed；OpenAI 兼容服务发送 temperature、top_p、max_tokens，`numCtx`、`seed` 不发送。提示与采样最初参考 [DeepSeek 官方用法建议](https://huggingface.co/deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B#usage-recommendations)，现在不再绑定具体模型。模型输出动作 JSON；没有现存探索目标时，另输出目标坐标或 `none`，不要求生成理由。

## 累计经历与持续目标（v0.4）

每次决策汇总真实探索历史：每个地点尝试几次、几次没采到食物、累计采集量及精力消耗，并保留最早和最近事件 tick。采完最后一份食物不算失败；缺少前后状态的旧事件不补造统计。提示最多包含六处，优先当前位置、目标位置及附近地点；完整事件仍保留。最近六步的移动路径与原路折返次数也会提供，并标注模型/规则来源。

探索目的地由模型从当前视野和统计中记得有食物的地点选择，也可以暂不设目标。目标随事件原子保存，重启、吃饭、休息后保留；到达后实际探索才完成。连续四次移动未刷新最近距离时，程序释放目标供模型重选。这是工程上的目标管理规则，不是模型学会的策略。目标和累计信息不删减合法动作，也不自动替模型走路。

旧存档下次运行即可使用历史记录，无需重新出生。`learning` 输出的是可提供给下一次决策的信息；事件中的 `learning.offered` 记录该步上下文，`goalBeforeAction` / `goalAfter` 记录行动前后目标。`rule` 行动并未调用模型；规则接管完成的目标也不算模型成功。统计归纳由程序计算，不涉及模型权重训练，行为是否改善需另行实测。

## 本机实测与限制

2026 年 11 月 6 日，v0.2 阶段已实际连接现有 DeepSeek-R1 1.5B。接入调试中观察到输出截断、虚构理由和动作理解错误；缩小任务为动作选择后，得到可执行输出，但不代表决策质量已达标。以下是该阶段的历史实测，不是新生角色设定的行为验收结果。

本次严格模式实际保存五步模型行动，每步约 7.1–12.9 秒，第六步因输出截断停止；其中出现低饥饿值时连续进食的现象。最终记忆对照中，有无记忆均选择向东，未返回西侧已知食物点，结论为 `not-demonstrated`（退出码 2）。因此本轮确认的是接入、执行与持久化链路；尚不能确认该模型已胜任自主探索和记忆利用。

记忆实验先通过真实世界动作产生浆果丛观察，再把角色带回食物点视野之外，分别提供和移除记忆。该脚本采用固定默认场景和身体规则，读取配置中的模型运行参数，不使用自定义初始地图和角色。实验每个条件仅调用一次，且不使用规则接管；原始输入、选择和延迟的历史归档见 `docs/evidence/evaluations/2026-11-06T03-09-19-687Z.json`；新运行仍写入 `data/local-evaluation.json`，并保留到 `data/evaluations/`。两种条件均成功返回动作且仅有记忆时朝已知食物方向移动，才记为 `observed-once`；其他有效输出记为 `not-demonstrated`，推理失败记为 `inference-error`。命令退出码分别为 0、2、1。一次对照不具有统计显著性，也不能证明长期记忆能力。

自动化测试验证动作约束、资源消耗、存档兼容与恢复、记忆更新及长期检索、事务回滚、推理超时和接管边界。它们不替代真实模型行为评测。

v0.3 阶段的 20 项自动化测试通过，补充了独立配置校验、配置实际生效、已有存档保护、行动经历传递及空地点提示回归验证。独立存档本机测试先完成一次规则移动，再由本地模型完成一次行动（约 10.2 秒），该次请求提供了前一步真实经历。记录见 `docs/evidence/newborn-smoke.json`。这只验证新设定的执行链路，不证明它已学会世界规则。

针对新生小鹿重复探索空地点的问题，已完成本机对照并修复空地点被附上行动提示的输入问题；原存档未推进。结果和仍存在的机制限制见 [学习行为限制排查](docs/research/学习行为限制排查-20261106.md)。

v0.4 阶段 25 项自动化测试通过。新增模块已在第 12 步存档副本上真实调用本地模型：两个种子的新旧输入均选择继续折返；随后严格运行成功三步，目标虽保存但模型走远，第四步输出截断停止。尚未观察到行为改善，原存档未推进。详细输入和结果见 [v0.4 本机验证记录](docs/evidence/evaluations/learning-2026-11-06T06-57-19-880Z/report.json)。

目前逐动作推理，响应较慢；v0.4.1 阶段尚无 2D 界面、用户关系记忆、性格成长、屏幕观察或桌面形态，也未完成 24 小时真实运行验证。后续重点是提高决策合理性和记忆利用，再扩展表现层。

产品方向见 [讨论纪要](docs/product/产品形态与开发方向讨论纪要-V1.0.md)，原始规划见 [立项书](docs/product/项目立项书-V1.0.md)。


v0.4.1 新增提示组织对照与精简候选实验入口；默认运行保留原提示。精简候选将最近一次真实经历写成短句，保留地点记忆、身体变化和模型目标。26 项自动化测试通过。第 18 步原提示三次中两次截断、一次重复空探索；实验精简版三次都离开。候选版本以三个新种子复查，也都离开该地点，但仍选择旧位置，目标与行动可能不一致；独立的进食、休息、恢复资源采集场景仍未达到预期。当前只观察到特定重复探索场景的局部改善，不能确认生存能力或持续学习达标。对照与局限见 [最新排查结果](docs/research/学习行为限制排查-20261106.md)。

可用 `node scripts/diagnostics/verify-compact.ts` 显式重跑候选提示的四场景验证，结果保存到 `data/diagnostics/`，不执行模型动作。追加 `docs/evidence/diagnostics/step18-2026-11-06T07-20-36-596Z/report.json --previous` 可对照归档中的旧提示在三个合成场景的表现。它们都是小样本单步观察。


## 仓库内容

```text
deer-live/
├── src/
│   ├── app/              # CLI 入口与生命循环调度
│   ├── world/            # 世界、身体和资源规则
│   ├── agent/            # 模型协议适配、决策、经历类型与持续目标
│   ├── storage/          # SQLite 存档与历史检索
│   ├── config/           # 配置加载与校验
│   └── web/              # 本机网页服务与运行控制
├── web/                  # 2D页面、Canvas地图和小鹿素材
├── config/               # 世界资源和新生角色配置
├── test/                 # 无需本地模型的自动化测试
├── scripts/
│   ├── evaluation/       # 行为对照与副本运行评测
│   └── diagnostics/      # 历史决策重建与提示诊断
├── docs/
│   ├── product/          # 立项书和产品方向
│   ├── research/         # 调研与行为排查结论
│   └── evidence/         # 已归档的实验输入、输出和统计
├── data/                 # 本机存档与新运行结果，Git 忽略
├── deerlive.config.json  # 运行配置入口
└── package.json          # 启动、测试与实验命令
```

源码职责见 [源码结构](src/README.md)，阅读入口见 [文档索引](docs/README.md)，实验命令和前置条件见 [脚本说明](scripts/README.md)。本地存档及新运行结果写入被忽略的 `data/`，克隆仓库后会从新世界开始。

当前核心目标是让经历带来可持续、可迁移且重启后保留的行为改善。模型训练尚未开始；本机 M1 / 8GB 仅完成小规模 QLoRA 可行性评估，实际训练内存、速度和效果均待验证。


v0.5 新增本机 2D 界面、参考形象生成的卡通小鹿、真实状态和日记、单步/连续运行/暂停取消；仍复用原有世界与模型循环。30 项自动化测试通过，新增网页状态读取、来源边界、暂停取消、并发限制和严格模式/规则接管检查。支持桌面与窄屏，模型成长与训练仍未实现。

## 后续旁路实验

2026 年 11 月 13–16 日增加了不进入正式生命循环的留白、身体/世界分离和经验复用探针，代码位于 `src/life/`、`src/experience/`、`worlds/` 和 `scripts/experiments/`。这些实验尚未实现持续自我系统，也未改变上述 v0.5 行为。经验记录、聚合、检索与持久化已抽成独立模块 [src/experience/](src/experience/README.md)，目前不调用模型，也尚未接入正式循环。阶段结果、限制和归档证据见 [自我系统实验进度](docs/research/自我系统实验进度-20261116.md)，实验配置与命令见 [脚本说明](scripts/README.md)。
