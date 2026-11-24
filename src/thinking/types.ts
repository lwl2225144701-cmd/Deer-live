// 思考系统的边界：这里只保存“我认为什么”——模型基于经验事实写下的自我判断。
// 经验事实归经验系统（src/experience/），思考系统不记录事实；
// 判断必须引用已存在的经验事实 ID，检索提示词时以“自我信念”的身份出现。

export type ThinkingStatus = 'active' | 'retired';

// 可校验的声明：判断可以（可选）声明它主张什么、关于哪个地点。
// 校准系统用它和后续事实做机械对账；没有 claim 的判断无法校准。
export type BeliefClaim = { kind: 'avoid' | 'prefer'; place: string };

export type ThinkingBelief = {
  id: string;
  statement: string;
  basisFactIds: string[];
  confidence: number;
  status: ThinkingStatus;
  source: 'model';
  createdAt: string;
  updatedAt: string;
  reviewCount: number;
  claim?: BeliefClaim;
};

export type BeliefInput = { statement: string; basisFactIds: string[]; confidence: number; claim?: BeliefClaim };

// 提供给提示词的自我信念：只有判断文本与置信度，不携带行动指令。
export type SelfBelief = { statement: string; confidence: number };

// 一次复核的结果：模型对已有判断的立场。
export type ReviewVerdict = { id: string; verdict: 'keep' | 'drop' };
