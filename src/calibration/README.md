# 校准系统

位置：`src/calibration/`。回答一个问题：**这只鹿说到的，做到了吗**。

## 三层分工

| 系统 | 内容 | 谁写 | 位置 |
|---|---|---|---|
| 经验系统 | 发生了什么 | 观察事实，系统聚合 | `data/experience.json` |
| 思考系统 | 我认为什么 | 模型撰写的自我判断 | `data/thinking.json` |
| 校准系统（本模块） | 我说对了吗 | **现实**——机械对账，零模型调用 | `data/calibration.json` |

## 工作方式

1. 思考系统的判断可以携带 **claim**：`{ kind: 'avoid' | 'prefer', place }`——这条判断主张在哪个地点回避或偏好什么；
2. 校准系统每步把判断写下**之后**、发生在 claim 地点的**新事实**与 claim 比对：
   - `avoid`：出现危害损失（结果文本带“危险”）或空手探索 → `violated`；只路过无损失 → `consistent`；没去过 → `untested`；
   - `prefer`：拿到食物 → `consistent`；空手探索 → `violated`；
3. 记录是**累计**的：violation 不会因时间流逝自动洗白——恢复只有一条路，模型在思考复核时面对“你的判断和你的遭遇不一致”自己 drop 或修正；
4. 校准摘要随思考复核提示词下发（`calibration` 字段），模型自评从此有了现实锚。

## 明确不做

- 不调用模型（整个系统的可信度恰恰来自这一点）；
- 不自动删除或降级判断——裁判提供事实，处置权在思考复核；
- 不解释因果：它只报告“判断写下后在某地发生了什么”，不判定“是否因为这条判断”。

## 使用

```bash
npm start -- calibration       # 查看对账记录
DEER_LIVE_CALIBRATION=0 npm start -- live   # 关闭校准
```

配置段 `calibration`：`enabled`、`path`（默认 `data/calibration.json`）。

测试：`node --test test/calibration.test.ts`。
