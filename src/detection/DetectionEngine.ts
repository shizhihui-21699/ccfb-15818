/**
 * 检测引擎。
 *
 * 职责：
 * 1. 调度全部启用的检测器，收集带证据的信号；
 * 2. 用并查集把围绕同一批编辑/账号/团伙的信号聚合成案件（拆分攻击在这里重新合拢）；
 * 3. 计算 0~100 风险分，叠加误报抑制（高信誉、外部佐证支持）；
 * 4. 高风险案件自动隔离：被隔离编辑不进入公众投影，等人审拍板；
 * 5. 信号与案件全部留痕，任何结论可回溯到原始数据。
 */

import type { EventStore } from "../domain/EventStore.ts";
import { extractActorFeatures, extractEditFeatures } from "../domain/features.ts";
import type {
  Case,
  CaseId,
  EditEvent,
  Signal,
  Ts,
} from "../domain/types.ts";
import { DEFAULT_TUNING, type Detector, type RuleFamily, type RuleTuning } from "./Detector.ts";

const LEVEL_WEIGHT = { info: 3, review: 14, escalate: 30 } as const;

export interface EngineOptions {
  tuning?: Record<string, RuleTuning>;
  /** 自动隔离阈值：风险分 >= 该值则隔离编辑并立案 */
  quarantineThreshold: number;
  /** 立案阈值：达到该分即创建 open 案件 */
  caseThreshold: number;
}

export class DetectionEngine {
  private cases = new Map<CaseId, Case>();
  private readonly tuning: Record<string, RuleTuning>;
  private caseSeq = 1;
  private readonly store: EventStore;
  private readonly detectors: Detector[];
  private readonly opts: EngineOptions;
  /** 未达立案阈值的信号也完整留痕，供审计与后续校准 */
  private signalLog: Signal[] = [];

  constructor(
    store: EventStore,
    detectors: Detector[],
    opts: EngineOptions = {
      quarantineThreshold: 60,
      caseThreshold: 25,
    },
  ) {
    this.store = store;
    this.detectors = detectors;
    this.opts = opts;
    this.tuning = { ...DEFAULT_TUNING, ...(opts.tuning ?? {}) };
  }

  /** 规则 id -> 家族的索引，评分时用于多维交叉加成 */
  private familyByRule(): Map<string, RuleFamily> {
    const map = new Map<string, RuleFamily>();
    for (const d of this.detectors) map.set(d.ruleId, d.family);
    return map;
  }

  allSignals(): Signal[] {
    return [...this.signalLog];
  }

  // -------------------------------------------------------------------------
  // 主流程
  // -------------------------------------------------------------------------

  async run(candidateEdits: EditEvent[], now: Ts): Promise<Case[]> {
    const ctx = {
      now,
      candidateEdits,
      allEdits: this.store.allEvents(),
      stateBefore: (editId: string) => this.store.stateBefore(editId),
      actorProfile: (actorId: string) => this.store.getActor(actorId),
      actorFeatures: (actorId: string) => extractActorFeatures(this.store.getActor(actorId), now),
      editFeatures: (edit: EditEvent) =>
        extractEditFeatures(edit, this.store.stateBefore(edit.editId), now),
      corroborators: [],
    };

    const rawSignals: Signal[] = [];
    for (const detector of this.detectors) {
      const tune = this.tuning[detector.ruleId];
      if (tune && !tune.enabled) continue;
      const found = await detector.detect(ctx);
      const weight = tune?.weight ?? 1;
      for (const s of found) {
        rawSignals.push(weight === 1 ? s : { ...s, confidence: s.confidence * weight });
      }
    }

    const signals = this.applyFalsePositiveControls(rawSignals);
    this.signalLog.push(...signals);
    if (signals.length === 0) return [];

    const groups = this.groupSignals(signals);
    const familyMap = this.familyByRule();
    const touchedCases: Case[] = [];

    for (const group of groups) {
      const score = this.score(group, familyMap);
      if (score < this.opts.caseThreshold) continue;
      const merged = this.upsertCase(group, score, now);
      if (merged) touchedCases.push(merged);
    }
    return touchedCases;
  }

  // -------------------------------------------------------------------------
  // 误报抑制：真实世界变化的三道防线
  // -------------------------------------------------------------------------

  private applyFalsePositiveControls(signals: Signal[]): Signal[] {
    const supportiveEdits = new Set(
      signals
        .filter((s) => s.evidence.supportive === true)
        .map((s) => (s.subject.kind === "edit" ? s.subject.editId : null))
        .filter((x): x is string => x !== null),
    );

    return signals
      .map((s): Signal | null => {
        // 防线 1：外部权威源明确支持的编辑，删除针对它的 info/review 怀疑信号，
        // 但硬证据（协同、佐证矛盾、前科）不受影响
        if (s.subject.kind === "edit" && supportiveEdits.has(s.subject.editId)) {
          const hardRule =
            s.ruleId === "R-COORD-CLUSTER" ||
            s.ruleId === "R-CORROBORATION-MISMATCH" ||
            s.ruleId === "R-REPEAT-TAINTED";
          if (!hardRule) return null;
        }

        // 防线 2：高信誉账号的首次可疑编辑降级（仅一次，escalate 降为 review）
        if (s.level === "escalate" && s.subject.kind === "edit") {
          const edit = this.store.getEvent(s.subject.editId);
          if (edit) {
            const profile = this.store.getActor(edit.actorId);
            const reputation =
              profile.totalEdits === 0
                ? 0.5
                : profile.positiveFeedback /
                  Math.max(1, profile.totalEdits + profile.positiveFeedback);
            if (reputation >= 0.8 && profile.badEdits === 0) {
              return { ...s, level: "review", explanation: `【高信誉降权】${s.explanation}` };
            }
          }
        }

        // 防线 3：info 级且无其他信号伴随的零佐证提示不单独立案（评分阶段自然衰减，
        // 这里保留信号留痕）
        return s;
      })
      .filter((s): s is Signal => s !== null);
  }

  // -------------------------------------------------------------------------
  // 信号聚合：并查集把关联信号并成案件
  // -------------------------------------------------------------------------

  private groupSignals(signals: Signal[]): Signal[][] {
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      if (!parent.has(x)) parent.set(x, x);
      let root = x;
      while (parent.get(root) !== root) root = parent.get(root)!;
      let cur = x;
      while (parent.get(cur) !== root) {
        const next = parent.get(cur)!;
        parent.set(cur, root);
        cur = next;
      }
      return root;
    };
    const union = (a: string, b: string) => parent.set(find(a), find(b));

    const signalNodes = signals.map((_, i) => `s${i}`);
    const editOwners = new Map<string, string>();
    const actorOwners = new Map<string, string>();

    signals.forEach((s, i) => {
      const node = signalNodes[i]!;
      find(node);
      const edits: string[] = [];
      const actors: string[] = [];
      if (s.subject.kind === "edit") edits.push(s.subject.editId);
      if (s.subject.kind === "actor") actors.push(s.subject.actorId);
      if (s.subject.kind === "cluster") {
        edits.push(...s.subject.editIds);
        actors.push(...s.subject.actorIds);
      }
      if (s.subject.kind === "entity") edits.push(...this.store.entityEditIds(s.subject.entityId));

      for (const editId of edits) {
        const owner = editOwners.get(editId);
        if (owner) union(node, owner);
        else editOwners.set(editId, node);
      }
      for (const actorId of actors) {
        const owner = actorOwners.get(actorId);
        if (owner) union(node, owner);
        else actorOwners.set(actorId, node);
      }
    });

    const buckets = new Map<string, Signal[]>();
    signals.forEach((s, i) => {
      const root = find(signalNodes[i]!);
      const list = buckets.get(root) ?? [];
      list.push(s);
      buckets.set(root, list);
    });
    return [...buckets.values()];
  }

  // -------------------------------------------------------------------------
  // 风险评分：可解释的加权模型，而非黑盒概率
  // -------------------------------------------------------------------------

  private score(group: Signal[], familyMap: Map<string, RuleFamily>): number {
    let score = 0;
    const counted = new Set<string>();
    for (const s of group) {
      // 同一规则对同一主体只计一次基础分，防止刷量式重复信号把分数顶满
      const dedupeKey = `${s.ruleId}:${JSON.stringify(s.subject)}`;
      if (counted.has(dedupeKey)) continue;
      counted.add(dedupeKey);
      let contribution = LEVEL_WEIGHT[s.level] * s.confidence;
      // 影响规模乘子：cluster 信号波及的编辑越多、参与账号越多，实际危害越大。
      // 封顶 2.0，避免超大批量直接拉满分；单编辑信号乘子为 1。
      if (s.subject.kind === "cluster" && (s.subject.editIds.length > 1 || s.subject.actorIds.length > 1)) {
        const editScope = 1 + 0.12 * Math.max(0, s.subject.editIds.length - 1);
        const actorScope = 1 + 0.1 * Math.max(0, s.subject.actorIds.length - 1);
        contribution *= Math.min(2.0, editScope * actorScope);
      }
      score += contribution;
    }
    // 多维信号叠加加成：内容、行为者、协同/佐证家族同时出现时，恶意概率显著上升。
    // info 级信号（如零佐证提示）不参与家族计数，避免单条编辑自我强化。
    const families = new Set(
      group
        .filter((s) => s.level !== "info")
        .map((s) => familyMap.get(s.ruleId))
        .filter((f): f is RuleFamily => f !== undefined),
    );
    if (families.size >= 3) score *= 1.2;
    else if (families.size === 2) score *= 1.15;
    return Math.min(100, Math.round(score));
  }

  // -------------------------------------------------------------------------
  // 案件生命周期
  // -------------------------------------------------------------------------

  private collectSubjects(group: Signal[]): {
    editIds: Set<string>;
    actorIds: Set<string>;
    links: Case["links"];
  } {
    const editIds = new Set<string>();
    const actorIds = new Set<string>();
    const links: Case["links"] = [];

    for (const s of group) {
      if (s.subject.kind === "edit") {
        editIds.add(s.subject.editId);
        links.push({ editId: s.subject.editId, role: "seed", ruleId: s.ruleId });
      } else if (s.subject.kind === "cluster") {
        s.subject.editIds.forEach((id) => {
          editIds.add(id);
          links.push({ editId: id, role: "seed", ruleId: s.ruleId });
        });
        s.subject.actorIds.forEach((id) => actorIds.add(id));
      } else if (s.subject.kind === "actor") {
        actorIds.add(s.subject.actorId);
      } else if (s.subject.kind === "entity") {
        this.store.entityEditIds(s.subject.entityId).forEach((id) => {
          editIds.add(id);
          links.push({ editId: id, role: "seed", ruleId: s.ruleId });
        });
      }
      const evidenceActor = s.evidence.actorId;
      if (typeof evidenceActor === "string") actorIds.add(evidenceActor);
    }
    // 同一编辑可能被多条信号引用，案件链接按 editId 去重（保留首次出现的角色与规则）
    const seenLinks = new Set<string>();
    const dedupedLinks = links.filter((l) => {
      if (seenLinks.has(l.editId)) return false;
      seenLinks.add(l.editId);
      return true;
    });
    return { editIds, actorIds, links: dedupedLinks };
  }

  private upsertCase(group: Signal[], score: number, now: Ts): Case | null {
    const { editIds, actorIds, links } = this.collectSubjects(group);

    // 与既有案件合并：编辑或账号有交集即并入，保证一个攻击活动不会裂成多个案件
    let existing: Case | null = null;
    for (const c of this.cases.values()) {
      const overlapEdit = c.links.some((l) => editIds.has(l.editId));
      const overlapActor = c.actorIds.some((a) => actorIds.has(a));
      if (overlapEdit || overlapActor) {
        existing = c;
        break;
      }
    }

    if (existing) {
      const knownSignals = new Set(existing.signals.map((s) => JSON.stringify(s)));
      for (const s of group) {
        if (!knownSignals.has(JSON.stringify(s))) existing.signals.push(s);
      }
      const knownEdits = new Set(existing.links.map((l) => l.editId));
      for (const l of links) if (!knownEdits.has(l.editId)) existing.links.push(l);
      for (const a of actorIds) if (!existing.actorIds.includes(a)) existing.actorIds.push(a);
      existing.riskScore = Math.max(existing.riskScore, score);
      existing.updatedAt = now;
      existing.title = this.buildTitle(existing);
      if (existing.riskScore >= this.opts.quarantineThreshold) existing.quarantined = true;
      return existing;
    }

    if (score < this.opts.caseThreshold) return null;
    const caseId = `CASE-${String(this.caseSeq++).padStart(5, "0")}`;
    const c: Case = {
      caseId,
      status: "open",
      createdAt: now,
      updatedAt: now,
      title: "",
      signals: group,
      links,
      actorIds: [...actorIds],
      riskScore: score,
      quarantined: score >= this.opts.quarantineThreshold,
      resolution: null,
      resolvedBy: null,
    };
    c.title = this.buildTitle(c);
    this.cases.set(caseId, c);
    return c;
  }

  private buildTitle(c: Case): string {
    const ruleIds = [...new Set(c.signals.map((s) => s.ruleId))];
    const top = ruleIds.slice(0, 3).join("、");
    return `风险案件 ${c.caseId}（${top}，风险分 ${c.riskScore}，涉案编辑 ${c.links.length} 条）`;
  }

  getCase(id: CaseId): Case | null {
    return this.cases.get(id) ?? null;
  }

  listCases(): Case[] {
    return [...this.cases.values()].sort((a, b) => b.riskScore - a.riskScore);
  }

  /** 当前被隔离的全部编辑 id（公众投影据此过滤） */
  quarantinedEditIds(): Set<string> {
    const set = new Set<string>();
    for (const c of this.cases.values()) {
      if (!c.quarantined || c.status === "dismissed" || c.status === "rolled_back") continue;
      for (const l of c.links) set.add(l.editId);
    }
    return set;
  }

  isEditQuarantined(editId: string): boolean {
    return this.quarantinedEditIds().has(editId);
  }

  /** 人审确认恶意：更新状态、回写账号污点（反馈只在人审后进入画像，杜绝反馈环） */
  confirm(caseId: CaseId, resolvedBy: string, note: string, now: Ts): Case {
    const c = this.requireCase(caseId);
    c.status = "confirmed_malicious";
    c.resolution = note;
    c.resolvedBy = resolvedBy;
    c.updatedAt = now;
    for (const actorId of c.actorIds) this.store.markActorBad(actorId, caseId);
    return c;
  }

  /** 人审驳回：真实世界变化，解除隔离并放行编辑 */
  dismiss(caseId: CaseId, resolvedBy: string, note: string, now: Ts): Case {
    const c = this.requireCase(caseId);
    c.status = "dismissed";
    c.quarantined = false;
    c.resolution = note;
    c.resolvedBy = resolvedBy;
    c.updatedAt = now;
    return c;
  }

  private requireCase(caseId: CaseId): Case {
    const c = this.cases.get(caseId);
    if (!c) throw new Error(`案件不存在: ${caseId}`);
    return c;
  }
}
