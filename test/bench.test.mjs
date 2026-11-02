import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMockHost } from './mock-host.mjs';
import { apply } from '../lib/index.js';

function setup(extra = {}) {
  const host = makeMockHost(extra);
  apply(host.ctx, {});
  return { host, tools: Object.fromEntries(host.registered.map((t) => [t.name, t])) };
}

async function bench(fn, n = 50) {
  const times = [];
  for (let i = 0; i < n; i++) {
    const t0 = process.hrtime.bigint();
    await fn();
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  return {
    p50: times[Math.floor(n * 0.5)],
    p95: times[Math.floor(n * 0.95)],
    min: times[0],
    max: times[n - 1],
  };
}

test('性能：session_list 50 次', async () => {
  const { tools } = setup();
  const r = await bench(() => tools.session_list.execute({}), 50);
  console.log('  session_list   p50=' + r.p50.toFixed(3) + 'ms  p95=' + r.p95.toFixed(3) + 'ms');
  assert.ok(r.p50 < 5, '列表应 <5ms，实际 ' + r.p50);
});

test('性能：session_search 50 次', async () => {
  const { tools } = setup();
  const r = await bench(() => tools.session_search.execute({ query: '解析器' }), 50);
  console.log('  session_search p50=' + r.p50.toFixed(3) + 'ms  p95=' + r.p95.toFixed(3) + 'ms');
  assert.ok(r.p50 < 5, '搜索应 <5ms，实际 ' + r.p50);
});

test('性能：send_message 50 次', async () => {
  const { tools } = setup();
  const r = await bench(() => tools.send_message.execute({ to: 'session-bbb-2222', message: 'x' }), 50);
  console.log('  send_message   p50=' + r.p50.toFixed(3) + 'ms  p95=' + r.p95.toFixed(3) + 'ms');
  assert.ok(r.p50 < 5, '单发应 <5ms，实际 ' + r.p50);
});

test('性能：broadcast 到 50 个会话', async () => {
  const many = Array.from({ length: 50 }, (_, i) => ({
    id: 'target-' + i, title: 'T' + i, cwd: '/w/' + i, running: false, origin: 'root',
  }));
  const { tools } = setup({ sessions: many });
  const t0 = Date.now();
  const r = await tools.broadcast.execute({ message: 'x', confirm: true });
  const ms = Date.now() - t0;
  console.log('  broadcast x50  ' + ms + 'ms  成功=' + r.succeeded + ' 失败=' + r.failed);
  assert.equal(r.failed, 0);
  assert.ok(ms < 500, '广播 50 个应 <500ms，实际 ' + ms);
});

test('并发安全：broadcast 不丢失任何目标', async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    id: 'c-' + i, title: 'C' + i, cwd: '/c', running: false, origin: 'root',
  }));
  const { host, tools } = setup({ sessions: many });
  const r = await tools.broadcast.execute({ message: '并发测试', confirm: true });
  assert.equal(r.targetCount, 30);
  assert.equal(r.succeeded, 30);
  let received = 0;
  for (const [id, inbox] of host.inboxes) {
    if (id.startsWith('c-') && inbox.nextTurn.length === 1) received++;
  }
  assert.equal(received, 30);
});
