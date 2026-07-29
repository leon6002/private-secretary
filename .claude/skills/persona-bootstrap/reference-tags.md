# Reference vocabulary — pattern tags

This file is a **reference vocabulary** the bootstrap analyzer pattern-matches
against when scanning chat history. It is NOT a fixed taxonomy and NOT a
required output. Rules:

- A tag is emitted only when there is concrete observed evidence in the
  history window (same anti-fabrication rule as every other inferred field).
- Evidence MUST be quoted (or cited by source_message_id) in the persona's
  `evidence` block under the field path that received the tag.
- If a person's behavior doesn't match any of these tags, leave it out. A
  sparse `behavior` block is the correct output.
- These tags are descriptive shorthand for the secretary's analysis. They are
  written into `behavior.*` (typically `behavior.work_style_tags` or
  woven into `behavior.reliability` / `behavior.bad_news_style` /
  `behavior.escalation_style` prose), with the matched pattern recorded in
  evidence.
- Don't pile on tags. Two or three well-evidenced tags are better than ten
  weakly-evidenced ones.

## 个性 / 工作风格标签

| 标签 | 触发模式（需要看到才打） |
|------|---------------------------|
| 甩锅高手 / 甩锅艺术家 | 出问题第一反应找外部原因；事前模糊责任边界；被问责说"当时需求没说清楚""这块本来不是我的"；秒速提供时间线证明"不在我这里"。 |
| 背锅侠 | 默默承接别人推过来的问题；很少说"不是我的事"；出错先道歉再分析。 |
| 完美主义 | 在某个细节反复 block；交付慢但质量高；对 PR/方案有大量细节评论。 |
| 差不多就行 | "能跑就行"是口头禅；不主动优化；对细节 bug 容忍度高。 |
| 拖延症 | 排期给出后实际开始时间很晚；靠 deadline 压力才动起来；回复要等几小时。 |
| PUA 高手 | "这对你是个成长机会"让别人做苦活；肯定中夹带否定；让对方自我怀疑；画大饼后拖着不兑现。 |
| 职场政治玩家 | 先观望不表态；在多方利益间周转；表面支持私下不配合；控制信息流通节点。 |
| 向上管理专家 | 对上级极度配合讨好；关键节点前主动刷存在感；包装汇报、放大亮点；在上级面前说别人的问题。 |
| 阴阳怪气 | 不直接表达不满，用反问或冷嘲热讽；评论带刺但表面礼貌；"可以啊，你厉害"。 |
| 情绪勒索 | 用"我最近状态不好"换让步；用疲惫/委屈让人愧疚拒绝你。 |
| 爱讲大道理 | 任何问题先讲方法论；引用书/文章/名人名言；把简单问题复杂化。 |
| 只读不回 | 已读不回是常态；只在被追问时才回；回复永远比预期晚。 |
| 秒回强迫症 | 随时在线，几乎秒回；非工作时间也回复；对别人延迟回复明显焦虑。 |
| 反复横跳 | 今天 A 明天 B；意见随讨论对象变化；已确认的事容易被推翻。 |

## 企业文化标签

| 标签 | 触发模式 |
|------|-----------|
| 字节范 | 开口必讲 context，缺了就打断要求补充；评价方案先问"impact 是什么"；说"这个 take 对不对"；坦诚直接是美德；OKR 对齐挂嘴边。 |
| 阿里味 | 口头禅：赋能/抓手/生态/闭环/颗粒度/打法；讲问题先讲方法论框架；用阿里内部黑话；六脉神剑能随时背出来。 |
| 腾讯味 | 凡事先看数据，没数据不表态；赛马思维，同事同时做两版；保守，不轻易否定现有路径；用户体验第一。 |
| 华为味 | 强调流程和规范，走流程是对的哪怕慢；PPT 精美，汇报是一门功课；奋斗者文化，加班是美德；执行力强但创造力有限。 |
| 百度味 | 技术至上，非技术背景天然矮一截；层级意识强，跨级沟通谨慎；内部竞争，信息不轻易共享。 |
| 美团味 | 极致执行力，细节抠到极致；本地化/下沉市场思维；结果导向，过程不重要。 |
| 第一性原理 | 任何问题先问"本质是什么"；拒绝"别人都这么做"的类比推理；会从头否定现有方案；激进简化，砍功能。 |
| OKR 狂热者 | 任何事先定义 Objective；KR 颗粒度极细要量化；定期 review 进度；把不符合 OKR 的事推掉。 |
| 大厂流水线 | 依赖 SOP 和现成工具；出了 SOP 就不知道怎么办；创造力低稳定性高；怕背锅凡事留 evidence。 |
| 创业公司派 | 全栈思维，什么都能搭；资源有限下会取舍；对混乱容忍度高；结果比流程重要。 |

## How the analyzer uses this file

During the Style pass (and where the Facts pass turns up behavioral signal):
1. Scan the messages for the trigger patterns above.
2. For each pattern that fires with concrete evidence, emit the matched tag
   into the appropriate `behavior.*` field — usually as a short descriptor
   inside the existing prose field (e.g. `behavior.reliability: "只读不回 —
   ..."`), not as a separate list, so the schema stays as defined in
   specs/persona-v3.md.
3. Quote the evidence verbatim in the `evidence` block under the same field
   path, with date or source_message_id when available.
4. If nothing matches, write nothing. Do NOT stretch a pattern to fit.

These tags are descriptive observations, not judgments. They go into the
secretary's notes so future drafts can match register and avoid landmines
(e.g. for "只读不回", relay drafts to this contact should be tight and
include an explicit ask, not open-ended).
