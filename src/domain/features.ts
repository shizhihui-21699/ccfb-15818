/**
 * 特征工程。
 *
 * 难点在于「正常编辑看起来和恶意编辑一模一样」，因此特征不局限于编辑内容本身，
 * 而是分四层：
 *   1. 内容特征：改了什么（关店、开放小区道路、删限行……）
 *   2. 行为者特征：账号年龄、历史信誉、是否养号后突发
 *   3. 速度/节奏特征：批量操作的时间密度
 *   4. 环境特征：IP 段、设备、与被改实体的利益关系
 * 每个特征带人类可读说明，检测命中时直接成为证据。
 */

import type { ActorProfile } from "./EventStore.ts";
import type { EditEvent, MapEntity, Ts } from "./types.ts";

export interface Feature {
  key: string;
  value: number | string | boolean;
  note: string;
}

export interface EditFeatures {
  edit: EditEvent;
  /** 编辑生效前的实体状态（create 时为 null） */
  prior: MapEntity | null;
  features: Feature[];
}

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------
// 编辑级特征
// ---------------------------------------------------------------------------

export function extractEditFeatures(
  edit: EditEvent,
  prior: MapEntity | null,
  now: Ts,
): EditFeatures {
  const features: Feature[] = [];
  const push = (key: string, value: Feature["value"], note: string) =>
    features.push({ key, value, note });

  push("has_evidence", edit.evidenceRefs.length > 0,
    edit.evidenceRefs.length ? `附带 ${edit.evidenceRefs.length} 份佐证材料` : "无任何佐证材料");
  push("has_reason", edit.reason !== null && edit.reason.trim().length > 0,
    edit.reason ? `填写了理由：${edit.reason}` : "未填写编辑理由");

  if (edit.entityType === "place") {
    const toClosed = edit.after.status === "closed" || edit.after.status === "temporarily_closed";
    push("place_set_closed", toClosed,
      toClosed ? `把商户营业状态改为 ${edit.after.status}` : "未改动营业状态");
    if (prior && prior.type === "place") {
      push("place_was_open", prior.status === "open",
        `变更前状态为 ${prior.status}`);
      push("actor_is_claimant", prior.claimedBy === edit.actorId,
        prior.claimedBy
          ? prior.claimedBy === edit.actorId ? "编辑者是商户认领人本人" : "编辑者不是商户认领人（疑似第三方）"
          : "该商户无人认领");
    }
  }

  if (edit.entityType === "road" && prior?.type === "road") {
    const opened = edit.after.openToTraffic === true && prior.openToTraffic === false;
    push("road_opened_compound", opened && prior.compoundId !== null,
      opened && prior.compoundId !== null
        ? `把小区 ${prior.compoundId} 内部道路改为社会车辆可通行`
        : "未开放小区道路");
    const rerouteClass =
      typeof edit.after.roadClass === "string" && edit.after.roadClass !== prior.roadClass;
    push("road_class_changed", rerouteClass,
      rerouteClass ? `道路等级 ${prior.roadClass} → ${edit.after.roadClass}` : "道路等级未变");
  }

  if (edit.entityType === "restriction" && prior?.type === "restriction") {
    const deactivated = edit.after.active === false && prior.active === true;
    push("restriction_deactivated", deactivated,
      deactivated ? "关闭了一条路口限行规则" : "未关闭限行");
  }

  if (edit.action === "delete") {
    push("entity_deleted", true, `删除${edit.entityType}实体`);
  }

  push("edit_age_hours", Math.round((now - edit.ts) / HOUR), "编辑距当前的小时数");
  return { edit, prior, features };
}

export function hasFeature(f: EditFeatures, key: string): boolean {
  return f.features.some((x) => x.key === key && x.value === true);
}

export function getFeature(f: EditFeatures, key: string): Feature | undefined {
  return f.features.find((x) => x.key === key);
}

// ---------------------------------------------------------------------------
// 账号级特征
// ---------------------------------------------------------------------------

export interface ActorFeatures {
  actorId: string;
  accountAgeDays: number;
  totalEdits: number;
  reputation: number; // 归一化信誉 0~1，越高越可信
  burstRatio: number; // 近期速度 / 历史平均速度
  isSleeperWake: boolean;
  nurtureRatio: number; // 养号期编辑占比
  features: Feature[];
}

export function extractActorFeatures(
  profile: ActorProfile,
  now: Ts,
  burstWindowMs: number = 3 * HOUR,
): ActorFeatures {
  const features: Feature[] = [];
  const registeredAt = profile.registeredAt > 0 ? profile.registeredAt : now;
  const accountAgeMs = Math.max(1, now - registeredAt);
  const accountAgeDays = accountAgeMs / DAY;

  const totalEdits = profile.totalEdits;
  // 信誉：正反馈越多、污点越少越高；新账号给中性偏保守的 0.5
  const reputation =
    totalEdits === 0
      ? 0.5
      : clamp01(
          0.5 +
            0.5 * (profile.positiveFeedback / (totalEdits + profile.positiveFeedback + 1)) -
            0.6 * (profile.badEdits / (totalEdits + 1)),
        );

  // 突发比：burstWindow 内编辑数 vs 按账号生命周期折算的期望数
  const recentBurst = profile.recentEditTs.filter((t) => now - t <= burstWindowMs).length;
  const expectedPerWindow =
    (totalEdits / Math.max(1, accountAgeMs / burstWindowMs)) || 0;
  const burstRatio = expectedPerWindow > 0 ? recentBurst / (expectedPerWindow + 0.5) : recentBurst;

  // 养号后突发：账号很新或长期沉寂，养号期攒了大量「无害」编辑，随后开始高风险操作
  const nurtureRatio = totalEdits > 0 ? profile.nurtureEdits / totalEdits : 0;
  const dormantThenActive =
    profile.totalEdits >= 5 &&
    recentBurst >= 3 &&
    (accountAgeDays <= 45 || nurtureRatio >= 0.6) &&
    burstRatio >= 3;

  features.push({ key: "account_age_days", value: Math.round(accountAgeDays), note: `账号年龄 ${Math.round(accountAgeDays)} 天` });
  features.push({ key: "reputation", value: round2(reputation), note: `历史信誉分 ${round2(reputation)}（正反馈 ${profile.positiveFeedback}/污点 ${profile.badEdits}）` });
  features.push({ key: "burst_ratio", value: round2(burstRatio), note: `${burstWindowMs / HOUR} 小时内编辑 ${recentBurst} 条，突发倍率 ${round2(burstRatio)}` });
  features.push({ key: "nurture_ratio", value: round2(nurtureRatio), note: `养号期编辑占比 ${round2(nurtureRatio)}` });
  features.push({ key: "sleeper_wake", value: dormantThenActive, note: dormantThenActive ? "符合「养号后突发」模式" : "无养号突发特征" });

  return {
    actorId: profile.actorId,
    accountAgeDays,
    totalEdits,
    reputation,
    burstRatio,
    isSleeperWake: dormantThenActive,
    nurtureRatio,
    features,
  };
}

// ---------------------------------------------------------------------------
// 批量节奏特征：同一账号在时间窗内对同类实体的连续操作
// ---------------------------------------------------------------------------

export interface BatchFeatures {
  actorId: string;
  windowMs: number;
  editIds: string[];
  count: number;
  sameEntityType: boolean;
  sameField: string | null;
  note: string;
}

/** 找出 actor 在 anchorTs 前后 windowMs 内、与 anchor 同类型且改同字段的编辑簇 */
export function extractBatch(
  actorId: string,
  anchor: EditEvent,
  edits: readonly EditEvent[],
  windowMs: number,
): BatchFeatures {
  const changedFields = Object.keys(anchor.after);
  const sameField = changedFields.length === 1 ? changedFields[0]! : null;
  const members = edits.filter((e) => {
    if (e.actorId !== actorId || e.entityType !== anchor.entityType) return false;
    if (Math.abs(e.ts - anchor.ts) > windowMs) return false;
    if (sameField && !(sameField in e.after)) return false;
    return true;
  });
  return {
    actorId,
    windowMs,
    editIds: members.map((e) => e.editId),
    count: members.length,
    sameEntityType: true,
    sameField,
    note:
      members.length >= 3
        ? `${windowMs / HOUR} 小时内对 ${members.length} 个${anchor.entityType}执行同类字段修改（${sameField ?? "多字段"}）`
        : "未构成批量模式",
  };
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
