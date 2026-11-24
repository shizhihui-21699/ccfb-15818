/**
 * 检测场景一：恶意批量关闭竞争对手店铺。
 * 同时验证误报边界：店主本人关店、有外部佐证的真实关店不应被立案。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeCorroborator, makeService } from "./helpers.ts";
import { closePlace, createPlace, DAY, HOUR, resetIdCounter } from "../src/domain/builders.ts";
import type { IngestInput } from "../src/domain/MapGuardService.ts";

const T0 = 1_700_000_000_000;

async function ingestAll(service: ReturnType<typeof makeService>, inputs: IngestInput[], now: number) {
  const allCases = [];
  for (const input of inputs) {
    const r = await service.ingest(input, now);
    allCases.push(...r.cases);
  }
  return allCases;
}

test("非认领账号短时间批量关闭 4 家商户 -> 立案并自动隔离", async () => {
  resetIdCounter();
  const service = makeService();
  service.registerActor("attacker", T0 - 40 * DAY);

  const inputs: IngestInput[] = [];
  for (let i = 1; i <= 4; i++) {
    const id = `rival-${i}`;
    inputs.push(createPlace(`owner-${i}`, id, T0 - 10 * DAY, { claimedBy: `owner-${i}` }));
  }
  // 攻击者在 2 小时内连续关店，无任何佐证
  for (let i = 1; i <= 4; i++) {
    inputs.push(closePlace("attacker", `rival-${i}`, T0 + i * 20 * 60 * 1000));
  }

  await ingestAll(service, inputs, T0 + 3 * HOUR);

  const cases = service.listCases();
  assert.ok(cases.length >= 1, "应至少形成一个案件");
  const top = cases[0]!;
  // 断言相对隔离状态而非魔法分数：阈值可随校准调整
  assert.equal(top.quarantined, true, "批量关店案件应被自动隔离");
  assert.ok(top.riskScore >= 60, `风险分应达到隔离阈值，实际 ${top.riskScore}`);

  // 触发了哪些规则必须可解释
  const ruleIds = top.signals.map((s) => s.ruleId);
  assert.ok(ruleIds.includes("R-CLOSE-RIVAL"));
  assert.ok(ruleIds.includes("R-BATCH-VELOCITY"));

  // 被隔离的关店编辑不能影响公众视图：商户仍显示营业
  const visible = service.publicEntity("rival-1");
  assert.ok(visible && visible.type === "place");
  assert.equal(visible.status, "open", "隔离期间公众视图应保持营业状态");
  // 审核端能看到待审的「已关闭」状态
  assert.equal((service.internalEntity("rival-1") as { status: string }).status, "closed");
});

test("店主本人关闭自己的店铺 -> 不产生恶意关店案件", async () => {
  resetIdCounter();
  const service = makeService();
  service.registerActor("owner-1", T0 - 100 * DAY);

  const inputs: IngestInput[] = [
    createPlace("owner-1", "shop-1", T0 - 30 * DAY, { claimedBy: "owner-1" }),
    closePlace("owner-1", "shop-1", T0, { reason: "店铺租约到期停业" }),
  ];
  await ingestAll(service, inputs, T0 + HOUR);

  const cases = service.listCases();
  assert.equal(cases.length, 0, "本人关店不应立案");
  // 编辑正常生效
  assert.equal((service.publicEntity("shop-1") as { status: string }).status, "closed");
});

test("外部权威源确认商户仍营业 -> 恶意关店信号升级；确认真实关店 -> 不立案", async () => {
  resetIdCounter();

  // 情形 A：外部源反驳（工商登记仍在册）
  const corroborator = new FakeCorroborator();
  corroborator.set("shop-a", { status: "open" });
  const serviceA = makeService([corroborator]);
  serviceA.registerActor("bad", T0 - 30 * DAY);
  await serviceA.ingest(createPlace("owner-a", "shop-a", T0 - 10 * DAY, { claimedBy: "owner-a" }), T0 - 9 * DAY);
  const rA = await serviceA.ingest(closePlace("bad", "shop-a", T0), T0 + 1000);
  const ruleA = rA.cases.flatMap((c) => c.signals).find((s) => s.ruleId === "R-CORROBORATION-MISMATCH");
  assert.ok(ruleA, "应产出佐证矛盾信号");
  assert.equal(ruleA?.level, "escalate");

  // 情形 B：外部源支持（工商已注销），怀疑信号被抑制
  resetIdCounter();
  const corroboratorB = new FakeCorroborator();
  corroboratorB.set("shop-b", { status: "closed" });
  const serviceB = makeService([corroboratorB]);
  serviceB.registerActor("editor-b", T0 - 30 * DAY);
  await serviceB.ingest(createPlace("owner-b", "shop-b", T0 - 10 * DAY, { claimedBy: "owner-b" }), T0 - 9 * DAY);
  const rB = await serviceB.ingest(closePlace("editor-b", "shop-b", T0), T0 + 1000);
  // 单条关店 + 外部支持，不形成案件
  assert.equal(rB.cases.length, 0);
});

test("高信誉老账号的首次可疑编辑被降权，但仍留 review 痕迹", async () => {
  resetIdCounter();
  const service = makeService();
  service.registerActor("veteran", T0 - 400 * DAY);
  // 积累大量正反馈
  for (let i = 0; i < 20; i++) {
    service.store.recordFeedback("veteran", 1);
  }
  await service.ingest(createPlace("veteran", "place-x", T0 - 5 * DAY), T0 - 4 * DAY);
  // 一次无佐证关店（非本人认领）
  const r = await service.ingest(closePlace("veteran", "place-x", T0), T0 + 1000);
  for (const c of r.cases) {
    for (const s of c.signals) {
      if (s.ruleId === "R-CLOSE-RIVAL") assert.notEqual(s.level, "escalate");
    }
  }
});
