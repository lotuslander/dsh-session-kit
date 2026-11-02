/**
 * 工具注册 —— 6 个工具
 *
 * DSH 工具声明格式（已从 dsh-call-session 源码确认）：
 *   { name, description, parameters, output: { schema, render }, execute, isConcurrencySafe? }
 */

import { defineTool, validateArgs } from './toolkit.js';
import { resolveTarget } from './resolve.js';

export function registerTools(ctx, kit, logger) {
  const reg = (spec) => {
    ctx.tools.register(defineTool(spec));
  };


  // ── 1. session_list ──
  reg({
    name: 'session_list',
    description:
      '列出所有可达的 DSH 会话：sessionId、标题、工作目录、忙/闲、是否与你同目录。用于发现"有谁在、在哪个目录干活"。只读，不唤醒任何会话。',
    isConcurrencySafe: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        active_only: { type: 'boolean', description: '只看正在运行的会话' },
        updated_within_minutes: { type: 'integer', description: '只看最近 N 分钟内活跃过的', minimum: 1 },
        include_subagents: { type: 'boolean', description: '是否包含 subagent 会话（默认不含）' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'count', 'sessions'],
        properties: {
          ok: { type: 'boolean' },
          count: { type: 'integer' },
          sessions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string' },
                title: { type: 'string' },
                cwd: { type: 'string' },
                running: { type: 'boolean' },
                isSelf: { type: 'boolean' },
                sameWorkspace: { type: 'boolean' },
                updatedAt: { type: 'string' },
              },
            },
          },
        },
      },
      render(_args, v) {
        const lines = ['可达会话 ' + (v.count ?? 0) + ' 个：'];
        for (const s of v.sessions || []) {
          const flags = (s.isSelf ? ' [自己]' : '') + (s.running ? ' 运行中' : ' 空闲') + (s.sameWorkspace ? ' 同目录' : '');
          lines.push('  ' + s.title + '  [' + String(s.sessionId).slice(0, 8) + ']' + flags);
          if (s.cwd) lines.push('      ' + s.cwd);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      const v = validateArgs(this.parameters, args);
      if (!v.ok) throw new Error('参数无效：' + v.errors.join('; '));
      const list = await kit.list({
        activeOnly: v.value.active_only === true,
        updatedWithinMinutes: v.value.updated_within_minutes,
        includeSubagents: v.value.include_subagents === true,
      });
      return {
        ok: true,
        count: list.length,
        sessions: list.map((s) => ({
          sessionId: s.sessionId, title: s.title, cwd: s.cwd,
          running: s.running, isSelf: s.isSelf,
          sameWorkspace: s.sameWorkspace, updatedAt: s.updatedAt,
        })),
      };
    },
  });


  // ── 2. session_search ──
  reg({
    name: 'session_search',
    description:
      '在所有会话的对话正文里做全文检索（复用宿主 FTS5 索引），找出哪个会话真的讨论过这个话题，返回 sessionId 和命中片段。只读，不唤醒任何人。问错会话会得到不精准的答案，先搜再问。',
    isConcurrencySafe: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: '要搜的内容。模块名、表名、报错文本、接口路径搜得最准。', minLength: 1 },
        limit: { type: 'integer', description: '最多返回几条，默认 10', minimum: 1, maximum: 100 },
        exclude_self: { type: 'boolean', description: '是否排除当前会话，默认 true' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'query', 'total', 'results'],
        properties: {
          ok: { type: 'boolean' },
          indexed: { type: 'boolean' },
          query: { type: 'string' },
          total: { type: 'integer' },
          elapsedMs: { type: 'integer' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string' },
                title: { type: 'string' },
                cwd: { type: 'string' },
                sameWorkspace: { type: 'boolean' },
                matchType: { type: 'string' },
                snippet: { type: 'string' },
              },
            },
          },
          note: { type: 'string' },
        },
      },
      render(_args, v) {
        if (!v.results || v.results.length === 0) {
          return [{ type: 'text', text: '没有会话讨论过这个话题。' + (v.note || '') }];
        }
        const lines = ['命中 ' + v.total + ' 个会话' + (v.elapsedMs != null ? '（' + v.elapsedMs + 'ms）' : '') + '：'];
        for (const r of v.results) {
          lines.push('');
          lines.push('· ' + r.title + '  [' + String(r.sessionId).slice(0, 8) + ']' + (r.sameWorkspace ? ' 同目录' : ''));
          lines.push('  ' + String(r.snippet || '').replace(/\n/g, ' ').slice(0, 160));
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      const v = validateArgs(this.parameters, args);
      if (!v.ok) throw new Error('参数无效：' + v.errors.join('; '));
      const r = await kit.search(v.value.query, {
        limit: v.value.limit,
        excludeSelf: v.value.exclude_self !== false,
      });
      if (!r.ok) throw new Error('搜索失败：' + (r.message ?? r.code));
      return {
        ok: r.ok, indexed: r.indexed, query: r.query,
        total: r.total ?? 0, elapsedMs: r.elapsedMs,
        results: (r.results ?? []).map((x) => ({
          sessionId: x.sessionId, title: x.title, cwd: x.cwd,
          sameWorkspace: x.sameWorkspace, matchType: x.matchType, snippet: x.snippet,
        })),
        note: r.note,
      };
    },
  });


  // ── 3. session_read ──
  reg({
    name: 'session_read',
    description: '读取指定会话最近的对话（只读，不唤醒对方）。用于确认对方进度，避免反复追问。',
    isConcurrencySafe: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['session_id'],
      properties: {
        session_id: { type: 'string', description: '目标会话的 sessionId' },
        limit: { type: 'integer', description: '读最近几条，默认 10', minimum: 1, maximum: 100 },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'messages'],
        properties: {
          ok: { type: 'boolean' },
          sessionId: { type: 'string' },
          count: { type: 'integer' },
          messages: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                role: { type: 'string' },
                time: { type: 'string' },
                text: { type: 'string' },
              },
            },
          },
        },
      },
      render(_args, v) {
        const lines = [];
        for (const m of v.messages || []) {
          lines.push((m.role === 'user' ? '用户 ' : 'AI ') + (m.time ? '[' + m.time.slice(11, 19) + '] ' : ''));
          lines.push(String(m.text || '').slice(0, 500));
          lines.push('');
        }
        return [{ type: 'text', text: lines.join('\n') || '（没有消息）' }];
      },
    },
    async execute(args) {
      const v = validateArgs(this.parameters, args);
      if (!v.ok) throw new Error('参数无效：' + v.errors.join('; '));
      const r = await kit.read(v.value.session_id, { limit: v.value.limit });
      return {
        ok: r.ok, sessionId: r.sessionId, count: r.count,
        messages: (r.messages ?? []).map((m) => ({ role: m.role, time: m.time, text: m.text })),
      };
    },
  });


  // ── 4. send_message ──
  reg({
    name: 'send_message',
    description:
      '向指定会话推送消息并唤醒它。目标离线会自动恢复。mode: queue（排队）/ steer（插入当前步）/ interrupt（插队，结论优先）。接收方会用 send_message 回复你。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['to', 'message'],
      properties: {
        to: { type: 'string', description: '目标 sessionId、唯一前缀、或唯一标题' },
        message: { type: 'string', description: '消息正文', minLength: 1 },
        mode: { type: 'string', description: 'queue（默认）/ steer / interrupt', enum: ['queue', 'steer', 'interrupt'] },
        thread: { type: 'string', description: '对话线程标识，用于把往返消息串起来' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          messageId: { type: 'string' },
          to: { type: 'string' },
          mode: { type: 'string' },
          code: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render(_args, v) {
        if (!v.ok) return [{ type: 'text', text: '发送失败：' + (v.message || v.code || '未知') }];
        return [{ type: 'text', text: '已发送到 ' + String(v.to || '').slice(0, 8) + '（' + (v.mode || 'queue') + '）msg=' + (v.messageId || '') }];
      },
    },
    async execute(args) {
      const v = validateArgs(this.parameters, args);
      if (!v.ok) throw new Error('参数无效：' + v.errors.join('; '));

      const all = await kit.list({ includeSubagents: true });
      const selfId = all.find((s) => s.isSelf)?.sessionId ?? '';
      const res = resolveTarget(v.value.to, all.filter((s) => s.targetable), selfId);
      if (!res.ok) return { ok: false, code: res.code, message: res.message };

      const r = await kit.deliver({
        to: res.target.sessionId,
        message: v.value.message,
        mode: v.value.mode,
        thread: v.value.thread,
      });
      if (!r.ok && r.code === 'empty_message') throw new Error('消息不能为空');
      return {
        ok: r.ok, messageId: r.messageId, to: r.to,
        mode: r.mode, code: r.code, message: r.message,
      };
    },
  });


  // ── 5. broadcast（核心）──
  reg({
    name: 'broadcast',
    description:
      '本套件核心能力：向多个会话同时广播消息并唤醒它们。默认只预览不发送，必须传 confirm:true 才真发。目标可指定 all / id 列表 / 唯一标题。单个失败不影响其他。适用于全局通知、批量派活、跨项目同步。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['message'],
      properties: {
        message: { type: 'string', description: '广播正文', minLength: 1 },
        targets: { type: 'string', description: '目标：all（全部可达会话）/ 单个 id 或标题 / 逗号分隔的多个' },
        mode: { type: 'string', description: 'queue（默认，排队）/ steer（插入当前步）', enum: ['queue', 'steer'] },
        confirm: { type: 'boolean', description: '必须显式传 true 才会真正发送。不传或 false 时只返回预览。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'dryRun', 'targetCount'],
        properties: {
          ok: { type: 'boolean' },
          dryRun: { type: 'boolean' },
          broadcastId: { type: 'string' },
          thread: { type: 'string' },
          targetCount: { type: 'integer' },
          succeeded: { type: 'integer' },
          failed: { type: 'integer' },
          message: { type: 'string' },
          targets: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string' },
                title: { type: 'string' },
                cwd: { type: 'string' },
                running: { type: 'boolean' },
              },
            },
          },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string' },
                title: { type: 'string' },
                ok: { type: 'boolean' },
                messageId: { type: 'string' },
                code: { type: 'string' },
                message: { type: 'string' },
              },
            },
          },
          note: { type: 'string' },
        },
      },
      render(_args, v) {
        if (v.dryRun) {
          const lines = ['【预览】将向 ' + v.targetCount + ' 个会话广播，尚未发送：'];
          for (const t of v.targets || []) {
            lines.push('  · ' + t.title + (t.running ? ' 运行中' : ' 空闲') + '  [' + String(t.sessionId).slice(0, 8) + ']');
          }
          lines.push('');
          lines.push(v.note || '确认无误后传 confirm:true 再调用一次。');
          return [{ type: 'text', text: lines.join('\n') }];
        }
        const lines = ['广播完成：成功 ' + (v.succeeded || 0) + ' / 失败 ' + (v.failed || 0) + '（' + v.targetCount + ' 个目标）'];
        if (v.thread) lines.push('线程：' + v.thread);
        for (const r of v.results || []) {
          if (!r.ok) lines.push('  x ' + r.title + '：' + (r.message || r.code || '失败'));
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      const v = validateArgs(this.parameters, args);
      if (!v.ok) throw new Error('参数无效：' + v.errors.join('; '));

      let spec = v.value.targets;
      if (typeof spec === 'string' && spec !== 'all' && spec.includes(',')) {
        spec = spec.split(',').map((s) => s.trim()).filter(Boolean);
      }

      const r = await kit.broadcast({
        message: v.value.message,
        targets: spec,
        mode: v.value.mode,
        confirm: v.value.confirm === true,
      });
      if (!r.ok && r.code) {
        throw new Error(r.code + '：' + (r.message ?? ''));
      }
      return {
        ok: r.ok, dryRun: r.dryRun,
        broadcastId: r.broadcastId, thread: r.thread,
        targetCount: r.targetCount ?? 0,
        succeeded: r.succeeded, failed: r.failed,
        message: r.message, targets: r.targets,
        results: (r.results ?? []).map((x) => ({
          sessionId: x.sessionId, title: x.title, ok: x.ok,
          messageId: x.messageId, code: x.code, message: x.message,
        })),
        note: r.note,
      };
    },
  });


  // ── 6. session_audit ──
  reg({
    name: 'session_audit',
    description: '查看本套件的操作审计：谁在什么时候发了什么、广播到哪里、成功失败数。用于追责和排查。',
    isConcurrencySafe: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', description: '最近几条，默认 20', minimum: 1, maximum: 200 },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'count', 'entries'],
        properties: {
          ok: { type: 'boolean' },
          count: { type: 'integer' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                event: { type: 'string' },
                to: { type: 'string' },
                broadcastId: { type: 'string' },
                total: { type: 'integer' },
                succeeded: { type: 'integer' },
                failed: { type: 'integer' },
                mode: { type: 'string' },
                chars: { type: 'integer' },
                at: { type: 'string' },
              },
            },
          },
        },
      },
      render(_args, v) {
        const lines = ['审计记录 ' + v.count + ' 条：'];
        for (const e of v.entries || []) {
          lines.push('  [' + String(e.at || '').slice(11, 19) + '] ' + e.event
            + (e.to ? ' -> ' + String(e.to).slice(0, 8) : '')
            + (e.broadcastId ? ' ' + e.broadcastId : '')
            + (e.succeeded != null ? ' 成功' + e.succeeded + '/失败' + e.failed : '')
            + (e.chars ? ' ' + e.chars + '字' : ''));
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      const v = validateArgs(this.parameters, args);
      const entries = kit.audit(v.value.limit ?? 20);
      return {
        ok: true,
        count: entries.length,
        entries: entries.map((e) => ({
          event: e.event, to: e.to, broadcastId: e.broadcastId,
          total: e.total, succeeded: e.succeeded, failed: e.failed,
          mode: e.mode, chars: e.chars, at: e.at,
        })),
      };
    },
  });


  logger?.info?.('dsh-session-kit: 6 个工具已注册');
}
