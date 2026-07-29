# WeChat 本地解密路径 (Local SQLCipher Decrypt)

> **Superseded by `specs/wechat-decrypt-migration.md` (2026-06-13).** Active
> backend is `ylytdeng/wechat-decrypt` MCP server (richer message channels,
> server-side filtering). This document is retained as the wxecho spike
> historical record + the WeChat 4.1.8.x version-pinning + codesign /
> get-task-allow / sudo-keys prerequisites, which still apply.

补充 `specs/action-item-engine.md` 的源清单 wechat 那一行。这是 **2026-06-13
可靠性 spike** 的结果记录 + 操作手册。计划里 WeChat 个人 1:1 读取始终
"Deferred"，今天的 spike 把 **可行性、约束、维护成本** 都刨清楚了 — 真要把它
升级成 source 时，照这份文件做。

---

## 结论 (TL;DR)

| 维度 | 结论 |
|---|---|
| 可行 | ✅ `@walkerch/wxecho` 在 macOS / Apple Silicon / WeChat 4.1.8.106 上跑通 |
| Source 化 | ❌ 仍 Deferred — 见下面"为什么不升级 source" |
| 已落地用途 | persona-bootstrap 一次性补 WeChat 历史 (PR 5) |
| 维护成本 | 中高 — 见"维护负担" |

## 工具栈

- `@walkerch/wxecho` (npm, 已全局安装) — 内嵌 C scanner (`find_all_keys_macos.arm64`)
  扫 WeChat 进程内存提密钥；Python 脚本基于密钥 + salt 解密 SQLCipher 4 数据库；
  Node CLI 包了一层。
- 旧的 `@canghe_ai/wechat-cli` (npm) 不支持 4.x，已 deprecated，**不要用**。

## 验证过的版本组合

| 组件 | 版本 | 状态 |
|---|---|---|
| WeChat.app | **4.1.8.106** (build 37335) | ✅ 38 keys 提到，26/28 DBs 解开 |
| WeChat.app | 4.1.10.53 (build 39917) | ❌ scanner 在内存里扫不到密钥布局 |
| macOS | 15 (Sequoia) Darwin 25.5 | ✅ 但需要 App Management 权限 |
| Apple Silicon arm64 | M-series | ✅ |
| `@walkerch/wxecho` | 0.x (2026-04 更新) | ✅ |

## 一次性安装步骤

1. `npm install -g @walkerch/wxecho`
2. `pip3 install --user pycryptodome` (Python 解密依赖)
3. 装 WeChat **4.1.8.106**：
   - 从 Tencent 官方 DMG 装：
     `https://dldir1.qq.com/weixin/Universal/Mac/xWeChatMac_universal_4.1.8.106_37335.dmg`
     (SHA256: `972823a966cdaa1f5f0a785bc9f1219d174a75f43d30ec0fbf9ba7ab0249b2f1`)
   - **关掉微信里的自动更新** — 不关掉早晚被升到 4.1.10+，整套链废
4. 系统设置 → Privacy & Security → **App Management** 把 Terminal.app 打开
   (sudo codesign 需要)
5. 给 WeChat.app 加 `get-task-allow` entitlement (使 `task_for_pid` 可读其内存)：
   ```bash
   osascript -e 'quit app "WeChat"'
   codesign -d --entitlements :- /Applications/WeChat.app > /tmp/wechat_ent.plist
   /usr/libexec/PlistBuddy -c "Add :com.apple.security.get-task-allow bool true" /tmp/wechat_ent.plist
   sudo codesign --force --sign - --entitlements /tmp/wechat_ent.plist /Applications/WeChat.app
   rm /tmp/wechat_ent.plist
   open -a WeChat   # 重新登录
   ```

## 每次刷新流程

```bash
# 1. 确保微信运行 + 登录
open -a WeChat

# 2. 提密钥 — 注意不要前缀 sudo, wxecho 内部自己 sudo prompt
#    (前缀 sudo 会让 Node 以 EUID=0 算 HOME=/var/root, 找不到 DB)
wxecho keys

# 3. 解密所有 DB (覆盖 ~/Documents/.../py/decrypted/)
wxecho decrypt

# 4. 看谁活跃 (按消息量倒序)
wxecho export -l --top 200

# 5. 导出某个联系人 (注意 _dummy_ 占位 — wxecho CLI 有 bug, -u 必须配 positional)
wxecho export _dummy_ -u <wxid>
# 输出到 ~/Downloads/wxecho/<wxid>/{chat.txt, chat.csv, chat.json}
```

## 已知坑

- **wxecho CLI bug**: `wxecho export -u <wxid>` 不带 positional 会报"需要联系人名称"。
  workaround: `wxecho export _dummy_ -u <wxid>` (Python 后端 `-u` 优先生效)。
- **不要 sudo 前缀 wxecho keys**: Node 以 EUID=0 跑会让 `os.userInfo().homedir` 返回
  `/var/root`，传给 C scanner 后找不到用户 WeChat 数据。CLI 内部已经会自己 spawn sudo。
- **session.db 单独的解密失败 (2/28 DBs)**: 不影响 message_*.db / contact.db，可以照常 export。
- **export 是全量覆盖**: 不是增量。每次 `wxecho export -u X` 都重写整份 chat.txt。
  想要"只看新消息"需要自己按 timestamp 过滤 (chat.txt 行首是 `[YYYY-MM-DD HH:MM:SS]`)。
- **密钥每次进程重启会变**: WeChat 重启后重跑 `wxecho keys`。
- **WeChat 自动更新是头号杀手**: 一升级到 4.1.10+ 整套链断。靠 in-app "关掉自动更新"
  保护；如果不放心可以 firewall `update.weixin.qq.com`。

## 维护负担

| 项 | 频率 |
|---|---|
| 装 / 重装 WeChat 4.1.8 | 一次性 + 每次 WeChat 偷偷升级后 |
| codesign 加 `get-task-allow` | 一次性 + 每次重装后 |
| `wxecho keys` | 每次 WeChat 进程重启 |
| `wxecho decrypt` | 每次想拿新消息前 |
| `wxecho export` | 每个联系人 30-60 秒 (全量) |
| WxEcho 自身适配新版 WeChat | **靠社区** — 4.1.8 → 4.1.10 还没出现新版 wxecho |

## 为什么不升级成 source

把它接入 `relay/sources/wechat-1to1.ts` 跑在 30 分钟 scan loop 里需要：

1. **新消息的增量检测** — wxecho 没有原生的"自上次以来"接口。要么按 timestamp 后处理
   chat.txt，要么直接读 SQLite (但前提是绕过 wxecho 的全量 export)。
2. **WeChat 进程持续运行** — scan loop 跑的时候微信必须开着登着。
3. **版本钉死的承诺** — Tencent 不停推送更新，靠用户手动拒绝不可持续。
4. **macOS 专属** — Linux/Windows 版 wxecho 路径未验证 (作者按 darwin-arm64 主测)。
5. **签名失效风险** — 任何 macOS 系统更新都可能让 ad-hoc 签名失效 (尤其 SIP/AMFI 收紧)。

对比 Phase 3 计划里的 WeChat Customer Service 官方 API：
- 官方 API 只服务**公众号 / 客服号**，**不支持个人 1:1 读 + 发**。
- 也就是说本地解密路径覆盖的是官方 API 永远不会有的能力。
- 两者**并不互斥**，未来 Phase 3 可能同时存在：客服号 send 走官方，个人 1:1 read
  走本地解密。

## 现在的接入点

- `relay/io/wechat-cli.ts` — wrapper (PR 5)。设计假设是 `wechat-cli` 那套接口，
  但 wxecho 提供的子命令名一致 (sessions/contacts/history/new-messages/export)，
  接口可平移。**今天没切到 wxecho — wrapper 仍然 shell out 到 `wechat-cli` 这个名字**。
  正式接入 source 时需要：要么改 wrapper 调 `wxecho`，要么在 PATH 里 alias。
- `.claude/skills/persona-bootstrap/SKILL.md` — 已说明 WeChat 历史只在
  `handles.wechat` 已知时拉取 (ASK-not-GUESS)。
- `.claude/settings.local.json` — `wechat-cli` 子命令的权限白名单**没合进去**
  (auto-mode classifier 拦了 self-modification)；现在每次跑会弹权限提示。
- **未在 source 注册** — `relay/sources/index.ts` 没注册 wechat-1to1。
  `REQUIRE_CROSS_LANG` 在 `relay/core/metrics.ts` 仍为 false。
