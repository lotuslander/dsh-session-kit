/**
 * 会话寻址 —— 支持多种定位方式，有歧义时拒绝
 */

/**
 * 根据候选池解析目标
 * @param {string} spec  sessionId / 唯一前缀 / 唯一标题 / 工作目录片段 / 'self'
 * @param {Array} candidates [{ sessionId, title, cwd, running, targetable }]
 * @param {string} selfId
 * @returns {{ok:true, target:object}|{ok:false, code:string, message:string, candidates:Array}}
 */
export function resolveTarget(spec, candidates, selfId) {
  const s = typeof spec === 'string' ? spec.trim() : '';
  if (!s) {
    return { ok: false, code: 'empty_target', message: 'target is empty', candidates: [] };
  }
  if (s === 'self') {
    const self = candidates.find((c) => c.sessionId === selfId);
    if (!self) return { ok: false, code: 'self_not_found', message: 'current session not found in list', candidates: [] };
    return { ok: true, target: self };
  }

  // 1. 完整 id
  const exact = candidates.filter((c) => c.sessionId === s);
  if (exact.length === 1) return { ok: true, target: exact[0] };

  // 2. id 前缀
  const byPrefix = candidates.filter((c) => c.sessionId.startsWith(s));
  if (byPrefix.length === 1) return { ok: true, target: byPrefix[0] };
  if (byPrefix.length > 1) {
    return {
      ok: false, code: 'ambiguous_id',
      message: `"${s}" matches ${byPrefix.length} sessions by id prefix`,
      candidates: byPrefix.map(brief),
    };
  }

  // 3. 唯一标题
  const byTitle = candidates.filter((c) => (c.title || '') === s);
  if (byTitle.length === 1) return { ok: true, target: byTitle[0] };
  if (byTitle.length > 1) {
    return {
      ok: false, code: 'ambiguous_title',
      message: `"${s}" matches ${byTitle.length} sessions by exact title`,
      candidates: byTitle.map(brief),
    };
  }

  // 4. 标题包含
  const byContains = candidates.filter((c) => (c.title || '').includes(s));
  if (byContains.length === 1) return { ok: true, target: byContains[0] };
  if (byContains.length > 1) {
    return {
      ok: false, code: 'ambiguous_title',
      message: `"${s}" matches ${byContains.length} sessions by title`,
      candidates: byContains.map(brief),
    };
  }

  // 5. 工作目录片段
  const byCwd = candidates.filter((c) => (c.cwd || '').toLowerCase().includes(s.toLowerCase()));
  if (byCwd.length === 1) return { ok: true, target: byCwd[0] };
  if (byCwd.length > 1) {
    return {
      ok: false, code: 'ambiguous_cwd',
      message: `"${s}" matches ${byCwd.length} sessions by working directory`,
      candidates: byCwd.map(brief),
    };
  }

  return { ok: false, code: 'not_found', message: `no session matches "${s}"`, candidates: [] };
}

function brief(c) {
  return { sessionId: c.sessionId, title: c.title, cwd: c.cwd, running: c.running };
}

/** 判断两个工作目录是否相同 */
export function sameWorkspace(a, b) {
  if (!a || !b) return false;
  const norm = (p) => String(p).replace(/[\\/]+$/, '').toLowerCase().replace(/\\/g, '/');
  return norm(a) === norm(b);
}
