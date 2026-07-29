# Spec: Action Item Engine

## Status: v3.1 — PR 1 + PR 2 + PR 3 landed (2026-06-11); PR 4 pending
v3.1 修正(2026-06-11):**撤销 v3 的"reply 只存草稿箱"决定。** reply 与所有
action 一样:human-in-the-loop——批准后执行/发送,人审批是唯一关卡,不是"永不
发送"。无 `drafted` 状态;reply 批准后发回发信人。
v3 变更(2026-06-11):新增消息源与 `MessageSource` 适配器契约、人物档案增强
(rolling context / 跨平台身份合并 / 字段级 provenance)、新增 reminder/archive/label
三个 executor、全 executor 幂等(execution receipt)。
v2 变更(2026-06-10):简化审批 UI(每卡两主按钮)、删除通知推送(只写待处理
队列)、删除 feature flag 与 config 机制(旧自动 relay 路径已删,无回退)。

## Summary
Private Secretary 的核心行为:以固定间隔扫描各消息源的新消息,基于发信人
context 理解意图,输出结构化的建议 Action Item 到待处理队列。所有 action
human-in-the-loop。relay 只是 action 类型之一。

不做实时监听,不做 briefing,不做通知推送,无 feature flag,无 config 系统,
无批量指令解析。引擎唯一产出 = 待处理队列里的 Action Item。

## Message Sources(v3 新增)

### 起点原则(2026-06-11 确认)
**Action Item 的起点只能是"别人发来的消息"——人对人的 messaging channel 入站消息
(Slack、Gmail、WeChat)。** Jira / Notion 不是起点,它们扮演两个不同角色:
- **信息来源(reference)**:分析某条入站消息时,按需查询 Jira issue / Notion page
  来补全上下文(就是 open-thread 拉取规则的一部分)。
- **Executor 目标**:动作可以落到 Jira/Notion(如未来"建 Jira ticket"/"加 Notion
  评论")。它们是 `ActionTarget.platform`,不是 `InboundMessage.platform`。
扫描循环只轮询 messaging channel;绝不扫描 Jira/Notion 来"发现"待办。

### MessageSource 契约
每个源是一个适配器,插进现有 Scan Loop,管线零改动:
- **源按"账号实例"建键,不是按平台类型**:`slack:taiv`、`slack:ws2`、
  `gmail:leo`、`gmail:acct2` 各是独立源。`marks` 已按任意 source 字符串分桶,
  支持这个,管线零改动。
- **契约**: `poll(cursor) -> raw payloads` → `normalize(raw) -> InboundMessage`
  (统一消息形状,relay/core/types.ts 已定义)。
- normalize 是确定性纯函数,放 `relay/sources/<source>.ts`,单测覆盖。
- poll 的 I/O 始终经 MCP(本产品是 MCP-native),按运行时分两种到达方式:
  - **Claude-Code-hosted**(MVP 运行时):Claude 经 claude.ai 连接器池执行。
    限制:每类型一个账号(见连接层硬事实)。
  - **Claude-API-hosted**(Phase 2 独立 app 运行时):app 调 Messages API,自己传
    `mcp_servers` 数组(beta `mcp-client-2025-11-20`)。数组可含同类型多个实例,
    各带各的 `url` + `authorization_token` —— **多 workspace / 多 Gmail 在此解锁**。
- 每源独立游标、`source + message_id` 去重(dedup.ts)、故障隔离(单源失败
  不阻塞、游标不前进、`sourceErrors`——round-commit 已实现)。
- 新增源 = 一个 normalize 纯函数 + 运行时多一个 MCP server 条目,管线代码零改动。

### 连接层硬事实(2026-06-11 确认)
- claude.ai 连接器 UI **每类型只能连一个账号**——这是 UI/产品限制,不是 MCP
  协议或 Claude API 限制。所以 Claude-Code-hosted 运行时只能到达单个 Slack
  workspace + 单个 Gmail。
- Claude API 的 MCP connector **可在一次请求里连多个远程 MCP server**,含同类型
  多实例(每实例自己的 URL + OAuth token)。所以"第二 Slack workspace + 3 个
  Gmail"的正解是:Phase 2 独立 app 调 API 时,在 `mcp_servers` 列表里给每个账号
  一个条目。**不写 @slack/web-api / googleapis 直连 adapter**(上一稿基于错误前提,
  已撤销)。
- API MCP connector 约束:仅远程 HTTPS server(stdio 不支持;本地/私网用 MCP
  tunnels 暴露);每账号需 OAuth token(API 侧刷新,或用 Managed Agents vault 自动
  刷新);**不在 ZDR 范围**(处理客户消息时注意,呼应隐私决定)。

### 源清单(只列 messaging channel —— 起点)
| Source | 到达方式 | 读取范围 | 状态 |
|---|---|---|---|
| slack:taiv (DM/@/thread) | MCP (Claude-Code now) | DM、@提及、我所在 thread | 已有(PR 1) |
| gmail:leo | MCP (Claude-Code now) | to:/cc: 我的邮件 | 已有(PR 1) |
| slack:taiv #channels | MCP (Claude-Code now) | 支持频道里涉及我的 thread(如 ticket) | **PR 3 landed** |
| slack:ws2 | MCP via Claude API `mcp_servers` | 第二 workspace 的 DM/@提及 | **Phase 2**(随 API 运行时解锁) |
| gmail:acct2/3/4 | MCP via Claude API `mcp_servers` | to:/cc: 我的邮件 | **Phase 2**(每账号一个 OAuth token) |
| wechat (1:1) | `ylytdeng/wechat-decrypt` MCP server (sqlcipher 解密 + server-side filter / decode) | 本机微信数据库 1:1 + 群聊全量,含 file/link/quoted/system/transfer 富消息 | **MCP 迁移完成 2026-06-13**: wrapper API 不变,后端从 wxecho 切到 wechat-decrypt 17 个工具(spec [`specs/wechat-decrypt-migration.md`](wechat-decrypt-migration.md));5/5 富消息 channel 不再丢失。仍 4.1.8.x 钉死 — 见 [`specs/wechat-local-decrypt.md`](wechat-local-decrypt.md)。Bootstrap 已接入,**作为 source 仍 Deferred**(scan loop 接入留 Phase 3 source 化阶段)。 |
| telegram | 远程 MCP / Bot API | — | 仅预留接口,本期不实现 |

**非源(reference + executor 目标,不扫描):** Jira(Atlassian MCP)、Notion(Taiv
Notion MCP)。分析时查上下文,以及未来作为 executor 目标——见起点原则。

多账号前置(到 Phase 2 再做):确认 Slack/Gmail 的远程 MCP server URL 可用;为
每个额外账号过一次 OAuth 拿 token。无 token 则该源不可用,但不阻塞其他源。

## Action Item Schema

| Field | Type | Description |
|---|---|---|
| `id` | string | 唯一标识 |
| `source_message_id` | string | 触发该 action 的原始消息 |
| `action_type` | enum | 见下表 |
| `target` | object | 动作对象(收件人 / 参会人 / 转发对象) |
| `reason` | string | 一句话:为什么建议这个 action |
| `confidence` | float | 0–1 |
| `params` | object | 执行所需参数;执行后写入 `execution_receipt`(幂等凭证) |
| `draft` | string? | reply/relay/forward 时的草稿内容 |
| `status` | enum | suggested / approved / executed / rejected |
| `created_at` | timestamp | 所属扫描轮次时间 |

### Status 状态机(v3.1)
```
suggested ──approve──▶ approved ──executor──▶ executed   (终态;所有类型)
    │                     ▲
    └──skip──▶ rejected   │ wechat reply/relay/forward 在 approved 等手动粘贴确认
               (终态)
```
- 所有类型(reply 含在内)批准后执行:reply 发回发信人,relay/forward 发给收件人,
  calendar 建会议,task/ignore 落账。**人审批是唯一关卡,没有"永不发送"。**
- 防重复执行(回归保证):终态不可再转移;executor 执行前检查
  `params.execution_receipt`,已有凭证则跳过 API 调用直接置 executed。

### Action Types 与 Executors(v3 全集)

| Type | 终态 | Params | 平台 API | 失败模式 |
|---|---|---|---|---|
| `reply` | executed | draft(必须) | 批准后发回发信人。**回复语言永远镜像发件人语言。** Slack 真发送;**Gmail 本连接器只能 create_draft(无发送工具)→ 建回复草稿,用户去 Gmail 发**;WeChat 剪贴板手动 | API 失败→停在 approved 可重试(receipt 防重) |
| `relay` | executed | recipient, draft | Slack/Gmail MCP 发送;WeChat 剪贴板+手动确认 | 发送失败→停在 approved 可重试;WeChat 永不声称已发 |
| `forward` | executed | recipient | 同 relay(原文转发) | 同 relay |
| `calendar` | executed | title, start, end, attendees, location? | Google Calendar MCP:**创建前必须 `list_events` 查冲突**,冲突写入 reason 并用 `suggest_time` 给替代时段;确认后 `create_event` | 冲突检查失败→不允许创建;create 失败→approved 可重试;receipt 存 event_id 防重复建会 |
| `task` | executed | title, due? | 无外部 API(写入 state 待办区) | 仅本地写失败 |
| `ignore` | executed | category | 无外部 API(归类记录) | 仅本地写失败 |
| `reminder` | executed | remind_at, note | 无外部 API:存入 state;**到期后下一轮扫描把原 item 重新置为 suggested 复活**(带 reminder 标记) | 时间格式非法→missing info;按 action id 键控,复活不重复 |
| `archive` | executed | — | **仅 Gmail**:移除 INBOX label(`unlabel_message`)。Slack 无 mark-read API→不提供 | unlabel 失败→approved 可重试 |
| `label` | executed | label_name | **仅 Gmail**:`create_label`(如需)+ `label_message`。Slack 无 label→不提供 | label 失败→approved 可重试;receipt 防重复打标 |

幂等总则:每个 executor 在调用平台 API 成功后、置终态前,把平台返回的凭证
(draft_id / message_link / event_id / label_id)写入 `params.execution_receipt`;
重试路径先查 receipt,有则跳过 API 直接置终态。重放一个已 approved 的 action
绝不产生第二个草稿/事件/标签。

## Sender Context Layer — 人物档案(v3 增强)

存储:`personas/<key>.yaml`(已有),扩展 schema:

```yaml
key: brendan-odoherty
display_name: Brendan O'Doherty
identity_role: Reliability Engineering Lead        # 身份与角色
relationship: close peer; owns fleet reliability   # 与我的关系
handles:                                           # 可达平台(跨平台身份)
  slack: U0165SDQ4RJ
  gmail: brendan@taiv.tv
  wechat: null
language: en
register: casual                                   # 正式程度
tone_notes: terse, lowercase, decisive
typical_message_length: short (1-10 words)         # 典型消息长度(新)
style_profile:                                     # 懒生成缓存(新)
  generated_at: 2026-06-11T...
  interactions_since_build: 0                      # 超过阈值(常量 30)才重建
  summary: <LLM 生成的风格画像>
open_threads:                                      # rolling context(新)
  - "switcher design-flaw verdict pending — gates the 3500 batch payment"
provenance:                                        # 字段级来源(新)
  tone_notes: manual
  style_profile: inferred
  open_threads: inferred
```

规则:
- **手动编辑永远赢**:provenance 标 `manual` 的字段,LLM 重生成时绝不覆盖。
- **Rolling context**:每轮扫描后 append-only 更新 open_threads;总长封顶
  (常量,约 1500 字符),超限时由 LLM 把最旧条目压缩合并,新条目原文保留。
- **跨平台身份合并**:同一个人在 Slack 和 WeChat 必须解析到同一份档案
  (handles 多键已支持)。手动链接优先;引擎只**建议**合并(以 task 类卡片
  入队:"这两个档案疑似同一人",批准后由运行时合并 YAML),**永不自动合并**。
- 懒加载:首次遇到联系人时从历史消息生成 style_profile 并缓存;
  `interactions_since_build` 超过阈值才重建。
- **读附件**(实测教训):消息带图片/文件时,起草前必须取来读(Slack slack_read_file、
  Gmail 附件),绝不当纯文本处理。重点常在截图里(如推荐的型号)。实例:Michael
  "This should work" 配了一张他选好的 Mean Well GST25A12 截图,只读文字会把意图理解反
  (看起来像"去找一个",其实他已经选好了)。
- **Open-thread 拉取**(PR 1 实测教训):对话中引用 ticket/thread/邮件时,
  起草前必须拉取被引用上下文,不允许只凭 DM 片段起草。
- **未知联系人先建档**(实测规则):涉及没有 persona 的人时,先尽可能全面地跨源
  拉取背景(Slack 搜索其 DM/提及/共同 thread、Gmail 往来、taiv-employees 目录、被
  引用的 Jira/Notion),再建 persona,然后才起草。发件人和被牵涉的第三方都适用。
- **第三方 cross-check**(实测规则):一条消息牵涉到另一个联系人时(如抄送你、实为
  你和某人之间的事),起草前先 cross-check 你和那个人的近期 Slack/Gmail 往来,补全
  背景再推荐 action——背景常常会改变正确的 action(实例:补了 Leo↔Zech 背景后,
  "归档 task" 纠正成 "relay 给 Zech 协调")。
- **Anti-AI 风格关**:所有发给人的草稿(reply/relay/forward)发送前必须过
  `anti-ai-writing-style` skill(无破折号、无 AI 腔)。

## Scan Loop (Polling)
(同 v2,不变)固定间隔默认 30 分钟(`DEFAULT_SCAN_INTERVAL_MINUTES` 常量,
env 可覆盖);每源增量游标;`source+message_id` 幂等去重;单源失败不阻塞、
游标不前进、记 `sourceErrors`;每轮结束只写待处理队列,无任何推送;
无新消息则静默。

## Pipeline(每轮,对每条新消息)
1. 加载/生成 sender context(含 style_profile 缓存、open_threads、被引用
   thread 的拉取)
2. LLM 意图分析 → Action Item(s),CLI 校验后入队,status = suggested
3. 跨消息合并:同发信人同轮多条消息合并分析(merge.ts)
4. 轮末:按 rolling-context 规则更新相关 persona 的 open_threads

## 审批 UI 与执行策略
- 默认 human-in-the-loop(所有类型批准后才执行/发送);每卡两主按钮 + 低强调跳过:
  - reply / relay / forward:「**批准并发送**」/「编辑」/「跳过」
  - calendar / task / ignore:「**批准并执行**」/「编辑」/「跳过」
- 无编号批量指令(批量留给未来多选 UI)
- `calendar` / `reply` / `relay` / `forward` 永远需要确认(硬编码)
- `archive` / `label` / `reminder` V3 也需要确认(谨慎起步;它们改信箱状态)
- `ignore` / `task` 高置信度(≥0.9,硬编码)自动落账
- 缺参数→missing info,不允许猜;未处理项留队列,不过期不重复推送

## 实现切分(v3)

- **PR 2 — 动词补全**:`drafted` 状态 + reply→草稿箱(Gmail create_draft /
  Slack send_message_draft / WeChat 剪贴板回退)、calendar/task/ignore
  executor、execution_receipt 幂等机制、style_profile 懒生成+缓存、
  open-thread 拉取规则、Direction 类型放宽(en→en)、ignore/task 自动落账
- **PR 3 (landed) — 输入拓宽(单账号,Claude-Code 运行时内)**:MessageSource 契约
  (`relay/sources/`,账号实例建键)、normalize 纯函数 + 单测、`normalize` CLI、
  slack-channels 源。Jira/Notion **不是源**——它们是分析时的上下文查询 + 未来 executor
  目标(起点原则)。多账号(slack:ws2、gmail:acct2/3/4)和 WeChat 不在本 PR。
- **Jira/Notion executor(未来,PR 4+)**:作为动作落地目标(建 ticket / 加评论),
  届时 ActionTarget.platform = jira/notion,加对应 executor。
- **多账号源**:随 Phase 2 独立 app(Claude API 运行时)解锁——届时用 `mcp_servers`
  数组,每账号一个条目。契约已为此按账号实例建键,届时零管线改动。
- **PR 4 (landed) — Persona Layer v3**:范围以 **specs/persona-v3.md** 为准
  (本文件早先的 persona 段落如与其冲突,以 persona-v3.md 为准):分层 schema +
  字段级 provenance/evidence、R1 写入卡点(persona-store)、v2→v3 迁移、
  /persona-bootstrap 一次性建档(staged + promote,可恢复)、Phase B 轮末档案
  更新、R3 合并建议卡、R5 全上下文规则。R4(style profile 自动重建)取消,
  R6(disclosure)删除,R2(open_threads 压缩)推迟。
  reminder/archive/label executor 移出本 PR,归入后续“便利动词” PR。

约束(自 v2 不变):无 feature flag、无 config 系统、无推送通知、无批量
指令解析;一切经待处理队列人工审批。

## Phase 2 — Cockpit(方向修正,2026-06-11 用户裁决)

**产品单位修正(推翻 CEO plan 的 "unit = RELAY"):产品的单位是 TASK。**
一次 conversation 触发一系列任务;一个任务可横跨 A/B/C 多平台、多个人的转译与
动作,但聚合维度是任务本身——小到"明天吃什么",大到"下周出差准备"(实例:与
Zack 的一段对话 spawn 出 确认行程/建日历/打包清单/给 Kevin 发消息 四个子动作,
同属一个 Chicago-trip 任务)。Cockpit 界面按任务聚合:Queue 卡片按任务分组,
原 "Topic view" 实质为 **Task view**。RELAY 仍是动作类型之一,不再是产品单位。

裁决记录:
1. **Gate(已实施)**:EN↔ZH 双向覆盖要求**暂停**(metrics.ts
   `REQUIRE_CROSS_LANG = false`),方向覆盖仍计算并报告;微信接入后重新启用。
   现行 gate = 近 20 条 surfaced ≥16 clean + ≥3 联系人 + 零错收件人。
2. **四屏全部按 task-based 重设计**(4 个 Stitch prompt 已交付 2026-06-11):
   - Person profile:provenance 徽章(manual/inferred)、evidence 可回溯、
     commitments 账本、staged/promote 审核流、该联系人参与的任务列表。
   - Queue(原 Pending Relay):任务组 > 动作卡两级结构;卡片态含 needs-info、
     awaiting-manual(Gmail 草稿深链/微信粘贴)、brief(确认归档)、
     auto-handled 折叠日志。
   - Task View(原 Topic View):左任务列表(open/waiting/done + waiting-on)
     + 右侧任务详情(子动作清单带 receipt、跨平台统一时间线、context shelf)。
   - Settings → Connections:仅连接卡 + 只读规则说明卡,无任何行为开关。
3. **Settings 屏 = 连接管理 only**(账号 + OAuth)。行为规则继续硬编码,
   不引入 config 系统;auto-send 分层属 Phase 3。
4. **Gmail 真发送**:先查证官方/可信的支持 send 的 Gmail MCP;查证结果决定
   走 MCP 还是 app 直连 Gmail API。
5. **扫描触发模型**:核算轮询成本;评估改为 notification-based(Slack Events/
   Socket Mode、Gmail watch+Pub/Sub),或"app 原生廉价检测(零 LLM)→ 有新消息
   才调 Claude 分析"的混合模式。
6. **便利动词(reminder/archive/label)取消**:用户在 Gmail/Slack 中不使用
   label/archive 工作流,不再排期。
