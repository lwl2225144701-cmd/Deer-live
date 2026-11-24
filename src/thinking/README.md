# 思考系统

位置：`src/thinking/`。回答一个问题：**这只鹿对 自己的经历怎么看**。

## 与经验系统的分工

| 经验系统（`src/experience/`） | 思考系统（本模块） |
|---|---|
| 只存事实：实际发生过什么、身体变化多少 | 只存判断：模型基于事实写下的自我看法 |
| 系统聚合，模型解释不进入事实 | 内容完全来自模型，系统只负责结构与约束 |
| 检索返回"过去观察" | 提示词携带"自我信念" |

判断必须引用已存在的经验事实 ID（由经验系统同步进来），防止凭空观点。经验系统自身的 `addHypothesis` 仍保留为底层原语，正式循环只使用本模块。

## 生命周期

1. **写入**：定期（`thinking.everyTicks`）把最近事实、聚合模式、已有判断交给模型，让它 (a) 对每条已有判断给出 `keep/drop`，(b) 最多补充 3 条新判断（statement ≤100 字，必须引用事实 ID，confidence 0–1）；
2. **复核**：`keep` 累计 `reviewCount`；`drop` 转入 `retired`（保留不删除）；完全相同的文本视为再次确认，合并证据并更新置信度，不产生重复；
3. **携带**：每次模型决策前，active 判断按置信度排序取前 `maxBeliefsInPrompt` 条，以 `selfBeliefs` 注入提示词，声明"像自己的经验之谈一样对待，可以用新经历修正"；
4. **持久化**：JSON 原子写盘（`thinking.path`），重启后判断仍在。

复核失败不阻塞生存循环：日志可见，世界照常推进。

## 明确不做

- 不记录事实、不调用决策之外的第二个行动模型；
- 判断不携带行动指令，系统不把"避开某地"翻译成禁令——是否采纳仍由模型决定；
- 复核是模型自评，不是客观验证：判断可能被后续事实推翻，这正是设计（可信度由 reviewCount 与置信度共同表达）。

## 使用

```bash
npm start -- thinking          # 查看自我判断与复核状态
DEER_LIVE_THINKING=0 npm start -- live   # 关闭思考复核
```

配置段 `thinking`：`enabled`、`path`（默认 `data/thinking.json`）、`everyTicks`、`maxActive`、`maxBeliefsInPrompt`。

测试：`node --test test/thinking.test.ts`。
