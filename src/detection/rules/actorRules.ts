/**
 * 行为者类规则：从账号画像识别「人」的异常，而不是「编辑」的异常。
 * 专门覆盖「慢慢养号后才开始做坏事」的场景。
 */

import { hasFeature } from "../../domain/features.ts";
import type { Signal } from "../../domain/types.ts";
import type { DetectionContext, Detector } from "../Detector.ts";

// ---------------------------------------------------------------------------
// R-SLEEPER-WAKE：养号后突发高风险操作
// ---------------------------------------------------------------------------

export class SleeperWakeDetector implements Detector {
  readonly ruleId = "R-SLEEPER-WAKE";
  readonly family = "actor" as const;
  readonly description = "账号长期低风险养号后突发批量高风险编辑";
  readonly defaultLevel = "escalate" as const;
  private readonly burstWindowMs = 3 * 3600 * 1000;

  detect(ctx: DetectionContext): Signal[] {
    const out: Signal[] = [];
    const actors = new Set(ctx.candidateEdits.map((e) => e.actorId));

    const isRisky = (e: (typeof ctx.allEdits)[number]): boolean => {
      const f = ctx.editFeatures(e);
      return (
        hasFeature(f, "place_set_closed") ||
        hasFeature(f, "road_opened_compound") ||
        hasFeature(f, "restriction_deactivated") ||
        f.features.some((x) => x.key === "entity_deleted")
      );
    };

    for (const actorId of actors) {
      const af = ctx.actorFeatures(actorId);
      if (!af.isSleeperWake) continue;

      // 从全量事件聚合该账号突发时间窗内的风险编辑——增量入库时每次只评估一条，
      // 必须能回看该账号此前已经提交的突发操作，才能还原整个作案批次
      const riskyEdits = ctx.allEdits.filter((e) => {
        if (e.actorId !== actorId) return false;
        if (ctx.now - e.ts > this.burstWindowMs) return false;
        return isRisky(e);
      });
      if (riskyEdits.length === 0) continue;

      out.push({
        ruleId: this.ruleId,
        level: "escalate",
        confidence: Math.min(0.92, 0.55 + 0.1 * riskyEdits.length),
        explanation:
          `账号 ${actorId} 养号期占比 ${af.nurtureRatio}，近期突发倍率 ${af.burstRatio}，` +
          `并在突发期执行 ${riskyEdits.length} 次高风险编辑，符合养号作案模式`,
        evidence: {
          actorId,
          accountAgeDays: Math.round(af.accountAgeDays),
          nurtureRatio: af.nurtureRatio,
          burstRatio: af.burstRatio,
          reputation: af.reputation,
          riskyEditIds: riskyEdits.map((e) => e.editId),
          actorFeatures: af.features.map((x) => x.note),
        },
        ts: ctx.now,
        subject: {
          kind: "cluster",
          editIds: riskyEdits.map((e) => e.editId),
          actorIds: [actorId],
        },
      });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// R-NEW-ACTOR-RISKY：新账号直接做高风险编辑
// ---------------------------------------------------------------------------

export class NewActorRiskyDetector implements Detector {
  readonly ruleId = "R-NEW-ACTOR-RISKY";
  readonly family = "actor" as const;
  readonly description = "注册时间很短的账号执行高风险字段修改";
  readonly defaultLevel = "review" as const;

  private readonly maxAgeDays: number;

  constructor(maxAgeDays = 14) {
    this.maxAgeDays = maxAgeDays;
  }

  detect(ctx: DetectionContext): Signal[] {
    const out: Signal[] = [];
    for (const edit of ctx.candidateEdits) {
      const af = ctx.actorFeatures(edit.actorId);
      if (af.accountAgeDays > this.maxAgeDays) continue;
      const f = ctx.editFeatures(edit);
      const risky =
        hasFeature(f, "place_set_closed") ||
        hasFeature(f, "road_opened_compound") ||
        hasFeature(f, "restriction_deactivated") ||
        edit.action === "delete";
      if (!risky) continue;
      out.push({
        ruleId: this.ruleId,
        level: "review",
        confidence: 0.55,
        explanation: `注册仅 ${Math.round(af.accountAgeDays)} 天的新账号 ${edit.actorId} 直接修改高风险字段`,
        evidence: {
          actorId: edit.actorId,
          accountAgeDays: Math.round(af.accountAgeDays),
          editId: edit.editId,
          reputation: af.reputation,
        },
        ts: edit.ts,
        subject: { kind: "edit", editId: edit.editId },
      });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// R-REPEAT-TAINTED：有已确认恶意前科的账号再次出手
// ---------------------------------------------------------------------------

export class RepeatTaintedDetector implements Detector {
  readonly ruleId = "R-REPEAT-TAINTED";
  readonly family = "actor" as const;
  readonly description = "曾被确认恶意的账号再次提交高风险编辑";
  readonly defaultLevel = "escalate" as const;

  detect(ctx: DetectionContext): Signal[] {
    const out: Signal[] = [];
    for (const edit of ctx.candidateEdits) {
      const profile = ctx.actorProfile(edit.actorId);
      if (profile.badEdits === 0) continue;
      out.push({
        ruleId: this.ruleId,
        level: "escalate",
        confidence: Math.min(0.95, 0.7 + 0.1 * profile.badEdits),
        explanation: `账号 ${edit.actorId} 已有 ${profile.badEdits} 次被确认恶意的记录（案件 ${profile.caseHistory.join("、")}），再次提交编辑`,
        evidence: {
          actorId: edit.actorId,
          badEdits: profile.badEdits,
          caseHistory: profile.caseHistory,
          editId: edit.editId,
        },
        ts: edit.ts,
        subject: { kind: "edit", editId: edit.editId },
      });
    }
    return out;
  }
}
