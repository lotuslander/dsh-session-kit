import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMockHost } from './mock-host.mjs';
import { apply } from '../lib/index.js';
import { resolveTarget } from '../lib/resolve.js';
import { normalizeConfig } from '../lib/config.js';
import { validateArgs } from '../lib/toolkit.js';

function setup(config = {}) {
  const host = makeMockHost();
  apply(host.ctx, config);
  const tools = Object.fromEntries(host.registered.map((t) => [t.name, t]));
  return { host, tools };
}

// ══════════════════════════════════════════════
//  1. 工具注册
// ══════════════════════════════════════════════

test('注册 6 个工具', () => {
  const { host } = setup();
  assert.equal(host.registered.length, 6);
  const names = host.registered.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'broadcast', 'send_message', 'session_audit',
    'session_list', 'session_read', 'session_search',
  ]);
});

test('每个工具都有 description / parameters / output.schema / render / execute', () => {
  const { host } = setup();
  for (const t of host.registered) {
    assert.ok(t.description && t.description.length > 10, t.name + ' 缺 description');
    assert.equal(t.parameters.type, 'object', t.name + ' parameters 非 object');
    // DSH 要求 output 必须声明 { schema, render }
    assert.ok(t.output, t.name + ' 缺 output');
    assert.equal(t.output.schema.type, 'object', t.name + ' output.schema 非 object');
    assert.equal(typeof t.output.render, 'function', t.name + ' output.render 不是函数');
    assert.equal(typeof t.execute, 'function', t.name + ' 缺 execute');
  }
});

test('render 返回 DSH 要求的文本块', () => {
  const { host } = setup();
  const list = host.registered.find((t) => t.name === 'session_list');
  const out = list.output.render({}, {
    ok: true, count: 1,
    sessions: [{ sessionId: 'abc12345', title: '测试会话', cwd: 'C:/w', running: true, isSelf: false, sameWorkspace: true }],
  });
  assert.ok(Array.isArray(out));
  assert.equal(out[0].type, 'text');
  assert.ok(out[0].text.includes('测试会话'));
});

// ══════════════════════════════════════════════
//  2. session_list
// ══════════════════════════════════════════════

test('session_list 排除 subagent 和自身标记', async () => {
  const { host, tools } = setup();
  const r = await tools.session_list.execute({});
  assert.equal(r.ok, true);
  // 5 个会话，排除 1 个 subagent = 4
  assert.equal(r.count, 4);
  assert.ok(r.sessions.some((s) => s.isSelf === true));
  assert.ok(!r.sessions.some((s) => s.title === '子代理任务'));
});

test('session_list 只列活跃', async () => {
  const { tools } = setup();
  const r = await tools.session_list.execute({ active_only: true });
  assert.ok(r.sessions.every((s) => s.running === true));
});

test('session_list 标出同工作目录', async () => {
  const { tools } = setup();
  const r = await tools.session_list.execute({});
  const aaa = r.sessions.find((s) => s.sessionId === 'session-aaa-1111');
  const bbb = r.sessions.find((s) => s.sessionId === 'session-bbb-2222');
  assert.equal(aaa.sameWorkspace, true);
  assert.equal(bbb.sameWorkspace, false);
});

// ══════════════════════════════════════════════
//  3. session_search
// ══════════════════════════════════════════════

test('session_search 走宿主 FTS5 并返回片段', async () => {
  const { host, tools } = setup();
  const r = await tools.session_search.execute({ query: '解析器' });
  assert.equal(r.ok, true);
  assert.equal(r.indexed, true);
  assert.ok(r.total >= 1);
  assert.ok(r.results[0].snippet.includes('解析'));

  // 确认真的调了宿主接口
  assert.equal(host.searches.length, 1);
  assert.equal(host.searches[0].query.query, '解析器');
});

test('session_search 默认排除自己', async () => {
  const { tools } = setup();
  const r = await tools.session_search.execute({ query: 'x' });
  assert.ok(!r.results.some((x) => x.sessionId === host_selfId(r)));
  function host_selfId() { return 'session-self-0001'; }
});

test('session_search 空 query 报错', async () => {
  const { tools } = setup();
  await assert.rejects(
    () => tools.session_search.execute({ query: '   ' }),
    /参数无效|empty/,
  );
});

test('session_search 无索引时优雅降级', async () => {
  const host = makeMockHost();
  delete host.services.sessionQuery;
  apply(host.ctx, {});
  const tools = Object.fromEntries(host.registered.map((t) => [t.name, t]));
  const r = await tools.session_search.execute({ query: 'x' });
  assert.equal(r.ok, true);
  assert.equal(r.indexed, false);
  assert.equal(r.total, 0);
  assert.ok(r.note.includes('未挂载'));
});

// ══════════════════════════════════════════════
//  4. session_read
// ══════════════════════════════════════════════

test('session_read 读出消息', async () => {
  const { tools } = setup();
  const r = await tools.session_read.execute({ session_id: 'session-aaa-1111' });
  assert.equal(r.ok, true);
  assert.ok(r.messages.length >= 2);
  assert.equal(r.messages[0].role, 'user');
  assert.equal(r.messages[1].role, 'assistant');
});

test('session_read 不存在的会话', async () => {
  const { tools } = setup();
  const r = await tools.session_read.execute({ session_id: 'nope' });
  assert.equal(r.ok, false);
});

// ══════════════════════════════════════════════
//  5. send_message
// ══════════════════════════════════════════════

test('send_message 投递到 nextTurn', async () => {
  const { host, tools } = setup();
  const r = await tools.send_message.execute({ to: 'session-bbb-2222', message: '跑一下测试' });
  assert.equal(r.ok, true);
  const inbox = host.inboxes.get('session-bbb-2222');
  assert.equal(inbox.nextTurn.length, 1);
  assert.ok(inbox.nextTurn[0].content[0].text.includes('跑一下测试'));
  assert.ok(inbox.nextTurn[0].content[0].text.includes('[session-kit v1]'));
});

test('send_message steer 进 nextStep', async () => {
  const { host, tools } = setup();
  const r = await tools.send_message.execute({
    to: 'session-aaa-1111', message: '停一下', mode: 'steer',
  });
  assert.equal(r.ok, true);
  const inbox = host.inboxes.get('session-aaa-1111');
  assert.equal(inbox.nextStep.length, 1);
  assert.equal(inbox.nextTurn.length, 0);
});

test('send_message 通过标题寻址', async () => {
  const { host, tools } = setup();
  const r = await tools.send_message.execute({ to: '部署配置', message: 'hi' });
  assert.equal(r.ok, true);
  assert.equal(r.to, 'session-bbb-2222');
});

test('send_message 通过 id 前缀寻址', async () => {
  const { host, tools } = setup();
  const r = await tools.send_message.execute({ to: 'session-ccc', message: 'hi' });
  assert.equal(r.ok, true);
  assert.equal(r.to, 'session-ccc-3333');
});

test('send_message 不允许发给自己', async () => {
  const { tools } = setup();
  const r = await tools.send_message.execute({ to: 'self', message: 'hi' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'self_send_disabled');
});

test('send_message 空消息被拒绝', async () => {
  const { tools } = setup();
  await assert.rejects(() => tools.send_message.execute({ to: 'session-bbb-2222', message: '  ' }));
});

test('send_message 目标不存在返回错误', async () => {
  const { tools } = setup();
  const r = await tools.send_message.execute({ to: 'zzz-not-exist', message: 'hi' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not_found');
});

// ══════════════════════════════════════════════
//  6. broadcast（核心）
// ══════════════════════════════════════════════

test('broadcast 默认 dryRun 不发送', async () => {
  const { host, tools } = setup();
  const r = await tools.broadcast.execute({ message: '全局通知' });
  assert.equal(r.dryRun, true);
  assert.ok(r.targetCount >= 3);
  assert.ok(r.note.includes('预览'));
  // 没有任何收件箱被写入
  for (const inbox of host.inboxes.values()) {
    assert.equal(inbox.nextTurn.length, 0);
  }
});

test('broadcast confirm 后真的发送', async () => {
  const { host, tools } = setup();
  const r = await tools.broadcast.execute({ message: '全局通知', confirm: true });
  assert.equal(r.dryRun, false);
  assert.ok(r.succeeded >= 3);
  assert.equal(r.failed, 0);

  // 每个目标都收到了
  const bbb = host.inboxes.get('session-bbb-2222');
  assert.equal(bbb.nextTurn.length, 1);
  assert.ok(bbb.nextTurn[0].content[0].text.includes('全局通知'));
});

test('broadcast 生成统一 thread', async () => {
  const { host, tools } = setup();
  const r = await tools.broadcast.execute({ message: 'x', confirm: true });
  assert.ok(r.thread.startsWith('thread-bc-'));
  const bbb = host.inboxes.get('session-bbb-2222');
  assert.ok(bbb.nextTurn[0].source.thread === r.thread);
});

test('broadcast 指定目标列表', async () => {
  const { host, tools } = setup();
  const r = await tools.broadcast.execute({
    message: 'x', targets: 'session-bbb-2222,session-ccc-3333', confirm: true,
  });
  assert.equal(r.succeeded, 2);
  assert.equal(r.failed, 0);
});

test('broadcast 单个失败不影响其他', async () => {
  const { host, tools } = setup();
  // 破坏一个目标的 inbox
  host.agents.get('session-ccc-3333').inbox = null;
  const r = await tools.broadcast.execute({ message: 'x', confirm: true });
  assert.ok(r.succeeded >= 2);
  assert.ok(r.failed >= 1);
  assert.ok(r.results.some((x) => x.ok === false && x.code === 'no_inbox'));
});

test('broadcast 排除 subagent', async () => {
  const { host, tools } = setup();
  const r = await tools.broadcast.execute({ message: 'x' });
  assert.ok(!r.targets.some((t) => t.sessionId === 'session-ddd-4444'));
});

test('broadcast 空消息被拒绝', async () => {
  const { tools } = setup();
  await assert.rejects(() => tools.broadcast.execute({ message: '' }));
});

test('broadcast 超过 maxTargets 被拒绝', async () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    id: 's-' + i, title: 't' + i, cwd: '/w', running: false, origin: 'root',
  }));
  const host = makeMockHost({ sessions: many });
  apply(host.ctx, { broadcast: { maxTargets: 10 } });
  const tools = Object.fromEntries(host.registered.map((t) => [t.name, t]));
  await assert.rejects(
    () => tools.broadcast.execute({ message: 'x', confirm: true }),
    /too_many_targets/,
  );
});

// ══════════════════════════════════════════════
//  7. session_audit
// ══════════════════════════════════════════════

test('session_audit 记录广播', async () => {
  const { tools } = setup();
  await tools.broadcast.execute({ message: 'x', confirm: true });
  const r = await tools.session_audit.execute({});
  assert.equal(r.ok, true);
  assert.ok(r.count >= 1);
  assert.equal(r.entries[r.entries.length - 1].event, 'broadcast');
});

test('session_audit 记录单发', async () => {
  const { tools } = setup();
  await tools.send_message.execute({ to: 'session-bbb-2222', message: 'x' });
  const r = await tools.session_audit.execute({});
  assert.ok(r.entries.some((e) => e.event === 'deliver'));
});

// ══════════════════════════════════════════════
//  8. 寻址解析
// ══════════════════════════════════════════════

const cands = [
  { sessionId: 'session-aaa-1111', title: '修复解析器', cwd: 'C:/work/main', running: true },
  { sessionId: 'session-bbb-2222', title: '部署配置', cwd: 'C:/work/server', running: false },
  { sessionId: 'session-abc-9999', title: '另一个', cwd: 'C:/work/x', running: false },
];

test('resolveTarget 完整 id', () => {
  const r = resolveTarget('session-bbb-2222', cands, '');
  assert.equal(r.ok, true);
  assert.equal(r.target.sessionId, 'session-bbb-2222');
});

test('resolveTarget 唯一前缀', () => {
  const r = resolveTarget('session-bbb', cands, '');
  assert.equal(r.ok, true);
});

test('resolveTarget 歧义前缀被拒绝', () => {
  const r = resolveTarget('session-a', cands, '');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ambiguous_id');
  assert.ok(r.candidates.length >= 2);
});

test('resolveTarget 唯一标题', () => {
  const r = resolveTarget('部署配置', cands, '');
  assert.equal(r.ok, true);
});

test('resolveTarget 标题不存在', () => {
  const r = resolveTarget('不存在的东西', cands, '');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not_found');
});

test('resolveTarget 空目标', () => {
  const r = resolveTarget('   ', cands, '');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'empty_target');
});

// ══════════════════════════════════════════════
//  9. 配置
// ══════════════════════════════════════════════

test('默认配置安全：requireConfirm + dryRun', () => {
  const c = normalizeConfig({});
  assert.equal(c.broadcast.requireConfirm, true);
  assert.equal(c.broadcast.dryRunByDefault, true);
  assert.equal(c.broadcast.excludeSelf, true);
  assert.equal(c.broadcast.excludeSubagents, true);
});

test('配置边界钳制', () => {
  const c = normalizeConfig({ broadcast: { maxTargets: 99999, concurrency: 999 } });
  assert.ok(c.broadcast.maxTargets <= 500);
  assert.ok(c.broadcast.concurrency <= 20);
});

test('非法 mode 回退', () => {
  const c = normalizeConfig({ delivery: { defaultMode: 'bogus' } });
  assert.equal(c.delivery.defaultMode, 'queue');
});

// ══════════════════════════════════════════════
//  10. 参数校验
// ══════════════════════════════════════════════

test('validateArgs 必填检查', () => {
  const schema = { type: 'object', required: ['a'], properties: { a: { type: 'string' } } };
  const r = validateArgs(schema, {});
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('required')));
});

test('validateArgs 类型检查', () => {
  const schema = { type: 'object', properties: { n: { type: 'integer' } } };
  const r = validateArgs(schema, { n: 'x' });
  assert.equal(r.ok, false);
});

test('validateArgs 剥离未知字段', () => {
  const schema = { type: 'object', properties: { a: { type: 'string' } } };
  const r = validateArgs(schema, { a: 'x', evil: 'y' });
  assert.equal(r.ok, true);
  assert.equal(r.value.evil, undefined);
});
