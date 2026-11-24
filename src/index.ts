/**
 * map-guard 公共导出面。
 * 生产集成方只需要理解这一层：服务门面、领域类型、检测器接口与标准检测器工厂。
 */

export { MapGuardService, buildDefaultDetectors } from "./domain/MapGuardService.ts";
export { EventStore, type ActorProfile } from "./domain/EventStore.ts";
export { PublicMapView } from "./domain/PublicMapView.ts";
export { applyEvent, createEntity } from "./domain/projection.ts";
export * from "./domain/types.ts";

export { DetectionEngine, type EngineOptions } from "./detection/DetectionEngine.ts";
export { type Detector, type DetectionContext, DEFAULT_TUNING } from "./detection/Detector.ts";
export { CoordinationGraph, DEFAULT_COORD_OPTIONS } from "./detection/CoordinationGraph.ts";

export {
  CloseRivalDetector,
  CompoundRoadOpenDetector,
  RestrictionLiftDetector,
  NoEvidenceRiskyDetector,
  BatchVelocityDetector,
} from "./detection/rules/contentRules.ts";
export {
  SleeperWakeDetector,
  NewActorRiskyDetector,
  RepeatTaintedDetector,
} from "./detection/rules/actorRules.ts";
export {
  CoordClusterDetector,
  CorroborationMismatchDetector,
} from "./detection/rules/networkRules.ts";

export { RollbackEngine } from "./rollback/RollbackEngine.ts";
