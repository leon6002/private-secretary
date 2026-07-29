# 迁移：`@walkerch/wxecho` → `ylytdeng/wechat-decrypt` (MCP)

补充 `specs/wechat-local-decrypt.md`。这是 **2026-06-13 spike + A/B quality diff**
驱动的迁移决策 + 落地手册。前者把 wxecho 路径跑通了；这份文件回答"为什么要换、
换到哪、什么时候动、怎么动"。

---

## 决策摘要 (TL;DR)

| 维度 | 结论 |
|---|---|
| 换不换 | ✅ 换。质量差距足以越过 CLAUDE.md "messages are never text-only" 硬约束 |
| 何时动 | ⏸ 等当前那轮 top-30 persona-bootstrap 跑完再 land — mid-flight 切换会断 |
| 路径 | **Path A**：保 `relay/io/wechat-cli.ts` 对外签名不变，把内部 `execFile("wxecho")` 换成 MCP stdio client。下游零改动 |
| 工作量 | ~1 个工作日（含测试 + 游标补丁 + 文档） |
| Cockpit 依赖 | ❌ 无依赖。Cockpit 读 `state/loop-state.json` + `personas/*.yaml`，对后端透明，可并行开发 |
| 共存 | ✅ wxecho 和 wechat-decrypt 已在本机共存（不同二进制、不同 decrypted 目录、共享 re-signed WeChat.app） |

---

## 决策依据：A/B quality diff

同窗口对比 `wxid_y30rici04nja32`（坦丁，2026-01-01 ~ 2026-06-13，~10k 消息）：

| 富消息类型 | wxecho | wechat-decrypt | 差距 |
|---|---:|---:|---|
| image | 226 占位符 | 190 + `local_id` 可解码 | wxecho 只有 `[图片]`，wechat-decrypt 带句柄可 `decode_image` 拿真实 JPG 路径 |
| **file** | 0 | **33 (附文件名)** | wxecho 完全丢；wechat-decrypt: `[文件] 发票运单明细.pdf (local_id=34)` |
| **link** | 0 | **7** | wxecho 完全丢淘宝/公众号/小程序卡片 |
| **namecard** | 0 | 2 | wxecho 丢名片 |
| **quoted reply** | 4 | **22 (5.5×)** | wxecho 检出率 ~18%；wechat-decrypt 渲染成 `↳ 回复 X: [引用消息] ...` |
| **system** | 0 | **97** | wxecho 丢撤回/红包提示/群管理事件 |
| sticker | 217 | 199 | 持平 |
| video | 6 | 4 | 持平 |

含义：wxecho 给 LLM 看的是 placeholder-heavy 文本，wechat-decrypt 给的是带媒体句柄、
引用链、文件名、系统事件的结构化文本。CLAUDE.md 第二条硬约束（消息从不是 text-only）
在 wxecho 路径上事实上是部分违反的 — bootstrap 看不到 file/link/namecard/quoted/system
五个 channel。

---

## 上游 MCP 工具面 (17 tools)

`ylytdeng/wechat-decrypt` 的 `mcp_server.py` 暴露 FastMCP stdio server，**v1.27.2**
spike 验证 17 个工具全部 list 出来。返回 **格式化中文文本**（不是 JSON），下游
按文本消费仍然适配。

| 类别 | 工具 | 关键参数 |
|---|---|---|
| 列举 | `get_recent_sessions(limit=20)` | 带未读计数，按 last_timestamp DESC |
| 历史 | `get_chat_history(chat_name, limit, offset, start_time, end_time, oldest_first, msg_types[])` | 全套窗口/分页/类型过滤 |
| 搜索 | `search_messages(keyword, chat_name?, start_time, end_time, limit≤500, offset)` | 单 chat / 多 chat / 全局 |
| 联系人 | `get_contacts(query, limit)` / `get_contact_tags()` / `get_tag_members(tag_name)` | nickname / remark / wxid 三字段匹配 |
| 增量 | `get_new_messages()` | **进程 RAM 游标**，重启丢；必须 wrapper 端持久化 |
| 媒体解码 | `decode_image` / `decode_file_message` / `decode_voice` / `transcribe_voice` / `get_chat_images` / `get_voice_messages` | 出本地路径；voice 走 silk→wav→whisper |
| 富消息 | `decode_transfer`（含红包）/ `decode_refer`（引用回复）/ `decode_location` / `decode_record_item`（聊天记录合并转发的一条） | 均需 `(chat_name, local_id, create_time)` |

未覆盖的（上游也没有）：群成员列表、收藏、stats、JSON 输出。

---

## 当前 wrapper 真实使用面

```
relay/cli.ts:428   wechatContacts(arg1)         ← 子命令 `relay wechat-contacts`
relay/cli.ts:465   wechatHistory(arg1, opts)    ← 子命令 `relay wechat-history`
```

下游消费者：
- `.claude/skills/persona-bootstrap/SKILL.md` — 只 catch `WechatCliNotInitializedError`，
  内容当文本喂给 LLM。**不依赖 JSON shape**。
- `personas/_staged/*.yaml` — 只在 evidence 串里写 `"wxecho session row #N: ..."`
  纯描述，迁移后改成 `"wechat session row #N: ..."` 即可。

`wechatSessions / wechatNewMessages / wechatUnread / wechatRaw` 仅测试调用，
prod 无人用；后两个本就是 `WechatCliNotSupportedError` 占位。

迁移面**极小**：两个 prod callsite，一个 error class，一个 SKILL.md 引用。

---

## 迁移路径：Path A — 保签名换底层

### 设计要点

1. **wrapper API 不动**：`wechatContacts(query?) -> string` / `wechatHistory(chat, opts) -> string`
   返回签名不变。下游 persona-bootstrap / cli 零改动。
2. **runner 注入接口保留**：`__setRunner` 改成接受 MCP client 而不是 execFile 包装；
   测试 mock 一个 in-memory MCP client。
3. **stdio 客户端自己实现，不引 SDK**：FastMCP 协议简单（`initialize` + `tools/call`），
   smoke test 已经证明 ~50 行 Python 够用。Node 端写 ~80 行 TS 自己起 stdio
   subprocess + JSON-RPC 帧。**不增加 npm 依赖**（避免 `@modelcontextprotocol/sdk`
   把 Phase 2 cockpit 的依赖图复杂化）。
4. **单例 MCP server 进程**：wrapper 内部 lazy 起一个 mcp_server.py 子进程，
   首次 call 时 spawn，后续调用复用 stdio 通道。`process.on("exit")` 关闭。
5. **新增游标持久化**：`state/loop-state.json` v2 加 `wechatCursor: { lastTs: number, byWxid: Record<string, number> }`，
   每轮扫描后写回。补 `get_new_messages` RAM-only 缺口。

### 上游 → wrapper 方法映射

| wrapper 方法 | 上游工具 | 备注 |
|---|---|---|
| `wechatContacts(query?)` | `get_contacts(query, limit=200)` | wxecho 路径下是 `export -l --top 200` + JS 子串 filter；上游已数据库匹配，可去掉 JS filter |
| `wechatSessions()` | `get_recent_sessions(limit=20)` | wxecho 下是 `wechatContacts` 别名；新路径下让 sessions ≠ contacts |
| `wechatHistory(chat, {start, limit})` | `get_chat_history(chat_name=chat, start_time=start, limit=limit)` | wechat-decrypt 原生支持窗口/分页，可删 `filterChatText` 纯函数 |
| `wechatHistory({end, msg_types, oldest_first})` | `get_chat_history` 新增参数 pass-through | 顺手扩 `WechatHistoryOptions` |
| `wechatNewMessages()` | `get_new_messages()` + `loop-state.json` 持久化游标 | 不再 throw NotSupported；wrapper 加持久层 |
| `wechatUnread()` | `get_recent_sessions` 的 unread 字段 | 解 placeholder |
| (新增) `wechatSearch(keyword, opts)` | `search_messages` | 给 cockpit + 未来 source 用 |
| (新增) `wechatDecodeImage(chat, local_id)` | `decode_image` | persona-bootstrap 选用：拿图片真实路径喂 LLM |
| (新增) `wechatDecodeFile/Transfer/Refer/Location/RecordItem` | 同名上游工具 | 同上 |

---

## 文件级改动清单

### 改 (4)

| 文件 | 改动 |
|---|---|
| `relay/io/wechat-cli.ts` | 重写 runner — 删 `execFile("wxecho")`、删 `INIT_NEEDED_RE` 文本匹配、删 `filterChatText/filterContactsText` 纯函数；新增 MCP stdio client + 单例 spawn；解 `wechatNewMessages/Unread` 的 throw；新增 `wechatSearch/wechatDecode*` |
| `relay/io/wechat-cli.test.ts` | mock 改成 in-memory MCP client（接受 JSON-RPC request → 返回文本）。保留全部既有 case：CJK 直传 / 错误转换 / `__setRunner` 注入 / sessions vs contacts |
| `relay/io/loop-state.ts`<br>(or wherever loop-state v2 lives) | schema 加 `wechatCursor` 字段；版本 bump 仅 minor（向后兼容：缺字段时 `lastTs=0`） |
| `relay/cli.ts:103-106, 428-465` | 子命令保持名称，options 透传新增的 `--end`、`--msg-type`、`--oldest-first`；加 `relay wechat-search`、`relay wechat-decode-image` 等子命令薄包装 |

### 删 (0)

不动 `WechatHistoryOptions` interface 名（向后兼容），仅扩字段。
不删任何既有 export，避免下游编译炸。

### 新 (1) + 文档更新 (2)

| 文件 | 内容 |
|---|---|
| `relay/io/mcp-stdio-client.ts`（新） | ~80 行 TS：spawn child + JSON-RPC framing + initialize/tools/call。单例 + lazy。后续 Phase 2 cockpit、其他 MCP 接入也可复用 |
| `CLAUDE.md` | 改 Phase 3 Roadmap 那行 `@walkerch/wxecho` → `ylytdeng/wechat-decrypt`；hard constraints 不变 |
| `specs/wechat-local-decrypt.md` | 顶部加一个 "**Superseded by `wechat-decrypt-migration.md`（2026-06-13）**" 标签；正文留作 wxecho spike 历史不删 |
| `specs/action-item-engine.md` | 源清单 wechat 那一行 `@walkerch/wxecho 本地解密` → `ylytdeng/wechat-decrypt MCP` |

### 不动 (重要)

| 文件 | 理由 |
|---|---|
| `personas/_staged/*.yaml` | bootstrap 已写的 evidence 串里 `"wxecho session row #N"` **保留不动** — 历史出处真实就是 wxecho。新一轮 R5 round-end persona 更新会自然补 wechat-decrypt 来源的新 evidence |
| `.claude/skills/persona-bootstrap/SKILL.md` | catch `WechatCliNotInitializedError` 这一段不变 — error class 名保留 |
| `.claude/skills/relay/SKILL.md` | 后端透明 |
| `state/shadow-log.jsonl` | Phase 3 B 数据集与本 PR 无关 |

---

## 测试 + 回归

### 必保留（CLAUDE.md mandatory regression tests）

无影响 — 这四个都不是 wechat 相关：
- `dedup-survives-restart`
- `no-double-execute`
- `reply-requires-approval`
- `R1-manual-survives-llm-update`
- `round-commit-without-task_id-unchanged`

### `wechat-cli.test.ts` 改造原则

- 保留 17 个 case（CJK 直传、错误转换、sessions 别名、`__setRunner` 注入等），
  mock 层改成 MCP client，断言面不变。
- **新增** case：
  - MCP server 未启动时 `wechatContacts` 返回 `WechatCliNotInitializedError`（保留 error class 名 + 含义，文案改写）
  - `wechatNewMessages` 第二次调用比第一次更窄（验证游标持久化）
  - `wechatDecodeImage` 把上游 `local_id=N` 文本传给 `decode_image` 后返回路径

### 集成 smoke (手动，本机)

迁移 PR 自带一个 `scripts/smoke-wechat-mcp.ts`：
1. `npm run relay wechat-contacts` 应该返回非空 + 含至少一个已知 wxid
2. `npm run relay wechat-history wxid_y30rici04nja32 --start 2026-06-01` 应包含 `local_id=`
3. `npm run relay wechat-new-messages`（首次）→ 列出 unread；（再次）→ 仅新增

### 测试计数维护

CLAUDE.md L106 + L131 + L150 写的 "188 unit tests"。迁移 PR 大概率净 +5 到 +10
（删几个 filterChatText 纯函数 case，新增 MCP client + 游标 case）。Land 时同步
更新 CLAUDE.md 测试数。

---

## 时序门 (Gating)

**HARD BLOCK 1：等当前那轮 top-30 persona-bootstrap 跑完再 land。**

理由：bootstrap 通过 `npm run relay wechat-contacts/wechat-history` 子进程调
wrapper。Mid-flight 切换 wrapper 后端会让下一次 `npm run` 起来要么 spawn 失败、
要么读到错误的 MCP server 状态。bootstrap "resumable" 设计前提是 wrapper 行为
稳定。

可并行（不阻塞）的动作：
- ✅ `claude mcp add wechat -- ~/tools/wechat-decrypt/.venv/bin/python3 ~/tools/wechat-decrypt/mcp_server.py`
  （仅配置，不动 wrapper 代码路径，cockpit 立刻可调）
- ✅ Cockpit Phase 2-1/2-2 开发（透明于后端）
- ✅ 在 `~/tools/wechat-decrypt/` 里做更多 quality diff（不动项目代码）

**HARD BLOCK 2：迁移 PR 必须自带 smoke 在 4.1.8.106 上跑过的截图/log**。
WeChat 版本兼容不在测试覆盖范围 — 必须人肉验证。

---

## 风险与开放问题

| 风险 | 缓解 |
|---|---|
| 上游 `get_new_messages` RAM-only 游标 | wrapper 自己在 `loop-state.json` 持久化 `lastTs`，每轮拉取后写回 |
| 上游返回中文格式化文本（不是 JSON） | 跟 wxecho `chat.txt` 同性质，下游 LLM 消费侧不变。富消息 marker `local_id=N, ts=T` 用 regex 提取 |
| WeChat 版本升级（4.1.10+ 已不支持） | 与 wxecho 同源风险。`specs/wechat-local-decrypt.md` 已经记的"关闭微信自动更新"约束继续生效 |
| Python 3.10+ 运行时依赖 | 已 `brew install python@3.11`，wrapper spawn 时显式用 `~/tools/wechat-decrypt/.venv/bin/python3` 绝对路径，避免 PATH 漂移 |
| `mcp_server.py` 路径硬编码在 wrapper 里 | 放到 `relay/io/wechat-cli.ts` 顶部常量；后续 env override `WECHAT_MCP_SERVER_PATH` |
| Bootstrap 跑完之后 evidence 残留 `wxecho session row` | 不动既有 evidence；下一轮 R5 round-end persona 更新会用新格式自然替代 |
| `decode_*` 工具需要 `(chat_name, local_id, create_time)` 三参数 | wrapper helper 从 `get_chat_history` 输出里 regex 抽 `local_id=N, ts=T` 配对，签名上对调用方只暴露 `(chat, local_id)` |

### 开放问题（land 前需要决）

1. `mcp_server.py` 进程**何时关**？方案 A：wrapper exit 时 SIGTERM。方案 B：30s
   idle timeout。**倾向 A**，简单且 relay 是 CLI 一次性进程。
2. Cockpit 用 wrapper（Node import）还是直连 MCP server？**倾向 wrapper** —
   保持 deterministic chokepoint + 测试白盒能力。后续 Phase 3 cockpit 转独立
   Claude API runtime 时再评估。
3. 是否在迁移 PR 里同时**重跑 top-30 persona-bootstrap** 用新 wrapper 输出对照？
   倾向：land 后单独 PR 跑 + diff 现 staged 与新 staged，避免迁移 PR 太大。

---

## 后续阶段路径

- **本次迁移**：wrapper 改后端，bootstrap 重跑（独立 PR），cockpit 透明接入。
- **Phase 3 source 化 (wechat-1to1)**：解 `wechatNewMessages` 阻塞后，
  `relay/sources/wechat-1to1.ts` 就可以基于 wrapper 的增量接口走，无需再 spike。
  CLAUDE.md L72-74 描述的 MessageSource contract 直接复用。
- **Phase 3 send 路径**：仍是 Customer Service API（公众号/客服号）+ 个人 1:1
  clipboard-manual。本次迁移不动这部分。
- **Cockpit P2-1/P2-2**：wechat 数据通过 wrapper 暴露给 cockpit Queue / People
  视图，跟 Slack/Gmail 同形态。

---

## 落地 checklist（land 时勾）

- [ ] 当前 top-30 persona-bootstrap 已完成（block 1 解除）
- [ ] `claude mcp add wechat ...` 已注册
- [ ] `relay/io/wechat-cli.ts` 改造 + `relay/io/mcp-stdio-client.ts` 新增
- [ ] `relay/io/wechat-cli.test.ts` 全绿（无新增失败）
- [ ] `relay/io/loop-state.ts` schema v2 加 `wechatCursor` + 向后兼容测试
- [ ] `relay/cli.ts` 新子命令薄包装 + 帮助文档
- [ ] `scripts/smoke-wechat-mcp.ts` 在 4.1.8.106 跑通（手动截图）
- [ ] `CLAUDE.md` Phase 3 行 + 测试数同步更新
- [ ] `specs/wechat-local-decrypt.md` 顶部 superseded 标签
- [ ] `specs/action-item-engine.md` 源清单 wechat 行同步
- [ ] Smoke: `npm run relay wechat-history wxid_y30rici04nja32 --start 2026-06-01` 含 `local_id=` 标记
