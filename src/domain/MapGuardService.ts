/**
 * MapGuardService：对外统一门面。
 *
 * 串联完整工作流：
 *   编辑入库 -> 增量检测 -> 信号聚合立案 -> 高风险自动隔离 -> 人审确认/驳回
 *   -> 依赖感知回滚 -> 公众视图自动收敛
 *
 * 所有时间由调用方传入（clock），整套系统因此是确定性的：同一批事件可以在
 * 测试、离线重算和事故复盘中得到逐字节一致的结论。
 */

import { DetectionEngine } from "../detection/DetectionEngine.ts";
import type { Detector } from "../detection/Detector.ts";
import {
  BatchVelocityDetector,
  CloseRivalDetector,
  CompoundRoadOpenDetector,
  NoEvidenceRiskyDetector,
  RestrictionLiftDetector,
} from "../detection/rules/contentRules.ts";
import {
  NewActorRiskyDetector,
  RepeatTaintedDetector,
  SleeperWakeDetector,
} from "../detection/rules/actorRules.ts";
import {
  CoordClusterDetector,
  CorroborationMismatchDetector,
} from "../detection/rules/networkRules.ts";
import { EventStore } from "./EventStore.ts";
import { PublicMapView } from "./PublicMapView.ts";
import { RollbackEngine } from "../rollback/RollbackEngine.ts";
import type {
  Case,
  CaseId,
  CorroborationProvider,
  EditEvent,
  EntityId,
  MapEntity,
  RollbackReport,
  Ts,
  UserId,
} from "./types.ts";

export interface IngestInput {
  editId: string;
  ts: Ts;
  actorId: UserId;
  entityId: EntityId;
  entityType: EditEvent["entityType"];
  action: EditEvent["action"];
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  reason?: string | null;
  evidenceRefs?: string[];
  ipPrefix?: string | null;
  deviceId?: string | null;
}

export interface IngestResult {
  event: EditEvent;
  cases: Case[];
  quarantined: boolean;
}

export class MapGuardService {
  readonly store: EventStore;
  readonly engine: DetectionEngine;
  readonly rollback: RollbackEngine;
  private readonly publicView: PublicMapView;

  constructor(detectors: Detector[], engineOptions?: ConstructorParameters<typeof DetectionEngine>[2]) {
    this.store = new EventStore();
    this.engine = new DetectionEngine(this.store, detectors, engineOptions);
    this.rollback = new RollbackEngine(this.store);
    this.publicView = new PublicMapView(this.store);
  }

  registerActor(actorId: UserId, registeredAt: Ts): void {
    this.store.registerActor(actorId, registeredAt);
  }

  /** 录入一条编辑并立即跑增量检测 */
  async ingest(input: IngestInput, now: Ts): Promise<IngestResult> {
    const event = this.store.append({
      editId: input.editId,
      ts: input.ts,
      actorId: input.actorId,
      entityId: input.entityId,
      entityType: input.entityType,
      action: input.action,
      before: input.before ?? {},
      after: input.after ?? {},
      reason: input.reason ?? null,
      evidenceRefs: input.evidenceRefs ?? [],
      ipPrefix: input.ipPrefix ?? null,
      deviceId: input.deviceId ?? null,
      compensationFor: null,
      caseId: null,
    });
    const cases = await this.engine.run([event], now);
    return { event, cases, quarantined: cases.some((c) => c.quarantined) };
  }

  /** 批量补录历史数据后做一次全量检测（离线重算场景） */
  async reanalyze(now: Ts): Promise<Case[]> {
    return this.engine.run([...this.store.allEvents()], now);
  }

  // -- 人审处置 -------------------------------------------------------------

  confirm(caseId: CaseId, reviewer: string, note: string, now: Ts): Case {
    return this.engine.confirm(caseId, reviewer, note, now);
  }

  dismiss(caseId: CaseId, reviewer: string, note: string, now: Ts): Case {
    return this.engine.dismiss(caseId, reviewer, note, now);
  }

  executeRollback(caseId: CaseId, operator: string, now: Ts, force = false): RollbackReport {
    const c = this.engine.getCase(caseId);
    if (!c) throw new Error(`案件不存在: ${caseId}`);
    if (c.status !== "confirmed_malicious" && c.status !== "partially_rolled_back") {
      throw new Error(`案件 ${caseId} 状态为 ${c.status}，确认恶意后才能回滚`);
    }
    return this.rollback.rollback(c, now, { operator, force });
  }

  // -- 视图 -----------------------------------------------------------------

  /** 普通用户看到的实体（自动排除隔离编辑的影响） */
  publicEntity(id: EntityId): MapEntity | null {
    return this.publicView.getVisibleEntity(id, this.engine.quarantinedEditIds());
  }

  publicEntities(): Map<EntityId, MapEntity> {
    return this.publicView.getVisibleEntities(this.engine.quarantinedEditIds());
  }

  /** 审核端看到的实体（含隔离中的待审状态） */
  internalEntity(id: EntityId): MapEntity | null {
    return this.store.getEntity(id);
  }

  listCases(): Case[] {
    return this.engine.listCases();
  }

  getCase(caseId: CaseId): Case | null {
    return this.engine.getCase(caseId);
  }
}

/** 标准检测器全家桶工厂（佐证源可选接入） */
export function buildDefaultDetectors(corroborators: CorroborationProvider[] = []): Detector[] {
  return [
    new CloseRivalDetector(),
    new CompoundRoadOpenDetector(),
    new RestrictionLiftDetector(),
    new NoEvidenceRiskyDetector(),
    new BatchVelocityDetector(),
    new SleeperWakeDetector(),
    new NewActorRiskyDetector(),
    new RepeatTaintedDetector(),
    new CoordClusterDetector(),
    new CorroborationMismatchDetector(corroborators),
  ];
}
