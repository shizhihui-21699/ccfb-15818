/**
 * 端到端集成测试：完整工作流串起来验证。
 *
 * 恶意批量关店：
 *   1. 编辑入库即检测，高风险案件自动隔离；
 *   2. 隔离期公众视图不受污染，审核端可见待审状态；
 *   3. 人审确认恶意，账号污点回写；
 *   4. 执行依赖感知回滚，补偿事件还原状态；
 *   5. 回滚后公众视图与内部视图一致收敛，审计链完整可查。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { makeService } from "./helpers.ts";
import { closePlace, createPlace, resetIdCounter, DAY, HOUR } from "../src/domain/builders.ts";

const T0 = 1_700_000_000_000;

test("端到端：恶意关店从检测、隔离、人审到回滚的完整生命周期", async () => {
  resetIdCounter();
  const service = makeService();
  service.registerActor("vandal", T0 - 45 * DAY);

  // 4 家正常营业的商户
  for (let i = 1; i <= 4; i++) {
    await service.ingest(
      createPlace(`owner-${i}`, `shop-${i}`, T0 - 10 * DAY, { claimedBy: `owner-${i}` }),
      T0 - 9 * DAY,
    );
  }

  // 攻击：2 小时内批量关店
  const maliciousEditIds: string[] = [];
  for (let i = 1; i <= 4; i++) {
    const r = await service.ingest(closePlace("vandal", `shop-${i}`, T0 + i * 20 * 60 * 1000), T0 + 3 * HOUR);
    if (r.event) maliciousEditIds.push(r.event.editId);
  }

  // 阶段一：立案并隔离
  const c = service.listCases()[0]!;
  assert.ok(c, "应形成案件");
  assert.equal(c.quarantined, true);
  for (let i = 1; i <= 4; i++) {
    // 公众视图：仍是攻击前的营业状态
    assert.equal((service.publicEntity(`shop-${i}`) as { status: string }).status, "open");
    // 审核端：能看到待审的关闭状态
    assert.equal((service.internalEntity(`shop-${i}`) as { status: string }).status, "closed");
  }

  // 阶段二：人审确认恶意
  service.confirm(c.caseId, "reviewer-anna", "证据确凿：批量关闭竞争对手店铺", T0 + 4 * HOUR);
  assert.equal(service.getCase(c.caseId)!.status, "confirmed_malicious");
  assert.ok(service.store.getActor("vandal").badEdits >= 1);

  // 阶段三：回滚
  const report = service.executeRollback(c.caseId, "ops-bot", T0 + 5 * HOUR);
  assert.equal(report.conflictCount, 0);
  assert.ok(report.reversedCount >= 4);
  assert.equal(service.getCase(c.caseId)!.status, "rolled_back");

  // 阶段四：视图收敛，商户恢复营业
  for (let i = 1; i <= 4; i++) {
    const visible = service.publicEntity(`shop-${i}`) as { status: string };
    const internal = service.internalEntity(`shop-${i}`) as { status: string };
    assert.equal(visible.status, "open");
    assert.equal(internal.status, "open");
  }

  // 阶段五：审计链完整——补偿事件可追溯到原始恶意编辑与案件
  const compEvents = service.store.allEvents().filter((e) => e.caseId === c.caseId);
  assert.ok(compEvents.length >= 4);
  for (const comp of compEvents) {
    assert.ok(comp.compensationFor !== null);
    assert.ok(maliciousEditIds.includes(comp.compensationFor!));
    assert.ok(comp.reason?.includes(c.caseId));
  }
});

test("端到端：人审驳回真实关店后，隔离解除且编辑正常生效", async () => {
  resetIdCounter();
  const service = makeService();
  service.registerActor("editor", T0 - 45 * DAY);
  await service.ingest(
    createPlace("owner-1", "real-shop", T0 - 10 * DAY, { claimedBy: "owner-1" }),
    T0 - 9 * DAY,
  );

  // 构造一个达到立案阈值的批次（3 家），但人审判断都是真实关店
  for (let i = 1; i <= 3; i++) {
    await service.ingest(
      createPlace(`owner-x${i}`, `real-shop-${i}`, T0 - 8 * DAY, { claimedBy: `owner-x${i}` }),
      T0 - 7 * DAY,
    );
  }
  for (let i = 1; i <= 3; i++) {
    await service.ingest(
      closePlace("editor", `real-shop-${i}`, T0 + i * 1000, { reason: "实地核实已停业", evidenceRefs: ["photo-1"] }),
      T0 + 4000,
    );
  }

  const c = service.listCases()[0]!;
  assert.ok(c, "批量关店仍会立案等待人审");
  service.dismiss(c.caseId, "reviewer-ben", "经核实为真实世界变化，全部停业属实", T0 + 5000);

  const after = service.getCase(c.caseId)!;
  assert.equal(after.status, "dismissed");
  assert.equal(after.quarantined, false);
  // 驳回后编辑放行，公众视图看到关闭状态
  assert.equal((service.publicEntity("real-shop-1") as { status: string }).status, "closed");
});
