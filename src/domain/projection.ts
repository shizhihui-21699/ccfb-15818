/**
 * 事件 -> 实体状态的纯函数投影规则。
 * EventStore（含隔离的全量视图）与 PublicMapView（跳过隔离编辑的公众视图）共用，
 * 保证两条投影路径对同一事件的解释永远一致。
 */

import type { EditEvent, MapEntity, PlaceEntity, RestrictionEntity, RoadEntity } from "./types.ts";

export function applyEvent(state: MapEntity | null, e: EditEvent): MapEntity {
  if (e.action === "create") {
    if (state) throw new Error(`实体 ${e.entityId} 已存在，不能重复 create`);
    return createEntity(e);
  }
  if (!state) throw new Error(`实体 ${e.entityId} 不存在，无法 ${e.action}`);
  if (e.action === "delete") {
    return { ...state, deleted: true, version: state.version + 1, lastEditId: e.editId };
  }
  return { ...state, ...e.after, version: state.version + 1, lastEditId: e.editId } as MapEntity;
}

export function createEntity(e: EditEvent): MapEntity {
  const base = { id: e.entityId, version: 1, lastEditId: e.editId, deleted: false };
  const p = e.after;

  if (e.entityType === "road") {
    const road: RoadEntity = {
      ...base,
      type: "road",
      geometry: (p.geometry as RoadEntity["geometry"]) ?? [],
      roadClass: (p.roadClass as string) ?? "residential",
      openToTraffic: (p.openToTraffic as boolean) ?? false,
      oneway: (p.oneway as RoadEntity["oneway"]) ?? null,
      name: (p.name as string | null) ?? null,
      compoundId: (p.compoundId as string | null) ?? null,
    };
    return road;
  }
  if (e.entityType === "place") {
    const place: PlaceEntity = {
      ...base,
      type: "place",
      name: (p.name as string) ?? "未命名",
      category: (p.category as string) ?? "unknown",
      location: (p.location as PlaceEntity["location"]) ?? [0, 0],
      status: (p.status as PlaceEntity["status"]) ?? "open",
      claimedBy: (p.claimedBy as PlaceEntity["claimedBy"]) ?? null,
    };
    return place;
  }
  const restriction: RestrictionEntity = {
    ...base,
    type: "restriction",
    roadId: (p.roadId as RestrictionEntity["roadId"]) ?? "",
    position: (p.position as RestrictionEntity["position"]) ?? [0, 0],
    rule: (p.rule as RestrictionEntity["rule"]) ?? {},
    active: (p.active as boolean) ?? true,
  };
  return restriction;
}
