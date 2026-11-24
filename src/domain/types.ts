/**
 * 领域模型：地图实体、编辑事件、信号与案件。
 *
 * 设计原则：
 * - 一切编辑都是「只追加」的不可变事件（event sourcing），当前地图状态是事件流的投影；
 * - 检测层产出的是带证据的信号（Signal），而不是直接判罚；
 * - 案件（Case）是人工/自动处置的唯一载体，回滚以案件为单位执行。
 */

// ---------------------------------------------------------------------------
// 基础类型
// ---------------------------------------------------------------------------

/** 毫秒时间戳。系统内所有时间判断都基于事件自身的 ts，便于对历史数据做确定性重放。 */
export type Ts = number;
export type EntityId = string;
export type UserId = string;
export type EditId = string;
export type CaseId = string;

/** 平台三类可编辑对象 */
export type EntityType = "road" | "place" | "restriction";

/** 经纬度坐标（WGS84，[lng, lat]） */
export type LngLat = [number, number];

// ---------------------------------------------------------------------------
// 实体快照（事件流投影出的当前状态）
// ---------------------------------------------------------------------------

export interface RoadEntity {
  id: EntityId;
  type: "road";
  /** 道路几何，按顺序的坐标串 */
  geometry: LngLat[];
  /** 道路等级，例如 residential / secondary / primary */
  roadClass: string;
  /** 是否允许社会车辆通行（小区道路被改成可通行引导车流，即改这个字段） */
  openToTraffic: boolean;
  /** 单行方向：null=双向，"forward"/"backward"=单行 */
  oneway: "forward" | "backward" | null;
  name: string | null;
  /** 关联的小区/园区 id，用于识别「小区内部道路」 */
  compoundId: string | null;
  version: number;
  lastEditId: EditId | null;
  deleted: boolean;
}

export interface PlaceEntity {
  id: EntityId;
  type: "place";
  name: string;
  /** 商户类目，例如 restaurant / gas_station */
  category: string;
  location: LngLat;
  /** 营业状态：open / closed / temporarily_closed */
  status: "open" | "closed" | "temporarily_closed";
  /** 认领该商户的账号（商家本人），竞争者恶意关闭通常针对他人认领的店铺 */
  claimedBy: UserId | null;
  version: number;
  lastEditId: EditId | null;
  deleted: boolean;
}

/** 路口限行信息（例如限时禁行、限车型） */
export interface RestrictionEntity {
  id: EntityId;
  type: "restriction";
  /** 限行作用的路口/道路 */
  roadId: EntityId;
  position: LngLat;
  /** 限行规则的机读描述，如 { maxWeightKg: 2000, timeWindows: [...] } */
  rule: Record<string, unknown>;
  /** 该限行是否生效；删除限行 = 让本不该通行的车流被导航放行 */
  active: boolean;
  version: number;
  lastEditId: EditId | null;
  deleted: boolean;
}

export type MapEntity = RoadEntity | PlaceEntity | RestrictionEntity;

// ---------------------------------------------------------------------------
// 编辑事件
// ---------------------------------------------------------------------------

/** 一次编辑可以修改的字段；before/after 只包含实际发生变化的字段。 */
export type EntityPatch = Record<string, unknown>;

export type EditAction = "create" | "modify" | "delete";

export interface EditEvent {
  editId: EditId;
  /** 单调递增的事件序列号，决定投影与回滚的顺序 */
  seq: number;
  ts: Ts;
  actorId: UserId;
  entityId: EntityId;
  entityType: EntityType;
  action: EditAction;
  /** 变更前字段（create 时为空） */
  before: EntityPatch;
  /** 变更后字段（delete 时为空） */
  after: EntityPatch;
  /** 客户端自报的编辑理由，可作为弱证据 */
  reason: string | null;
  /** 关联的外部佐证凭证 id（现场照片、营业执照、工单等），无则为空 */
  evidenceRefs: string[];
  /** 编辑发生时账号所在的近似 IP 段，用于协同聚类（不存精确 IP） */
  ipPrefix: string | null;
  /** 设备指纹摘要 */
  deviceId: string | null;
  /** 若本事件是回滚补偿事件，指向被撤销的原始编辑；普通编辑为 null */
  compensationFor: EditId | null;
  /** 补偿事件所属案件 id，普通编辑为 null */
  caseId: CaseId | null;
}

// ---------------------------------------------------------------------------
// 检测信号
// ---------------------------------------------------------------------------

/** 信号级别：info 仅记录；review 建议人审；escalate 建议立即隔离并立案 */
export type SignalLevel = "info" | "review" | "escalate";

export interface Signal {
  /** 规则 id，例如 R-CLOSE-RIVAL、R-SLEEPER-WAKE */
  ruleId: string;
  /** 命中的对象：可以是编辑、账号、实体或一组编辑（团伙） */
  subject:
    | { kind: "edit"; editId: EditId }
    | { kind: "actor"; actorId: UserId }
    | { kind: "entity"; entityId: EntityId }
    | { kind: "cluster"; editIds: EditId[]; actorIds: UserId[] };
  level: SignalLevel;
  /** 0~1 的置信度，由规则自身根据证据强度给出 */
  confidence: number;
  /** 人类可读的解释，人审页面直接展示 */
  explanation: string;
  /** 结构化证据：所有结论必须能回溯到具体数据 */
  evidence: Record<string, unknown>;
  ts: Ts;
}

// ---------------------------------------------------------------------------
// 案件与处置
// ---------------------------------------------------------------------------

export type CaseStatus =
  | "open" // 已立案，等待人审
  | "confirmed_malicious" // 确认恶意
  | "dismissed" // 驳回：属于真实世界变化
  | "rolled_back" // 已完成回滚
  | "partially_rolled_back"; // 存在无法自动回滚的冲突，已部分处理

export interface CaseEditLink {
  editId: EditId;
  /** seed=检测直接命中；downstream=回滚分析展开的受影响后续编辑 */
  role: "seed" | "downstream";
  /** 关联到本案的信号规则 */
  ruleId: string;
}

export interface Case {
  caseId: CaseId;
  status: CaseStatus;
  createdAt: Ts;
  updatedAt: Ts;
  title: string;
  /** 聚合进本案的全部信号 */
  signals: Signal[];
  /** 涉案编辑（种子 + 展开的下游编辑） */
  links: CaseEditLink[];
  /** 涉案账号（含协同聚类扩展出的账号） */
  actorIds: UserId[];
  /** 风险分 0~100，随信号聚合更新 */
  riskScore: number;
  /** 高风险案件在确认前先隔离：隔离中的编辑不对公众投影生效 */
  quarantined: boolean;
  /** 人审结论备注 */
  resolution: string | null;
  resolvedBy: string | null;
}

// ---------------------------------------------------------------------------
// 回滚
// ---------------------------------------------------------------------------

/** 单条编辑的回滚处置结果 */
export type RollbackItemStatus =
  | "reversed" // 已生成补偿事件成功逆操作
  | "conflict" // 与后续善意编辑冲突，未自动回滚
  | "already_reversed" // 幂等：此前已回滚
  | "noop"; // 无需处理（例如创建后从未生效且已被隔离）

export interface RollbackItem {
  editId: EditId;
  entityId: EntityId;
  status: RollbackItemStatus;
  /** 生成的补偿事件 id（reversed 时有值） */
  compensationEditId: EditId | null;
  /** conflict 时的冲突说明 */
  conflictReason: string | null;
}

export interface RollbackReport {
  caseId: CaseId;
  executedAt: Ts;
  items: RollbackItem[];
  reversedCount: number;
  conflictCount: number;
  /** 回滚后重建出的受影响实体快照，供人审复核 */
  rebuiltEntities: EntityId[];
}

// ---------------------------------------------------------------------------
// 外部佐证（真实世界变化的「真相源」接口）
// ---------------------------------------------------------------------------

/**
 * 外部佐证提供方。生产环境可对接：
 * - 商户工商状态/POI 数据库（关店是否真实）
 * - 交管部门限行公告
 * - 现场照片 OCR/航拍比对
 * - 平台客服工单
 * 测试中用内存假实现。返回 null 表示佐证源没有该实体的信息。
 */
export interface CorroborationProvider {
  /** 返回该实体当前被外部源确认的状态字段；null = 无数据 */
  fetchExternalState(entityId: EntityId): Promise<Record<string, unknown> | null>;
}
