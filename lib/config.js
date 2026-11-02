/**
 * 配置归一化 —— 零依赖
 */

const DEFAULTS = {
  // 广播
  broadcast: {
    dryRunByDefault: true,      // 默认只预览，必须显式 confirm 才真发
    maxTargets: 50,             // 单次广播最多目标数
    concurrency: 5,             // 并发投递数
    requireConfirm: true,       // 必须 confirm:true 才发
    excludeSelf: true,          // 排除自己
    excludeSubagents: true,     // 排除 subagent
  },
  // 搜索
  search: {
    defaultLimit: 10,
    maxLimit: 100,
    snippetChars: 200,
    minScore: 0,                // 0 = 不过滤
  },
  // 投递
  delivery: {
    defaultMode: 'queue',       // queue | steer | interrupt
    maxMessageChars: 8000,
    allowCrossWorkspace: true,
    persistState: true,
  },
  // 审计
  audit: {
    enabled: true,
    maxEntries: 500,
  },
};

function isPlain(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 深合并，用户配置覆盖默认 */
function merge(base, over) {
  if (!isPlain(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    out[k] = isPlain(v) && isPlain(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

export function normalizeConfig(raw) {
  const cfg = merge(DEFAULTS, raw);
  // 边界钳制
  cfg.broadcast.maxTargets = Math.min(Math.max(1, Number(cfg.broadcast.maxTargets) || 50), 500);
  cfg.broadcast.concurrency = Math.min(Math.max(1, Number(cfg.broadcast.concurrency) || 5), 20);
  cfg.search.defaultLimit = Math.min(Math.max(1, Number(cfg.search.defaultLimit) || 10), 100);
  cfg.search.maxLimit = Math.min(Math.max(1, Number(cfg.search.maxLimit) || 100), 500);
  if (!['queue', 'steer', 'interrupt'].includes(cfg.delivery.defaultMode)) {
    cfg.delivery.defaultMode = 'queue';
  }
  return cfg;
}

export { DEFAULTS };
