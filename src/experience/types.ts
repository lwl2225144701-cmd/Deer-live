// 经验系统的边界：这里只保存“实际发生过什么”，不保存模型对它的解释。
// 模型生成的解释必须走 Hypothesis，不得混进事实或检索结果。

export type Condition = 'can_move' | 'cannot_move';
export type InventoryItem = { id: string; name: string; count: number };

export type Situation = {
  hunger: number;
  energy: number;
  condition: Condition;
  place?: string;
  inventory?: InventoryItem[];
};

export type ObservedEffect = {
  hungerDelta: number;
  energyDelta: number;
  foodDelta: number;
  conditionAfter: Condition;
  outcome: string;
  item?: string;
};

export type ExperienceFact = {
  id: string;
  tick: number;
  action: string;
  situation: Situation;
  effect: ObservedEffect;
  source: 'observed';
  recordedAt: string;
};

export type ExperienceInput = Omit<ExperienceFact, 'id' | 'source' | 'recordedAt'> & { recordedAt?: string };

export type EffectVariant = {
  effect: ObservedEffect;
  count: number;
  firstTick: number;
  lastTick: number;
  factIds: string[];
};

export type ExperiencePattern = {
  action: string;
  situation: Situation;
  situationKey: string;
  variants: EffectVariant[];
  total: number;
  firstTick: number;
  lastTick: number;
};

export type ExperienceMatch = { pattern: ExperiencePattern; score: number };

export type Hypothesis = {
  id: string;
  statement: string;
  basisFactIds: string[];
  confidence: number;
  source: 'model';
  createdAt: string;
  updatedAt: string;
};

export type HypothesisInput = { statement: string; basisFactIds: string[]; confidence: number };

// 提供给模型提示词的经验线索：由事实聚合描述生成，不包含任何模型解释。
export type ExperienceHint = { action: string; text: string };
