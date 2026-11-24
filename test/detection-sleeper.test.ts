/**
 * 检测场景二：养号后突发作案。
 * 攻击者注册账号后先做大量正常编辑积累信誉，沉寂/养号期结束后突发高风险操作。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { makeService } from "./helpers.ts";
import { closePlace, createPlace, DAY, HOUR, resetIdCounter } from "../src/domain/builders.ts";
import { extractActorFeatures } from "../src/domain/features.ts";

const T0 = 1_700_000_000_000;

test("养号期低风险编辑 -> 突发批量关店，触发 R-SLEEPER-WAKE", async () => {
  resetIdCounter();
  const service = makeService();
  const reg = T0 - 35 * DAY;
  service.registerActor("sleeper", reg);

  // 养号期（前 20 天）：8 条良性的商户创建，带正反馈
  for (let i = 1; i <= 8; i++) {
    await service.ingest(
      createPlace("sleeper", `benign-${i}`, reg + (2 * i) * DAY, {
        name: `正常商户${i}`,
        claimedBy: "sleeper",
      }),
      reg + (2 * i) * DAY + HOUR,
    );
    service.store.recordFeedback("sleeper", 2);
  }

  // 突发期：3 小时内连续关闭 3 家他人店铺
  const victims: string[] = [];
  for (let i = 1; i <= 3; i++) {
    const id = `victim-${i}`;
    victims.push(id);
    await service.ingest(
      createPlace(`owner-${i}`, id, T0 - 5 * DAY, { claimedBy: `owner-${i}` }),
      T0 - 4 * DAY,
    );
  }
  for (let i = 0; i < victims.length; i++) {
    await service.ingest(closePlace("sleeper", victims[i]!, T0 + i * 30 * 60 * 1000), T0 + 3 * HOUR);
  }

  const c = service.listCases()[0];
  assert.ok(c, "应形成案件");
  const ruleIds = c.signals.map((s) => s.ruleId);
  assert.ok(ruleIds.includes("R-SLEEPER-WAKE"), `应命中养号突发规则，实际 ${ruleIds.join(",")}`);
  assert.ok(c.quarantined, "养号作案案件应被隔离");

  const sleeperSignal = c.signals.find((s) => s.ruleId === "R-SLEEPER-WAKE")!;
  assert.ok((sleeperSignal.evidence.riskyEditIds as unknown[]).length >= 3);
  // 证据必须可解释
  assert.ok(typeof sleeperSignal.explanation === "string" && sleeperSignal.explanation.length > 10);
});

test("始终稳定贡献的正常账号不会被误判为养号", async () => {
  resetIdCounter();
  const service = makeService();
  const reg = T0 - 200 * DAY;
  service.registerActor("steady", reg);

  // 长期、均匀地编辑，没有突发倍率
  for (let i = 0; i < 12; i++) {
    const ts = reg + (10 * i + 5) * DAY;
    await service.ingest(
      createPlace("steady", `s-${i}`, ts, { claimedBy: "steady" }),
      ts + HOUR,
    );
  }
  const af = extractActorFeatures(service.store.getActor("steady"), T0);
  assert.equal(af.isSleeperWake, false, "稳定贡献账号不应出现养号突发特征");
});

test("人审确认恶意后账号污点进入画像，再次作案被 R-REPEAT-TAINTED 直接升级", async () => {
  resetIdCounter();
  const service = makeService();
  service.registerActor("repeat", T0 - 60 * DAY);
  // 第一批：连续关闭 3 家他人店铺，达到立案条件
  for (let i = 1; i <= 3; i++) {
    await service.ingest(
      createPlace(`owner-a${i}`, `shop-a${i}`, T0 - 2 * DAY, { claimedBy: `owner-a${i}` }),
      T0 - 2 * DAY + HOUR,
    );
  }
  for (let i = 1; i <= 3; i++) {
    await service.ingest(closePlace("repeat", `shop-a${i}`, T0 + i * 1000), T0 + 4000);
  }

  // 人审确认并回写污点
  const caseId = service.listCases()[0]!.caseId;
  service.confirm(caseId, "reviewer-1", "确认恶意关店", T0 + 5000);
  assert.ok(service.store.getActor("repeat").badEdits >= 1);

  // 同一账号再次对新店铺下手——哪怕只关一家，前科规则也应直接升级
  await service.ingest(
    createPlace("owner-y", "shop-y", T0 + 3 * HOUR, { claimedBy: "owner-y" }),
    T0 + 3 * HOUR + 1000,
  );
  const again = await service.ingest(closePlace("repeat", "shop-y", T0 + 4 * HOUR), T0 + 4 * HOUR + 1000);
  const allRuleIds = again.cases.flatMap((c) => c.signals.map((s) => s.ruleId));
  assert.ok(allRuleIds.includes("R-REPEAT-TAINTED"), "有前科账号应触发再犯规则");
  const repeatSignal = again.cases
    .flatMap((c) => c.signals)
    .find((s) => s.ruleId === "R-REPEAT-TAINTED");
  assert.equal(repeatSignal?.level, "escalate");
});
