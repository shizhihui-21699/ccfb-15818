/**
 * 协同关系图与团伙发现。
 *
 * 一条篡改被拆成多个看似无害的小改动时，单条编辑都无法定罪，但改动之间存在
 * 结构性关联：
 *   1. 共享环境：同一 IP 段 / 设备指纹（账号农场）——强连接
 *   2. 短时间接力共改同一实体（拆分作案）——连接性边，但带时间窗约束
 *   3. 任意共改同一实体——只是弱证据，不能单独把两个账号连进同一个团伙：
 *      众包平台上大量正常用户都会编辑同一个热门实体
 *
 * 关键区分：
 * - 「连接性边」（共享 IP/设备、时间窗内接力）参与并查集连通；
 * - 「弱证据边」（时间窗外的普通共改）只给已经连通的团伙累计证据权重，
 *   不产生新的连通关系。这样正常的跨时间协作不会把陌生账号卷进团伙。
 *
 * 算法保持确定性（节点与边按字典序处理），便于重放与测试。
 */

import type { EditEvent, UserId } from "../domain/types.ts";

export interface CoordEdge {
  a: UserId;
  b: UserId;
  weight: number;
  /** 是否参与团伙连通；false 表示仅作为已连通团伙的补充证据 */
  connecting: boolean;
  reasons: string[];
}

export interface CoordCluster {
  actorIds: UserId[];
  editIds: string[];
  edgeCount: number;
  totalWeight: number;
  reasons: string[];
}

export interface CoordGraphOptions {
  /** 两个账号编辑时间相差不超过该值，共改才算「接力」连接边 */
  relayWindowMs: number;
  /** 时间窗内共改同一实体的边权 */
  sharedEntityWeight: number;
  /** 时间窗外普通共改的弱证据边权（不产生连通性） */
  weakCoEditWeight: number;
  /** 共享 IP 段的边权 */
  sharedIpWeight: number;
  /** 共享设备的边权（强信号） */
  sharedDeviceWeight: number;
  /** 时间衔接边权 */
  temporalLinkWeight: number;
  /** 成团的最小累计边权 */
  minClusterWeight: number;
}

export const DEFAULT_COORD_OPTIONS: CoordGraphOptions = {
  relayWindowMs: 6 * 3600 * 1000,
  sharedEntityWeight: 1.5,
  weakCoEditWeight: 0.3,
  sharedIpWeight: 1,
  sharedDeviceWeight: 3,
  temporalLinkWeight: 1,
  minClusterWeight: 2.5,
};

interface EdgeInput {
  a: UserId;
  b: UserId;
  weight: number;
  connecting: boolean;
  reason: string;
}

export class CoordinationGraph {
  private edges = new Map<string, CoordEdge>();
  private actorEdits = new Map<UserId, Set<string>>();
  private readonly events: readonly EditEvent[];
  private readonly opts: CoordGraphOptions;

  constructor(
    events: readonly EditEvent[],
    opts: CoordGraphOptions = DEFAULT_COORD_OPTIONS,
  ) {
    this.events = events;
    this.opts = opts;
    this.build();
  }

  private edgeKey(a: UserId, b: UserId): string {
    return [a, b].sort().join("");
  }

  private addEdge(input: EdgeInput): void {
    if (input.a === input.b) return;
    const key = this.edgeKey(input.a, input.b);
    const existing = this.edges.get(key);
    if (existing) {
      existing.weight += input.weight;
      // 只要有一条连接性证据，整条边就是连接性的
      existing.connecting = existing.connecting || input.connecting;
      if (!existing.reasons.includes(input.reason)) existing.reasons.push(input.reason);
    } else {
      const [a, b] = [input.a, input.b].sort();
      this.edges.set(key, {
        a: a!,
        b: b!,
        weight: input.weight,
        connecting: input.connecting,
        reasons: [input.reason],
      });
    }
  }

  private build(): void {
    const byActor = new Map<UserId, EditEvent[]>();
    const actorMeta = new Map<UserId, { ips: Set<string>; devices: Set<string> }>();
    const entityEditors = new Map<string, { actor: UserId; ts: number }[]>();

    for (const e of this.events) {
      const list = byActor.get(e.actorId) ?? [];
      list.push(e);
      byActor.set(e.actorId, list);
      this.actorEdits.set(
        e.actorId,
        new Set([...(this.actorEdits.get(e.actorId) ?? []), e.editId]),
      );

      const meta = actorMeta.get(e.actorId) ?? { ips: new Set<string>(), devices: new Set<string>() };
      if (e.ipPrefix) meta.ips.add(e.ipPrefix);
      if (e.deviceId) meta.devices.add(e.deviceId);
      actorMeta.set(e.actorId, meta);

      const editors = entityEditors.get(e.entityId) ?? [];
      if (!editors.some((x) => x.actor === e.actorId)) editors.push({ actor: e.actorId, ts: e.ts });
      entityEditors.set(e.entityId, editors);
    }

    // 边 1：共改同一实体。时间窗内接力 -> 连接性边；否则 -> 弱证据边
    for (const [entityId, editors] of entityEditors) {
      if (editors.length < 2) continue;
      for (let i = 0; i < editors.length; i++) {
        for (let j = i + 1; j < editors.length; j++) {
          const x = editors[i]!;
          const y = editors[j]!;
          const gap = Math.abs(x.ts - y.ts);
          const inWindow = gap <= this.opts.relayWindowMs;
          this.addEdge({
            a: x.actor,
            b: y.actor,
            weight: inWindow ? this.opts.sharedEntityWeight : this.opts.weakCoEditWeight,
            connecting: inWindow,
            reason: inWindow
              ? `${Math.round(gap / 60000)} 分钟内接力共改实体 ${entityId}`
              : `跨时段共改实体 ${entityId}（弱证据）`,
          });
        }
      }
    }

    // 边 2：共享 IP 段 / 设备（连接性边，设备证据最强）
    const actors = [...actorMeta.keys()].sort();
    for (let i = 0; i < actors.length; i++) {
      for (let j = i + 1; j < actors.length; j++) {
        const m1 = actorMeta.get(actors[i]!)!;
        const m2 = actorMeta.get(actors[j]!)!;
        for (const ip of m1.ips) {
          if (m2.ips.has(ip)) {
            this.addEdge({ a: actors[i]!, b: actors[j]!, weight: this.opts.sharedIpWeight, connecting: true, reason: `共享 IP 段 ${ip}` });
          }
        }
        for (const d of m1.devices) {
          if (m2.devices.has(d)) {
            this.addEdge({ a: actors[i]!, b: actors[j]!, weight: this.opts.sharedDeviceWeight, connecting: true, reason: `共享设备 ${d}` });
          }
        }
      }
    }

    // 边 3：同实体时间衔接的接力（不同账号、时间窗内），再次强化连接
    const byEntity = new Map<string, EditEvent[]>();
    for (const e of this.events) {
      const list = byEntity.get(e.entityId) ?? [];
      list.push(e);
      byEntity.set(e.entityId, list);
    }
    for (const list of byEntity.values()) {
      const sorted = [...list].sort((x, y) => x.seq - y.seq);
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1]!;
        const cur = sorted[i]!;
        if (prev.actorId === cur.actorId) continue;
        if (cur.ts - prev.ts <= this.opts.relayWindowMs) {
          this.addEdge({
            a: prev.actorId,
            b: cur.actorId,
            weight: this.opts.temporalLinkWeight,
            connecting: true,
            reason: `${prev.actorId} 与 ${cur.actorId} 在 ${Math.round((cur.ts - prev.ts) / 60000)} 分钟内接力编辑 ${cur.entityId}`,
          });
        }
      }
    }
  }

  /** 返回权重达到阈值的边（检测层用于生成证据） */
  strongEdges(minWeight?: number): CoordEdge[] {
    const threshold = minWeight ?? this.opts.minClusterWeight;
    return [...this.edges.values()]
      .filter((e) => e.weight >= threshold)
      .sort((a, b) => b.weight - a.weight);
  }

  /** 并查集连通分量：仅连接性边参与连通，再用累计边权过滤团伙 */
  clusters(): CoordCluster[] {
    const parent = new Map<UserId, UserId>();
    const nodes = new Set<UserId>();
    const connectingEdges = [...this.edges.values()].filter((e) => e.connecting);
    for (const e of connectingEdges) {
      nodes.add(e.a).add(e.b);
      parent.set(e.a, e.a).set(e.b, e.b);
    }

    const find = (x: UserId): UserId => {
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
    const union = (a: UserId, b: UserId) => parent.set(find(a), find(b));
    for (const e of connectingEdges) union(e.a, e.b);

    const groups = new Map<UserId, UserId[]>();
    for (const node of nodes) {
      const root = find(node);
      const list = groups.get(root) ?? [];
      list.push(node);
      groups.set(root, list);
    }

    const result: CoordCluster[] = [];
    for (const members of groups.values()) {
      const memberSet = new Set(members);
      // 团伙内部的所有边（含弱证据边）都计入证据权重
      const internalEdges = [...this.edges.values()].filter(
        (e) => memberSet.has(e.a) && memberSet.has(e.b),
      );
      const totalWeight = internalEdges.reduce((s, e) => s + e.weight, 0);
      if (totalWeight < this.opts.minClusterWeight || members.length < 2) continue;

      const editIds = new Set<string>();
      for (const m of members) for (const id of this.actorEdits.get(m) ?? []) editIds.add(id);
      const reasons = internalEdges.flatMap((e) => e.reasons);

      result.push({
        actorIds: [...members].sort(),
        editIds: [...editIds].sort(),
        edgeCount: internalEdges.length,
        totalWeight: Math.round(totalWeight * 100) / 100,
        reasons: [...new Set(reasons)].sort(),
      });
    }
    return result.sort((a, b) => b.totalWeight - a.totalWeight);
  }
}
