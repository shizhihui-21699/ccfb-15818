/**
 * 协同与佐证类规则。
 *
 * - R-COORD-CLUSTER：把分散账号在关系图上重新聚合成团伙，让「拆分到几十个账号的
 *   小改动」作为一个整体被看见；
 * - R-CORROBORATION-MISMATCH：用外部真相源（工商状态、交管公告等）校验编辑内容。
 *   注意佐证缺失不等于恶意（很多真实变化没有数字化记录），只有「佐证明确反驳」
 *   才升级；佐证确认一致则反向降权，由引擎抑制误报。
 */

import { CoordinationGraph } from "../CoordinationGraph.ts";
import type { CorroborationProvider, Signal } from "../../domain/types.ts";
import type { DetectionContext, Detector } from "../Detector.ts";

// ---------------------------------------------------------------------------
// R-COORD-CLUSTER
// ---------------------------------------------------------------------------

export class CoordClusterDetector implements Detector {
  readonly ruleId = "R-COORD-CLUSTER";
  readonly family = "network" as const;
  readonly description = "多个账号在关系图上构成高内聚团伙，疑似拆分协同作案";
  readonly defaultLevel = "escalate" as const;

  detect(ctx: DetectionContext): Signal[] {
    const graph = new CoordinationGraph(ctx.allEdits);
    const clusters = graph.clusters();
    const candidateEdits = new Set(ctx.candidateEdits.map((e) => e.editId));

    return clusters
      // 只报与当前待评估编辑有交集的簇，避免历史团伙反复告警
      .filter((c) => c.editIds.some((id) => candidateEdits.has(id)))
      .map<Signal>((c) => ({
        ruleId: this.ruleId,
        level: "escalate",
        confidence: Math.min(0.95, 0.6 + 0.05 * c.actorIds.length + 0.02 * c.editIds.length),
        explanation:
          `发现 ${c.actorIds.length} 个账号构成协同团伙，内部关联边 ${c.edgeCount} 条、累计权重 ${c.totalWeight}，` +
          `涉及 ${c.editIds.length} 条编辑。关联依据：${c.reasons.slice(0, 4).join("；")}`,
        evidence: {
          actorIds: c.actorIds,
          editIds: c.editIds,
          edgeCount: c.edgeCount,
          totalWeight: c.totalWeight,
          reasons: c.reasons,
        },
        ts: ctx.now,
        subject: { kind: "cluster", editIds: c.editIds, actorIds: c.actorIds },
      }));
  }
}

// ---------------------------------------------------------------------------
// R-CORROBORATION-MISMATCH
// ---------------------------------------------------------------------------

type FieldVerdict = "contradicted" | "supported" | "unknown";

export class CorroborationMismatchDetector implements Detector {
  readonly ruleId = "R-CORROBORATION-MISMATCH";
  readonly family = "corroboration" as const;
  readonly description = "编辑内容与外部权威数据源明确矛盾，或得到外部源支持";
  readonly defaultLevel = "review" as const;

  private readonly providers: CorroborationProvider[];

  constructor(providers: CorroborationProvider[]) {
    this.providers = providers;
  }

  async detect(ctx: DetectionContext): Promise<Signal[]> {
    if (this.providers.length === 0) return [];
    const out: Signal[] = [];

    for (const edit of ctx.candidateEdits) {
      // 只校验有明确「事实型字段」的编辑
      const factFields = this.factFields(edit);
      if (factFields.length === 0) continue;

      let verdict: FieldVerdict = "unknown";
      const details: Record<string, { claimed: unknown; external: unknown }> = {};

      for (const provider of this.providers) {
        const external = await provider.fetchExternalState(edit.entityId);
        if (!external) continue;
        for (const field of factFields) {
          if (!(field in external)) continue;
          const claimed = edit.after[field];
          const extValue = external[field];
          details[field] = { claimed, external: extValue };
          if (claimed === extValue) verdict = "supported";
          else verdict = "contradicted";
        }
      }

      if (verdict === "contradicted") {
        out.push({
          ruleId: this.ruleId,
          level: "escalate",
          confidence: 0.9,
          explanation: `编辑声称的字段值被外部权威源明确反驳（实体 ${edit.entityId}）`,
          evidence: {
            actorId: edit.actorId,
            entityId: edit.entityId,
            editId: edit.editId,
            contradiction: details,
          },
          ts: edit.ts,
          subject: { kind: "edit", editId: edit.editId },
        });
      } else if (verdict === "supported") {
        // 反向信号：外部源支持该编辑，用于在引擎里压低风险分
        out.push({
          ruleId: this.ruleId,
          level: "info",
          confidence: 0.8,
          explanation: `编辑内容与外部权威源一致（实体 ${edit.entityId}），属于可信真实变化`,
          evidence: { actorId: edit.actorId, entityId: edit.entityId, match: details, supportive: true },
          ts: edit.ts,
          subject: { kind: "edit", editId: edit.editId },
        });
      }
    }
    return out;
  }

  private factFields(edit: { entityType: string; after: Record<string, unknown> }): string[] {
    const watched: Record<string, string[]> = {
      place: ["status"],
      road: ["openToTraffic", "oneway", "roadClass"],
      restriction: ["active", "rule"],
    };
    const fields = watched[edit.entityType];
    return fields ? fields.filter((f) => f in edit.after) : [];
  }
}
