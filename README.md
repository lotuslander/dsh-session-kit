# dsh-session-kit

DSH 会话套件：**跨会话全文搜索 + 通信 + 全局广播 + 操作审计**，一个插件全包。

零外部依赖 · 跨工作区 · 默认安全 · 上架就绪。

---

## 它解决什么

DSH 里多个会话同时干活，但彼此看不见：

| 痛点 | 后果 |
|---|---|
| 不知道别的会话在做什么 | 重复劳动、重复踩坑 |
| 想把结论告诉所有会话 | 手动暂停→复制→切过去→粘贴 |
| 不知道某个话题该问谁 | 问错会话，得到不精准的答案 |

本套件把这三件事变成 6 个工具调用。

---

## 6 个工具

| 工具 | 作用 | 只读 |
|---|---|---|
| `session_list` | 列出所有可达会话：id / 标题 / 目录 / 忙闲 | ✅ |
| `session_search` | **跨会话全文检索**（宿主 FTS5），找"谁讨论过这个话题" | ✅ |
| `session_read` | 读某会话最近对话 | ✅ |
| `send_message` | 向单个会话发消息并唤醒 | ❌ |
| **`broadcast`** | **向多个会话同时广播**（本套件核心） | ❌ |
| `session_audit` | 查看操作审计 | ✅ |

---

## 快速开始

### 安装

```powershell
$dsh = '<DSH安装目录>\dsh.cmd'
& $dsh plugin --profile web add @lotuslander/dsh-session-kit
```

或从本地目录：

```powershell
& $dsh plugin --profile web add C:\path\to\dsh-session-kit
```

重启 DSH 后 6 个工具即可使用。

### 典型用法

**1. 找谁讨论过这个话题**

```javascript
session_search({ query: "部署配置" })
// → [{ sessionId, title, snippet: "…相关结论…" }]
```

**2. 把结论告诉某个会话**

```javascript
send_message({
  to: "部署配置",           // 支持标题/id/前缀
  message: "分支已合并，请重新部署",
  mode: "queue"             // queue | steer | interrupt
})
```

**3. 全局广播（核心）**

```javascript
// 第一次：自动预览，不会发送
broadcast({ message: "今天 18:00 前所有分支合并到 main" })
// → { dryRun: true, targetCount: 5, targets: [...] , note: "这是预览，未发送" }

// 确认后：真正发送
broadcast({ message: "今天 18:00 前所有分支合并到 main", confirm: true })
// → { dryRun: false, succeeded: 5, failed: 0, thread: "thread-bc-xxx" }
```

**4. 指定目标广播**

```javascript
broadcast({
  message: "...",
  targets: "session-aaa,session-bbb",   // 逗号分隔
  confirm: true
})
```

---

## 安全设计

广播是危险操作，本套件默认不让人误触：

| 保护 | 说明 |
|---|---|
| **默认预览** | 不传 `confirm:true` 只返回将发给谁，不发送 |
| **必须确认** | `requireConfirm: true` 时缺 `confirm` 一律拒绝 |
| **目标上限** | 默认最多 50 个，超了报 `too_many_targets` |
| **排除自己** | `excludeSelf: true` |
| **排除 subagent** | `excludeSubagents: true`（子代理由父会话驱动，不该被广播打扰） |
| **失败隔离** | 单个目标失败不影响其他，逐项返回结果 |
| **并发限制** | 默认 5 路并发，避免瞬间唤醒太多会话 |
| **审计留痕** | 每次广播/投递都记录到审计日志 |
| **统一线程** | 一次广播的所有消息共享同一个 `thread`，便于接收方关联 |

---

## 性能

复用 DSH 宿主原生 `sessionQuery.searchSessions()`（FTS5），不自己建索引。

基准测试（假宿主，50 次取中位数）：

```
session_list     p50 = 0.042ms   p95 = 0.314ms
session_search   p50 = 0.049ms   p95 = 0.298ms
send_message     p50 = 0.139ms   p95 = 1.964ms
broadcast x50          6ms      成功 50 / 失败 0
```

**为什么这么快**：搜索直接走宿主 SQLite FTS5 索引，O(log n) + 片段提取，没有解析开销。

---

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: session-kit
  config:
    broadcast:
      dryRunByDefault: true      # 默认只管预览
      maxTargets: 50             # 单次广播上限
      concurrency: 5             # 并发投递数
      requireConfirm: true       # 必须 confirm 才发
      excludeSelf: true
      excludeSubagents: true
    search:
      defaultLimit: 10
      maxLimit: 100
      snippetChars: 200
    delivery:
      defaultMode: queue         # queue | steer | interrupt
      maxMessageChars: 8000
    audit:
      enabled: true
      maxEntries: 500
```

---

## 消息协议

发出的消息带机器可解析的信封：

```
[session-kit v1] from=session-abc thread=thread-bc-xxx
from-cwd: C:\work\project-a
sent-at: 2026-11-01T14:30:00.000Z
--- message ---
今天 18:00 前所有分支合并到 main
--- reply ---
用 send_message 工具把结果发回会话 session-abc。不要只为确认收到而回复。
```

接收方看到后会知道：
- 谁发的（`from=`）
- 属于哪次广播（`thread=`）
- 怎么回复

---

## 寻址规则

支持多种定位方式，**有歧义时一律拒绝，绝不猜**：

| 方式 | 示例 |
|---|---|
| 完整 id | `session-aaa-1111` |
| 唯一前缀 | `session-aaa` |
| 唯一标题 | `部署配置` |
| 标题包含 | `部署`（唯一匹配时） |
| 工作目录片段 | `server` |
| 自己 | `self` |

歧义时返回 `ambiguous_id` / `ambiguous_title` + 候选列表。

---

## 限制

| 限制 | 原因 |
|---|---|
| 不能投递给 subagent 会话 | 子代理由父会话驱动 |
| 目标离线需先恢复 | 会自动 `resume`，但可能失败 |
| 全文搜索依赖宿主 | 宿主没挂载 `sessionQuery` 时降级为标题匹配（`indexed: false`） |
| 广播会消耗目标额度 | 每个目标会真的开始一个回合，请当作"以用户身份发指令" |

---

## 测试

```powershell
cd dsh-session-kit
node --test test/kit.test.mjs     # 41 个功能测试
node --test test/bench.test.mjs   # 5 个性能测试
```

全部不依赖 DSH 运行时（用假宿主）。

---

## 目录

```
dsh-session-kit/
├── lib/
│   ├── index.js       插件入口
│   ├── engine.js      核心引擎（列表/搜索/读取/投递/广播）
│   ├── tools.js       6 个工具注册
│   ├── toolkit.js     工具定义与参数校验（零依赖）
│   ├── resolve.js     会话寻址
│   └── config.js      配置归一化
├── test/
│   ├── mock-host.mjs  假宿主
│   ├── kit.test.mjs   40 个功能测试
│   └── bench.test.mjs 性能基准
├── cordis.patch.yml   挂载补丁
└── package.json
```

---

## License

MIT
