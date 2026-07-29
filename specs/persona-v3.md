# Spec: Persona Layer v3 — 人物档案增强

## Status: Approved — implement per this version

## 目的
丰富人物档案的结构与生成规则,使其足以支撑意图分析与草稿生成。
本 PR 的核心交付物是一次性的 **Bootstrap 全量建档任务** + 新 schema。

## 1. Persona YAML Schema

每人一个 YAML。v2 字段(key, display_name, handles, language,
register, tone_notes, context)重组为分层结构:

```yaml
key: string                      # 不变, 主键
display_name: string
identity:
  role: string
  org: string
  relationship: string           # 原顶层 `relationship`
relationship_meta:
  power: enum                    # serves-them | peer | leads-them
  decision_authority: bool
  origin: string?
  temperature: string?           # inferred, 随事实变化更新
handles:                         # 不变, 多平台键
  slack: string?
  gmail: string?
  wechat: string?
communication:
  language: enum                 # 原顶层 `language`
  register: enum                 # 原顶层 `register`
  tone_notes: string             # 原顶层 `tone_notes`
  timezone: string?
  active_hours: string?
  response_rhythm: string?
  channel_preference: map?       # {urgent: ..., default: ..., formal: ...}
  urgency_calibration: string?
open_threads: string             # 原 `context`; 只记当前仍 open 的事项
commitments:                     # 承诺账本
  - who: enum                    # me | them
    what: string
    due: date?
    status: enum                 # open | done | overdue
    source_message_id: string?
behavior:
  reliability: string?
  bad_news_style: string?
  pet_peeves: [string]?
personal:
  family: string?
  interests: [string]?
  notes: string?
graph:
  reports_to: string?
  related_contacts: [string]?
provenance:                      # 按字段: manual | inferred
  <field_path>: manual | inferred
evidence:                        # inferred 字段的出处
  <field_path>: string           # 简短证据说明或 source message id(s)
style_profile_meta:
  last_built_at: timestamp?
```

注: 空块直接省略,不输出 null 占位。稀疏档案是正常且正确的形态。

## 2. 规则

R1 — Provenance: 每个叶子字段记录 manual|inferred。manual 永远赢;
     任何 LLM 重建/补全/更新都绝不覆盖 manual 字段。

R2 — (推迟到后续 PR) open_threads 的封顶与压缩机制本 PR 不做。
     临时护栏: 建档时 open_threads 只写当前仍 open 的事项,
     不得倾倒历史流水。

R3 — 跨平台合并: 引擎怀疑两个 persona 为同一人时,向待处理队列
     发一张 task 类建议卡("合并 A + B?"),用户批准后才执行合并。
     复用现有卡片机制,不造新 UI。永不自动合并。

R4 — (取消) 无 interaction 计数阈值,无周期性自动重建。
     Style profile 在 Bootstrap 时生成一次,之后仅在用户显式
     命令时重建。替代机制见 R7 Phase B 的事件驱动事实更新。

R5 — 全上下文规则(PR 1 教训): 消息引用 ticket/thread/文档时,
     起草前必须拉取被引用对象的完整内容,不得仅凭片段起草。

R6 — (删除) 无 disclosure 块,无 relay 前置比对。
     理由: 所有草稿与 action 均经人工 review 后才发出。

R7 — 两阶段建档(本 PR 核心):

### Phase A — Bootstrap(一次性批处理任务)
- 独立可调用的任务(CLI 命令或管理入口),**不属于** 30 分钟
  scan loop。现在跑一次,之后数月内可能不再跑。
- 对选定联系人读取历史消息,生成完整 persona YAML
  (全部 schema 块,含 style profile)。
- 联系人选择 — `--contacts` 参数:
  - `top:20`(首跑默认): 按消息量×新近度加权排名取前 20;
    处理前打印名单,等待用户确认,允许手动换人
  - `all`: 全员(后续放量)
  - `key1,key2,...`: 显式列表,用于重跑指定人
- 历史窗口 — `--history-years`,默认 5: 仅读取窗口内的消息;
  窗口外的消息完全忽略——不摘要、不计入证据。
  所有 evidence 引用必须落在窗口内。
- 反脑补规则(prompt 中强制, review 中验证):
  - 仅当真实消息中存在证据时才填写字段。不猜测、不填
    "听起来合理"的内容、不写 "probably"。无证据 = 字段留空。
  - 每个 inferred 字段必须可追溯: 在 evidence 块中记录
    简短证据说明或 source message id(s)。
- 可恢复: 逐人处理、持久化进度;中断后重跑跳过已完成的人。
  `top:20` 跑完后再跑 `all`,已建档的人不重复处理
  (显式列表形式除外)。对已建档 persona 重跑必须遵守 R1。
- 预期长耗时、高 token 开销: 逐人记录进度日志,
  结束输出汇总(成功/跳过/失败)。

### Phase B — Ongoing(机会式,scan loop 内)
- 每轮扫描后,仅依据**本轮**消息更新档案:
  - 填空: 本轮消息含证据时,填写空的 inferred 字段
  - 修订: 本轮消息揭示事实变化时(换工作、离职、离婚、
    搬家等),自动更新受影响的 inferred 字段
- 同样适用反脑补与 evidence 规则。本阶段绝不批量重读历史。
- manual 字段始终受 R1 保护。

## 3. 迁移

现有 persona YAML 机械迁移(旧字段 → 新路径),迁移字段一律标
provenance: manual(它们是手写的)。标准示例 — michael-dobosz.yaml:

迁移前:

  key: michael-dobosz
  display_name: Michael Dobosz
  relationship: Embedded Systems Team Lead — Leo's direct lead
  handles: {slack: UR36HT3HV, gmail: michael@taiv.tv, wechat: null}
  language: en
  register: casual
  tone_notes: >
    Brief, rapid-fire messages. Dry humor ...
  context: |
    Leo's team lead on embedded (hardware & firmware), Winnipeg. ...

迁移后:

  key: michael-dobosz
  display_name: Michael Dobosz
  identity:
    role: Embedded Systems Team Lead (hardware & firmware)
    org: Taiv
    relationship: Leo's direct lead
  relationship_meta:
    power: serves-them
    decision_authority: true
  handles: {slack: UR36HT3HV, gmail: michael@taiv.tv, wechat: null}
  communication:
    language: en
    register: casual
    tone_notes: >
      Brief, rapid-fire messages. Dry humor ("Av guy job is worst",
      "HAHA"). Supportive and easygoing. Comfortable dropping
      hardware specifics mid-chat. No formality, no greetings.
    timezone: America/Winnipeg
  open_threads: |
    Recurring: power-supply sizing (box ~15W draw, derating,
    GST60A12, 25-30W supply), switcher firmware, install
    logistics, AI tooling (Claude, cowork, skills, MCP routing).
    Often sounding board for Leo's field war stories.
  behavior:
    bad_news_style: "direct, no cushioning needed"
  provenance:
    identity.*: manual
    communication.*: manual
    open_threads: manual
    behavior.bad_news_style: inferred
    relationship_meta.*: inferred
  evidence:
    behavior.bad_news_style: "tone across Slack history; no source id (migrated)"
    relationship_meta.*: "derived from relationship field (migrated)"
  style_profile_meta:
    last_built_at: null

示例说明: timezone 由 context 推得; power=serves-them 因为他是
我的 lead; commitments/personal/graph 空块直接省略。

## 4. 范围与约束

- 本 PR 内容: schema + 迁移脚本 + Phase A bootstrap 任务 +
  Phase B 钩子 + R3 合并建议卡 + R5 管线规则。
  不含新 executor、不含新消息源、不含 R2 压缩机制。
- 沿用 v2 约束: 无 feature flag、无 config 系统、无推送通知、
  无批量指令解析器。`--contacts` 与 `--history-years` 是
  CLI 参数(带默认值),不是 config 系统。
- 实现顺序: schema + 迁移 → Phase A bootstrap → Phase B 钩子
  与 R1 保护 → R5 管线规则 → R3 合并卡。

## 5. Definition of Done

- Michael 的 YAML 经迁移精确得到上文"迁移后"形态
- 手动编辑过的字段在强制重建后保持不变(R1)
- bootstrap top:20 跑完再跑 all,零重复处理;中断重跑跳过已完成
- bootstrap 产出的每个 inferred 字段在 evidence 块有出处,
  抽查任意字段可回溯到真实消息
- 模拟"事实变化"消息(如 "I left Acme last month")在下轮扫描
  使该人的 inferred identity 字段更新,manual 字段不动
- relay/forward 起草时引用了 ticket 的消息,可观察到完整
  上下文被拉取(R5)

## 6. 实施附加要求(批准时随计划确认)

- 先迁移 michael-dobosz.yaml,给用户审阅、批准后才批量迁移其余档案;
  结构必须与 §3 "迁移后"示例逐字节一致(structure)。
- Bootstrap 必须有 `--dry-run`:打印排名联系人清单 + 各人窗口内消息量,
  **零生成调用**(本运行时里 = 零 LLM 起草/建档;凭据只在 Claude 手里,
  廉价的 MCP 计数查询不可避免)。
- Bootstrap 产出经评审门:生成的 persona 写入 staging 目录
  (`personas/_staged/`),不覆盖 live 文件;单独的 promote 步骤才转正。
  重跑时发现 staged-未-promoted 的 persona 视为未完成,重做。
- R1 写保护必须在 YAML 写入层本身强制(单一卡点 persona-store),
  调用方绝不各自重实现。
- 合并建议卡(R3)豁免 task 自动落账——必须出卡给用户,绝不静默记录。

## 7. v3.1 增补 — behavior 结构化 + corrections（已实现）

来源:借鉴 `titanwings/colleague-skill` 的行为画像方法论(我们的 Style pass
与 `reference-tags.md` 本就同源),按本项目用途裁剪——我们不"扮演"对方,而是
读懂其意图 + 用 Leo 的口吻给其起草(register 对味、避雷)。因此只取行为维度
与人工纠正,不取 persona/work 分离、不取"以其口吻生成"的 Layer-0 规则。

纯增量:现有 persona 零改动校验通过;michael-dobosz 迁移产物逐字节不变。

### §7A — behavior 子字段(全部扁平,一层)

`behavior` 块新增字段。**必须扁平**(一层),不可深层嵌套——`leafPaths()`(管
provenance/evidence/合并粒度的核心)只下钻一层,两层嵌套会把 R1 退化成整块
粒度。全部 inferred-only、需 evidence、空则省略:

```yaml
behavior:
  reliability / bad_news_style / pet_peeves   # v3 原有
  decision_style: string?      # 优先考量 / 何事推动 / 如何表达分歧 / 被怼如何回
  interpersonal: string?       # 对上 / 对下 / 对平级 / 受压时
  landmines: [string]?         # 硬线 + 回避话题(起草最关键)
  says_no_by: string?          # flat refusal | excuse | silence | forward
  work_style_tags: [string]?   # reference-tags 个性/工作风格词表,≤3,各需证据
  culture_tags: [string]?      # 字节范/阿里味/…,≤2,各需证据
```

`work_style_tags` / `culture_tags` 给 `reference-tags.md` 的标签一个正式归属
(此前塞进 prose)。起草层 `draft-prompt` 会把 `landmines` 喂给模型以避雷。

### §7B — corrections(人工纠正账本)

顶层新增 `corrections`,记录人工对"读人/起草"的纠正,起草时取用以免重犯:

```yaml
corrections:
  - scene: string     # 情景,如 "Leo 问他 ETA 时"
    wrong: string     # 草稿/意图判断错在哪
    correct: string   # 这个人实际是怎样
    at: timestamp?    # 记录时间
```

规则:
- **永远 provenance=manual,LLM 绝不可写**(在 `LLM_FORBIDDEN_ROOTS` + store 的
  llm 整文件写双重拦截)。写入只经人工路径:`relay persona-correct <key>`
  (stdin `{scene,wrong,correct}`)。
- promote 合并 / R3 合并时,corrections 始终保留(staged 建档不携带它)。
- 起草时 `draft-prompt` 渲染匹配的纠正给模型("别再犯")。
- 软上限 ~30/人;逼近时提示用户合并相近条目(不静默丢弃)。本期不实现合并逻辑。

### §7C — 物料阈值(反脑补收紧)

行为类推断(`behavior.decision_style` / `interpersonal` / `landmines` /
`says_no_by` / `*_tags`)需 **≥2 条佐证**方可下结论;仅 1 条则省略。例外:
landmine 安全相关,单条可保留但 evidence 标 `low_evidence`(宁可多避)。
事实字段(identity/handles/commitments/open_threads)仍沿用单条好证据规则。
此为生成端(bootstrap prompt)规则 + 评审校验,不在 store 强制(store 无法
计数源消息)。

### §7D — 重建可整档替换(用户授权)

当用户要"删旧重建更准"时:bootstrap 生成全新 staged 档案,promote 对该人
**整档替换**而非 manual-merge(等同 v2→v3 的 replaced-v2 路径)。manual 字段
仍受 R1 保护的常规 promote 不变;整档替换是显式授权下的单独动作。
[待实现:promote 的整档替换开关。]

### §7E — work 块(Action Item 生成的首要 RAG 层)

教训:生成 Action Item 时,最有用的检索上下文不是个人琐事,而是"这个人会
什么、负责哪块、和 Leo 在哪些项目上交互"。v3 把这些散在 identity /
open_threads / behavior 里、且偏"当前开放"。新增独立的 `work` 块承载耐久的
工作上下文:

```yaml
work:
  skills: [string]      # 技能/能做什么(如 Altium PCB、RP2040 固件、FCC 认证、RK SoC bringup)
  owns: [string]        # 负责的子系统/决策/流程/对外关系
  projects: [string]    # 与 Leo 的项目交互点;每条带他的角色+现状,作为 RAG 锚点
```

- 全部扁平数组(一层),inferred-only、需 evidence、空则省略——与 §7A 同理。
- `work.projects` 是**耐久的项目交互地图**(有的开放有的循环);`open_threads`
  仅记**当前仍开放**的事项(Phase B 滚动更新)。二者分工:前者答"他们一起做
  什么",后者答"现在什么没结"。允许少量重叠。
- 起草层 `draft-prompt` 把 `work.skills/owns/projects` 喂给模型,作为读意图 +
  起草的事实底座。
- 建档侧重:工作维度深挖,个人信息只留对起草有用的少量(时区、register、
  关键 landmine),不堆砌生活琐事。
