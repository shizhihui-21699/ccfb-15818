/**
 * 检测器接口与规则体系。
 *
 * 每条规则只负责一件事：在给定上下文里找出它认识的异常模式，产出 0..n 个信号。
 * 规则之间不互相调用、不直接处置账号——聚合、升级和立案由 DetectionEngine 统一完成。
 * 这样新增攻击模式时只需加一个 Detector，也可以按业务情况单独调权或关停规则。
 */

import type { ActorProfile } from "../domain/EventStore.ts";
import type {
  CorroborationProvider,
  EditEvent,
  Signal,
  Ts,
} from "../domain/types.ts";
import type { ActorFeatures, EditFeatures } from "../domain/features.ts";

/** 检测上下文：规则需要的一切数据都从这里取，保证规则本身无状态、可重放 */
export interface DetectionContext {
  now: Ts;
  /** 待评估的编辑（增量检测时通常是新入库的一批） */
  candidateEdits: EditEvent[];
  /** 事件存储读出的全量事件（规则自行过滤） */
  allEdits: readonly EditEvent[];
  /** 取编辑生效前的实体快照 */
  stateBefore(editId: string): import("../domain/types.ts").MapEntity | null;
  /** 取账号画像 */
  actorProfile(actorId: string): ActorProfile;
  /** 取账号特征（内部基于画像计算） */
  actorFeatures(actorId: string): ActorFeatures;
  /** 取编辑特征 */
  editFeatures(edit: EditEvent): EditFeatures;
  /** 外部佐证源（可能为空数组，表示没有接入任何真相源） */
  corroborators: CorroborationProvider[];
}

/** 信号家族：用于引擎计算「多维度交叉」加成，避免单一信号类型自我强化 */
export type RuleFamily = "content" | "actor" | "network" | "corroboration";

export interface Detector {
  readonly ruleId: string;
  readonly family: RuleFamily;
  readonly description: string;
  /** 该规则产出信号的默认级别 */
  readonly defaultLevel: Signal["level"];
  detect(ctx: DetectionContext): Promise<Signal[]> | Signal[];
}

/** 规则可调参数：阈值与权重集中管理，便于用真实数据做校准 */
export interface RuleTuning {
  enabled: boolean;
  /** 置信度乘子（0~1），校准用 */
  weight: number;
  params?: Record<string, number | string | boolean>;
}

export const DEFAULT_TUNING: Record<string, RuleTuning> = {
  "R-CLOSE-RIVAL": { enabled: true, weight: 1, params: { minBatchSize: 3 } },
  "R-COMPOUND-OPEN": { enabled: true, weight: 1 },
  "R-RESTRICTION-LIFT": { enabled: true, weight: 0.9 },
  "R-NO-EVIDENCE-RISKY": { enabled: true, weight: 0.7 },
  "R-BATCH-VELOCITY": { enabled: true, weight: 0.9, params: { windowHours: 6, minBatch: 5 } },
  "R-SLEEPER-WAKE": { enabled: true, weight: 1 },
  "R-NEW-ACTOR-RISKY": { enabled: true, weight: 0.8, params: { maxAccountAgeDays: 14 } },
  "R-REPEAT-TAINTED": { enabled: true, weight: 1 },
  "R-COORD-CLUSTER": { enabled: true, weight: 1 },
  "R-CORROBORATION-MISMATCH": { enabled: true, weight: 1 },
};
