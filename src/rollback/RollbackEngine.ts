/**
 * 依赖感知回滚引擎。
 *
 * 确认恶意后要撤回的不只是恶意编辑本身，还包括「建立在它之上」的后续编辑
 * （例如恶意把道路改成可通行后，其他用户基于这个错误状态修改了道路名称）。
 *
 * 关键设计抉择：
 * 1. 只追加、不物理删除——回滚通过写入补偿事件（compensation event）实现，
 *    完整审计链保留，补偿事件本身也带案件 id，可被再次审计；
 * 2. 每条下游编辑先做冲突检测，冲突项只隔离不自动覆盖，交人审处理——
 *    绝不能为了撤销攻击而误伤善意用户的真实编辑；
 * 3. 幂等：同一案件重复执行不会产生重复补偿；
 * 4. 交叉实体引用（限行依赖道路）纳入受影响集合。
 */

import type { EventStore } from "../domain/EventStore.ts";
import type {
  Case,
  EditEvent,
  EntityId,
  RollbackItem,
  RollbackReport,
  Ts,
} from "../domain/types.ts";

export interface RollbackOptions {
  /** 冲突项是否强制逆操作（默认 false：冲突只隔离，等人审） */
  force?: boolean;
  /** 执行回滚的操作者（审计用） */
  operator: string;
}

export class RollbackEngine {
  /** 已回滚编辑 -> 补偿事件 id，保证幂等 */
  private reversed = new Map<string, string>();
  /** 案件 -> 报告，重复执行直接返回 */
  private reports = new Map<string, RollbackReport>();

  private readonly store: EventStore;

  constructor(store: EventStore) {
    this.store = store;
  }

  // -------------------------------------------------------------------------
  // 受影响集合展开：恶意种子 + 依赖它们的下游编辑
  // -------------------------------------------------------------------------

  /**
   * 展开规则：
   * - 同实体：种子编辑之后的每条编辑都是候选下游（它读到的基线可能已被污染）；
   * - 跨实体：restriction.roadId 指向被污染道路时，该限行的后续编辑同样纳入；
   * - 已被其他案件回滚的编辑跳过。
   */
  expandAffected(seedEditIds: Set<string>): {
    ordered: EditEvent[];
    downstream: Set<string>;
  } {
    const all = this.store.allEvents();
    const seedEvents = all.filter((e) => seedEditIds.has(e.editId));
    const maxSeedSeq = seedEvents.reduce((m, e) => Math.max(m, e.seq), 0);

    const pollutedEntities = new Set<EntityId>(seedEvents.map((e) => e.entityId));
    // 跨实体：找到引用被污染道路的限行实体
    for (const e of all) {
      if (e.entityType === "restriction" && pollutedEntities.has(e.after.roadId as EntityId)) {
        pollutedEntities.add(e.entityId);
      }
    }

    const downstream = new Set<string>();
    const ordered: EditEvent[] = [];

    for (const e of all) {
      if (e.seq > maxSeedSeq && pollutedEntities.has(e.entityId) && !seedEditIds.has(e.editId)) {
        downstream.add(e.editId);
        ordered.push(e);
      }
    }
    // 种子编辑按 seq 排在前面，整体保持事件顺序
    const seedsOrdered = seedEvents.sort((a, b) => a.seq - b.seq);
    return { ordered: [...seedsOrdered, ...ordered], downstream };
  }

  // -------------------------------------------------------------------------
  // 冲突检测
  // -------------------------------------------------------------------------

  /**
   * 判定一条下游编辑是否与回滚冲突。
   *
   * 语义：该下游编辑若来自善意第三方（非涉案账号、非系统补偿），且它修改的字段
   * 与恶意种子所污染的字段存在重叠，那么自动逆操作会抹掉这位用户的真实贡献——
   * 此时只隔离、不覆盖，交人审处理。
   *
   * @param downstream 待判定的下游编辑
   * @param seedEvents 本案确认恶意的种子编辑集合
   * @param caseActorIds 涉案账号
   */
  findConflict(
    downstream: EditEvent,
    seedEvents: EditEvent[],
    caseActorIds: string[],
  ): { conflict: boolean; reason: string | null } {
    // 系统补偿与同案账号的编辑都不是需要保护的善意贡献
    if (downstream.compensationFor !== null) return { conflict: false, reason: null };
    if (caseActorIds.includes(downstream.actorId)) return { conflict: false, reason: null };

    // 计算该实体上被恶意种子污染的字段集合
    const pollutedFields = new Set<string>();
    for (const seed of seedEvents) {
      if (seed.entityId !== downstream.entityId) continue;
      for (const k of Object.keys(seed.after)) pollutedFields.add(k);
      for (const k of Object.keys(seed.before)) pollutedFields.add(k);
    }
    // 跨实体引用场景（如限行依赖污染道路）：没有同实体字段重叠时不构成字段冲突
    if (pollutedFields.size === 0) return { conflict: false, reason: null };

    const overlapping = Object.keys(downstream.after).filter((k) => pollutedFields.has(k));
    if (overlapping.length === 0) return { conflict: false, reason: null };

    return {
      conflict: true,
      reason: `善意编辑 ${downstream.editId}（用户 ${downstream.actorId}）修改了被污染字段 ${overlapping.join("、")}，自动逆操作会覆盖其贡献`,
    };
  }

  // -------------------------------------------------------------------------
  // 补偿事件构造：原操作的逆
  // -------------------------------------------------------------------------

  private buildCompensation(
    original: EditEvent,
    now: Ts,
    caseId: string,
    operator: string,
  ): Omit<EditEvent, "seq"> {
    const inverseAction =
      original.action === "create"
        ? "delete"
        : original.action === "delete"
          ? "create"
          : "modify";

    // 逆操作的 before/after 与原事件互换；create 的逆是 delete（after 置空）
    const inverseBefore = original.action === "create" ? {} : { ...original.after };
    const inverseAfter =
      original.action === "delete"
        ? { ...original.before }
        : original.action === "create"
          ? {}
          : { ...original.before };

    return {
      editId: `RB-${caseId}-${original.editId}`,
      ts: now,
      actorId: `system:rollback:${operator}`,
      entityId: original.entityId,
      entityType: original.entityType,
      action: inverseAction,
      before: inverseBefore,
      after: inverseAfter,
      reason: `案件 ${caseId} 回滚补偿：撤销 ${original.editId}（原操作者 ${original.actorId}）`,
      evidenceRefs: [`case:${caseId}`],
      ipPrefix: null,
      deviceId: null,
      compensationFor: original.editId,
      caseId,
    };
  }

  // -------------------------------------------------------------------------
  // 主入口
  // -------------------------------------------------------------------------

  rollback(c: Case, now: Ts, options: RollbackOptions): RollbackReport {
    const cached = this.reports.get(c.caseId);
    if (cached) return cached;

    const seedIds = new Set(c.links.filter((l) => l.role === "seed").map((l) => l.editId));
    const { ordered, downstream } = this.expandAffected(seedIds);

    // 把下游编辑登记到案件上（案件对象随之完整记录波及范围）
    for (const id of downstream) {
      if (!c.links.some((l) => l.editId === id)) {
        c.links.push({ editId: id, role: "downstream", ruleId: "ROLLBACK-DEPENDENCY" });
      }
    }

    const seedEvents = ordered.filter((e) => seedIds.has(e.editId));
    const items: RollbackItem[] = [];
    const rebuilt = new Set<EntityId>();
    let reversedCount = 0;
    let conflictCount = 0;

    // 第一阶段：预先标出所有存在善意冲突的下游编辑及其实体。
    // 一旦某实体存在未解决的善意冲突，该实体保持隔离待人审，系统不擅自决定
    // 冲突字段的最终取值——既不覆盖善意贡献，也不机械还原恶意基线。
    const conflictedEdits = new Set<string>();
    const blockedEntities = new Set<EntityId>();
    for (const e of ordered) {
      if (seedIds.has(e.editId)) continue;
      const { conflict, reason } = this.findConflict(e, seedEvents, c.actorIds);
      if (conflict && !options.force) {
        conflictedEdits.add(e.editId);
        blockedEntities.add(e.entityId);
        conflictCount += 1;
        items.push({
          editId: e.editId,
          entityId: e.entityId,
          status: "conflict",
          compensationEditId: null,
          conflictReason: reason,
        });
      }
    }

    // 第二阶段：逆序回滚。先撤最晚的下游编辑，再撤种子，保证中间状态自洽。
    for (const original of [...ordered].reverse()) {
      rebuilt.add(original.entityId);

      if (conflictedEdits.has(original.editId)) continue; // 已在第一阶段记录为冲突

      if (this.reversed.has(original.editId)) {
        items.push({
          editId: original.editId,
          entityId: original.entityId,
          status: "already_reversed",
          compensationEditId: this.reversed.get(original.editId)!,
          conflictReason: null,
        });
        continue;
      }

      const isSeed = seedIds.has(original.editId);
      // 种子编辑所在实体存在未解决善意冲突时，暂缓种子补偿、保持隔离
      if (isSeed && blockedEntities.has(original.entityId) && !options.force) {
        items.push({
          editId: original.editId,
          entityId: original.entityId,
          status: "conflict",
          compensationEditId: null,
          conflictReason: `同实体存在未解决的善意第三方编辑冲突，实体保持隔离待人审`,
        });
        continue;
      }

      const compInput = this.buildCompensation(original, now, c.caseId, options.operator);
      const comp = this.store.append(compInput);
      this.reversed.set(original.editId, comp.editId);
      reversedCount += 1;
      items.push({
        editId: original.editId,
        entityId: original.entityId,
        status: "reversed",
        compensationEditId: comp.editId,
        conflictReason: null,
      });
    }

    const report: RollbackReport = {
      caseId: c.caseId,
      executedAt: now,
      items: [...items].sort((a, b) =>
        a.status === b.status ? a.editId.localeCompare(b.editId) : a.status.localeCompare(b.status),
      ),
      reversedCount,
      conflictCount,
      rebuiltEntities: [...rebuilt].sort(),
    };
    this.reports.set(c.caseId, report);

    c.status = conflictCount > 0 ? "partially_rolled_back" : "rolled_back";
    // 全部逆操作完成后解除隔离（部分回滚时冲突编辑保持隔离待人审）
    if (conflictCount === 0) c.quarantined = false;
    c.updatedAt = now;
    return report;
  }

  isReversed(editId: string): boolean {
    return this.reversed.has(editId);
  }
}
