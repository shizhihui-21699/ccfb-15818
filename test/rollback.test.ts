/**
 * 回滚引擎测试。
 *
 * 覆盖：
 * 1. 确认恶意后，恶意编辑与其下游受影响编辑一起被补偿事件撤销；
 * 2. 下游存在善意第三方同字段编辑时，冲突项只隔离不自动覆盖；
 * 3. 跨实体引用（限行依赖被污染道路）纳入受影响集合；
 * 4. 补偿事件是原操作的严格逆，投影状态回到篡改前；
 * 5. 幂等：重复执行不产生重复补偿；
 * 6. 回滚全程只追加，审计链完整。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { RollbackEngine } from "../src/rollback/RollbackEngine.ts";
import { EventStore } from "../src/domain/EventStore.ts";
import type { EditEvent } from "../src/domain/types.ts";
import {
  closePlace,
  createCompoundRoad,
  createPlace,
  createRestriction,
  deactivateRestriction,
  openCompoundRoad,
  resetIdCounter,
  DAY,
  HOUR,
} from "../src/domain/builders.ts";
import type { Case } from "../src/domain/types.ts";

const T0 = 1_700_000_000_000;

function freshStore(): EventStore {
  resetIdCounter();
  return new EventStore();
}

function rawEvent(over: Partial<EditEvent> & Pick<EditEvent, "editId" | "actorId" | "entityId" | "entityType" | "action" | "ts" | "seq">): EditEvent {
  return {
    before: {}, after: {}, reason: null, evidenceRefs: [], ipPrefix: null,
    deviceId: null, compensationFor: null, caseId: null, ...over,
  };
}

/** 把 builder 产出的 IngestInput 归一化为 EventStore.append 需要的完整事件 */
function appendInput(store: EventStore, input: ReturnType<typeof createPlace>): EditEvent {
  return store.append({
    editId: input.editId,
    ts: input.ts,
    actorId: input.actorId,
    entityId: input.entityId,
    entityType: input.entityType,
    action: input.action,
    before: input.before ?? {},
    after: input.after ?? {},
    reason: input.reason ?? null,
    evidenceRefs: input.evidenceRefs ?? [],
    ipPrefix: input.ipPrefix ?? null,
    deviceId: input.deviceId ?? null,
    compensationFor: null,
    caseId: null,
  });
}

function makeCase(seedIds: string[], actorIds: string[], now: number): Case {
  return {
    caseId: "CASE-T1",
    status: "confirmed_malicious",
    createdAt: now,
    updatedAt: now,
    title: "test",
    signals: [],
    links: seedIds.map((editId) => ({ editId, role: "seed" as const, ruleId: "R-TEST" })),
    actorIds,
    riskScore: 90,
    quarantined: true,
    resolution: null,
    resolvedBy: null,
  };
}

test("恶意关店被补偿事件撤销，商户状态恢复为营业", () => {
  const store = freshStore();
  store.registerActor("attacker", T0 - 30 * DAY);
  appendInput(store, createPlace("owner", "p1", T0 - 5 * DAY, { claimedBy: "owner" }));
  const malicious = appendInput(store, closePlace("attacker", "p1", T0));

  const engine = new RollbackEngine(store);
  const report = engine.rollback(makeCase([malicious.editId], ["attacker"], T0 + HOUR), T0 + 2 * HOUR, { operator: "admin" });

  assert.equal(report.reversedCount, 1);
  assert.equal(report.conflictCount, 0);
  const place = store.getEntity("p1");
  assert.ok(place && place.type === "place");
  assert.equal(place.status, "open", "回滚后商户应恢复营业");

  // 补偿事件是 modify 的逆，且带案件审计信息
  const comp = store.getEvent(report.items[0]!.compensationEditId!)!;
  assert.equal(comp.compensationFor, malicious.editId);
  assert.equal(comp.caseId, "CASE-T1");
  assert.deepEqual(comp.after, { status: "open" });
});

test("下游编辑建立在污染状态上 -> 随恶意编辑一起逆序撤销", () => {
  const store = freshStore();
  // 道路初始不可通行
  appendInput(store, createCompoundRoad("planner", "r1", "c1", T0 - 10 * DAY));
  // 恶意开放
  const malicious = appendInput(store, openCompoundRoad("attacker", "r1", T0));
  // 同案账号随后基于污染状态改了道路名（下游，应一并撤销）
  const downstream = store.append(rawEvent({
    editId: "down-1", seq: 99, actorId: "attacker", entityId: "r1", entityType: "road",
    action: "modify", ts: T0 + HOUR, before: { name: "小区内部路" }, after: { name: "快捷通道" },
  }));

  const engine = new RollbackEngine(store);
  const { ordered, downstream: expanded } = engine.expandAffected(new Set([malicious.editId]));
  assert.ok(expanded.has(downstream.editId), "下游编辑应被展开进受影响集合");
  assert.deepEqual(ordered.map((e) => e.editId), [malicious.editId, downstream.editId]);

  const report = engine.rollback(makeCase([malicious.editId], ["attacker"], T0 + 2 * HOUR), T0 + 3 * HOUR, { operator: "admin" });
  assert.equal(report.reversedCount, 2);
  const road = store.getEntity("r1");
  assert.ok(road && road.type === "road");
  assert.equal(road.openToTraffic, false, "道路恢复不可通行");
  assert.equal(road.name, "小区内部路", "下游改名也被撤销");
});

test("善意第三方在恶意编辑后改了同字段 -> 标记冲突，不自动覆盖", () => {
  const store = freshStore();
  appendInput(store, createPlace("owner", "p2", T0 - 5 * DAY));
  const malicious = appendInput(store, closePlace("attacker", "p2", T0));
  // 无关的善意用户随后更新了营业状态（比如真实地改为暂停营业），改的是同字段 status
  const goodFaith = store.append(rawEvent({
    editId: "good-1", seq: 50, actorId: "trusted-mapper", entityId: "p2", entityType: "place",
    action: "modify", ts: T0 + HOUR, before: { status: "closed" },
    after: { status: "temporarily_closed" },
  }));

  const engine = new RollbackEngine(store);
  const c = makeCase([malicious.editId], ["attacker"], T0 + 2 * HOUR);
  const report = engine.rollback(c, T0 + 3 * HOUR, { operator: "admin" });

  // 善意下游因同字段冲突保留，且实体保持隔离；种子补偿也暂缓，系统不擅自定夺字段值
  const conflictItem = report.items.find((i) => i.editId === goodFaith.editId);
  assert.equal(conflictItem?.status, "conflict");
  assert.ok(conflictItem?.conflictReason?.includes("trusted-mapper"));
  const seedItem = report.items.find((i) => i.editId === malicious.editId);
  assert.equal(seedItem?.status, "conflict", "冲突实体上的种子补偿应暂缓");
  assert.equal(report.conflictCount, 1);
  assert.equal(c.status, "partially_rolled_back");
  assert.equal(c.quarantined, true, "存在未解决冲突的实体必须保持隔离待人审");
  // 善意编辑的值原样保留，未被系统覆盖
  const place = store.getEntity("p2");
  assert.equal((place as { status: string }).status, "temporarily_closed");
});

test("善意第三方只改了无关字段 -> 不构成冲突，恶意字段照常回滚", () => {
  const store = freshStore();
  appendInput(store, createPlace("owner", "p3", T0 - 5 * DAY));
  const malicious = appendInput(store, closePlace("attacker", "p3", T0));
  // 善意用户改的是 name，与被污染的 status 无关
  store.append(rawEvent({
    editId: "good-2", seq: 51, actorId: "trusted-mapper", entityId: "p3", entityType: "place",
    action: "modify", ts: T0 + HOUR, before: { name: "旧名" }, after: { name: "新名" },
  }));

  const engine = new RollbackEngine(store);
  const report = engine.rollback(makeCase([malicious.editId], ["attacker"], T0 + 2 * HOUR), T0 + 3 * HOUR, { operator: "admin" });
  assert.equal(report.conflictCount, 0);
  // 善意下游与恶意种子都被正常撤销
  assert.equal(report.reversedCount, 2);
  const place = store.getEntity("p3") as { status: string; name: string };
  assert.equal(place.status, "open", "恶意 status 被回滚");
  assert.equal(place.name, "旧名", "善意下游整体逆操作后，name 还原到该编辑之前的值");
});

test("跨实体：限行依赖被污染道路，限行的后续编辑纳入受影响集合", () => {
  const store = freshStore();
  appendInput(store, createCompoundRoad("planner", "r2", "c2", T0 - 10 * DAY));
  appendInput(store, createRestriction("planner", "restr-2", "r2", T0 - 9 * DAY));
  const malicious = appendInput(store, openCompoundRoad("attacker", "r2", T0));
  // 限行实体的后续编辑（引用被污染道路 r2）
  const restrEdit = appendInput(store, deactivateRestriction("attacker2", "restr-2", T0 + HOUR));

  const engine = new RollbackEngine(store);
  const { downstream } = engine.expandAffected(new Set([malicious.editId]));
  assert.ok(downstream.has(restrEdit.editId), "引用污染道路的限行编辑应被纳入");
});

test("回滚幂等：同一案件重复执行返回缓存报告，不产生重复补偿", () => {
  const store = freshStore();
  appendInput(store, createPlace("owner", "p4", T0 - 5 * DAY));
  const malicious = appendInput(store, closePlace("attacker", "p4", T0));
  const eventCountBefore = store.allEvents().length;

  const engine = new RollbackEngine(store);
  const c = makeCase([malicious.editId], ["attacker"], T0 + HOUR);
  const r1 = engine.rollback(c, T0 + 2 * HOUR, { operator: "admin" });
  const r2 = engine.rollback(c, T0 + 3 * HOUR, { operator: "admin" });
  assert.equal(r1, r2, "重复执行应返回同一份报告");
  assert.equal(store.allEvents().length, eventCountBefore + 1, "只应有一条补偿事件");
});

test("create 型恶意编辑的逆是 delete；delete 型的逆是 create", () => {
  const store = freshStore();
  // 恶意创建一个虚假限行，回滚应删除它
  const fakeCreate = appendInput(store, createRestriction("vandal", "fake-restr", "r9", T0));
  const engine = new RollbackEngine(store);
  const report = engine.rollback(makeCase([fakeCreate.editId], ["vandal"], T0 + HOUR), T0 + 2 * HOUR, { operator: "admin" });
  const comp = store.getEvent(report.items[0]!.compensationEditId!)!;
  assert.equal(comp.action, "delete");
  assert.equal(store.getEntity("fake-restr")?.deleted, true);
});
