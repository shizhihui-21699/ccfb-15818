/**
 * 检测场景三：多账号拆分协同。
 * 一次完整篡改被拆成多个看似无害的小改动，分散在不同账号、不同时间，
 * 通过共享设备/IP 和时间接力暴露团伙结构。
 *
 * 同时验证关键反例：仅仅编辑过同一个热门实体的正常用户，不会被误连成团伙。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { CoordinationGraph } from "../src/detection/CoordinationGraph.ts";
import { makeService } from "./helpers.ts";
import {
  createCompoundRoad,
  createRestriction,
  deactivateRestriction,
  openCompoundRoad,
  DAY,
  HOUR,
  resetIdCounter,
} from "../src/domain/builders.ts";
import type { EditEvent } from "../src/domain/types.ts";

const T0 = 1_700_000_000_000;

test("三个账号接力拆分开放小区道路+解除限行，共享设备 -> 聚合成一个团伙案件", async () => {
  resetIdCounter();
  const service = makeService();
  // 账号农场：三台"马甲"在同一设备/IP 段注册
  service.registerActor("mule-a", T0 - 20 * DAY);
  service.registerActor("mule-b", T0 - 18 * DAY);
  service.registerActor("mule-c", T0 - 16 * DAY);

  // 正常历史：小区道路创建 + 限行存在
  await service.ingest(createCompoundRoad("planner", "road-1", "compound-x", T0 - 30 * DAY), T0 - 29 * DAY);
  await service.ingest(createRestriction("planner", "restr-1", "road-1", T0 - 29 * DAY), T0 - 29 * DAY + 1000);

  // 拆分攻击，每一步单独看都"无害"，但都来自同一设备指纹 farm-dev-1
  // 步骤 1：mule-a 先改道路等级（铺垫）
  await service.ingest({
    editId: "atk-1",
    ts: T0,
    actorId: "mule-a",
    entityId: "road-1",
    entityType: "road",
    action: "modify",
    before: { roadClass: "residential" },
    after: { roadClass: "secondary" },
    deviceId: "farm-dev-1",
    ipPrefix: "10.8.0.0/16",
  }, T0 + 1000);

  // 步骤 2：1 小时后 mule-b 把道路改成可通行（核心动作）
  await service.ingest(
    {
      ...openCompoundRoad("mule-b", "road-1", T0 + HOUR, { deviceId: "farm-dev-1", ipPrefix: "10.8.0.0/16" }),
      editId: "atk-2",
    },
    T0 + HOUR + 1000,
  );

  // 步骤 3：再 1 小时后 mule-c 解除该道路上的限行（让导航真正放行车流）
  await service.ingest(
    {
      ...deactivateRestriction("mule-c", "restr-1", T0 + 2 * HOUR, { deviceId: "farm-dev-1", ipPrefix: "10.8.0.0/16" }),
      editId: "atk-3",
    },
    T0 + 2 * HOUR + 1000,
  );

  const cases = service.listCases();
  const coordCase = cases.find((c) => c.signals.some((s) => s.ruleId === "R-COORD-CLUSTER"));
  assert.ok(coordCase, "应形成协同团伙案件");

  // 案件合并会保留早期较小簇的信号，取账号覆盖最全的一条作为最终团伙结论
  const coordSignals = coordCase.signals.filter((s) => s.ruleId === "R-COORD-CLUSTER");
  const coordSignal = coordSignals.reduce((a, b) =>
    ((b.evidence.actorIds as string[]).length > (a.evidence.actorIds as string[]).length ? b : a),
  );
  const actorIds = coordSignal.evidence.actorIds as string[];
  for (const mule of ["mule-a", "mule-b", "mule-c"]) {
    assert.ok(actorIds.includes(mule), `团伙应包含 ${mule}`);
  }
  // 正常规划账号不在团伙里
  assert.ok(!actorIds.includes("planner"), "正常账号 planner 不应被卷入团伙");
  assert.ok(coordCase.quarantined, "协同案件应被隔离");
});

test("仅共改同一热门实体、无环境/时间关联的正常用户不构成团伙", () => {
  // 三个用户在几个月内各自编辑同一个地标，时间相隔很远，IP/设备完全不同
  const events: EditEvent[] = [
    {
      editId: "n1", seq: 1, ts: T0 - 90 * DAY, actorId: "user-1", entityId: "landmark", entityType: "place",
      action: "modify", before: {}, after: { name: "旧名称" }, reason: null, evidenceRefs: [],
      ipPrefix: "1.1.0.0/16", deviceId: "dev-1", compensationFor: null, caseId: null,
    },
    {
      editId: "n2", seq: 2, ts: T0 - 40 * DAY, actorId: "user-2", entityId: "landmark", entityType: "place",
      action: "modify", before: {}, after: { name: "新名称" }, reason: null, evidenceRefs: [],
      ipPrefix: "2.2.0.0/16", deviceId: "dev-2", compensationFor: null, caseId: null,
    },
    {
      editId: "n3", seq: 3, ts: T0 - 5 * DAY, actorId: "user-3", entityId: "landmark", entityType: "place",
      action: "modify", before: {}, after: { category: "poi" }, reason: null, evidenceRefs: [],
      ipPrefix: "3.3.0.0/16", deviceId: "dev-3", compensationFor: null, caseId: null,
    },
  ];

  const graph = new CoordinationGraph(events);
  const clusters = graph.clusters();
  assert.equal(clusters.length, 0, "跨时段、无环境关联的普通共改不应形成团伙");
});

test("共享 IP 段但无其他关联的两个账号，证据权重不足时不成团", () => {
  const events: EditEvent[] = [
    {
      editId: "s1", seq: 1, ts: T0 - DAY, actorId: "u-a", entityId: "e1", entityType: "place",
      action: "create", before: {}, after: { status: "open" }, reason: null, evidenceRefs: [],
      ipPrefix: "9.9.0.0/16", deviceId: "da", compensationFor: null, caseId: null,
    },
    {
      editId: "s2", seq: 2, ts: T0, actorId: "u-b", entityId: "e2", entityType: "place",
      action: "create", before: {}, after: { status: "open" }, reason: null, evidenceRefs: [],
      ipPrefix: "9.9.0.0/16", deviceId: "db", compensationFor: null, caseId: null,
    },
  ];
  // 单条共享 IP 边权重 1，低于默认成团阈值 2.5
  const graph = new CoordinationGraph(events);
  assert.equal(graph.clusters().length, 0);
  // 但如果 u-a、u-b 在时间窗内对同一实体多轮短间隔接力，连接性证据累积后成团
  const more = [
    ...events,
    {
      ...events[0]!,
      editId: "s3", seq: 3, entityId: "e1", ts: T0 + 500,
      action: "modify" as const, before: { x: 0 }, after: { x: 1 },
    },
    {
      ...events[1]!,
      editId: "s4", seq: 4, entityId: "e1", ts: T0 + 1000,
      action: "modify" as const, before: { x: 1 }, after: { x: 2 },
    },
    {
      ...events[0]!,
      editId: "s5", seq: 5, entityId: "e1", ts: T0 + 1500,
      action: "modify" as const, before: { x: 2 }, after: { x: 3 },
    },
  ];
  const graph2 = new CoordinationGraph(more);
  const clusters = graph2.clusters();
  assert.ok(clusters.length >= 1, "IP 共享 + 多轮时间窗内接力共改后应成团");
  assert.deepEqual(clusters[0]!.actorIds, ["u-a", "u-b"]);
});
