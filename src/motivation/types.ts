// 动机系统的边界：这里只保存“我要什么”——模型基于自己的经历定下的心愿。
// 心愿必须带机械可核的度量（囤粮数 / 到访某地 / 探索次数），现实进度由系统计算；
// 身体信号（饥饿、精力）不是这里的指令，只是决策时与心愿竞争的输入。

export type DesireMeasure =
  | { kind: 'food'; target: number }
  | { kind: 'visit'; place: string; target?: number }
  | { kind: 'explore'; count: number };

export type DesireStatus = 'active' | 'fulfilled' | 'abandoned';

export type Desire = {
  id: string;
  statement: string;
  measure: DesireMeasure;
  priority: number;
  status: DesireStatus;
  source: 'model';
  createdAt: string;
  createdAtTick: number;
  updatedAt: string;
  baselineVisits: Record<string, number>;
  baselineExplores: number;
  reviewCount: number;
  progress: number;
  fulfilledAtTick?: number;
};

export type DesireInput = { statement: string; measure: DesireMeasure; priority: number };

export type SelfDesire = { statement: string; priority: number; progress: number };

export type DesireVerdict = { id: string; verdict: 'keep' | 'drop' | 'adjust'; priority?: number };

// 决策提示词里的身心上下文：身体是客观信号，心愿是模型自己的目标。
export type BodyState = { hunger: number; energy: number; food: number; health: number };
