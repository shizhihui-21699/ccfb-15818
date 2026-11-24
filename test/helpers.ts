/** 测试共享工具：构造一个装配好全部标准检测器的服务 */

import {
  BatchVelocityDetector,
  CloseRivalDetector,
  CompoundRoadOpenDetector,
  NoEvidenceRiskyDetector,
  RestrictionLiftDetector,
} from "../src/detection/rules/contentRules.ts";
import {
  NewActorRiskyDetector,
  RepeatTaintedDetector,
  SleeperWakeDetector,
} from "../src/detection/rules/actorRules.ts";
import {
  CoordClusterDetector,
  CorroborationMismatchDetector,
} from "../src/detection/rules/networkRules.ts";
import type { Detector } from "../src/detection/Detector.ts";
import { MapGuardService } from "../src/domain/MapGuardService.ts";
import type { CorroborationProvider } from "../src/domain/types.ts";

function buildDetectors(corroborators: CorroborationProvider[]): Detector[] {
  return [
    new CloseRivalDetector(),
    new CompoundRoadOpenDetector(),
    new RestrictionLiftDetector(),
    new NoEvidenceRiskyDetector(),
    new BatchVelocityDetector(),
    new SleeperWakeDetector(),
    new NewActorRiskyDetector(),
    new RepeatTaintedDetector(),
    new CoordClusterDetector(),
    new CorroborationMismatchDetector(corroborators),
  ];
}

export function makeService(corroborators: CorroborationProvider[] = []) {
  return new MapGuardService(buildDetectors(corroborators));
}

/** 内存版外部佐证源 */
export class FakeCorroborator implements CorroborationProvider {
  private data = new Map<string, Record<string, unknown>>();
  set(entityId: string, state: Record<string, unknown>): void {
    this.data.set(entityId, state);
  }
  async fetchExternalState(entityId: string) {
    return this.data.get(entityId) ?? null;
  }
}
