/**
 * dsh-session-kit 插件入口
 *
 * 完整套件：搜索 + 通信 + 广播 + 审计
 * 零外部依赖（只用 node:* 与相对路径），保证在 profile 层可加载。
 */

import { normalizeConfig } from './config.js';
import { SessionKit } from './engine.js';
import { registerTools } from './tools.js';

export const name = 'dsh-session-kit';

export const inject = ['tools'];

/**
 * 插件应用函数（Cordis 约定）
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const logger = {
    info: (...a) => ctx.logger?.info?.('dsh-session-kit', ...a),
    warn: (...a) => ctx.logger?.warn?.('dsh-session-kit', ...a),
    debug: (...a) => ctx.logger?.debug?.('dsh-session-kit', ...a),
  };

  const kit = new SessionKit(ctx, config, logger);

  registerTools(ctx, kit, logger);

  logger.info('已加载：6 个工具（session_list / session_search / session_read / send_message / broadcast / session_audit）');
}

export { SessionKit, normalizeConfig };
