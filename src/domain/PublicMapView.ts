/**
 * 公众地图视图。
 *
 * 隔离中的编辑不能影响普通用户看到的地图，但数据仍保留在事件流里等人审。
 * 做法：重放事件流时跳过被隔离的编辑（及其补偿事件），用与全量投影完全相同的
 * applyEvent 规则得到「干净视图」。
 * 视图按隔离集缓存，隔离集变化时整体失效（隔离是低频操作，无需增量维护）。
 */

import type { EventStore } from "./EventStore.ts";
import { applyEvent } from "./projection.ts";
import type { EditEvent, EntityId, MapEntity } from "./types.ts";

export class PublicMapView {
  private cache: { key: string; entities: Map<EntityId, MapEntity> } | null = null;
  private readonly store: EventStore;

  constructor(store: EventStore) {
    this.store = store;
  }

  /**
   * @param quarantinedEditIds 当前被隔离的编辑集合
   */
  getVisibleEntities(quarantinedEditIds: Set<string>): Map<EntityId, MapEntity> {
    const key = [...quarantinedEditIds].sort().join("|");
    if (this.cache && this.cache.key === key) return this.cache.entities;

    const entities = new Map<EntityId, MapEntity>();
    for (const event of this.store.allEvents()) {
      if (this.shouldSkip(event, quarantinedEditIds)) continue;
      const current = entities.get(event.entityId) ?? null;
      entities.set(event.entityId, applyEvent(current, event));
    }
    this.cache = { key, entities };
    return entities;
  }

  getVisibleEntity(id: EntityId, quarantinedEditIds: Set<string>): MapEntity | null {
    return this.getVisibleEntities(quarantinedEditIds).get(id) ?? null;
  }

  private shouldSkip(event: EditEvent, quarantined: Set<string>): boolean {
    if (quarantined.has(event.editId)) return true;
    // 若补偿事件所撤销的原始编辑仍在隔离中，补偿也不进入公众视图，
    // 否则两个状态会互相矛盾
    if (event.compensationFor && quarantined.has(event.compensationFor)) return true;
    return false;
  }
}
