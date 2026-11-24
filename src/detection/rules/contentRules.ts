/**
 * 编辑内容与节奏类规则。
 *
 * 关键克制：这些规则单独命中时大多只给 review 级信号——因为真实世界确实在变化，
 * 真实关店、真实道路开通每天都在发生。只有和行为者/协同/佐证类信号叠加后，
 * 才由引擎升级为 escalate。
 */

import { extractBatch, getFeature, hasFeature } from "../../domain/features.ts";
import type { Signal, Ts } from "../../domain/types.ts";
import type { DetectionContext, Detector } from "../Detector.ts";

const HOUR = 3600 * 1000;

function signal(
  ruleId: string,
  level: Signal["level"],
  confidence: number,
  explanation: string,
  evidence: Record<string, unknown>,
  ts: Ts,
  subject: Signal["subject"],
): Signal {
  return { ruleId, level, confidence: Math.round(confidence * 100) / 100, explanation, evidence, ts, subject };
}

// ---------------------------------------------------------------------------
// R-CLOSE-RIVAL：批量把他人认领的商户标记关闭
// ---------------------------------------------------------------------------

export class CloseRivalDetector implements Detector {
  readonly ruleId = "R-CLOSE-RIVAL";
  readonly family = "content" as const;
  readonly description = "非认领人批量把商户标记为关闭/暂停营业";
  readonly defaultLevel = "review" as const;

  private readonly minBatch: number;
  private readonly lookbackMs: number;

  constructor(minBatch = 3, lookbackMs = 24 * HOUR) {
    this.minBatch = minBatch;
    this.lookbackMs = lookbackMs;
  }

  detect(ctx: DetectionContext): Signal[] {
    const out: Signal[] = [];
    // 以本次入库编辑涉及的账号为触发点，但聚合范围是全量事件——
    // 增量入库时每条编辑单独评估，也必须能看到该账号此前的同类操作
    const triggerActors = new Set<string>();
    for (const edit of ctx.candidateEdits) {
      if (edit.entityType !== "place") continue;
      const f = ctx.editFeatures(edit);
      if (!hasFeature(f, "place_set_closed")) continue;
      if (getFeature(f, "actor_is_claimant")?.value === true) continue;
      triggerActors.add(edit.actorId);
    }

    for (const actorId of triggerActors) {
      const edits = ctx.allEdits.filter((e) => {
        if (e.actorId !== actorId || e.entityType !== "place") return false;
        if (ctx.now - e.ts > this.lookbackMs) return false;
        const f = ctx.editFeatures(e);
        if (!hasFeature(f, "place_set_closed")) return false;
        // 本人认领店铺的关店是正常经营行为，直接排除
        return getFeature(f, "actor_is_claimant")?.value !== true;
      });
      if (edits.length === 0) continue;

      const isBatch = edits.length >= this.minBatch;
      const confidence = Math.min(0.95, 0.45 + 0.12 * edits.length);
      out.push(
        signal(
          this.ruleId,
          isBatch ? "escalate" : "review",
          isBatch ? confidence : confidence * 0.7,
          isBatch
            ? `账号 ${actorId} 在 ${this.lookbackMs / HOUR} 小时内把 ${edits.length} 家非本人认领商户标记关闭，符合打击竞争对手模式`
            : `账号 ${actorId} 关闭了非本人认领的商户（近 ${this.lookbackMs / HOUR} 小时共 ${edits.length} 家），需核实`,
          {
            actorId,
            closedEntities: edits.map((e) => e.entityId),
            batchSize: edits.length,
            windowHours: this.lookbackMs / HOUR,
            allThirdParty: true,
          },
          ctx.now,
          isBatch
            ? { kind: "cluster", editIds: edits.map((e) => e.editId), actorIds: [actorId] }
            : { kind: "edit", editId: edits[0]!.editId },
        ),
      );
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// R-COMPOUND-OPEN：把小区内部道路改成可通行（引导车流穿行）
// ---------------------------------------------------------------------------

export class CompoundRoadOpenDetector implements Detector {
  readonly ruleId = "R-COMPOUND-OPEN";
  readonly family = "content" as const;
  readonly description = "把小区/园区内部道路改为社会车辆可通行";
  readonly defaultLevel = "review" as const;

  detect(ctx: DetectionContext): Signal[] {
    const out: Signal[] = [];
    for (const edit of ctx.candidateEdits) {
      if (edit.entityType !== "road") continue;
      const f = ctx.editFeatures(edit);
      if (!hasFeature(f, "road_opened_compound")) continue;
      const profile = ctx.actorProfile(edit.actorId);
      // 小区道路开放影响周边居民，通常应由有历史贡献的账号带佐证发起
      const weakActor = profile.totalEdits < 10;
      out.push(
        signal(
          this.ruleId,
          weakActor && edit.evidenceRefs.length === 0 ? "escalate" : "review",
          0.6 + (weakActor ? 0.15 : 0) + (edit.evidenceRefs.length === 0 ? 0.1 : 0),
          `小区 ${f.prior?.type === "road" ? f.prior.compoundId : ""} 的内部道路被改为可通行，` +
            (edit.evidenceRefs.length === 0 ? "且未提供物业/交管佐证" : "附带了佐证需核验"),
          {
            actorId: edit.actorId,
            entityId: edit.entityId,
            compoundId: f.prior?.type === "road" ? f.prior.compoundId : null,
            actorTotalEdits: profile.totalEdits,
            evidenceCount: edit.evidenceRefs.length,
          },
          edit.ts,
          { kind: "edit", editId: edit.editId },
        ),
      );
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// R-RESTRICTION-LIFT：解除/关闭路口限行
// ---------------------------------------------------------------------------

export class RestrictionLiftDetector implements Detector {
  readonly ruleId = "R-RESTRICTION-LIFT";
  readonly family = "content" as const;
  readonly description = "关闭路口限行规则，可能为违规车流开路";
  readonly defaultLevel = "review" as const;

  detect(ctx: DetectionContext): Signal[] {
    const out: Signal[] = [];
    for (const edit of ctx.candidateEdits) {
      if (edit.entityType !== "restriction") continue;
      const f = ctx.editFeatures(edit);
      const lifted = hasFeature(f, "restriction_deactivated") || edit.action === "delete";
      if (!lifted) continue;
      const noEvidence = edit.evidenceRefs.length === 0;
      out.push(
        signal(
          this.ruleId,
          noEvidence ? "escalate" : "review",
          noEvidence ? 0.75 : 0.5,
          noEvidence
            ? `限行规则 ${edit.entityId} 被关闭且无交管公告等佐证，可能放行违规车流`
            : `限行规则 ${edit.entityId} 被关闭，已附佐证需核验`,
          {
            actorId: edit.actorId,
            entityId: edit.entityId,
            evidenceCount: edit.evidenceRefs.length,
            action: edit.action,
          },
          edit.ts,
          { kind: "edit", editId: edit.editId },
        ),
      );
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// R-NO-EVIDENCE-RISKY：高风险改动却零佐证（通用兜底规则）
// ---------------------------------------------------------------------------

const RISKY_FIELDS: Record<string, string[]> = {
  place: ["status"],
  road: ["openToTraffic", "roadClass", "oneway"],
  restriction: ["active", "rule"],
};

export class NoEvidenceRiskyDetector implements Detector {
  readonly ruleId = "R-NO-EVIDENCE-RISKY";
  readonly family = "content" as const;
  readonly description = "高风险字段变更未附带任何佐证材料";
  readonly defaultLevel = "info" as const;

  detect(ctx: DetectionContext): Signal[] {
    const out: Signal[] = [];
    for (const edit of ctx.candidateEdits) {
      if (edit.evidenceRefs.length > 0) continue;
      const watched = RISKY_FIELDS[edit.entityType];
      if (!watched) continue;
      const touched = Object.keys(edit.after).filter((k) => watched.includes(k));
      if (touched.length === 0) continue;
      out.push(
        signal(
          this.ruleId,
          "info",
          0.4,
          `高风险字段 ${touched.join("、")} 的变更没有佐证材料`,
          { actorId: edit.actorId, entityId: edit.entityId, touchedFields: touched },
          edit.ts,
          { kind: "edit", editId: edit.editId },
        ),
      );
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// R-BATCH-VELOCITY：时间窗内同类批量操作（慢速拆分也能被累计窗口捕获）
// ---------------------------------------------------------------------------

export class BatchVelocityDetector implements Detector {
  readonly ruleId = "R-BATCH-VELOCITY";
  readonly family = "content" as const;
  readonly description = "短时间内对同类实体执行同字段批量修改";
  readonly defaultLevel = "review" as const;

  private readonly windowHours: number;
  private readonly minBatch: number;

  constructor(windowHours = 6, minBatch = 3) {
    this.windowHours = windowHours;
    this.minBatch = minBatch;
  }

  detect(ctx: DetectionContext): Signal[] {
    const out: Signal[] = [];
    const seen = new Set<string>();
    const windowMs = this.windowHours * HOUR;

    for (const anchor of ctx.candidateEdits) {
      const batch = extractBatch(anchor.actorId, anchor, ctx.allEdits, windowMs);
      if (batch.count < this.minBatch) continue;
      const key = `${anchor.actorId}:${anchor.entityType}:${batch.sameField ?? "*"}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(
        signal(
          this.ruleId,
          "escalate",
          Math.min(0.9, 0.5 + 0.05 * batch.count),
          `${anchor.actorId} 在 ${this.windowHours} 小时内对 ${batch.count} 个${anchor.entityType}批量修改 ${batch.sameField ?? "多个字段"}，节奏异常`,
          {
            actorId: anchor.actorId,
            windowHours: this.windowHours,
            batchSize: batch.count,
            field: batch.sameField,
            editIds: batch.editIds,
          },
          ctx.now,
          { kind: "cluster", editIds: batch.editIds, actorIds: [anchor.actorId] },
        ),
      );
    }
    return out;
  }
}
