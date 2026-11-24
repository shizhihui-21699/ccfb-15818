# map-guard — 众包地图编辑的恶意篡改识别与回滚服务

面向众包地图平台（道路、商户、路口限行信息可被用户编辑）的风控内核。用 TypeScript 实现，
**零运行时依赖**，直接用 Node.js（>= 22.6）原生 TypeScript 执行，无需打包步骤。

它要解决的核心矛盾：

> 真实世界本来就在不断变化，很多正常编辑和恶意编辑长得一模一样；一次篡改还可能被拆成
> 几十个看似无害的小改动，分散在不同账号里慢慢做。

因此系统的设计目标不是「自动定罪」，而是**把分散的可疑痕迹重新聚合成可解释的案件，
自动隔离高风险内容，把判断权交给人审，并在确认恶意后安全地连带回滚**。

---

## 一、架构总览

```
                         编辑入库 (Ingest)
                              │
                              ▼
   ┌──────────────────────────────────────────────┐
   │ EventStore（事件溯源，只追加）                 │
   │  全序事件流 ──投影──► 实体状态 / 账号画像        │
   └──────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼──────────────────────┐
        ▼                     ▼                      ▼
 内容类规则              行为者类规则            协同/佐证类规则
 R-CLOSE-RIVAL          R-SLEEPER-WAKE         R-COORD-CLUSTER
 R-COMPOUND-OPEN        R-NEW-ACTOR-RISKY      R-CORROBORATION-MISMATCH
 R-RESTRICTION-LIFT     R-REPEAT-TAINTED
 R-BATCH-VELOCITY
 R-NO-EVIDENCE-RISKY
        └─────────────────────┼──────────────────────┘
                              ▼
                   DetectionEngine
        信号聚合(并查集) → 可解释风险评分 → 误报抑制
                              │
                 ┌────────────┴────────────┐
                 ▼                         ▼
            立案 (Case)              自动隔离 (Quarantine)
                 │                         │
        人审 confirm / dismiss     PublicMapView 跳过隔离编辑
                 │
                 ▼
           RollbackEngine
   受影响集合展开 → 冲突检测 → 补偿事件（只追加、可审计）
```

### 四个关键设计决策

1. **事件溯源（event sourcing）**
   所有编辑都是只追加的不可变事件，当前地图状态是事件流的投影。这让「选择性回滚」
   「历史重放」「事故复盘」都变成确定性的事件重算，而不是去修改一份随时被覆盖的现状数据。

2. **证据驱动，而非单点判罚**
   单条内容永远不直接定罪。检测器只产出带结构化证据的 `Signal`，由引擎把围绕同一批
   编辑/账号的信号用并查集聚合成案件，再做可解释的加权评分。每条结论都能回溯到具体数据。

3. **连接性边 vs 弱证据边（协同图）**
   多账号拆分攻击靠关系图重新合拢。但「都编辑过同一个热门实体」在众包平台是常态，
   不能因此把陌生用户连成团伙。图中只有共享 IP/设备、时间窗内接力这类**连接性边**参与
   连通分量；普通共改只是**弱证据边**，给已连通的团伙加权，不产生新连通。

4. **回滚靠补偿事件，且绝误伤善意贡献**
   回滚不物理删除，而是写入原操作的逆事件（带案件 id，可被再次审计）。下游编辑先做
   冲突检测：善意第三方若改过被污染字段，该实体保持隔离待人审，系统不擅自决定字段最终值。

---

## 二、目录结构

```
src/
  domain/
    types.ts            领域模型：实体、编辑事件、信号、案件、回滚报告
    EventStore.ts       事件存储与投影（实体状态 + 账号画像）
    projection.ts       事件→实体的纯函数投影规则（全量/公众视图共用）
    features.ts         四层特征工程（内容/行为者/速度/环境）
    PublicMapView.ts    跳过隔离编辑的公众视图
    MapGuardService.ts  对外统一门面 + 标准检测器工厂
    builders.ts         编辑构造器（测试/演示用）
  detection/
    Detector.ts         检测器接口、信号家族、调参配置
    CoordinationGraph.ts 协同关系图与并查集团伙发现
    DetectionEngine.ts  规则调度、信号聚合、评分、误报抑制、案件生命周期
    rules/
      contentRules.ts   关店/小区道路/限行/无佐证/批量速度
      actorRules.ts     养号突发/新号高风险/前科再犯
      networkRules.ts   协同团伙/外部佐证矛盾
  rollback/
    RollbackEngine.ts   受影响展开、冲突检测、补偿事件、幂等回滚
test/                   node:test 测试（22+ 用例，零第三方测试框架）
examples/demo.ts        三类攻击的完整演示
```

---

## 三、快速开始

```bash
npm install
npm test          # 运行全部测试
npm run typecheck # 严格类型检查（strict + noUncheckedIndexedAccess）
npm run demo      # 看三类攻击端到端处置过程
```

最小用法：

```ts
import { MapGuardService, buildDefaultDetectors } from "./src/index.ts";

const service = new MapGuardService(buildDefaultDetectors());
service.registerActor("user-1", registeredAt);

const { cases, quarantined } = await service.ingest(
  {
    editId: "e-1001",
    ts: Date.now(),
    actorId: "user-1",
    entityId: "place-88",
    entityType: "place",
    action: "modify",
    before: { status: "open" },
    after: { status: "closed" },
    evidenceRefs: [],          // 无佐证
    ipPrefix: "10.8.0.0/16",
    deviceId: "dev-xyz",
  },
  Date.now(),
);

if (quarantined) {
  // 高风险编辑已自动隔离，公众视图不受影响，等待人审
}

// 人审确认恶意后
service.confirm(caseId, "reviewer-1", "确认恶意", Date.now());
const report = service.executeRollback(caseId, "ops", Date.now());
```

接入外部真相源（工商状态、交管公告等）实现 `CorroborationProvider` 即可：

```ts
const detectors = buildDefaultDetectors([new GovRegistryProvider(), new TrafficAnnouncementProvider()]);
```

---

## 四、检测器清单与误报防线

| 规则 | 家族 | 触发模式 | 默认级别 |
|------|------|----------|----------|
| `R-CLOSE-RIVAL` | content | 非认领人批量关店 | review / 批量时 escalate |
| `R-COMPOUND-OPEN` | content | 小区内部道路改可通行 | review |
| `R-RESTRICTION-LIFT` | content | 关闭路口限行 | review / 无佐证 escalate |
| `R-NO-EVIDENCE-RISKY` | content | 高风险字段零佐证（兜底） | info |
| `R-BATCH-VELOCITY` | content | 时间窗内同字段批量修改 | escalate |
| `R-SLEEPER-WAKE` | actor | 养号后突发高风险操作 | escalate |
| `R-NEW-ACTOR-RISKY` | actor | 新账号直接改高风险字段 | review |
| `R-REPEAT-TAINTED` | actor | 有恶意前科再犯 | escalate |
| `R-COORD-CLUSTER` | network | 多账号协同团伙 | escalate |
| `R-CORROBORATION-MISMATCH` | corroboration | 与权威外部源矛盾 / 一致 | escalate / info |

针对「正常编辑与恶意编辑同形」的三道误报防线：

1. **外部佐证**：权威源明确反驳才升级；明确一致则抑制怀疑信号（硬证据如协同、前科不受抑制）。
2. **高信誉降权**：高信誉、无污点账号的首次可疑编辑从 escalate 降为 review。
3. **本人操作豁免**：商户认领人关闭自己的店铺等正常经营行为直接排除。

评分是可解释的加权模型（信号级别权重 × 置信度，叠加影响规模乘子与多家族交叉加成），
不是黑盒概率分；所有阈值集中在 `Detector.ts` / `DetectionEngine.ts`，便于用真实数据校准。

---

## 五、回滚的安全性语义

- **受影响集合展开**：恶意种子 + 同实体后续编辑 + 跨实体引用（限行依赖被污染道路）。
- **逆序补偿**：先撤最晚的下游编辑，再撤种子，保证中间状态始终自洽。
- **冲突保护**：善意第三方改了被污染字段 → 该实体整体保持隔离、标记 `conflict` 待人审，
  系统不机械还原、也不覆盖善意贡献；只改无关字段则正常回滚。
- **幂等**：同一案件重复执行返回同一份报告，不产生重复补偿。
- **审计完整**：补偿事件带 `compensationFor` 与 `caseId`，任意现状都能追溯到全部历史。

---

## 六、生产化待办（当前为内存实现，接口已预留）

- `EventStore` 换成持久化只追加日志（如 Postgres + outbox 或 Kafka 流），投影物化为读模型；
- 检测从单条增量改为微批/流式，规则阈值接配置中心并支持灰度与 A/B 校准；
- `CorroborationProvider` 对接真实工商、交管、街景/航拍比对服务；
- 协同图的 IP/设备权重按平台实测的基率（base rate）重新标定；
- 人审队列、申诉流程与回滚复核 UI 对接 `Case` / `RollbackReport`。
