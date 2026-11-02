/**
 * 工具定义与参数校验 —— 零依赖实现
 *
 * DSH 宿主用普通 Node 模块解析加载安装目录之外的插件，
 * 而 @deepseek-ai/* 这些包只对安装在 DSH 安装目录内的插件可达。
 * 所以本文件自带定义与校验，不 import @deepseek-ai/dsh-tools。
 */

const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array']);

/** 校验单个值 */
function checkValue(value, schema, path) {
  const errors = [];
  if (schema === undefined) return errors;

  if (schema.anyOf) {
    const ok = schema.anyOf.some((s) => checkValue(value, s, path).length === 0);
    if (!ok) errors.push(`${path}: no variant matched`);
    return errors;
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: expected one of ${schema.enum.join(', ')}`);
    return errors;
  }

  if (schema.type) {
    const t = Array.isArray(value) ? 'array' : (value === null ? 'null' : typeof value);
    const want = schema.type;
    const typeOk = want === 'integer'
      ? Number.isInteger(value)
      : want === 'number' ? typeof value === 'number' && Number.isFinite(value)
      : want === 'object' ? (t === 'object' && !Array.isArray(value))
      : t === want;
    if (!typeOk) {
      errors.push(`${path}: expected ${want}, got ${t}`);
      return errors;
    }
  }

  if (schema.minLength !== undefined && typeof value === 'string' && value.length < schema.minLength) {
    errors.push(`${path}: shorter than ${schema.minLength}`);
  }
  if (schema.maxLength !== undefined && typeof value === 'string' && value.length > schema.maxLength) {
    errors.push(`${path}: longer than ${schema.maxLength}`);
  }
  if (schema.minimum !== undefined && typeof value === 'number' && value < schema.minimum) {
    errors.push(`${path}: below ${schema.minimum}`);
  }
  if (schema.maximum !== undefined && typeof value === 'number' && value > schema.maximum) {
    errors.push(`${path}: above ${schema.maximum}`);
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => errors.push(...checkValue(item, schema.items, `${path}[${i}]`)));
  }

  if (value && typeof value === 'object' && !Array.isArray(value) && schema.properties) {
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (value[key] === undefined) {
        if (schema.required?.includes(key)) errors.push(`${path}.${key}: required`);
        continue;
      }
      errors.push(...checkValue(value[key], sub, `${path}.${key}`));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in schema.properties)) errors.push(`${path}.${key}: not allowed`);
      }
    }
  }

  return errors;
}

/** 定义一个工具 */
export function defineTool(spec) {
  return Object.freeze({ ...spec });
}

/**
 * 校验参数，返回 { ok, value, errors }
 * 未知字段被剥离（宿主会按 additionalProperties:false 严格校验输出）
 */
export function validateArgs(schema, args) {
  const value = args && typeof args === 'object' ? args : {};
  const errors = [];

  if (schema.required) {
    for (const key of schema.required) {
      if (value[key] === undefined) errors.push(`${key}: required`);
    }
  }

  const cleaned = {};
  for (const [key, sub] of Object.entries(schema.properties || {})) {
    if (value[key] !== undefined) {
      cleaned[key] = value[key];
      errors.push(...checkValue(value[key], sub, key));
    }
  }

  return { ok: errors.length === 0, value: cleaned, errors };
}

/** 投影结果，只保留声明过的字段 */
export function project(value, schema) {
  if (!schema || !schema.properties) return value;
  if (Array.isArray(value)) {
    const itemSchema = schema.items;
    return value.map((v) => project(v, itemSchema));
  }
  if (!value || typeof value !== 'object') return value;

  const out = {};
  for (const key of Object.keys(schema.properties)) {
    if (value[key] !== undefined) {
      out[key] = project(value[key], schema.properties[key]);
    }
  }
  return out;
}
