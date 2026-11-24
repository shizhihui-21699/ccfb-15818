/**
 * 测试/演示用的编辑构造器。
 * 集中生成符合 IngestInput 形状的数据，让测试场景读起来像「故事」而不是字段堆砌。
 */

import type { IngestInput } from "./MapGuardService.ts";
import type { EntityType, LngLat, Ts, UserId } from "./types.ts";

let seq = 0;
export function nextEditId(prefix = "E"): string {
  seq += 1;
  return `${prefix}-${String(seq).padStart(4, "0")}`;
}

export function resetIdCounter(): void {
  seq = 0;
}

interface EditOpts {
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  reason?: string | null;
  evidenceRefs?: string[];
  ipPrefix?: string | null;
  deviceId?: string | null;
}

export function edit(
  actorId: UserId,
  entityId: string,
  entityType: EntityType,
  action: IngestInput["action"],
  ts: Ts,
  opts: EditOpts = {},
): IngestInput {
  return {
    editId: nextEditId(),
    ts,
    actorId,
    entityId,
    entityType,
    action,
    before: opts.before ?? {},
    after: opts.after ?? {},
    reason: opts.reason ?? null,
    evidenceRefs: opts.evidenceRefs ?? [],
    ipPrefix: opts.ipPrefix ?? null,
    deviceId: opts.deviceId ?? null,
  };
}

// -- 场景快捷方式 -------------------------------------------------------------

export const HOUR = 3600 * 1000;
export const DAY = 24 * HOUR;

/** 创建一个营业中的商户 */
export function createPlace(
  actorId: UserId,
  placeId: string,
  ts: Ts,
  extra: { name?: string; claimedBy?: UserId | null; location?: LngLat } = {},
): IngestInput {
  return edit(actorId, placeId, "place", "create", ts, {
    after: {
      name: extra.name ?? `商户${placeId}`,
      category: "restaurant",
      location: extra.location ?? [116.4, 39.9],
      status: "open",
      claimedBy: extra.claimedBy === undefined ? `owner-${placeId}` : extra.claimedBy,
    },
  });
}

/** 把商户改为关闭（恶意关店的典型动作） */
export function closePlace(
  actorId: UserId,
  placeId: string,
  ts: Ts,
  opts: EditOpts = {},
): IngestInput {
  return edit(actorId, placeId, "place", "modify", ts, {
    before: { status: "open" },
    after: { status: "closed" },
    ...opts,
  });
}

/** 创建小区内部道路（默认不对社会车辆开放） */
export function createCompoundRoad(
  actorId: UserId,
  roadId: string,
  compoundId: string,
  ts: Ts,
): IngestInput {
  return edit(actorId, roadId, "road", "create", ts, {
    after: {
      geometry: [[116.4, 39.9], [116.41, 39.91]] as LngLat[],
      roadClass: "residential",
      openToTraffic: false,
      oneway: null,
      name: "小区内部路",
      compoundId,
    },
  });
}

/** 把小区道路改为社会车辆可通行（引导车流穿行的典型动作） */
export function openCompoundRoad(
  actorId: UserId,
  roadId: string,
  ts: Ts,
  opts: EditOpts = {},
): IngestInput {
  return edit(actorId, roadId, "road", "modify", ts, {
    before: { openToTraffic: false },
    after: { openToTraffic: true },
    ...opts,
  });
}

/** 创建并立即关闭一条限行 */
export function createRestriction(
  actorId: UserId,
  restrictionId: string,
  roadId: string,
  ts: Ts,
): IngestInput {
  return edit(actorId, restrictionId, "restriction", "create", ts, {
    after: {
      roadId,
      position: [116.4, 39.9] as LngLat,
      rule: { maxWeightKg: 2000 },
      active: true,
    },
  });
}

export function deactivateRestriction(
  actorId: UserId,
  restrictionId: string,
  ts: Ts,
  opts: EditOpts = {},
): IngestInput {
  return edit(actorId, restrictionId, "restriction", "modify", ts, {
    before: { active: true },
    after: { active: false },
    ...opts,
  });
}
