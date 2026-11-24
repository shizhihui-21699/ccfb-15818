/**
 * 事件存储与投影。
 *
 * EventStore 是唯一的写入入口；所有投影（实体状态、实体编辑历史、账号画像）
 * 都从同一条只追加事件流派生，因此任何时刻都可以通过重放完整重建，
 * 这为回滚、争议复盘和检测规则重算提供了确定性基础。
 */

import type {
  EditEvent,
  EntityId,
  MapEntity,
  Ts,
  UserId,
} from "./types.ts";
import { applyEvent } from "./projection.ts";

// ---------------------------------------------------------------------------
// 账号画像：检测层的核心原料
// ---------------------------------------------------------------------------

export interface ActorProfile {
  actorId: UserId;
  /** 账号注册时间 */
  registeredAt: Ts;
  /** 累计编辑数 */
  totalEdits: number;
  /** 被点赞/采纳等正反馈次数 */
  positiveFeedback: number;
  /** 历史上被驳回或回滚的编辑数（含其参与案件的处置结果） */
  badEdits: number;
  /** 历史上涉及的案件 id */
  caseHistory: string[];
  /** 最近编辑时间 */
  lastEditAt: Ts | null;
  /** 用过的 IP 段与设备，用于协同聚类 */
  ipPrefixes: Set<string>;
  deviceIds: Set<string>;
  /** 按实体类型统计编辑量 */
  editsByType: { road: number; place: number; restriction: number };
  /** 最近 N 条编辑的时间戳，供速度/突发检测使用 */
  recentEditTs: Ts[];
  /** 早期「养号期」编辑数（注册后 nurtureWindowMs 内） */
  nurtureEdits: number;
}

// ---------------------------------------------------------------------------
// 投影结果
// ---------------------------------------------------------------------------

interface EntityRecord {
  current: MapEntity | null;
  /** 作用于该实体的全部事件 seq，按序 */
  editIds: string[];
}

export class EventStore {
  private events = new Map<string, EditEvent>();
  private seqIndex: EditEvent[] = [];
  private entities = new Map<EntityId, EntityRecord>();
  private actors = new Map<UserId, ActorProfile>();
  private registrations = new Map<UserId, Ts>();
  private nextSeq = 1;

  private readonly nurtureWindowMs: number;

  constructor(nurtureWindowMs: number = 30 * 24 * 3600 * 1000) {
    this.nurtureWindowMs = nurtureWindowMs;
  }

  // -- 写入 ----------------------------------------------------------------

  /** 注册账号；重复注册以最早时间为准 */
  registerActor(actorId: UserId, registeredAt: Ts): void {
    const existing = this.registrations.get(actorId);
    if (existing === undefined || registeredAt < existing) {
      this.registrations.set(actorId, registeredAt);
      this.actors.set(actorId, this.freshProfile(actorId, registeredAt));
    }
  }

  /** 追加一条编辑事件并同步更新投影。seq 由存储分配，保证全序。 */
  append(input: Omit<EditEvent, "seq">): EditEvent {
    if (this.events.has(input.editId)) {
      throw new Error(`重复的 editId: ${input.editId}`);
    }
    const event: EditEvent = { ...input, seq: this.nextSeq++ };
    this.events.set(event.editId, event);
    this.seqIndex.push(event);
    this.projectEntity(event);
    this.projectActor(event);
    return event;
  }

  // -- 读取 ----------------------------------------------------------------

  getEvent(editId: string): EditEvent | null {
    return this.events.get(editId) ?? null;
  }

  /** 全量事件，按 seq 排序（回滚与重放使用） */
  allEvents(): readonly EditEvent[] {
    return this.seqIndex;
  }

  eventsAfter(seq: number): EditEvent[] {
    return this.seqIndex.filter((e) => e.seq > seq);
  }

  getEntity(id: EntityId): MapEntity | null {
    return this.entities.get(id)?.current ?? null;
  }

  entityExists(id: EntityId): boolean {
    return this.entities.has(id);
  }

  /** 该实体上的全部编辑（含已被回滚补偿的），按时间顺序 */
  entityEditIds(id: EntityId): string[] {
    return [...(this.entities.get(id)?.editIds ?? [])];
  }

  /** 实体在某条事件「发生之前」的投影状态，供冲突检测使用 */
  stateBefore(editId: string): MapEntity | null {
    const target = this.events.get(editId);
    if (!target) return null;
    let state: MapEntity | null = null;
    for (const e of this.seqIndex) {
      if (e.entityId !== target.entityId) continue;
      if (e.seq >= target.seq) break;
      state = applyEvent(state, e);
    }
    return state;
  }

  getActor(actorId: UserId): ActorProfile {
    const registeredAt = this.registrations.get(actorId);
    if (registeredAt === undefined) {
      // 未显式注册的账号：以其第一条编辑时间兜底，画像仍可计算
      const profile = this.freshProfile(actorId, 0);
      this.actors.set(actorId, profile);
      return profile;
    }
    return this.actors.get(actorId)!;
  }

  allActorIds(): UserId[] {
    return [...this.actors.keys()];
  }

  // -- 实体投影 -------------------------------------------------------------

  private projectEntity(event: EditEvent): void {
    let record = this.entities.get(event.entityId);
    if (!record) {
      record = { current: null, editIds: [] };
      this.entities.set(event.entityId, record);
    }
    record.current = applyEvent(record.current, event);
    record.editIds.push(event.editId);
  }

  // -- 账号投影 -------------------------------------------------------------

  private freshProfile(actorId: UserId, registeredAt: Ts): ActorProfile {
    return {
      actorId,
      registeredAt,
      totalEdits: 0,
      positiveFeedback: 0,
      badEdits: 0,
      caseHistory: [],
      lastEditAt: null,
      ipPrefixes: new Set(),
      deviceIds: new Set(),
      editsByType: { road: 0, place: 0, restriction: 0 },
      recentEditTs: [],
      nurtureEdits: 0,
    };
  }

  private projectActor(e: EditEvent): void {
    const profile = this.getActor(e.actorId);
    profile.totalEdits += 1;
    profile.editsByType[e.entityType] += 1;
    profile.lastEditAt = e.ts;
    if (e.ipPrefix) profile.ipPrefixes.add(e.ipPrefix);
    if (e.deviceId) profile.deviceIds.add(e.deviceId);
    profile.recentEditTs.push(e.ts);
    if (profile.recentEditTs.length > 200) profile.recentEditTs.shift();
    // 注册时间未知（registeredAt=0 兜底）时不计养号期，避免误判
    if (
      profile.registeredAt > 0 &&
      e.ts - profile.registeredAt <= this.nurtureWindowMs
    ) {
      profile.nurtureEdits += 1;
    }
  }

  /** 案件处置后回写账号污点（人审确认的结果才会进入画像，避免反馈环污染） */
  markActorBad(actorId: UserId, caseId: string): void {
    const profile = this.getActor(actorId);
    profile.badEdits += 1;
    if (!profile.caseHistory.includes(caseId)) profile.caseHistory.push(caseId);
  }

  recordFeedback(actorId: UserId, positive: number): void {
    this.getActor(actorId).positiveFeedback += positive;
  }
}
