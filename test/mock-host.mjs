/**
 * 假宿主：模拟 DSH 提供的最小 API 面
 */

export function makeMockHost(opts = {}) {
  const selfId = opts.selfId ?? 'session-self-0001';
  const selfCwd = opts.selfCwd ?? 'C:/work/main';

  // 会话池
  const sessions = opts.sessions ?? [
    { id: 'session-aaa-1111', title: '修复解析器', cwd: 'C:/work/main', running: true, live: true, origin: 'root' },
    { id: 'session-bbb-2222', title: '部署配置', cwd: 'C:/work/server', running: false, live: false, origin: 'root' },
    { id: 'session-ccc-3333', title: '数据迁移', cwd: 'C:/work/data', running: false, live: false, origin: 'root' },
    { id: 'session-ddd-4444', title: '子代理任务', cwd: 'C:/work/main', running: false, live: false, origin: 'subagent' },
    { sessionId: selfId, title: '主会话', cwd: selfCwd, running: true, origin: 'root' },
  ];

  const inboxes = new Map();
  for (const s of sessions) {
    inboxes.set(s.id ?? s.sessionId, { nextTurn: [], nextStep: [] });
  }

  const agents = new Map();
  for (const s of sessions) {
    const id = s.id ?? s.sessionId;
    agents.set(id, {
      running: s.running === true,
      inbox: inboxes.get(id),
      session: {
        header: { id, title: s.title, cwd: s.cwd },
        snapshotEvents: () => opts.events?.[id] ?? [
          { type: 'user/message', time: Date.now() - 5000, data: { content: [{ type: 'text', text: '你好' }] } },
          { type: 'assistant/message', time: Date.now(), data: { message: { content: [{ type: 'text', text: '收到' }] } } },
        ],
      },
      async wake() { this.woke = true; },
    });
  }

  const searches = [];

  const services = {
    session: { id: selfId, header: { id: selfId, cwd: selfCwd } },
    agents: {
      get: (id) => agents.get(id),
      list: () => [...agents.values()],
      resume: async (id) => agents.get(id),
    },
    sessionQuery: {
      async listSessions() {
        return {
          items: sessions.map((s) => ({
            header: { id: s.id ?? s.sessionId, title: s.title, cwd: s.cwd, origin: s.origin },
            running: s.running,
            live: s.live,
          })),
        };
      },
      async searchSessions(query, opts) {
        searches.push({ query, opts });
        if (opts?.failSearch) throw new Error('index offline');
        const items = (opts?.hits ?? [
          {
            header: { id: 'session-aaa-1111', title: '修复解析器', cwd: 'C:/work/main' },
            live: true,
            bestMatch: { type: 'content', snippet: '…这里就是解析器报错的位置…', score: 0.92 },
          },
          {
            header: { id: 'session-bbb-2222', title: '部署配置', cwd: 'C:/work/server' },
            live: false,
            bestMatch: { type: 'content', snippet: '…nginx 反向代理…', score: 0.55 },
          },
        ]);
        return { items };
      },
    },
  };

  const registered = [];
  const ctx = {
    get: (key) => services[key],
    tools: { register: (spec) => registered.push(spec) },
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    effect: () => {},
    on: () => {},
  };

  return { ctx, services, registered, inboxes, agents, searches, selfId, selfCwd, sessions };
}
