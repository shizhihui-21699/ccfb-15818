/**
 * 事件溯源与投影基础测试：
 * 全序事件流、实体状态投影、账号画像、stateBefore、确定性重放。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { EventStore } from "../src/domain/EventStore.ts";
import { applyEvent } from "../src/domain/projection.ts";
import type { EditEvent } from "../src/domain/types.ts";

const T0 = 1_700_000_000_000;

function baseEvent(over: Partial<EditEvent> & Pick<EditEvent, "editId" | "actorId" | "entityId" | "entityType" | "action" | "ts">): Omit<EditEvent, "seq"> {
  return {
    before: {},
    after: {},
    reason: null,
    evidenceRefs: [],
    ipPrefix: null,
    deviceId: null,
    compensationFor: null,
    caseId: null,
    ...over,
  };
}

test("实体状态由事件流投影：create -> modify -> delete", () => {
  const store = new EventStore();
  store.registerActor("u1", T0 - 1000);

  store.append(baseEvent({
    editId: "e1", actorId: "u1", entityId: "p1", entityType: "place", action: "create", ts: T0,
    after: { name: "面馆", status: "open", category: "restaurant", location: [1, 2], claimedBy: "owner1" },
  }));
  store.append(baseEvent({
    editId: "e2", actorId: "u1", entityId: "p1", entityType: "place", action: "modify", ts: T0 + 10,
    before: { status: "open" }, after: { status: "closed" },
  }));

  const place = store.getEntity("p1");
  assert.ok(place && place.type === "place");
  assert.equal(place.status, "closed");
  assert.equal(place.version, 2);
  assert.equal(place.lastEditId, "e2");

  store.append(baseEvent({
    editId: "e3", actorId: "u1", entityId: "p1", entityType: "place", action: "delete", ts: T0 + 20,
    before: { status: "closed" },
  }));
  assert.equal(store.getEntity("p1")?.deleted, true);
});

test("stateBefore 返回某条编辑生效前的快照", () => {
  const store = new EventStore();
  store.append(baseEvent({
    editId: "e1", actorId: "u1", entityId: "r1", entityType: "road", action: "create", ts: T0,
    after: { geometry: [], openToTraffic: false, compoundId: "c1" },
  }));
  store.append(baseEvent({
    editId: "e2", actorId: "u1", entityId: "r1", entityType: "road", action: "modify", ts: T0 + 10,
    before: { openToTraffic: false }, after: { openToTraffic: true },
  }));

  const before = store.stateBefore("e2");
  assert.ok(before && before.type === "road");
  assert.equal(before.openToTraffic, false);
  assert.equal(store.stateBefore("e1"), null);
});

test("账号画像累计编辑量、设备/IP 与养号期统计", () => {
  const store = new EventStore(30 * 24 * 3600 * 1000);
  const reg = T0 - 40 * 24 * 3600 * 1000;
  store.registerActor("u1", reg);

  // 注册后第 5 天（养号期内）的两条编辑
  store.append(baseEvent({ editId: "e1", actorId: "u1", entityId: "p1", entityType: "place", action: "create", ts: reg + 5 * 864e5, after: { status: "open" }, ipPrefix: "10.1.0.0/16", deviceId: "d1" }));
  store.append(baseEvent({ editId: "e2", actorId: "u1", entityId: "p2", entityType: "place", action: "create", ts: reg + 6 * 864e5, after: { status: "open" }, ipPrefix: "10.1.0.0/16", deviceId: "d1" }));
  // 第 35 天（养号期外）
  store.append(baseEvent({ editId: "e3", actorId: "u1", entityId: "p3", entityType: "place", action: "create", ts: reg + 35 * 864e5, after: { status: "open" } }));
  store.append(baseEvent({ editId: "e4", actorId: "u1", entityId: "p3", entityType: "place", action: "modify", ts: reg + 35 * 864e5 + 1, before: { status: "open" }, after: { status: "closed" } }));

  const p = store.getActor("u1");
  assert.equal(p.totalEdits, 4);
  assert.equal(p.nurtureEdits, 2);
  assert.deepEqual([...p.ipPrefixes], ["10.1.0.0/16"]);
  assert.equal(p.editsByType.place, 4);
});

test("重复 editId 被拒绝；事件严格按 seq 全序", () => {
  const store = new EventStore();
  store.append(baseEvent({ editId: "e1", actorId: "u1", entityId: "p1", entityType: "place", action: "create", ts: T0, after: { status: "open" } }));
  assert.throws(() =>
    store.append(baseEvent({ editId: "e1", actorId: "u1", entityId: "p2", entityType: "place", action: "create", ts: T0, after: { status: "open" } })),
  );
  const seqs = store.allEvents().map((e) => e.seq);
  assert.deepEqual(seqs, [1]);
});

test("投影是纯函数：同一事件序列重放得到相同状态", () => {
  const events: EditEvent[] = [];
  const store = new EventStore();
  store.append(baseEvent({ editId: "e1", actorId: "u1", entityId: "r1", entityType: "road", action: "create", ts: T0, after: { openToTraffic: false } }));
  store.append(baseEvent({ editId: "e2", actorId: "u1", entityId: "r1", entityType: "road", action: "modify", ts: T0 + 1, before: { openToTraffic: false }, after: { openToTraffic: true } }));
  for (const e of store.allEvents()) events.push(e);

  let replay: ReturnType<typeof applyEvent> | null = null;
  for (const e of events) replay = applyEvent(replay, e);
  assert.deepEqual(replay, store.getEntity("r1"));
});
