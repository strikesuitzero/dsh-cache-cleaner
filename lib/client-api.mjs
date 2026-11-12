/**
 * dsh-cache-cleaner —— 设置页（Client 半）用的 Host API 接线与校验。
 *
 * 契约：DESIGN-v4.md §2。本文件只做「信封 / 校验 / 分发」，不 import 任何清理引擎，
 * 也不读宿主服务；真正的动作闭包由 index.js 注入（与工具共用同一组函数，避免两套实现漂移）。
 *
 * 传输：`POST /api/cache-cleaner.api`，请求体 `{ action, params? }`：
 * - 成功 HTTP 200 `{ ok:true, action, data }`
 * - 业务失败 HTTP 200 `{ ok:false, action, error:{ code, message, details? } }`
 * - 只有「请求体本身非法」才用非 200：415 content-type、413 超 64 KiB、400 JSON/信封非法。
 */

/** 精确路由路径（DESIGN-v4 §2）。 */
export const API_PATH = '/api/cache-cleaner.api';

/** 请求体上限 64 KiB。 */
export const MAX_BODY_BYTES = 64 * 1024;

/** 统一的业务错误：由路由转成 `{ok:false,error}` 信封。 */
export class ApiError extends Error {
  /**
   * @param {string} code 稳定错误码（客户端按 code 分支）
   * @param {string} [message] 人类可读说明
   * @param {object} [details] 附加细节（会原样进 error.details）
   */
  constructor(code, message, details) {
    super(message || code);
    this.name = 'ApiError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/**
 * action 规格：允许的参数名 + 是否属于「写动作」（apply:true 必须 confirm:true）。
 * `key` 是注入的 actions 里的字段名；`options-save` 走单独的 saveOptions。
 */
export const ACTION_SPECS = {
  status: { key: 'status', params: ['sections'] },
  clean: {
    key: 'clean',
    params: ['apply', 'includeLegacy', 'mode', 'confirm'],
    confirmOnApply: true,
  },
  'workspace-clean': {
    key: 'workspaceClean',
    params: ['apply', 'confirm', 'includeArchives', 'root'],
    confirmOnApply: true,
  },
  conversations: { key: 'conversations', params: ['includeAll'] },
  'conversation-delete': {
    key: 'conversationDelete',
    params: [
      'sessionIds',
      'allArchived',
      'includeArtifacts',
      'includeTempDirs',
      'cascade',
      'apply',
      'confirm',
    ],
    confirmOnApply: true,
  },
  'options-save': { key: 'saveOptions', params: ['mode', 'retainDays', 'quotaBytes', 'autoClean', 'autoCleanLegacy', 'manageArchives', 'intervalHours', 'systemCacheEnabled', 'allowUpdaterCleanup'] },
  'system-clean': {
    key: 'systemClean',
    params: ['apply', 'confirm', 'ids'],
    confirmOnApply: true,
  },
};

/** 可在设置页保存的选项（Config 是唯一真相）。 */
export const SAVEABLE_OPTION_KEYS = ['mode', 'retainDays', 'quotaBytes', 'autoClean', 'autoCleanLegacy', 'manageArchives', 'intervalHours', 'systemCacheEnabled', 'allowUpdaterCleanup'];

/** `status` 可分段拉取的数据块（v0.4.4：先出界面，扫描后补；v5 增加 system）。 */
export const STATUS_SECTIONS = ['meta', 'sizes', 'workspace', 'conversations', 'system'];

/**
 * 校验 `sections`：缺省表示全部（兼容旧调用）；显式传入时必须是非空、去重后的合法块名。
 * @param {unknown} value
 * @returns {string[]|null}
 */
export function normalizeSections(value) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0) {
    throw new ApiError('INVALID_ARGUMENT', 'sections 必须是非空数组');
  }
  const invalid = value.filter((name) => typeof name !== 'string' || !STATUS_SECTIONS.includes(name));
  if (invalid.length > 0) {
    throw new ApiError('INVALID_ARGUMENT', `sections 只能包含 ${STATUS_SECTIONS.join('/')}`, {
      invalid,
    });
  }
  return [...new Set(value)];
}

const MODES = new Set(['safe', 'normal', 'aggressive']);
const MAX_RETAIN_DAYS = 365;
const MAX_QUOTA_BYTES = 2 ** 40;
/** 自动扫描频率上限：一年（8784 小时）。 */
const MAX_INTERVAL_HOURS = 8784;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 校验并收敛 `options-save` 的补丁。非法值一律 `INVALID_ARGUMENT`（不静默忽略）。
 * @param {unknown} patch
 * @returns {{mode?:string, retainDays?:number|null, quotaBytes?:number|null, autoClean?:boolean, autoCleanLegacy?:boolean, manageArchives?:boolean}}
 */
export function validateOptionsPatch(patch) {
  if (!isPlainObject(patch)) {
    throw new ApiError('INVALID_ARGUMENT', 'options-save 的参数必须是对象');
  }
  const unknown = Object.keys(patch).filter((key) => !SAVEABLE_OPTION_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new ApiError('UNKNOWN_PARAMETER', '不支持的选项', { unknown });
  }
  const clean = {};
  if (Object.prototype.hasOwnProperty.call(patch, 'mode')) {
    if (typeof patch.mode !== 'string' || !MODES.has(patch.mode)) {
      throw new ApiError('INVALID_ARGUMENT', 'mode 必须是 safe/normal/aggressive 之一');
    }
    clean.mode = patch.mode;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'retainDays')) {
    const value = patch.retainDays;
    if (value === null) clean.retainDays = null;
    else if (!Number.isInteger(value) || value < 1 || value > MAX_RETAIN_DAYS) {
      throw new ApiError('INVALID_ARGUMENT', `retainDays 必须是 1..${MAX_RETAIN_DAYS} 的整数或 null`);
    } else clean.retainDays = value;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'quotaBytes')) {
    const value = patch.quotaBytes;
    if (value === null) clean.quotaBytes = null;
    else if (!Number.isInteger(value) || value < 0 || value > MAX_QUOTA_BYTES) {
      throw new ApiError('INVALID_ARGUMENT', `quotaBytes 必须是 0..${MAX_QUOTA_BYTES} 的整数或 null`);
    } else clean.quotaBytes = value;
  }
  for (const key of ['autoClean', 'autoCleanLegacy', 'manageArchives', 'systemCacheEnabled', 'allowUpdaterCleanup']) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    if (typeof patch[key] !== 'boolean') {
      throw new ApiError('INVALID_ARGUMENT', `${key} 必须是 boolean`);
    }
    clean[key] = patch[key];
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'intervalHours')) {
    const value = patch.intervalHours;
    if (!Number.isInteger(value) || value < 1 || value > MAX_INTERVAL_HOURS) {
      throw new ApiError('INVALID_ARGUMENT', `intervalHours 必须是 1..${MAX_INTERVAL_HOURS} 的整数`);
    }
    clean.intervalHours = value;
  }
  if (Object.keys(clean).length === 0) {
    throw new ApiError('INVALID_ARGUMENT', '没有可保存的选项');
  }
  return clean;
}

/**
 * 选项持久化：经宿主 configEditor 写进 profile 的 cordis.patch.yml（Config 是唯一真相）。
 * 保存会触发本插件 fiber reload，所以返回值带 `reloaded:true`。
 *
 * @param {object} deps
 * @param {() => any} deps.resolveEditor 取 configEditor 服务
 * @param {string} [deps.pluginId] 当前 patch 行 id（DESIGN-v4：`dsh-cache-cleaner`）
 * @param {object} [deps.log]
 * @returns {(patch: unknown) => Promise<{saved:true, options:object, reloaded:true}>}
 */
export function createOptionsSaver(deps = {}) {
  const { resolveEditor, pluginId = 'dsh-cache-cleaner', log } = deps;
  return async function saveOptions(patch) {
    const clean = validateOptionsPatch(patch);
    let editor = null;
    try {
      editor = typeof resolveEditor === 'function' ? resolveEditor() : null;
    } catch {
      editor = null;
    }
    if (!editor || typeof editor.entries !== 'function' || typeof editor.edit !== 'function') {
      throw new ApiError('CONFIG_EDITOR_UNAVAILABLE', '宿主未提供 configEditor 服务，无法保存选项');
    }
    const entries = editor.entries();
    const entry = Array.isArray(entries) ? entries.find((item) => item?.options?.id === pluginId) : undefined;
    if (!entry) {
      throw new ApiError('CONFIG_ENTRY_NOT_FOUND', `未找到 id=${pluginId} 的配置条目`);
    }
    let merged = null;
    const change = (current) => {
      merged = { ...(isPlainObject(current) ? current : {}), ...clean };
      return merged;
    };
    try {
      await editor.edit(entry, change);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError('CONFIG_SAVE_FAILED', `保存选项失败：${error?.message || String(error)}`);
    }
    if (log && typeof log.info === 'function') {
      log.info(`[cache-guard] 设置页保存选项：${Object.keys(clean).join(',')}（插件将 reload）`);
    }
    return { saved: true, options: merged ?? clean, reloaded: true };
  };
}

/**
 * 按 action 规格校验 params：未知键 → UNKNOWN_PARAMETER；非对象 → INVALID_ARGUMENT。
 */
function normalizeParams(action, params) {
  const spec = ACTION_SPECS[action];
  if (params === undefined || params === null) return {};
  if (!isPlainObject(params)) {
    throw new ApiError('INVALID_ARGUMENT', `${action} 的 params 必须是对象`);
  }
  const unknown = Object.keys(params).filter((key) => !spec.params.includes(key));
  if (unknown.length > 0) {
    throw new ApiError('UNKNOWN_PARAMETER', '不支持的参数', { unknown });
  }
  return params;
}

function errorPayload(error) {
  if (error instanceof ApiError) {
    const payload = { code: error.code, message: error.message };
    if (error.details !== undefined) payload.details = error.details;
    return payload;
  }
  return { code: 'INTERNAL', message: error?.message || String(error) };
}

function readHeader(request, name) {
  const headers = request && request.headers;
  if (!headers) return null;
  try {
    if (typeof headers.get === 'function') return headers.get(name);
    const lowered = name.toLowerCase();
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === lowered) return headers[key];
    }
  } catch {
    /* 头读取失败按缺省处理 */
  }
  return null;
}

function isJsonContentType(value) {
  if (typeof value !== 'string') return false;
  return value.split(';')[0].trim().toLowerCase() === 'application/json';
}

function jsonResponse(status, payload) {
  const body = JSON.stringify(payload);
  if (typeof Response === 'function' && typeof Response.json === 'function') {
    return Response.json(payload, { status, headers: { 'cache-control': 'no-store' } });
  }
  if (typeof Response === 'function') {
    return new Response(body, {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  return { status, headers: { 'content-type': 'application/json; charset=utf-8' }, body, text: async () => body };
}

async function readRequestBody(request) {
  if (request && typeof request.text === 'function') return await request.text();
  if (request && typeof request.body === 'string') return request.body;
  return '';
}

/**
 * 创建 Host API：`handle(action, params)` 供测试/内部复用；`route` 交给宿主注册。
 *
 * @param {object} deps
 * @param {Record<string, Function>} deps.actions {status, clean, workspaceClean, conversations, conversationDelete}
 * @param {(patch:object)=>Promise<object>} deps.saveOptions
 * @param {() => object} [deps.getConfig]
 * @param {{info?:Function,warn?:Function}} [deps.log]
 * @param {string} [deps.path]
 */
export function createClientApi(deps = {}) {
  const { actions = {}, saveOptions, getConfig, log, path = API_PATH } = deps;

  async function handle(action, params) {
    if (typeof action !== 'string' || action.trim() === '') {
      throw new ApiError('UNKNOWN_ACTION', '缺少 action');
    }
    const spec = ACTION_SPECS[action];
    if (!spec) throw new ApiError('UNKNOWN_ACTION', `未知 action: ${action}`);
    const input = normalizeParams(action, params);
    if (action === 'status') {
      input.sections = normalizeSections(input.sections);
    }
    if (spec.confirmOnApply && input.apply === true && input.confirm !== true) {
      throw new ApiError('CONFIRM_REQUIRED', 'apply:true 必须同时 confirm:true（删除不可撤销，请先预览）');
    }
    let data;
    if (action === 'options-save') {
      if (typeof saveOptions !== 'function') {
        throw new ApiError('ACTION_UNAVAILABLE', 'options-save 未接线');
      }
      data = await saveOptions(input);
    } else {
      const impl = actions[spec.key];
      if (typeof impl !== 'function') {
        throw new ApiError('ACTION_UNAVAILABLE', `action ${action} 未接线`);
      }
      data = await impl(input);
    }
    if (getConfig && typeof getConfig === 'function') {
      // 契约保留 getConfig 注入口；当前 action 的选项快照由 index.js 的 status 闭包直接取，
      // 这里不额外调用，避免为一次请求重复读配置。
    }
    return data;
  }

  async function fetch(request) {
    const method = String((request && request.method) || 'POST').toUpperCase();
    if (method !== 'POST') {
      return jsonResponse(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: '只支持 POST' } });
    }
    const contentType = readHeader(request, 'content-type');
    if (!isJsonContentType(contentType)) {
      return jsonResponse(415, {
        ok: false,
        error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'content-type 必须是 application/json' },
      });
    }
    let raw = '';
    try {
      raw = await readRequestBody(request);
    } catch (error) {
      return jsonResponse(400, {
        ok: false,
        error: { code: 'INVALID_BODY', message: error?.message || '读取请求体失败' },
      });
    }
    const bytes = Buffer.byteLength(raw, 'utf8');
    if (bytes > MAX_BODY_BYTES) {
      return jsonResponse(413, {
        ok: false,
        error: { code: 'BODY_TOO_LARGE', message: `请求体超过 ${MAX_BODY_BYTES} 字节`, details: { bytes } },
      });
    }
    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch {
      return jsonResponse(400, { ok: false, error: { code: 'INVALID_JSON', message: '请求体不是合法 JSON' } });
    }
    if (!isPlainObject(envelope)) {
      return jsonResponse(400, { ok: false, error: { code: 'INVALID_ENVELOPE', message: '请求体必须是 {action, params} 对象' } });
    }
    const action = envelope.action;
    if (typeof action !== 'string' || action.trim() === '') {
      return jsonResponse(400, { ok: false, error: { code: 'INVALID_ENVELOPE', message: '缺少 action' } });
    }
    const params = envelope.params;
    if (params !== undefined && !isPlainObject(params)) {
      return jsonResponse(400, { ok: false, error: { code: 'INVALID_PARAMS', message: 'params 必须是对象' } });
    }
    try {
      const data = await handle(action, params ?? {});
      return jsonResponse(200, { ok: true, action, data });
    } catch (error) {
      if (!(error instanceof ApiError) && log && typeof log.warn === 'function') {
        log.warn(`[cache-guard] API ${action} 失败：${error?.message || error}`);
      }
      return jsonResponse(200, { ok: false, action, error: errorPayload(error) });
    }
  }

  return {
    handle,
    fetch,
    route: { path, methods: ['POST'], requestBody: 'buffered', fetch },
  };
}
