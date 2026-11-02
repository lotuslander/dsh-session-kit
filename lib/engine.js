/**
 * 会话套件核心引擎
 *
 * 设计原则：复用 DSH 宿主原生能力，不重复实现，保证效率与生态最优插件持平。
 *   · 搜索：ctx.get('sessionQuery').searchSessions()  → 宿主 FTS5
 *   · 会话列表：ctx.get('sessionQuery') / ctx.agents
 *   · 投递：ctx.agents 的收件箱（nextTurn / nextStep）
 */

import { resolveTarget, sameWorkspace } from './resolve.js';

export class SessionKit {
  constructor(ctx, config, logger) {
    this.ctx = ctx;
    this.config = config;
    this.logger = logger;
    this.auditLog = [];
  }

  // ────────────────────────────────────────────────
  //  一、会话发现
  // ────────────────────────────────────────────────

  /** 取得宿主 sessionQuery 服务（可能不存在） */
  #sessionQuery() {
    try {
      return this.ctx.get?.('sessionQuery');
    } catch {
      return undefined;
    }
  }

  /**
   * 列出可达会话
   * @param {object} opts { activeOnly, updatedWithinMinutes, includeSubagents }
   */
  async list(opts = {}) {
    const sq = this.#sessionQuery();
    const selfId = this.#selfId();
    const selfCwd = this.#selfCwd();

    let rows = [];

    // 优先用宿主列表接口
    if (sq && typeof sq.listSessions === 'function') {
      try {
        const page = await sq.listSessions({ limit: 200 });
        rows = Array.isArray(page?.items) ? page.items : [];
      } catch (e) {
        this.logger?.warn?.('listSessions 失败，回退到 agents: ' + (e?.message ?? e));
      }
    }

    // 回退：从 ctx.agents 读
    if (rows.length === 0) {
      rows = this.#rowsFromAgents();
    }

    const out = [];
    for (const row of rows) {
      const header = row?.header ?? row ?? {};
      const sessionId = header.id ?? row?.id;
      if (typeof sessionId !== 'string' || !sessionId) continue;

      const origin = header.origin ?? row?.origin;
      const archived = header.archived === true || row?.archived === true;

      // 过滤
      if (archived) continue;
      if (this.config.broadcast.excludeSubagents && origin === 'subagent') continue;
      if (opts.includeSubagents !== true && origin === 'subagent') continue;

      const cwd = header.cwd ?? row?.cwd;
      const title = header.title ?? row?.title ?? '(未命名)';
      const running = row?.running === true || row?.status === 'running';
      const updatedAt = header.updatedAt ?? row?.updatedAt ?? row?.lastActivityAt;

      if (opts.activeOnly === true && !running) continue;
      if (opts.updatedWithinMinutes && updatedAt) {
        const age = Date.now() - new Date(updatedAt).getTime();
        if (age > opts.updatedWithinMinutes * 60_000) continue;
      }

      out.push({
        sessionId,
        title,
        cwd: cwd ?? '',
        running,
        live: row?.live === true,
        isSelf: sessionId === selfId,
        sameWorkspace: sameWorkspace(cwd, selfCwd),
        targetable: origin !== 'subagent',
        updatedAt: updatedAt ? new Date(updatedAt).toISOString() : undefined,
      });
    }

    out.sort((a, b) => {
      if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
      return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
    });

    return out;
  }

  #rowsFromAgents() {
    const out = [];
    let agents;
    try {
      agents = this.ctx.get?.('agents');
    } catch {
      return out;
    }
    if (!agents) return out;

    const list = typeof agents.list === 'function' ? agents.list() : [];
    for (const agent of list ?? []) {
      const session = agent?.session;
      const header = session?.header ?? agent?.header;
      if (!header?.id) continue;
      out.push({
        header,
        running: agent?.running === true,
        live: true,
      });
    }
    return out;
  }

  // ────────────────────────────────────────────────
  //  二、全文搜索（复用宿主 FTS5）
  // ────────────────────────────────────────────────

  /**
   * 跨会话全文搜索
   * @param {string} query
   * @param {object} opts { limit, workspaces, excludeSelf }
   */
  async search(query, opts = {}) {
    const q = typeof query === 'string' ? query.trim() : '';
    if (!q) {
      return { ok: false, code: 'empty_query', message: 'query is empty', results: [] };
    }

    const sq = this.#sessionQuery();
    if (!sq || typeof sq.searchSessions !== 'function') {
      return {
        ok: true, indexed: false, query: q, total: 0, results: [],
        note: '宿主未挂载全文索引（sessionQuery.searchSessions 不可用），只能按标题/目录匹配',
      };
    }

    const limit = Math.min(
      Math.max(1, Number(opts.limit) || this.config.search.defaultLimit),
      this.config.search.maxLimit,
    );

    const t0 = Date.now();
    let page;
    try {
      page = await sq.searchSessions({ query: q, limit }, { signal: opts.signal });
    } catch (e) {
      return {
        ok: false, code: 'search_failed',
        message: '全文检索失败：' + (e?.message ?? String(e)),
        results: [],
      };
    }
    const elapsedMs = Date.now() - t0;

    const items = Array.isArray(page?.items) ? page.items : [];
    const selfId = this.#selfId();
    const selfCwd = this.#selfCwd();

    const results = [];
    for (const hit of items) {
      const header = hit?.header ?? {};
      const sessionId = header.id;
      if (typeof sessionId !== 'string') continue;
      if (opts.excludeSelf !== false && sessionId === selfId) continue;

      const cwd = header.cwd ?? '';
      if (Array.isArray(opts.workspaces) && opts.workspaces.length > 0) {
        if (!opts.workspaces.some((w) => sameWorkspace(cwd, w))) continue;
      }

      const match = hit.bestMatch ?? {};
      const snippet = typeof match.snippet === 'string'
        ? match.snippet.slice(0, this.config.search.snippetChars)
        : '';

      results.push({
        sessionId,
        title: header.title ?? '(未命名)',
        cwd,
        live: hit.live === true,
        sameWorkspace: sameWorkspace(cwd, selfCwd),
        matchType: match.type ?? 'unknown',
        snippet,
        score: typeof match.score === 'number' ? match.score : undefined,
      });

      if (results.length >= limit) break;
    }

    return {
      ok: true,
      indexed: true,
      query: q,
      total: results.length,
      results,
      elapsedMs,
      note: results.length === 0
        ? '没有会话的对话内容包含该关键词。换更具体的词（模块名、表名、报错文本）通常更准。'
        : '只读检索，未唤醒任何会话。',
    };
  }

  // ────────────────────────────────────────────────
  //  三、读取会话尾部
  // ────────────────────────────────────────────────

  /**
   * 读取某会话最近的消息（不唤醒）
   * @param {string} sessionId
   * @param {object} opts { limit }
   */
  async read(sessionId, opts = {}) {
    const limit = Math.min(Math.max(1, Number(opts.limit) || 10), 100);
    const agents = this.#agents();
    if (!agents) {
      return { ok: false, code: 'no_agents_service', message: '宿主未提供 agents 服务', messages: [] };
    }

    let agent;
    try {
      agent = typeof agents.get === 'function' ? agents.get(sessionId) : undefined;
    } catch (e) {
      return { ok: false, code: 'agent_unavailable', message: String(e?.message ?? e), messages: [] };
    }

    // 目标可能离线，尝试 resume（只读，不投递）
    if (!agent && typeof agents.resume === 'function') {
      try {
        agent = await agents.resume(sessionId);
      } catch (e) {
        return {
          ok: false, code: 'session_offline',
          message: '会话未加载且无法恢复：' + (e?.message ?? e),
          messages: [],
        };
      }
    }
    if (!agent) {
      return { ok: false, code: 'session_not_found', message: '会话不存在', messages: [] };
    }

    const session = agent.session;
    let events;
    try {
      events = typeof session?.snapshotEvents === 'function'
        ? session.snapshotEvents()
        : (Array.isArray(session?.events) ? session.events : []);
    } catch (e) {
      return { ok: false, code: 'read_failed', message: String(e?.message ?? e), messages: [] };
    }

    const messages = [];
    for (let i = (events?.length ?? 0) - 1; i >= 0 && messages.length < limit; i -= 1) {
      const entry = toMessage(events[i]);
      if (entry) messages.unshift(entry);
    }

    return { ok: true, sessionId, count: messages.length, messages };
  }

  // ────────────────────────────────────────────────
  //  四、投递单条消息
  // ────────────────────────────────────────────────

  /**
   * 向目标会话投递消息并唤醒
   * @param {object} input { to, message, mode, thread }
   */
  async deliver(input) {
    const to = typeof input.to === 'string' ? input.to.trim() : '';
    const body = typeof input.message === 'string' ? input.message : '';

    if (!to) return { ok: false, code: 'empty_target', message: 'target is empty' };
    if (!body.trim()) return { ok: false, code: 'empty_message', message: 'message is empty' };
    if (body.length > this.config.delivery.maxMessageChars) {
      return {
        ok: false, code: 'message_too_long',
        message: `message is ${body.length} chars, above limit ${this.config.delivery.maxMessageChars}`,
      };
    }

    const selfId = this.#selfId();
    if (to === selfId && this.config.broadcast.excludeSelf) {
      return { ok: false, code: 'self_send_disabled', message: '不能发给自己' };
    }

    const agents = this.#agents();
    if (!agents) {
      return { ok: false, code: 'no_agents_service', message: '宿主未提供 agents 服务' };
    }

    let agent;
    try {
      agent = typeof agents.get === 'function' ? agents.get(to) : undefined;
      if (!agent && typeof agents.resume === 'function') {
        agent = await agents.resume(to);
      }
    } catch (e) {
      return { ok: false, code: 'delivery_failed', message: String(e?.message ?? e) };
    }
    if (!agent) {
      return { ok: false, code: 'session_not_found', message: '目标会话不存在：' + to };
    }

    const mode = ['queue', 'steer', 'interrupt'].includes(input.mode)
      ? input.mode : this.config.delivery.defaultMode;

    // 信封：让接收方知道来源
    const envelope = [
      `[session-kit v1] from=${selfId} thread=${input.thread ?? '-'}`,
      `from-cwd: ${this.#selfCwd() ?? '(unknown)'}`,
      `sent-at: ${new Date().toISOString()}`,
      '--- message ---',
      body,
      '--- reply ---',
      `用 send_message 工具把结果发回会话 ${selfId}。不要只为确认收到而回复。`,
    ].join('\n');

    const messageId = `kit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    try {
      const inbox = agent.inbox;
      if (!inbox || typeof inbox !== 'object') {
        return { ok: false, code: 'no_inbox', message: '目标会话没有收件箱' };
      }

      const payload = {
        id: messageId,
        role: 'user',
        content: [{ type: 'text', text: envelope }],
        source: { kind: 'agent-message', sender: selfId, thread: input.thread ?? undefined },
      };

      if (mode === 'steer') {
        if (!Array.isArray(inbox.nextStep)) return { ok: false, code: 'unsupported_mode', message: 'nextStep 不可用' };
        inbox.nextStep.push(payload);
      } else if (mode === 'interrupt') {
        if (!Array.isArray(inbox.nextStep)) return { ok: false, code: 'unsupported_mode', message: 'nextStep 不可用' };
        inbox.nextStep.push(payload);
      } else {
        if (!Array.isArray(inbox.nextTurn)) return { ok: false, code: 'unsupported_mode', message: 'nextTurn 不可用' };
        inbox.nextTurn.push(payload);
      }

      // 唤醒
      if (typeof agent.wake === 'function') await agent.wake();
      else if (typeof agent.resume === 'function' && !agent.running) await agent.resume();

      this.#audit({
        event: 'deliver', to, messageId, mode,
        chars: body.length, at: new Date().toISOString(),
      });

      return { ok: true, messageId, to, mode, chars: body.length };
    } catch (e) {
      return { ok: false, code: 'delivery_failed', message: String(e?.message ?? e) };
    }
  }

  // ────────────────────────────────────────────────
  //  五、广播（套件核心增值能力）
  // ────────────────────────────────────────────────

  /**
   * 广播消息到多个会话
   *
   * 安全设计：
   *   · 默认 dryRun=true，只预览不发送
   *   · requireConfirm=true 时必须 confirm:true 才真发
   *   · 单个目标失败不影响其他（失败隔离）
   *   · 并发受 concurrency 限制
   *
   * @param {object} input { message, targets, mode, dryRun, confirm, filter }
   */
  async broadcast(input) {
    const body = typeof input.message === 'string' ? input.message : '';
    if (!body.trim()) {
      return { ok: false, code: 'empty_message', message: '广播内容不能为空' };
    }

    // 1. 解析目标
    const resolved = await this.#resolveBroadcastTargets(input);
    if (!resolved.ok) return resolved;

    const { targets } = resolved;
    const cfg = this.config.broadcast;

    // 2. 安全检查
    const wantDryRun = input.dryRun !== false;   // 默认 true
    const confirmed = input.confirm === true;

    if (cfg.requireConfirm && !confirmed) {
      return {
        ok: true,
        dryRun: true,
        message: body.slice(0, 200),
        targetCount: targets.length,
        targets: targets.map((t) => ({
          sessionId: t.sessionId, title: t.title, cwd: t.cwd, running: t.running,
        })),
        note: `将向 ${targets.length} 个会话广播。这是预览，未发送。确认无误后传 confirm:true 再调用一次。`,
      };
    }

    // 3. 广播 ID（幂等标识）
    const broadcastId = `bc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const thread = `thread-${broadcastId}`;

    // 4. 并发投递（失败隔离）
    const results = [];
    const queue = [...targets];
    const workers = Array.from(
      { length: Math.min(cfg.concurrency, queue.length) },
      async () => {
        while (queue.length > 0) {
          const t = queue.shift();
          if (!t) break;
          try {
            const r = await this.deliver({
              to: t.sessionId,
              message: body,
              mode: input.mode,
              thread,
            });
            results.push({ sessionId: t.sessionId, title: t.title, ...r });
          } catch (e) {
            results.push({
              sessionId: t.sessionId, title: t.title,
              ok: false, code: 'worker_error', message: String(e?.message ?? e),
            });
          }
        }
      },
    );
    await Promise.all(workers);

    const succeeded = results.filter((r) => r.ok).length;
    const failed = results.length - succeeded;

    this.#audit({
      event: 'broadcast', broadcastId, thread,
      total: results.length, succeeded, failed,
      chars: body.length, at: new Date().toISOString(),
    });

    return {
      ok: succeeded > 0,
      dryRun: false,
      broadcastId,
      thread,
      targetCount: results.length,
      succeeded,
      failed,
      results,
      note: failed === 0
        ? `已向 ${succeeded} 个会话广播。接收方会用 thread=${thread} 回复。`
        : `${succeeded} 个成功，${failed} 个失败。失败项见 results。`,
    };
  }

  /** 解析广播目标 */
  async #resolveBroadcastTargets(input) {
    const cfg = this.config.broadcast;
    const all = await this.list({ includeSubagents: !cfg.excludeSubagents });
    const selfId = this.#selfId();

    let pool = all.filter((s) => s.targetable !== false);
    if (cfg.excludeSelf) pool = pool.filter((s) => s.sessionId !== selfId);

    const spec = input.targets;

    // targets: 'all'
    if (spec === 'all' || spec === undefined) {
      if (pool.length > cfg.maxTargets) {
        return {
          ok: false, code: 'too_many_targets',
          message: `目标 ${pool.length} 个，超过上限 ${cfg.maxTargets}。请收窄筛选条件。`,
        };
      }
      return { ok: true, targets: pool };
    }

    // targets: ['id1', 'id2'] 或 'id1'
    const specs = Array.isArray(spec) ? spec : [spec];
    const targets = [];
    for (const s of specs) {
      const r = resolveTarget(s, pool, selfId);
      if (!r.ok) return { ...r, ok: false };
      if (!targets.some((t) => t.sessionId === r.target.sessionId)) targets.push(r.target);
    }

    if (targets.length > cfg.maxTargets) {
      return {
        ok: false, code: 'too_many_targets',
        message: `目标 ${targets.length} 个，超过上限 ${cfg.maxTargets}`,
      };
    }

    return { ok: true, targets };
  }

  // ────────────────────────────────────────────────
  //  工具方法
  // ────────────────────────────────────────────────

  #agents() {
    try {
      return this.ctx.get?.('agents');
    } catch {
      return undefined;
    }
  }

  #selfId() {
    try {
      const s = this.ctx.get?.('session');
      return s?.id ?? s?.header?.id ?? this.ctx.session?.id ?? '';
    } catch {
      return '';
    }
  }

  #selfCwd() {
    try {
      const s = this.ctx.get?.('session');
      return s?.header?.cwd ?? s?.cwd ?? process.cwd();
    } catch {
      return process.cwd();
    }
  }

  #audit(entry) {
    if (!this.config.audit.enabled) return;
    this.auditLog.push(entry);
    if (this.auditLog.length > this.config.audit.maxEntries) {
      this.auditLog.splice(0, this.auditLog.length - this.config.audit.maxEntries);
    }
  }

  /** 读审计日志 */
  audit(limit = 50) {
    return this.auditLog.slice(-limit);
  }
}

/** 把会话事件转成消息 */
function toMessage(event) {
  if (!event || typeof event !== 'object') return null;
  const type = event.type;
  if (type !== 'user/message' && type !== 'assistant/message') return null;

  const data = event.data ?? {};
  const content = (data.message && data.message.content) || data.content;
  const texts = [];

  if (typeof content === 'string') texts.push(content);
  else if (Array.isArray(content)) {
    for (const c of content) {
      if (c && typeof c.text === 'string' && c.text) texts.push(c.text);
    }
  }

  const text = texts.join('\n').trim();
  if (!text) return null;

  return {
    role: type === 'user/message' ? 'user' : 'assistant',
    time: event.time ? new Date(event.time).toISOString() : undefined,
    text: text.slice(0, 2000),
  };
}
