# dsh-session-kit

**DSH Session Kit** — cross-session full-text search + messaging + global broadcast + audit, in one zero-dependency DeepSeek Harness plugin.

[中文](./README.md) | English

---

## Why

DSH runs many sessions at once, but they cannot see each other:

| Pain | Consequence |
|---|---|
| No idea what other sessions are doing | Duplicate work, repeated mistakes |
| Want to tell everyone a conclusion | Manually pause, copy, switch, paste |
| Do not know which session discussed a topic | Ask the wrong one, get a vague answer |

This kit turns all three into 6 tool calls.

---

## Tools

| Tool | Purpose | Read-only |
|---|---|---|
| `session_list` | List reachable sessions (id / title / cwd / busy) | yes |
| `session_search` | **Full-text search across sessions** (host FTS5) | yes |
| `session_read` | Read the tail of a session | yes |
| `send_message` | Send to one session and wake it | no |
| **`broadcast`** | **Send to many sessions at once** | no |
| `session_audit` | Inspect the operation log | yes |

---

## Install

> **npm package name is `@lotuslanderx/dsh-session-kit`** — the unscoped `dsh-session-kit` is taken by an unrelated project, so the org scope is used.

```powershell
$dsh = '<DSH-install-dir>\dsh.cmd'
& $dsh plugin --profile web add @lotuslanderx/dsh-session-kit
```

Or from a local directory:

```powershell
& $dsh plugin --profile web add C:\path\to\dsh-session-kit
```

Restart DSH. The 6 tools become available.

---

## IMPORTANT: enable full-text search

**DSH disables the session-query index by default.**

```yaml
# default — search is DISABLED
- id: session-query-sqlite
  config:
    path: ':memory:'
    openAt: never
```

`session_search` will fail with `SESSION_QUERY_SEARCH_DISABLED` unless you enable it.

Add this to `~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: session-query-sqlite
  config:
    path: !!js dshHomePath('storages/session-query.db')
    openAt: startup      # or 'first-search' for lazy indexing
```

| Setting | Behaviour |
|---|---|
| `openAt: never` | search disabled (default) |
| `openAt: first-search` | index built lazily on the first search |
| `openAt: startup` | index built at boot (recommended) |

**First indexing takes ~30s for 72 sessions (218 MB index). Subsequent searches take ~1.3s.**

---

## Usage

### Find who discussed something

```javascript
session_search({ query: 'payment callback signature' })
// -> [{ sessionId, title, cwd, snippet }]
```

### Send to one session

```javascript
send_message({
  to: 'deploy-config',        // title / id / prefix
  message: 'Branch merged, please redeploy',
  mode: 'queue'               // queue | steer | interrupt
})
```

### Broadcast (the core feature)

```javascript
// First call: preview only, nothing is sent
broadcast({ message: 'Merge all branches to main by 18:00' })
// -> { dryRun: true, targetCount: 5, targets: [...], note: 'preview, not sent' }

// Confirm: actually send
broadcast({ message: 'Merge all branches to main by 18:00', confirm: true })
// -> { dryRun: false, succeeded: 5, failed: 0, thread: 'thread-bc-xxx' }
```

---

## Safety

Broadcast is destructive, so it is off by default:

| Guard | Behaviour |
|---|---|
| **Preview by default** | Without `confirm:true` you only get a target preview |
| **Explicit confirm** | `requireConfirm: true` rejects unconfirmed calls |
| **Target cap** | Max 50 targets (`too_many_targets` beyond) |
| **Self excluded** | `excludeSelf: true` |
| **Subagents excluded** | `excludeSubagents: true` |
| **Failure isolation** | One failure does not abort the rest |
| **Concurrency cap** | 5 parallel sends |
| **Audit trail** | Every send / broadcast is logged |
| **Shared thread** | One broadcast = one thread id |

---

## Performance

Search reuses the host's `sessionQuery.searchSessions()` (SQLite FTS5) — no private index.

Benchmark (mock host, 50 iterations, median):

```
session_list     p50 = 0.023ms   p95 = 0.161ms
session_search   p50 = 0.011ms   p95 = 0.059ms
send_message     p50 = 0.029ms   p95 = 0.075ms
broadcast x50          1ms       50 succeeded / 0 failed
```

Real-world search (after indexing): **~1.3s / 72 sessions / 218 MB index**.

---

## Configuration

```yaml
- id: session-kit
  config:
    broadcast:
      dryRunByDefault: true
      maxTargets: 50
      concurrency: 5
      requireConfirm: true
      excludeSelf: true
      excludeSubagents: true
    search:
      defaultLimit: 10
      maxLimit: 100
      snippetChars: 200
    delivery:
      defaultMode: queue       # queue | steer | interrupt
      maxMessageChars: 8000
    audit:
      enabled: true
      maxEntries: 500
```

---

## Message envelope

```
[session-kit v1] from=session-abc thread=thread-bc-xxx
from-cwd: C:\work\project-a
sent-at: 2026-11-02T01:30:00.000Z
--- message ---
Merge all branches to main by 18:00
--- reply ---
Reply with send_message to session-abc. Do not ack-only.
```

---

## Addressing

Ambiguous targets are **rejected, never guessed**:

| Form | Example |
|---|---|
| Full id | `session-aaa-1111` |
| Unique prefix | `session-aaa` |
| Exact title | `deploy-config` |
| Title substring | `deploy` (must be unique) |
| cwd fragment | `server` |
| Self | `self` |

---

## Limitations

| Limit | Reason |
|---|---|
| Cannot target subagent sessions | Driven by their parent session |
| Offline targets need resume | Auto-resumed, may fail |
| Full-text search needs the index enabled | Host default is `openAt: never` |
| Broadcasting consumes target quota | Each target starts a real turn |

---

## Tests

```powershell
cd dsh-session-kit
node --test test/kit.test.mjs     # 41 functional tests
node --test test/bench.test.mjs   # 5 performance tests
```

All tests run against a mock host — no DSH runtime required.

---

## License

MIT
