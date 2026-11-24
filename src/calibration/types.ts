// 校准系统的边界：这里没有任何模型调用。
// 它把思考系统的自我判断与判断写下之后的实际遭遇做机械对账：
// 判断声称什么、现实里发生了什么，逐条比对，言行不一会留在记录里。
// 判断来自思考系统（模型撰写），事实来自经验系统（纯观察），本系统只做比对。

export type BeliefClaim = { kind: 'avoid' | 'prefer'; place: string };

export type CalibrationStatus = 'untested' | 'consistent' | 'violated';

export type CalibrationRecord = {
  beliefId: string;
  statement: string;
  claim: BeliefClaim;
  status: CalibrationStatus;
  sinceTick: number;
  lastCheckedTick: number;
  claimSource?: 'model' | 'derived';
  visitsSince: number;
  hazardDamageEventsSince: number;
  emptyExploresSince: number;
  foodGainsSince: number;
  updatedAt: string;
};

export type CalibrationSummary = {
  beliefId: string;
  status: CalibrationStatus;
  visitsSince: number;
  hazardDamageEventsSince: number;
  emptyExploresSince: number;
  foodGainsSince: number;
};
