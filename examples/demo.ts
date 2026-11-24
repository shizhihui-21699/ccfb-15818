/**
 * map-guard 演示：用一个连贯故事演完三类攻击的识别与处置。
 *
 * 运行：node examples/demo.ts
 *
 * 故事线：
 *   A. 恶意批量关闭竞争对手店铺
 *   B. 养号后突发作案
 *   C. 多账号拆分协同，把小区道路改成可通行并解除限行
 * 最后展示依赖感知回滚如何连带撤销受影响的下游编辑。
 */

import { MapGuardService, buildDefaultDetectors } from "../src/domain/MapGuardService.ts";
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
const MIN = 60 * 1000;

function hr(title: string): void {
  console.log(`\n${"=".repeat(72)}\n${title}\n${"=".repeat(72)}`);
}

function showCases(service: MapGuardService): void {
  for (const c of service.listCases()) {
    console.log(`  案件 ${c.caseId} | 风险分 ${c.riskScore} | 隔离=${c.quarantined} | 状态=${c.status}`);
    console.log(`    标题: ${c.title}`);
    for (const s of c.signals) {
      console.log(`    - [${s.level}] ${s.ruleId} (置信度 ${s.confidence}): ${s.explanation}`);
    }
  }
}

async function main(): Promise<void> {
  resetIdCounter();
  const service = new MapGuardService(buildDefaultDetectors());

  // ------------------------------------------------------------------- A
  hr("场景 A：恶意批量关闭竞争对手店铺");
  service.registerActor("attacker-a", T0 - 40 * DAY);
  for (let i = 1; i <= 4; i++) {
    await service.ingest(
      createPlace(`owner-${i}`, `rival-${i}`, T0 - 10 * DAY, { claimedBy: `owner-${i}` }),
      T0 - 9 * DAY,
    );
  }
  for (let i = 1; i <= 4; i++) {
    await service.ingest(closePlace("attacker-a", `rival-${i}`, T0 + i * 20 * MIN), T0 + 3 * HOUR);
  }
  showCases(service);
  const caseA = service.listCases()[0]!;
  console.log(`  公众视图 rival-1 状态（隔离中应仍为 open）: ${
    (service.publicEntity("rival-1") as { status: string }).status
  }`);

  // 人审确认并回滚
  service.confirm(caseA.caseId, "reviewer-1", "确认恶意打击竞争对手", T0 + 4 * HOUR);
  const reportA = service.executeRollback(caseA.caseId, "ops", T0 + 5 * HOUR);
  console.log(`  回滚: 撤销 ${reportA.reversedCount} 条，冲突 ${reportA.conflictCount} 条，` +
    `案件状态=${service.getCase(caseA.caseId)!.status}`);
  console.log(`  回滚后 rival-1 状态: ${(service.publicEntity("rival-1") as { status: string }).status}`);

  // ------------------------------------------------------------------- B
  hr("场景 B：养号后突发作案");
  const reg = T0 - 35 * DAY;
  service.registerActor("sleeper", reg);
  // 养号期：良性编辑攒信誉
  for (let i = 1; i <= 8; i++) {
    await service.ingest(
      createPlace("sleeper", `benign-${i}`, reg + 2 * i * DAY, { claimedBy: "sleeper" }),
      reg + 2 * i * DAY + HOUR,
    );
    service.store.recordFeedback("sleeper", 2);
  }
  // 突发期：批量关店
  for (let i = 1; i <= 3; i++) {
    await service.ingest(
      createPlace(`vic-owner-${i}`, `victim-${i}`, T0 - 2 * DAY, { claimedBy: `vic-owner-${i}` }),
      T0 - 2 * DAY + HOUR,
    );
  }
  for (let i = 0; i < 3; i++) {
    await service.ingest(closePlace("sleeper", `victim-${i + 1}`, T0 + i * 30 * MIN), T0 + 3 * HOUR);
  }
  const sleeperSignals = service
    .listCases()
    .flatMap((c: Case) => c.signals)
    .filter((s) => s.ruleId === "R-SLEEPER-WAKE");
  console.log(`  R-SLEEPER-WAKE 命中 ${sleeperSignals.length} 次: ${sleeperSignals[0]?.explanation ?? "（无）"}`);

  // ------------------------------------------------------------------- C
  hr("场景 C：多账号拆分协同（小区道路开放 + 限行解除）");
  service.registerActor("mule-a", T0 - 20 * DAY);
  service.registerActor("mule-b", T0 - 18 * DAY);
  service.registerActor("mule-c", T0 - 16 * DAY);
  await service.ingest(createCompoundRoad("planner", "road-x", "compound-z", T0 - 30 * DAY), T0 - 29 * DAY);
  await service.ingest(createRestriction("planner", "restr-x", "road-x", T0 - 29 * DAY), T0 - 29 * DAY + 1000);

  await service.ingest({
    editId: "c-1", ts: T0, actorId: "mule-a", entityId: "road-x", entityType: "road",
    action: "modify", before: { roadClass: "residential" }, after: { roadClass: "secondary" },
    deviceId: "farm-dev", ipPrefix: "10.8.0.0/16",
  }, T0 + 1000);
  await service.ingest({
    ...openCompoundRoad("mule-b", "road-x", T0 + HOUR, { deviceId: "farm-dev", ipPrefix: "10.8.0.0/16" }),
    editId: "c-2",
  }, T0 + HOUR + 1000);
  await service.ingest({
    ...deactivateRestriction("mule-c", "restr-x", T0 + 2 * HOUR, { deviceId: "farm-dev", ipPrefix: "10.8.0.0/16" }),
    editId: "c-3",
  }, T0 + 2 * HOUR + 1000);

  const coordCase = service
    .listCases()
    .find((c) => c.signals.some((s) => s.ruleId === "R-COORD-CLUSTER"))!;
  const coord = coordCase.signals
    .filter((s) => s.ruleId === "R-COORD-CLUSTER")
    .reduce((a, b) =>
      ((b.evidence.actorIds as string[]).length > (a.evidence.actorIds as string[]).length ? b : a));
  console.log(`  协同团伙: ${(coord.evidence.actorIds as string[]).join("、")}`);
  console.log(`  关联依据: ${(coord.evidence.reasons as string[]).slice(0, 3).join("；")}`);
  console.log(`  案件隔离状态: ${coordCase.quarantined}`);

  hr("处置汇总");
  console.log(`  共形成案件 ${service.listCases().length} 个`);
  for (const c of service.listCases()) {
    console.log(`  - ${c.caseId}: ${c.status}，风险分 ${c.riskScore}，涉案编辑 ${c.links.length} 条`);
  }
  console.log("\n演示完成。");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
