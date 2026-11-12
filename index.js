/**
 * dsh-cache-cleaner —— 把 DSH 进程的临时缓存迁到 D 盘，并按天数/配额白名单自动清理（Host 半）。
 *
 * 契约：DESIGN.md（v1 缓存）、DESIGN-v2.md（v2 会话/附件）、DESIGN-v3.md（v3 工作区目录）、
 * DESIGN-v4.md（v4 设置页 API）。
 * 本文件只做宿主集成；扫描/判定/删除全部委托给 ./lib/cleaner.mjs、./lib/conversations.mjs、
 * ./lib/workspace.mjs，不重复实现清理逻辑。设置页的信封/校验在 ./lib/client-api.mjs。
 * 硬约束：不 import 任何 @deepseek-ai/* 或 schemastery；工具定义按 ToolDefinition 手写。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_CONFIG,
  cacheTempRoot,
  cleanup,
  defaultCacheRoot,
  ensureRootMarker,
} from './lib/cleaner.mjs';
import {
  applyConversationDeletion,
  dshHomePath,
  listConversations,
  ownershipReport,
  planConversationDeletion,
} from './lib/conversations.mjs';
import {
  applyWorkspaceCleanup,
  planWorkspaceCleanup,
  scanWorkspaceRoot,
  normalizeWorkspaceRoots,
  WORKSPACE_STATUS_SCHEMA,
} from './lib/workspace.mjs';
import {
  applySystemCleanup,
  normalizeSystemConfig,
  planSystemCleanup,
  scanSystemCaches,
  SYSTEM_CACHE_IDS,
} from './lib/system.mjs';
import {
  ApiError,
  createClientApi,
  createOptionsSaver,
} from './lib/client-api.mjs';

export const name = 'dsh-cache-cleaner';

/** 只依赖宿主 tools 服务。缺少时插件不激活，所以不会在没登记工具的情况下改 TEMP。 */
export const inject = ['tools'];

const PLUGIN_VERSION = '0.5.1';

/** 三个档位（与 cleaner 的 mode 取值一致）。 */
const MODES = new Set(['safe', 'normal', 'aggressive']);

/** cache_clean 允许的参数；其它键视为调用错误（与 dsh-plugin-updates 的写法一致）。 */
const CLEAN_KEYS = ['apply', 'includeLegacy', 'mode'];

/** legacy 会话目录名前缀（DESIGN D3/D7）。 */
const LEGACY_DIR_PREFIX = 'dsh-workspace-changes-';

/** 单次 cache_status 的目录测量预算：宁可报 complete:false，也不卡住宿主事件循环。 */
const STATUS_BUDGET_MS = 4000;

/** 可在 cordis.patch.yml 的 config 里覆盖的插件键；其余未知键忽略。 */
const PLUGIN_DEFAULTS = {
  redirectTemp: true,
  autoClean: true,
  autoCleanLegacy: false,
  startupDelaySeconds: 60,
  intervalHours: 6,
  idleQuietMinutes: 10,
  mode: 'normal',
  retainDays: null,
  quotaBytes: null,
  // v3：工作区目录治理（路径围栏 + 根清单 + archive 总闸门）
  workspaceBases: [],
  workspaceRoots: [],
  manageArchives: false,
  // v5：系统缓存（Electron/GPU/更新包/插件更新包/%TEMP% 空目录）。
  // 只手动触发：自动定时器不碰这些目录（避免正在运行的 Electron 缓存被删）。
  systemCacheEnabled: true,
  systemCacheIds: [...SYSTEM_CACHE_IDS],
  systemCacheRetainDays: 7,
  systemCacheEmptyDirHours: 24,
  allowUpdaterCleanup: false,
};

const USER_KEYS = ['cacheRoot', ...Object.keys(PLUGIN_DEFAULTS)];

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function clampNumber(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function positiveNumberOrNull(value) {
  if (value === null || value === undefined) return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function secondsToMs(seconds) {
  return Math.max(0, Math.round(seconds * 1000));
}

function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left === '' || right === '') return false;
  const normalize = (value) => {
    let resolved;
    try {
      resolved = path.resolve(value);
    } catch {
      resolved = value;
    }
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function safeTmpdir() {
  try {
    return os.tmpdir();
  } catch {
    return null;
  }
}

function restoreEnv(key, previous) {
  if (previous === undefined) delete process.env[key];
  else process.env[key] = previous;
}

function formatBytes(bytes) {
  const value = Number.isFinite(bytes) ? bytes : 0;
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let index = 0;
  let scaled = Math.max(0, value);
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  return `${index === 0 ? scaled : scaled.toFixed(2)} ${units[index]}`;
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

/**
 * 合并 DEFAULT_CONFIG、插件默认值与用户 config；未知键丢弃，数值做范围收敛。
 * @param {unknown} raw cordis.patch.yml 里 config 的原值。
 */
function normalizeConfig(raw) {
  const cfg = { ...DEFAULT_CONFIG, ...PLUGIN_DEFAULTS };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const key of USER_KEYS) {
      if (Object.hasOwn(raw, key)) cfg[key] = raw[key];
    }
  }
  if (typeof cfg.cacheRoot !== 'string' || cfg.cacheRoot.trim() === '') cfg.cacheRoot = defaultCacheRoot();
  try {
    cfg.cacheRoot = path.resolve(cfg.cacheRoot);
  } catch {
    cfg.cacheRoot = defaultCacheRoot();
  }
  if (!MODES.has(cfg.mode)) cfg.mode = PLUGIN_DEFAULTS.mode;
  cfg.redirectTemp = cfg.redirectTemp !== false;
  cfg.autoClean = cfg.autoClean !== false;
  cfg.autoCleanLegacy = cfg.autoCleanLegacy === true;
  cfg.startupDelaySeconds = clampNumber(cfg.startupDelaySeconds, 0, 86400, PLUGIN_DEFAULTS.startupDelaySeconds);
  cfg.intervalHours = clampNumber(cfg.intervalHours, 0, 8784, PLUGIN_DEFAULTS.intervalHours);
  cfg.idleQuietMinutes = clampNumber(cfg.idleQuietMinutes, 0, 1440, PLUGIN_DEFAULTS.idleQuietMinutes);
  cfg.retainDays = positiveNumberOrNull(cfg.retainDays);
  cfg.quotaBytes = positiveNumberOrNull(cfg.quotaBytes);
  // v3：根清单/围栏只做形状收敛，路径合法性由 lib/workspace.mjs 的围栏校验负责。
  cfg.workspaceBases = Array.isArray(cfg.workspaceBases)
    ? cfg.workspaceBases.filter((base) => typeof base === 'string' && base.trim() !== '')
    : [];
  cfg.workspaceRoots = Array.isArray(cfg.workspaceRoots) ? cfg.workspaceRoots.filter(Boolean) : [];
  cfg.manageArchives = cfg.manageArchives === true;
  // v5：系统缓存开关/清单/天数；列表只保留已知 id（未知 id 直接丢弃，避免误扫）。
  const system = normalizeSystemConfig(cfg);
  cfg.systemCacheEnabled = system.enabled;
  cfg.systemCacheIds = system.ids;
  cfg.systemCacheRetainDays = system.retainDays;
  cfg.systemCacheEmptyDirHours = system.emptyDirMinAgeHours;
  cfg.allowUpdaterCleanup = system.allowUpdaterCleanup;
  return cfg;
}

// ---------------------------------------------------------------------------
// 目录测量（cache_status 用；只 stat，不读文件内容、不删任何东西）
// ---------------------------------------------------------------------------

/**
 * 递归测量一个目录的字节数/文件数，超过 deadline 立即停下并标 complete:false。
 * @param {string} root
 * @param {number} deadline Date.now() 的绝对截止时刻。
 */
async function measureTree(root, deadline) {
  const result = { path: root, exists: false, bytes: 0, files: 0, dirs: 0, complete: true, error: null };
  if (typeof root !== 'string' || root === '') {
    result.complete = false;
    result.error = 'INVALID_PATH';
    return result;
  }
  try {
    const stat = await fs.promises.stat(root);
    result.exists = true;
    if (!stat.isDirectory()) {
      result.complete = false;
      result.error = 'NOT_A_DIRECTORY';
      return result;
    }
  } catch (error) {
    result.error = error?.code || 'STAT_FAILED';
    return result;
  }

  const stack = [root];
  while (stack.length > 0) {
    if (Date.now() > deadline) {
      result.complete = false;
      result.error = 'TIME_BUDGET_EXCEEDED';
      break;
    }
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // 权限/句柄问题只跳过这个目录，不中断统计
    }
    result.dirs += 1;
    const files = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        result.dirs += 1;
        stack.push(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        files.push(entry.name);
      }
    }
    if (files.length > 0) {
      const sizes = await Promise.all(
        files.map(async (file) => {
          try {
            return (await fs.promises.stat(path.join(dir, file))).size;
          } catch {
            return 0;
          }
        }),
      );
      result.files += files.length;
      result.bytes += sizes.reduce((sum, size) => sum + size, 0);
    }
  }
  return result;
}

/** 列出 legacy 临时根下的 dsh-workspace-changes-* 会话目录（只读）。 */
async function listLegacyDirs(originalTemp) {
  if (typeof originalTemp !== 'string' || originalTemp === '') return [];
  try {
    const entries = await fs.promises.readdir(originalTemp, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(LEGACY_DIR_PREFIX))
      .map((entry) => path.join(originalTemp, entry.name))
      .sort();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 报告投影
// ---------------------------------------------------------------------------

/** 把完整 Report 压成内存里的 lastReport（丢掉 candidates/deleted 明细）。 */
function summarizeReport(report) {
  if (!report || typeof report !== 'object') return null;
  return {
    at: typeof report.generatedAt === 'string' ? report.generatedAt : new Date().toISOString(),
    apply: report.apply === true,
    mode: typeof report.mode === 'string' ? report.mode : null,
    error: report.error ?? null,
    totals: report.totals ?? null,
    warnings: Array.isArray(report.warnings) ? report.warnings.slice(0, 20) : [],
  };
}

/** 工具输出前截断明细，避免把上万条路径塞进模型上下文。 */
function presentReport(report, limit = 200) {
  if (!report || typeof report !== 'object') return report;
  const out = { ...report };
  for (const key of ['candidates', 'deleted', 'skipped']) {
    const rows = Array.isArray(report[key]) ? report[key] : [];
    out[key] = rows.slice(0, limit);
    out[`${key}Total`] = rows.length;
    if (rows.length > limit) out[`${key}Truncated`] = true;
  }
  return out;
}

// ---------------------------------------------------------------------------
// v2：会话归属 / 已归档会话删除
// ---------------------------------------------------------------------------

/** cache_ownership 允许的参数。 */
const OWNERSHIP_KEYS = ['root', 'includeLegacy', 'sessionId', 'json'];

/** conversation_list 允许的参数。 */
const CONVERSATION_LIST_KEYS = ['includeAll'];

/** conversation_delete 允许的参数。 */
const CONVERSATION_DELETE_KEYS = [
  'sessionIds',
  'allArchived',
  'includeArtifacts',
  'includeTempDirs',
  'cascade',
  'apply',
  'confirm',
];

/** workspace_status 允许的参数（DESIGN-v3 §5）。 */
const WORKSPACE_STATUS_KEYS = ['root'];

/** workspace_clean 允许的参数（DESIGN-v3 §5）。 */
const WORKSPACE_CLEAN_KEYS = ['apply', 'confirm', 'includeArchives', 'root'];

// v5：系统缓存工具参数。ids 只接受 catalog 里已知的 id（未知 id 报 UNKNOWN_PARAMETER）。
const SYSTEM_STATUS_KEYS = [];
const SYSTEM_CLEAN_KEYS = ['apply', 'confirm', 'ids'];

/** 状态输出里每个根的 stale 明细上限（DESIGN-v3 §5：≤50）。 */
const WORKSPACE_STATUS_ENTRY_LIMIT = 50;

/**
 * 把扫描结果裁成 workspace_status 的根摘要（去掉完整 staleEntries，保留前 50 条）。
 * @param {object} scan scanWorkspaceRoot 的返回值
 */
function presentWorkspaceScan(scan) {
  const staleEntries = Array.isArray(scan.staleEntries) ? scan.staleEntries : [];
  return {
    path: scan.path,
    kind: scan.kind,
    exists: scan.exists,
    auto: scan.auto === true,
    retainDays: scan.retainDays,
    bytes: scan.bytes,
    files: scan.files,
    dirs: scan.dirs,
    staleBytes: scan.staleBytes,
    staleCount: scan.staleCount ?? staleEntries.length,
    staleEntries: staleEntries.slice(0, WORKSPACE_STATUS_ENTRY_LIMIT),
    staleEntriesTruncated: staleEntries.length > WORKSPACE_STATUS_ENTRY_LIMIT,
    skippedLinks: scan.skippedLinks ?? 0,
    complete: scan.complete !== false,
    errors: scan.errors ?? [],
  };
}

/** 取宿主的 workspaceRegistry 服务（DESIGN-v2 §4.1）。 */
function registryService(ctx) {
  try {
    if (typeof ctx.get === 'function') {
      const viaGet = ctx.get('workspaceRegistry');
      if (viaGet) return viaGet;
    }
  } catch {
    /* 服务未注册 */
  }
  return ctx.workspaceRegistry ?? null;
}

/**
 * 归档状态清理适配器：只调官方 API（unarchiveSession / entity.detachSession），
 * 绝不直接读写 workspace.json。服务不可用时返回 null，由 apply 降级为 warning。
 */
function createRegistryAdapter(ctx, log) {
  const registry = registryService(ctx);
  if (
    !registry ||
    typeof registry.unarchiveSession !== 'function' ||
    typeof registry.list !== 'function'
  ) {
    log.warn('[cache-cleaner] workspaceRegistry 不可用：删除会话时只删文件、不清归档状态');
    return null;
  }
  return {
    async unarchive(sessionId) {
      await registry.unarchiveSession(sessionId);
    },
    async detachWorkspaceSlot(sessionId) {
      for (const entity of registry.list()) {
        const sessionIds = entity?.record?.sessionIds;
        if (Array.isArray(sessionIds) && sessionIds.includes(sessionId)) {
          await entity.detachSession(sessionId);
        }
      }
    },
  };
}

/** 会话是否仍活在内存里（S2：活跃会话拒绝删除）。 */
function hasLiveSession(ctx, sessionId) {
  try {
    const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : null;
    const live = sessions ?? ctx.sessions;
    if (live && typeof live.get === 'function') return live.get(sessionId) !== undefined;
  } catch {
    /* 服务不可用时按「不活跃」处理，计划阶段仍受归档集合保护 */
  }
  return false;
}

/** 报告文件名时间戳：conversation-20261104-104012-plan.json。 */
function reportStamp(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

function formatTimestamp(ms) {
  if (!Number.isFinite(ms)) return '未知';
  try {
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
  } catch {
    return '未知';
  }
}

/** cache_ownership 的人类可读渲染（推断项明确标注 [时间窗推断]）。 */
function renderOwnership(report, sessionId) {
  const lines = [];
  const totals = report.totals ?? { dirs: 0, dirBytes: 0, unattributedBytes: 0 };
  lines.push(`缓存归属盘点（${report.generatedAt ?? ''}）`);
  lines.push(
    `目录 ${totals.dirs} 个，合计 ${formatBytes(totals.dirBytes)}；` +
      `其中无法归因 ${formatBytes(totals.unattributedBytes)}`,
  );
  lines.push('');
  lines.push('== 目录 -> 候选会话 ==');
  const dirs = report.dirs ?? [];
  if (dirs.length === 0) lines.push('（没有发现 dsh-workspace-changes-* 目录）');
  for (const dir of dirs.slice(0, 50)) {
    const counts = dir.counts ?? {};
    lines.push(
      `- ${dir.path}`,
    );
    lines.push(
      `  大小 ${formatBytes(dir.sizeBytes)}，${counts.tmpObj ?? 0} 个 tmp_obj / ` +
        `${counts.captures ?? 0} 个 captures / ${counts.objects ?? 0} 个其他 objects；` +
        `活动窗 ${formatTimestamp(dir.firstWriteAt)} ~ ${formatTimestamp(dir.lastWriteAt)}`,
    );
    if ((dir.candidates ?? []).length === 0) {
      lines.push('  [无法归因] 没有会话活动窗与它重叠');
    } else {
      for (const candidate of dir.candidates.slice(0, 5)) {
        lines.push(
          `  [时间窗推断] ${candidate.sessionId}（重叠 ${Math.round(candidate.overlapMs / 1000)}s）`,
        );
      }
    }
  }
  if (dirs.length > 50) lines.push(`… 其余 ${dirs.length - 50} 个目录已截断（用 json:true 看全量）`);
  lines.push('');
  lines.push('== 会话 -> 缓存 ==');
  const sessions = report.bySession ?? [];
  if (sessions.length === 0) lines.push('（没有会话）');
  for (const item of sessions.slice(0, 50)) {
    if (sessionId && item.sessionId !== sessionId) continue;
    const flag = item.isArchived ? '已归档' : '未归档';
    const attribution =
      item.attribution === 'guess-cache'
        ? '时间窗推断'
        : item.attribution === 'exact-cache'
          ? '精确（projcache）'
          : '无缓存';
    lines.push(
      `- ${item.sessionId}（${flag}，${attribution}）：日志 ${formatBytes(item.logBytes)} / ` +
        `投影缓存 ${formatBytes(item.projcacheBytes)} / 临时目录 ${(item.cacheDirs ?? []).length} 个`,
    );
    for (const cacheDir of (item.cacheDirs ?? []).slice(0, 3)) lines.push(`    [时间窗推断] ${cacheDir}`);
  }
  if (sessions.length > 50) lines.push(`… 其余 ${sessions.length - 50} 个会话已截断（用 json:true 看全量）`);
  return lines.join('\n');
}

/** 删除计划的工具投影（截断明细、保留 totals/warnings）。 */
function presentPlan(plan) {
  return {
    targets: (plan?.targets ?? []).map((target) => ({
      id: target.id,
      logPaths: target.logPaths ?? [],
      dir: target.dir ?? null,
      isGhost: Boolean(target.isGhost),
      sizeBytes: target.sizeBytes ?? 0,
      children: target.children ?? [],
      blocked: target.blocked ?? null,
    })),
    projcacheFiles: (plan?.projcacheFiles ?? []).slice(0, 200),
    projcacheFilesTotal: (plan?.projcacheFiles ?? []).length,
    attachments: (plan?.attachments ?? []).slice(0, 200),
    attachmentsTotal: (plan?.attachments ?? []).length,
    tempDirs: (plan?.tempDirs ?? []).slice(0, 200),
    tempDirsTotal: (plan?.tempDirs ?? []).length,
    retainedBy: plan?.retainedBy ?? [],
    totals: plan?.totals ?? null,
    warnings: (plan?.warnings ?? []).slice(0, 50),
  };
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主插件上下文。
 * @param {unknown} config cordis.patch.yml 里本行的 config。
 */
export async function apply(ctx, config) {
  const cfg = normalizeConfig(config);
  const state = {
    disposed: false,
    lastReport: null,
    redirect: { applied: false, reason: null },
    queue: Promise.resolve(),
  };
  const timers = new Set();
  let idleTimer = null;
  let intervalTimer = null;

  const log = {
    info(message) {
      try {
        if (ctx.logger && typeof ctx.logger.info === 'function') ctx.logger.info(message);
        else console.info(message);
      } catch {
        /* 日志失败不能影响插件 */
      }
    },
    warn(message) {
      try {
        if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn(message);
        else console.warn(message);
      } catch {
        /* 同上 */
      }
    },
  };

  const trackTimer = (timer) => {
    if (timer && typeof timer.unref === 'function') timer.unref();
    if (timer) timers.add(timer);
    return timer;
  };

  /** 串行化所有 cleanup 调用：定时器、工具调用、幂等重入都走同一条队列。 */
  const serialized = (task) => {
    const next = state.queue.then(task, task);
    state.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  // --- 1. 捕获原临时根（必须在重定向前） -----------------------------------
  const originalTemp = safeTmpdir() || '';

  // --- 2. 缓存根目录 + 标记 ------------------------------------------------
  let tempRoot;
  try {
    tempRoot = cacheTempRoot(cfg);
  } catch {
    tempRoot = path.join(cfg.cacheRoot, DEFAULT_CONFIG.tempSubdir);
  }
  if (typeof tempRoot !== 'string' || tempRoot === '') tempRoot = path.join(cfg.cacheRoot, 'temp');

  try {
    fs.mkdirSync(tempRoot, { recursive: true });
  } catch (error) {
    log.warn(`[cache-cleaner] 无法创建临时缓存根 ${tempRoot}：${error?.message || error}（TEMP 重定向将不生效）`);
  }

  // 标记文件是 cleaner 执行删除的前置条件（DESIGN D6）。apply 是 async：先等标记落盘，
  // 再挂工具与定时器，避免「刚挂载就调用 cache_clean 却拿到 UNMARKED_ROOT」的竞态。
  await ensureRootMarker(cfg.cacheRoot)
    .then((markerPath) => log.info(`[cache-cleaner] 缓存根标记就绪：${markerPath}`))
    .catch((error) => log.warn(`[cache-cleaner] 写缓存根标记失败：${error?.message || error}（清理会以 UNMARKED_ROOT 拒绝执行）`));

  // --- 3. TEMP/TMP 重定向 + 校验 ------------------------------------------
  if (cfg.redirectTemp) {
    const previous = { TMP: process.env.TMP, TEMP: process.env.TEMP };
    try {
      process.env.TMP = tempRoot;
      process.env.TEMP = tempRoot;
      const effective = safeTmpdir();
      if (samePath(effective, tempRoot)) {
        state.redirect.applied = true;
      } else {
        restoreEnv('TMP', previous.TMP);
        restoreEnv('TEMP', previous.TEMP);
        state.redirect.reason = `os.tmpdir() 仍为 ${String(effective)}`;
        log.warn(`[cache-cleaner] TEMP/TMP 重定向校验失败：${state.redirect.reason}；已恢复原值，不弄坏宿主`);
      }
    } catch (error) {
      restoreEnv('TMP', previous.TMP);
      restoreEnv('TEMP', previous.TEMP);
      state.redirect.reason = error?.message || String(error);
      log.warn(`[cache-cleaner] TEMP/TMP 重定向异常：${state.redirect.reason}；已恢复原值`);
    }
  } else {
    state.redirect.reason = 'redirectTemp=false';
  }

  // --- 4. 日志打印实际生效的缓存根（A8 要能在日志里看到） ------------------
  log.info(
    `[cache-cleaner] 缓存根: ${cfg.cacheRoot}；临时根: ${tempRoot}；TEMP/TMP 重定向: ${
      state.redirect.applied ? '已生效' : `未生效（${state.redirect.reason || '未配置'}）`
    }；原临时根: ${originalTemp || '(未知)'}；自动清理: ${cfg.autoClean ? `开（mode=${cfg.mode}）` : '关'}`,
  );

  // --- 5. 工具 -------------------------------------------------------------
  const cleanupOptions = () => ({ ...cfg, legacyTempDir: originalTemp });

  // v2：会话归属与已归档会话删除所需的宿主上下文
  const dshHome = dshHomePath();
  const conversationReportDir = path.join(cfg.cacheRoot, 'reports');
  const conversationReportPath = (kind) =>
    path.join(conversationReportDir, `conversation-${reportStamp()}-${kind}.json`);
  const legacyTempRoots = () => {
    const roots = [originalTemp];
    for (const extra of Array.isArray(cfg.legacyTempDirs) ? cfg.legacyTempDirs : []) roots.push(extra);
    return roots.filter(
      (root, index) => typeof root === 'string' && root !== '' && roots.indexOf(root) === index,
    );
  };

  // v3：工作区目录治理（DESIGN-v3）。围栏/根清单来自 config，扫描与删除全在 lib/workspace.mjs。
  const workspaceReportPath = (kind) =>
    path.join(cfg.cacheRoot, 'reports', `workspace-${reportStamp()}-${kind}.json`);
  // v5：系统缓存报告（与 workspace 一样落在 <cacheRoot>/reports，便于事后核对）。
  const systemReportPath = (kind) =>
    path.join(cfg.cacheRoot, 'reports', `system-${reportStamp()}-${kind}.json`);
  const workspaceNormalized = (now = Date.now()) =>
    normalizeWorkspaceRoots(
      {
        cacheRoot: cfg.cacheRoot,
        retainDays: cfg.retainDays,
        workspaceBases: cfg.workspaceBases,
        workspaceRoots: cfg.workspaceRoots,
        manageArchives: cfg.manageArchives,
      },
      { now, dshHome },
    );

  /** 只读元信息：不碰文件系统，设置页首屏用它立即出界面。 */
  function buildStatusMeta() {
    return {
      schema: 'dsh-cache-cleaner/status/v1',
      generatedAt: new Date().toISOString(),
      plugin: { name, version: PLUGIN_VERSION },
      cacheRoot: cfg.cacheRoot,
      tempRoot,
      originalTemp,
      effectiveTmpdir: safeTmpdir(),
      redirect: {
        configured: cfg.redirectTemp,
        applied: state.redirect.applied,
        reason: state.redirect.reason,
        env: { TMP: process.env.TMP ?? null, TEMP: process.env.TEMP ?? null },
      },
      config: {
        mode: cfg.mode,
        autoClean: cfg.autoClean,
        autoCleanLegacy: cfg.autoCleanLegacy,
        startupDelaySeconds: cfg.startupDelaySeconds,
        intervalHours: cfg.intervalHours,
        idleQuietMinutes: cfg.idleQuietMinutes,
        retainDays: cfg.retainDays,
        quotaBytes: cfg.quotaBytes,
      },
      lastReport: state.lastReport,
      timers: {
        startupDelaySeconds: cfg.startupDelaySeconds,
        intervalHours: cfg.intervalHours,
        intervalArmed: intervalTimer !== null,
        idlePending: idleTimer !== null,
      },
    };
  }

  /** 目录测量（昂贵）：缓存根 + 临时根 + legacy 目录。 */
  async function measureStatusRoots() {
    const deadline = Date.now() + STATUS_BUDGET_MS;
    const cacheRootSize = await measureTree(cfg.cacheRoot, deadline);
    const tempRootSize = await measureTree(tempRoot, deadline);
    const legacyDirs = await listLegacyDirs(originalTemp);
    const legacySizes = [];
    for (const dir of legacyDirs.slice(0, 64)) {
      if (Date.now() > deadline) {
        legacySizes.push({ path: dir, exists: true, measured: false, error: 'TIME_BUDGET_EXCEEDED' });
        continue;
      }
      legacySizes.push(await measureTree(dir, deadline));
    }
    const legacyTotal = legacySizes.reduce((sum, row) => sum + (Number.isFinite(row.bytes) ? row.bytes : 0), 0);
    return {
      cacheRootBytes: cacheRootSize.bytes,
      cacheRoot: cacheRootSize,
      tempRootBytes: tempRootSize.bytes,
      tempRoot: tempRootSize,
      legacy: {
        path: originalTemp || null,
        dirCount: legacyDirs.length,
        measuredCount: legacySizes.length,
        bytes: legacyTotal,
        complete: legacySizes.every((row) => row.measured !== false && row.complete !== false),
        dirs: legacySizes,
      },
    };
  }

  async function buildStatus({ cached = false } = {}) {
    const status = buildStatusMeta();
    status.roots = cached ? (await cachedSection('sizes', measureStatusRoots)).value : await measureStatusRoots();
    return status;
  }

  // v0.4.4：status 分段缓存。设置页重复打开/刷新时，不必每次重扫 3.7GB 缓存根与 47 个会话日志。
  const SECTION_CACHE_TTL_MS = 15_000;
  const sectionCache = new Map();
  const cachedSection = async (key, loader) => {
    const hit = sectionCache.get(key);
    if (hit && Date.now() - hit.at < SECTION_CACHE_TTL_MS) {
      return { value: hit.value, cached: true };
    }
    const value = await loader();
    sectionCache.set(key, { at: Date.now(), value });
    return { value, cached: false };
  };
  const invalidateSections = () => sectionCache.clear();

  // --- 5. 动作层：工具与设置页 API 共用同一组实现（DESIGN-v4 §2.2） --------
  // 工具把返回值格式化成文本；HTTP 把同一份数据装进 {ok,data} 信封。两条入口不各写一套逻辑。
  const prettyJson = (value) => JSON.stringify(value, null, 2);
  const compactJson = (value) => JSON.stringify(value);

  async function runStatus() {
    try {
      return { ok: true, data: await buildStatus() };
    } catch (error) {
      return { ok: false, error: { code: 'STATUS_FAILED', message: error?.message || String(error) } };
    }
  }

  async function runClean(input) {
    const unknown = Object.keys(input).filter((key) => !CLEAN_KEYS.includes(key));
    if (unknown.length > 0) {
      return { ok: false, error: { code: 'UNKNOWN_PARAMETER', details: { unknown } } };
    }
    const apply = input.apply === true;
    const includeLegacy = input.includeLegacy === true;
    const mode = MODES.has(input.mode) ? input.mode : cfg.mode;
    try {
      const report = await serialized(() => cleanup({ ...cleanupOptions(), apply, includeLegacy, mode }));
      state.lastReport = summarizeReport(report);
      if (apply) invalidateSections();
      const totals = report?.totals ?? {};
      log.info(
        `[cache-cleaner] 手动清理（apply=${apply}，mode=${mode}）完成：候选 ${totals.candidateFiles ?? 0} 文件，` +
          `回收 ${formatBytes(totals.deletedBytes ?? 0)} / ${totals.deletedFiles ?? 0} 文件，跳过 ${totals.skippedFiles ?? 0}`,
      );
      return { ok: true, data: presentReport(report) };
    } catch (error) {
      return { ok: false, error: { code: 'CLEAN_FAILED', message: error?.message || String(error) } };
    }
  }

  async function runOwnership(input) {
    const unknown = Object.keys(input).filter((key) => !OWNERSHIP_KEYS.includes(key));
    if (unknown.length > 0) {
      return { ok: false, error: { code: 'UNKNOWN_PARAMETER', details: { unknown } } };
    }
    try {
      const cacheRoots =
        typeof input.root === 'string' && input.root
          ? [path.resolve(input.root)]
          : [cacheTempRoot(cfg)];
      const legacyRoots = input.includeLegacy === true ? legacyTempRoots() : [];
      let report = await ownershipReport({ dshHome, cacheRoots, legacyRoots });
      if (typeof input.sessionId === 'string' && input.sessionId) {
        const sessionId = input.sessionId;
        const dirs = report.dirs.filter((dir) =>
          (dir.candidates ?? []).some((candidate) => candidate.sessionId === sessionId),
        );
        const bySession = report.bySession.filter((item) => item.sessionId === sessionId);
        const dirBytes = dirs.reduce((sum, dir) => sum + dir.sizeBytes, 0);
        const unattributedBytes = dirs
          .filter((dir) => dir.confidence === 'unattributed')
          .reduce((sum, dir) => sum + dir.sizeBytes, 0);
        report = { ...report, dirs, bySession, totals: { dirs: dirs.length, dirBytes, unattributedBytes } };
      }
      if (input.json === true) {
        return { ok: true, data: prettyJson({ ...report, warnings: report.warnings ?? [] }) };
      }
      const text = renderOwnership(report, input.sessionId);
      const warnings = report.warnings ?? [];
      const data = warnings.length > 0 ? `${text}\n\n警告：${warnings.slice(0, 10).join('；')}` : text;
      return { ok: true, data };
    } catch (error) {
      return { ok: false, error: { code: 'OWNERSHIP_FAILED', message: error?.message || String(error) } };
    }
  }

  async function runConversationList(input) {
    const unknown = Object.keys(input).filter((key) => !CONVERSATION_LIST_KEYS.includes(key));
    if (unknown.length > 0) {
      return { ok: false, error: { code: 'UNKNOWN_PARAMETER', details: { unknown } } };
    }
    try {
      const result = await listConversations({ dshHome });
      const data =
        input.includeAll === true
          ? { archived: result.archived, all: result.all, warnings: result.warnings }
          : { archived: result.archived, warnings: result.warnings };
      return { ok: true, data };
    } catch (error) {
      return { ok: false, error: { code: 'CONVERSATION_LIST_FAILED', message: error?.message || String(error) } };
    }
  }

  async function runConversationDelete(input) {
    const unknown = Object.keys(input).filter((key) => !CONVERSATION_DELETE_KEYS.includes(key));
    if (unknown.length > 0) {
      return { ok: false, error: { code: 'UNKNOWN_PARAMETER', details: { unknown } } };
    }
    const hasIds = Array.isArray(input.sessionIds);
    const allArchived = input.allArchived === true;
    if (hasIds === allArchived) {
      return {
        ok: false,
        error: { code: 'INVALID_ARGUMENT', message: 'sessionIds 与 allArchived:true 必须二选一' },
      };
    }
    const includeArtifacts = input.includeArtifacts === true;
    const includeTempDirs = input.includeTempDirs === true;
    if (includeTempDirs && !includeArtifacts) {
      return {
        ok: false,
        error: { code: 'INVALID_ARGUMENT', message: 'includeTempDirs:true 需要同时 includeArtifacts:true' },
      };
    }
    const apply = input.apply === true;
    if (apply && input.confirm !== true) {
      return {
        ok: false,
        error: {
          code: 'CONFIRM_REQUIRED',
          message: 'apply:true 必须同时 confirm:true（删除不可撤销，请先 dry-run 看计划）',
        },
      };
    }
    try {
      const plan = await planConversationDeletion({
        dshHome,
        sessionIds: hasIds ? input.sessionIds.filter((id) => typeof id === 'string' && id) : null,
        allArchived,
        includeArtifacts,
        includeTempDirs,
        cascade: input.cascade !== false,
        legacyTempDir: originalTemp,
        legacyTempDirs: Array.isArray(cfg.legacyTempDirs) ? cfg.legacyTempDirs : [],
        cacheTempDir: tempRoot,
        isLive: (sessionId) => hasLiveSession(ctx, sessionId),
      });
      const summary = presentPlan(plan);
      if (!apply) {
        const dry = await applyConversationDeletion(plan, {
          registry: null,
          dryRun: true,
          reportPath: conversationReportPath('plan'),
          dshHome,
        });
        log.info(
          `[cache-cleaner] conversation_delete 计划：${summary.targets.length} 个会话，` +
            `合计 ${formatBytes(summary.totals?.totalBytes ?? 0)}，报告 ${dry.reportPath ?? '(未写)'}`,
        );
        return {
          ok: true,
          data: { ok: true, apply: false, reportPath: dry.reportPath, plan: summary, warnings: dry.warnings },
        };
      }
      const registry = createRegistryAdapter(ctx, log);
      const result = await applyConversationDeletion(plan, {
        registry,
        reportPath: conversationReportPath('apply'),
        dshHome,
      });
      log.info(
        `[cache-cleaner] conversation_delete 完成：删除 ${result.deleted.sessions} 个会话 / ` +
          `${formatBytes(result.deleted.bytes)}，报告 ${result.reportPath ?? '(未写)'}`,
      );
      return { ok: true, data: { apply: true, ...result, plan: summary } };
    } catch (error) {
      return { ok: false, error: { code: 'CONVERSATION_DELETE_FAILED', message: error?.message || String(error) } };
    }
  }

  async function runWorkspaceStatus(input) {
    const unknown = Object.keys(input).filter((key) => !WORKSPACE_STATUS_KEYS.includes(key));
    if (unknown.length > 0) {
      return { ok: false, error: { code: 'UNKNOWN_PARAMETER', details: { unknown } } };
    }
    try {
      const now = Date.now();
      const normalized = workspaceNormalized(now);
      let roots = normalized.roots;
      if (typeof input.root === 'string' && input.root.trim() !== '') {
        const wanted = path.resolve(input.root.trim());
        roots = roots.filter((root) => samePath(root.path, wanted));
        if (roots.length === 0) {
          return {
            ok: false,
            error: {
              code: 'WORKSPACE_ROOT_INVALID',
              details: { path: wanted, errors: normalized.errors },
            },
          };
        }
      }
      const scans = [];
      for (const root of roots) scans.push(await scanWorkspaceRoot(root, { now }));
      const presented = scans.map(presentWorkspaceScan);
      const totals = {
        roots: presented.length,
        existing: presented.filter((root) => root.exists).length,
        bytes: presented.reduce((sum, root) => sum + root.bytes, 0),
        files: presented.reduce((sum, root) => sum + root.files, 0),
        dirs: presented.reduce((sum, root) => sum + root.dirs, 0),
        staleBytes: presented.reduce((sum, root) => sum + root.staleBytes, 0),
        staleEntries: presented.reduce((sum, root) => sum + root.staleCount, 0),
      };
      return {
        ok: true,
        data: {
          schema: WORKSPACE_STATUS_SCHEMA,
          generatedAt: new Date(now).toISOString(),
          plugin: { name, version: PLUGIN_VERSION },
          manageArchives: cfg.manageArchives,
          bases: normalized.bases,
          roots: presented,
          totals,
          errors: normalized.errors,
        },
      };
    } catch (error) {
      return { ok: false, error: { code: 'WORKSPACE_STATUS_FAILED', message: error?.message || String(error) } };
    }
  }

  async function runWorkspaceClean(input) {
    const unknown = Object.keys(input).filter((key) => !WORKSPACE_CLEAN_KEYS.includes(key));
    if (unknown.length > 0) {
      return { ok: false, error: { code: 'UNKNOWN_PARAMETER', details: { unknown } } };
    }
    const apply = input.apply === true;
    const confirm = input.confirm === true;
    if (apply && !confirm) {
      return {
        ok: false,
        error: {
          code: 'CONFIRM_REQUIRED',
          message: 'apply:true 必须同时 confirm:true（删除不可撤销，请先 dry-run 看计划）',
        },
      };
    }
    try {
      const now = Date.now();
      const normalized = workspaceNormalized(now);
      let roots = normalized.roots;
      if (typeof input.root === 'string' && input.root.trim() !== '') {
        const wanted = path.resolve(input.root.trim());
        roots = roots.filter((root) => samePath(root.path, wanted));
        if (roots.length === 0) {
          return {
            ok: false,
            error: {
              code: 'WORKSPACE_ROOT_INVALID',
              details: { path: wanted, errors: normalized.errors },
            },
          };
        }
      }
      if (roots.length === 0) {
        return { ok: false, error: { code: 'WORKSPACE_ROOT_INVALID', details: { errors: normalized.errors } } };
      }
      const includeArchives = input.includeArchives === true;
      const plan = await serialized(() =>
        planWorkspaceCleanup(roots, { now, includeArchives, manageArchives: cfg.manageArchives }),
      );
      const result = await applyWorkspaceCleanup(plan, {
        apply,
        confirm,
        reportPath: workspaceReportPath(apply ? 'apply' : 'dryrun'),
        cacheRoot: cfg.cacheRoot,
      });
      log.info(
        `[cache-cleaner] workspace_clean（apply=${apply}）：候选 ${plan.totals?.entries ?? 0} 项 / ` +
          `${formatBytes(plan.totals?.bytes ?? 0)}，删除 ${result.deleted.entries} 项 / ` +
          `${formatBytes(result.deleted.bytes)}，跳过 ${result.skipped.length}，拒绝 ${result.refusals.length}，` +
          `报告 ${result.reportPath ?? '(未写)'}`,
      );
      return { ok: true, data: result };
    } catch (error) {
      return { ok: false, error: { code: 'WORKSPACE_CLEAN_FAILED', message: error?.message || String(error) } };
    }
  }

  // --- v5：系统缓存（只手动触发；默认 dry-run） ----------------------------
  function systemScanOptions() {
    return {
      dshHome,
      cacheRoot: cfg.cacheRoot,
      systemCacheEnabled: cfg.systemCacheEnabled,
      systemCacheIds: cfg.systemCacheIds,
      systemCacheRetainDays: cfg.systemCacheRetainDays,
      systemCacheEmptyDirHours: cfg.systemCacheEmptyDirHours,
      allowUpdaterCleanup: cfg.allowUpdaterCleanup,
    };
  }

  function writeSystemReport(kind, payload) {
    try {
      fs.mkdirSync(path.join(cfg.cacheRoot, 'reports'), { recursive: true });
      const reportPath = systemReportPath(kind);
      fs.writeFileSync(reportPath, `${JSON.stringify(payload, null, 2)}\n`);
      return reportPath;
    } catch {
      return null;
    }
  }

  async function runSystemStatus(input) {
    const unknown = Object.keys(input ?? {}).filter((key) => !SYSTEM_STATUS_KEYS.includes(key));
    if (unknown.length > 0) {
      return { ok: false, error: { code: 'UNKNOWN_PARAMETER', details: { unknown } } };
    }
    try {
      return { ok: true, data: await scanSystemCaches(systemScanOptions()) };
    } catch (error) {
      return { ok: false, error: { code: 'SYSTEM_STATUS_FAILED', message: error?.message || String(error) } };
    }
  }

  async function runSystemClean(input) {
    const unknown = Object.keys(input ?? {}).filter((key) => !SYSTEM_CLEAN_KEYS.includes(key));
    if (unknown.length > 0) {
      return { ok: false, error: { code: 'UNKNOWN_PARAMETER', details: { unknown } } };
    }
    const apply = input.apply === true;
    if (apply && input.confirm !== true) {
      return {
        ok: false,
        error: {
          code: 'CONFIRM_REQUIRED',
          message: 'apply:true 必须同时 confirm:true（系统缓存删除不可撤销，请先 dry-run 看计划）',
        },
      };
    }
    let ids = null;
    if (input.ids !== undefined) {
      if (!Array.isArray(input.ids) || input.ids.length === 0) {
        return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'ids 必须是非空数组' } };
      }
      const invalid = input.ids.filter((id) => typeof id !== 'string' || !SYSTEM_CACHE_IDS.includes(id));
      if (invalid.length > 0) {
        return { ok: false, error: { code: 'UNKNOWN_PARAMETER', details: { invalid } } };
      }
      ids = [...new Set(input.ids)];
    }
    try {
      const status = await scanSystemCaches(systemScanOptions());
      let plan = planSystemCleanup(status, { ids });
      plan = { ...plan, write: false };
      const applyResult = await serialized(() =>
        applySystemCleanup(plan, {
          apply,
          confirm: true,
          dshHome,
          cacheRoot: cfg.cacheRoot,
          env: process.env,
        }),
      );
      const reportPath = writeSystemReport(apply ? 'apply' : 'dryrun', {
        ...applyResult,
        plan,
        dryRun: !apply,
        generatedAt: new Date().toISOString(),
      });
      if (apply) invalidateSections();
      log.info(
        `[cache-cleaner] system_clean（apply=${apply}）：候选 ${plan.totals?.files ?? 0} 文件 / ` +
          `${formatBytes(plan.totals?.bytes ?? 0)}，删除 ${applyResult.deleted.files} 文件 / ` +
          `${formatBytes(applyResult.deleted.bytes)}，跳过 ${applyResult.skipped.length}，报告 ${reportPath ?? '(未写)'}`,
      );
      return {
        ok: true,
        data: {
          applied: applyResult.applied,
          deleted: applyResult.deleted,
          skipped: applyResult.skipped,
          plan,
          reportPath,
          status: apply ? undefined : status,
        },
      };
    } catch (error) {
      return { ok: false, error: { code: 'SYSTEM_CLEAN_FAILED', message: error?.message || String(error) } };
    }
  }

  // --- 5.1 设置页（Client 半）用的 HTTP API（DESIGN-v4 §2） -----------------
  function currentOptions() {
    return {
      mode: cfg.mode,
      retainDays: cfg.retainDays,
      quotaBytes: cfg.quotaBytes,
      autoClean: cfg.autoClean,
      autoCleanLegacy: cfg.autoCleanLegacy,
      manageArchives: cfg.manageArchives,
      systemCacheEnabled: cfg.systemCacheEnabled,
      allowUpdaterCleanup: cfg.allowUpdaterCleanup,
      startupDelaySeconds: cfg.startupDelaySeconds,
      intervalHours: cfg.intervalHours,
      idleQuietMinutes: cfg.idleQuietMinutes,
    };
  }

  function resolveConfigEditor() {
    if (typeof ctx.get === 'function') {
      try {
        const service = ctx.get('configEditor');
        if (service) return service;
      } catch {
        /* 服务未注册按缺失处理 */
      }
    }
    return ctx.configEditor ?? null;
  }

  const saveOptions = createOptionsSaver({ resolveEditor: resolveConfigEditor, pluginId: name, log });

  function apiErrorOf(error) {
    return new ApiError(error.code, error.message, error.details);
  }

  /**
   * 设置页的 status：按 `sections` 分段返回，并给出每段耗时。
   * 缺省（sections 未传）= 全部四段，保持 v4.3 之前的调用契约不变。
   * 首屏只请求 meta（毫秒级），sizes/workspace/conversations 由客户端随后补拉。
   */
  async function buildStatusForApi(params = {}) {
    const started = Date.now();
    const requested = Array.isArray(params.sections) ? params.sections : null;
    const wanted = new Set(requested ?? ['meta', 'sizes', 'workspace', 'conversations', 'system']);
    const timings = { meta: 0 };
    const status = buildStatusMeta();
    status.complete = false;
    const data = { status, options: currentOptions(), sections: [...wanted], timings };

    if (wanted.has('sizes')) {
      const at = Date.now();
      try {
        const measured = await cachedSection('sizes', measureStatusRoots);
        status.roots = measured.value;
        status.complete = true;
        timings.sizes = Date.now() - at;
        timings.sizesCached = measured.cached;
      } catch (error) {
        status.rootsError = { code: 'SIZES_FAILED', message: error?.message || String(error) };
        timings.sizes = Date.now() - at;
      }
    }
    if (wanted.has('workspace')) {
      const at = Date.now();
      try {
        const scanned = await cachedSection('workspace', () => runWorkspaceStatus({}));
        const result = scanned.value;
        data.workspace = result.ok ? result.data : { error: result.error };
        timings.workspace = Date.now() - at;
        timings.workspaceCached = scanned.cached;
      } catch (error) {
        data.workspace = { error: { code: 'WORKSPACE_STATUS_FAILED', message: error?.message || String(error) } };
        timings.workspace = Date.now() - at;
      }
    }
    if (wanted.has('conversations')) {
      const at = Date.now();
      try {
        const listed = await cachedSection('conversations', () => listConversations({ dshHome }));
        const value = listed.value;
        data.conversations = { archived: value.archived, all: value.all, warnings: value.warnings ?? [] };
        timings.conversations = Date.now() - at;
        timings.conversationsCached = listed.cached;
      } catch (error) {
        data.conversations = { error: { code: 'CONVERSATION_LIST_FAILED', message: error?.message || String(error) } };
        timings.conversations = Date.now() - at;
      }
    }
    if (wanted.has('system')) {
      const at = Date.now();
      try {
        const scanned = await cachedSection('system', () => scanSystemCaches(systemScanOptions()));
        const value = scanned.value;
        data.system = {
          enabled: value.enabled,
          entries: value.entries,
          protected: value.protected,
          totals: value.totals,
          installedVersion: value.installedVersion,
          retainDays: value.retainDays,
          allowUpdaterCleanup: value.allowUpdaterCleanup,
          errors: value.errors,
        };
        timings.system = Date.now() - at;
        timings.systemCached = scanned.cached;
      } catch (error) {
        data.system = { error: { code: 'SYSTEM_STATUS_FAILED', message: error?.message || String(error) } };
        timings.system = Date.now() - at;
      }
    }
    timings.total = Date.now() - started;
    return data;
  }
  const api = createClientApi({
    actions: {
      status: buildStatusForApi,
      clean: async (params) => {
        // 协议层允许 confirm（用于 apply 前置校验）；工具契约的 CLEAN_KEYS 仍只有 3 个参数。
        const { confirm: _confirm, ...rest } = params || {};
        const result = await runClean(rest);
        if (!result.ok) throw apiErrorOf(result.error);
        if (rest.apply === true) invalidateSections();
        return result.data;
      },
      workspaceClean: async (params) => {
        const result = await runWorkspaceClean(params);
        if (!result.ok) throw apiErrorOf(result.error);
        if (params && params.apply === true) invalidateSections();
        return result.data;
      },
      conversations: async (params) => {
        const result = await runConversationList(params);
        if (!result.ok) throw apiErrorOf(result.error);
        return result.data;
      },
      conversationDelete: async (params) => {
        const result = await runConversationDelete(params);
        if (!result.ok) throw apiErrorOf(result.error);
        if (params && params.apply === true) invalidateSections();
        return result.data;
      },
      systemStatus: async (params) => {
        const result = await runSystemStatus(params ?? {});
        if (!result.ok) throw apiErrorOf(result.error);
        return result.data;
      },
      systemClean: async (params) => {
        const result = await runSystemClean(params ?? {});
        if (!result.ok) throw apiErrorOf(result.error);
        if (params && params.apply === true) invalidateSections();
        return result.data;
      },
    },
    saveOptions,
    getConfig: currentOptions,
    log,
  });

  /**
   * 把一个「清理函数」挂到本插件 fiber 的 effect 上。
   * 注意：Cordis 的 ctx.effect(fn) 会**立即执行** fn，并把 fn 的返回值当作 dispose 回调。
   * 所以这里必须返回 disposer 本身，绝不能写成 `() => disposer()`——那会在挂载瞬间就把路由注销掉。
   */
  function trackEffect(disposer, label) {
    if (typeof disposer !== 'function') return;
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => disposer, label);
    }
  }

  /** 可选宿主服务：用 ctx.get 取，未注入/不可用时返回 undefined（不把 connection/webServer 放进 inject）。 */
  function serviceOf(serviceName) {
    try {
      if (typeof ctx.get === 'function') {
        const service = ctx.get(serviceName);
        if (service) return service;
      }
    } catch {
      // 未 inject 的服务在 cordis 里可能不可访问；按「可选服务」处理。
    }
    return undefined;
  }

  // v4.2：apply 时机不确定——整机冷启动时 connection 服务通常还没就绪，而 webServer 已就绪。
  // 实测 webServer 的 exact 路由对 POST 返回 405，用它回退只会把「未挂载」伪装成「405」。
  // 因此只走官方载体 connection.fetch（/api 精确 Fetch 路由，认证/Origin 由宿主围栏负责）：
  //   - 拿不到 connection 就不挂，交给 ctx.inject(['connection']) + 短定时器等待；
  //   - 每 500ms 重试一次，最多 120 次（60s），就绪即挂载并停止；
  //   - 每次尝试结果写 <cacheRoot>\.dsh-cache-cleaner-api.json，供重启后免日志定位。
  const API_RETRY_LIMIT = 120;
  const API_RETRY_INTERVAL_MS = 500;
  const apiRouteState = {
    mode: null,
    path: null,
    attempts: 0,
    lastError: null,
    retryTimer: null,
    retryEffectRegistered: false,
  };

  function apiDiagPath() {
    return path.join(cfg.cacheRoot, '.dsh-cache-cleaner-api.json');
  }

  function writeApiDiag(note) {
    try {
      fs.mkdirSync(cfg.cacheRoot, { recursive: true });
      const record = {
        schema: 'dsh-cache-cleaner/api-route/v1',
        pluginVersion: PLUGIN_VERSION,
        mode: apiRouteState.mode,
        path: apiRouteState.path,
        attempts: apiRouteState.attempts,
        lastError: apiRouteState.lastError,
        note: note ?? null,
        services: {
          connection: Boolean(serviceOf('connection')),
          webServer: Boolean(serviceOf('webServer')),
        },
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(apiDiagPath(), `${JSON.stringify(record, null, 2)}\n`);
    } catch {
      /* 诊断写盘失败不影响功能 */
    }
  }

  /** 尝试挂载一次；成功后记录状态并停止重试。返回 'fetch' | null。 */
  function tryMountApiRoute() {
    if (apiRouteState.mode) return apiRouteState.mode;
    apiRouteState.attempts += 1;
    const label = 'dsh-cache-cleaner: api route';
    const connection = serviceOf('connection');
    const fetchRegister = connection?.fetch?.register;
    if (typeof fetchRegister !== 'function') {
      apiRouteState.lastError = 'connection.fetch.register 不可用（connection 服务尚未就绪）';
      // 每次尝试都落盘（最多 120 次），便于重启后判断等待进度。
      writeApiDiag('waiting-connection');
      return null;
    }
    try {
      const dispose = fetchRegister.call(connection.fetch, api.route);
      trackEffect(dispose, label);
      apiRouteState.mode = 'fetch';
      apiRouteState.path = api.route.path;
      apiRouteState.lastError = null;
      log.info(`[cache-cleaner] 设置页 API 已注册：POST ${api.route.path}（connection.fetch，第 ${apiRouteState.attempts} 次尝试）`);
      writeApiDiag('mounted-connection-fetch');
      return 'fetch';
    } catch (error) {
      apiRouteState.lastError = `connection.fetch.register: ${error?.message || error}`;
      log.warn(`[cache-cleaner] 设置页 API 挂载失败（第 ${apiRouteState.attempts} 次）：${apiRouteState.lastError}`);
      writeApiDiag('mount-failed');
      return null;
    }
  }

  function scheduleApiRouteRetry() {
    if (apiRouteState.mode || apiRouteState.retryTimer) return;
    if (apiRouteState.attempts >= API_RETRY_LIMIT) {
      writeApiDiag('retry-exhausted');
      return;
    }
    if (!apiRouteState.retryEffectRegistered && typeof ctx.effect === 'function') {
      apiRouteState.retryEffectRegistered = true;
      ctx.effect(
        () => () => {
          if (apiRouteState.retryTimer) {
            clearTimeout(apiRouteState.retryTimer);
            apiRouteState.retryTimer = null;
          }
        },
        'dsh-cache-cleaner: api route retry timer',
      );
    }
    const timer = setTimeout(() => {
      apiRouteState.retryTimer = null;
      if (apiRouteState.mode) return;
      tryMountApiRoute();
      if (!apiRouteState.mode) scheduleApiRouteRetry();
    }, API_RETRY_INTERVAL_MS);
    if (typeof timer.unref === 'function') timer.unref();
    apiRouteState.retryTimer = timer;
  }

  /** 启动时挂载；connection 未就绪则交给 inject 回调 + 定时器等待。 */
  function mountApiRouteWithRetry() {
    const mode = tryMountApiRoute();
    if (mode) return mode;
    if (typeof ctx.inject === 'function') {
      try {
        ctx.inject(['connection'], () => {
          if (apiRouteState.mode) return;
          tryMountApiRoute();
          if (!apiRouteState.mode) scheduleApiRouteRetry();
        });
      } catch {
        /* 依赖服务缺失时 inject 不可用，交给定时器 */
      }
    }
    scheduleApiRouteRetry();
    return null;
  }

  const tools = ctx.tools;
  if (tools && typeof tools.register === 'function') {
    try {
      tools.register({
        name: 'cache_status',
        description: 'Show dsh-cache-cleaner status: cache root, temp root and legacy temp root; whether the TEMP/TMP redirect is active; size of each root; auto-clean settings and the last cleanup report. Read-only; deletes nothing.\n查看 dsh-cache-cleaner 状态：缓存根/临时根/原临时根路径、TEMP/TMP 重定向是否生效、各根占用大小、自动清理配置与最近一次清理报告。只读，不删除任何文件。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute() {
          const result = await runStatus();
          if (!result.ok) return compactJson({ error: result.error.code, message: result.error.message });
          return prettyJson(result.data);
        },
      });
    } catch (error) {
      log.warn(`[cache-cleaner] 注册 cache_status 失败：${error?.message || error}`);
    }

    try {
      tools.register({
        name: 'cache_clean',
        description: 'Clean the DSH temp cache by allowlist (tmp_obj_* git objects under dsh-workspace-changes session dirs), subject to the age gate and the quota gate. Dry-run by default (apply:false) — lists candidates without deleting; pass apply:true only when the user explicitly asks. Legacy dirs under the old %TEMP% are left alone unless includeLegacy:true.\n按白名单清理 DSH 临时缓存（dsh-workspace-changes 会话目录下的 tmp_obj_* 临时 git 对象），遵守天数闸门与配额闸门。默认 dry-run（apply:false）只列候选、不删文件；只有用户明确要求时才传 apply:true。legacy（旧 C 盘 %TEMP%）默认不清理，需显式 includeLegacy:true。',
        parameters: {
          type: 'object',
          properties: {
            apply: { type: 'boolean', description: 'true = actually delete; false (default) = dry-run, list candidates only. Irreversible — dry-run first.\ntrue = 真实删除；默认 false = 只 dry-run 列候选。不可撤销，务必先 dry-run。' },
            includeLegacy: { type: 'boolean', description: 'Also clean leftover dsh-workspace-changes-* dirs under the old %TEMP%; default false.\n是否同时清理旧位置 %TEMP% 下遗留的 dsh-workspace-changes-* 目录；默认 false。' },
            mode: { type: 'string', enum: ['safe', 'normal', 'aggressive'], description: 'Cleanup preset; defaults to the plugin\'s configured mode (normal = 14 days / 50 GiB).\n清理档位；默认用插件配置的 mode（normal = 14 天 / 50GiB）。' },
          },
          additionalProperties: false,
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args) {
          const result = await runClean(args && typeof args === 'object' ? args : {});
          if (result.ok) return prettyJson(result.data);
          if (result.error.code === 'UNKNOWN_PARAMETER') {
            return compactJson({ error: 'UNKNOWN_PARAMETER', unknown: result.error.details?.unknown ?? [] });
          }
          return compactJson({ error: result.error.code, message: result.error.message });
        },
      });
    } catch (error) {
      log.warn(`[cache-cleaner] 注册 cache_clean 失败：${error?.message || error}`);
    }

    // --- v2：cache_ownership ------------------------------------------------
    try {
      tools.register({
        name: 'cache_ownership',
        description: 'Attribute the current DSH temp cache (dsh-workspace-changes-* dirs under %TEMP% or <cacheRoot>\\temp): per-dir size, tmp_obj/captures/objects counts, active time window, and candidate sessions whose window overlaps. Read-only; deletes nothing. Note: these dirs carry no persisted ownership — candidates are inferred from a time window and labelled confidence: \"time-window\".\n查看当前 DSH 临时缓存（%TEMP% 或 <cacheRoot>\\temp 下的 dsh-workspace-changes-* 目录）的归属：每个目录的大小、tmp_obj/captures/objects 计数、活动时间窗，以及时间窗相交的候选会话。只读，不删除任何文件。注意：workspace-changes 目录没有持久化归属，候选会话是「时间窗推断」，不是精确归属。',
        parameters: {
          type: 'object',
          properties: {
            root: { type: 'string', description: 'Only inspect this cache root (defaults to the configured <cacheRoot>\\temp).\n只统计这个缓存根（默认用插件配置的 <cacheRoot>\\temp）。' },
            includeLegacy: { type: 'boolean', description: 'Include leftover dirs under the legacy temp root (old %TEMP%); default false.\n是否一并统计原临时根（旧 %TEMP%）下的遗留目录；默认 false。' },
            sessionId: { type: 'string', description: 'Show ownership for one session only.\n只显示某一个会话的归属。' },
            json: { type: 'boolean', description: 'true = return raw JSON; default returns human-readable text.\ntrue = 返回原始 JSON；默认返回人类可读文本。' },
          },
          additionalProperties: false,
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args) {
          const result = await runOwnership(args && typeof args === 'object' ? args : {});
          if (result.ok) return result.data;
          if (result.error.code === 'UNKNOWN_PARAMETER') {
            return compactJson({ error: 'UNKNOWN_PARAMETER', unknown: result.error.details?.unknown ?? [] });
          }
          return compactJson({ error: result.error.code, message: result.error.message });
        },
      });
    } catch (error) {
      log.warn(`[cache-cleaner] 注册 cache_ownership 失败：${error?.message || error}`);
    }

    // --- v2：conversation_list -----------------------------------------------
    try {
      tools.register({
        name: 'conversation_list',
        description: 'List archived DSH sessions: id, workspace, created time, log size, projection-cache size, subagent ids, ghost flag, and a snippet of the first user message. Read-only. includeAll:true also reports counts for all sessions.\n列出已归档（archive）的 DSH 会话：id、工作目录、创建时间、日志大小、投影缓存大小、子会话（subagent）id、ghost 标记、首条用户消息摘要。只读。includeAll:true 时同时给出全部会话计数。',
        parameters: {
          type: 'object',
          properties: {
            includeAll: { type: 'boolean', description: 'true = also report count and total size for all sessions (archived included); default lists archived only.\ntrue = 额外返回全部会话（含未归档）的计数与总大小；默认只列已归档。' },
          },
          additionalProperties: false,
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args) {
          const result = await runConversationList(args && typeof args === 'object' ? args : {});
          if (result.ok) return prettyJson(result.data);
          if (result.error.code === 'UNKNOWN_PARAMETER') {
            return compactJson({ error: 'UNKNOWN_PARAMETER', unknown: result.error.details?.unknown ?? [] });
          }
          return compactJson({ error: result.error.code, message: result.error.message });
        },
      });
    } catch (error) {
      log.warn(`[cache-cleaner] 注册 conversation_list 失败：${error?.message || error}`);
    }

    // --- v2：conversation_delete --------------------------------------------
    try {
      tools.register({
        name: 'conversation_delete',
        description: 'Delete archived DSH sessions (session logs only by default; includeArtifacts:true also removes attachment objects and the projection cache; includeTempDirs:true also removes temp snapshot dirs inferred by time window). Dry-run by default (apply:false) — plan only, no writes; apply:true requires confirm:true. Only archived, inactive sessions qualify; subagent sessions cascade by default (cascade:true).\n删除已归档的 DSH 会话（默认只删会话日志；includeArtifacts:true 连同附件对象与投影缓存一起删；includeTempDirs:true 再连同时间窗推断的临时快照目录）。默认 dry-run（apply:false）只返回计划、零写入；apply:true 必须同时 confirm:true。只允许删除已归档且不活跃的会话；级联删除子会话（cascade，默认 true）。',
        parameters: {
          type: 'object',
          properties: {
            sessionIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'Ids of archived sessions to delete; use either this or allArchived.\n要删除的已归档会话 id 列表；与 allArchived 二选一。',
            },
            allArchived: { type: 'boolean', description: 'Delete all archived sessions; use either this or sessionIds.\n删除全部已归档会话；与 sessionIds 二选一。' },
            includeArtifacts: { type: 'boolean', description: 'Also delete attachment objects (sha256 references) and the projection cache; default false keeps session logs only.\n是否连同附件对象（sha256 引用）与投影缓存一起删除；默认 false，只删会话日志。' },
            includeTempDirs: { type: 'boolean', description: 'Also delete dsh-workspace-changes-* temp dirs inferred by time window; requires includeArtifacts:true.\n是否连同时间窗推断出的 dsh-workspace-changes-* 临时目录一起删除；必须同时 includeArtifacts:true。' },
            cascade: { type: 'boolean', description: 'Also delete subagent sessions; default true.\n是否级联删除子会话（subagent）；默认 true。' },
            apply: { type: 'boolean', description: 'true = actually delete (confirm:true required); default false = return the plan only.\ntrue = 真实删除（需同时 confirm:true）；默认 false = 只返回计划。' },
            confirm: { type: 'boolean', description: 'Must be true when apply:true — the second confirmation.\napply:true 时必须为 true 的二次确认。' },
          },
          additionalProperties: false,
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args) {
          const result = await runConversationDelete(args && typeof args === 'object' ? args : {});
          if (result.ok) return prettyJson(result.data);
          if (result.error.code === 'UNKNOWN_PARAMETER') {
            return compactJson({ error: 'UNKNOWN_PARAMETER', unknown: result.error.details?.unknown ?? [] });
          }
          return compactJson({ error: result.error.code, message: result.error.message });
        },
      });
    } catch (error) {
      log.warn(`[cache-cleaner] 注册 conversation_delete 失败：${error?.message || error}`);
    }

    // --- v3：workspace_status（只读，W10） ----------------------------------
    try {
      tools.register({
        name: 'workspace_status',
        description: 'Read-only inventory of configured workspace roots (e.g. _tmp, _archive): existence, kind (temp/archive), size/files/dirs, retain days, whether auto-clean includes it, and stale candidates judged by the subtree\'s newest mtime (up to 50 per root). Creates nothing, writes no report, never changes mtime, deletes nothing.\n只读盘点配置的工作区目录（例如 buddy\\_tmp、_临时输出、_archive）：每个根是否存在、性质（temp/archive）、大小/文件/目录数、保留天数、是否参与自动清理，以及按「子树最新 mtime」判定的过期候选（每个根最多列 50 条）。不建目录、不写报告、不改 mtime、不删除任何文件。',
        parameters: {
          type: 'object',
          properties: {
            root: { type: 'string', description: 'Inspect only this root (must be one of the configured roots); default inspects all configured roots.\n只盘点这个根（必须是配置里的根之一）；默认盘点全部配置根。' },
          },
          additionalProperties: false,
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args) {
          const result = await runWorkspaceStatus(args && typeof args === 'object' ? args : {});
          if (result.ok) return prettyJson(result.data);
          if (result.error.code === 'UNKNOWN_PARAMETER') {
            return compactJson({ error: 'UNKNOWN_PARAMETER', unknown: result.error.details?.unknown ?? [] });
          }
          if (result.error.code === 'WORKSPACE_ROOT_INVALID') {
            return prettyJson({
              error: 'WORKSPACE_ROOT_INVALID',
              path: result.error.details?.path,
              errors: result.error.details?.errors,
            });
          }
          return compactJson({ error: result.error.code, message: result.error.message });
        },
      });
    } catch (error) {
      log.warn(`[cache-cleaner] 注册 workspace_status 失败：${error?.message || error}`);
    }

    // --- v3：workspace_clean（默认 dry-run；W4/W5） --------------------------
    try {
      tools.register({
        name: 'workspace_clean',
        description: 'Clean configured workspace temp/archive dirs: staleness is judged by the subtree\'s newest mtime plus each root\'s own retainDays, and only direct children strictly inside a configured root are removed (.git/.keep/KEEP/.dsh-cache-cleaner-keep are always kept). Dry-run by default (apply:false) — plan only, no writes; apply:true requires confirm:true. Archive roots are refused by default (ARCHIVE_DISABLED) and require both plugin config manageArchives:true and includeArchives:true on the call.\n清理配置的工作区临时/归档目录：按「子树最新 mtime + 每个根自己的 retainDays」判定过期，只删配置根严格内部的直接子项（.git/.keep/KEEP/.dsh-cache-cleaner-keep 永远保留）。默认 dry-run（apply:false）只返回计划、零写入；apply:true 必须同时 confirm:true。archive 根默认拒绝（ARCHIVE_DISABLED），需插件配置 manageArchives:true 且本次调用 includeArchives:true 才会进入计划。',
        parameters: {
          type: 'object',
          properties: {
            apply: { type: 'boolean', description: 'true = actually delete (confirm:true required); default false = return the plan only.\ntrue = 真实删除（需同时 confirm:true）；默认 false = 只返回计划。' },
            confirm: { type: 'boolean', description: 'Must be true when apply:true — the second confirmation.\napply:true 时必须为 true 的二次确认。' },
            includeArchives: { type: 'boolean', description: 'Include kind=archive roots (plugin config manageArchives:true is also required); default false.\n是否把 kind=archive 的根纳入（还需插件配置 manageArchives:true）；默认 false。' },
            root: { type: 'string', description: 'Clean only this root (must be one of the configured roots); default handles every cleanable configured root.\n只清理这个根（必须是配置里的根之一）；默认处理全部可清理的配置根。' },
          },
          additionalProperties: false,
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args) {
          const result = await runWorkspaceClean(args && typeof args === 'object' ? args : {});
          if (result.ok) return prettyJson(result.data);
          if (result.error.code === 'UNKNOWN_PARAMETER') {
            return compactJson({ error: 'UNKNOWN_PARAMETER', unknown: result.error.details?.unknown ?? [] });
          }
          if (result.error.code === 'WORKSPACE_ROOT_INVALID') {
            const details = result.error.details ?? {};
            if (details.path) {
              return prettyJson({ error: 'WORKSPACE_ROOT_INVALID', path: details.path, errors: details.errors });
            }
            return prettyJson({ error: 'WORKSPACE_ROOT_INVALID', errors: details.errors });
          }
          return compactJson({ error: result.error.code, message: result.error.message });
        },
      });
    } catch (error) {
      log.warn(`[cache-cleaner] 注册 workspace_clean 失败：${error?.message || error}`);
    }

    // --- v5：system_cache_status（只读） ------------------------------------
    try {
      tools.register({
        name: 'system_cache_status',
        description: 'Read-only inventory of known *regenerable* system caches: DSH updater packages, legacy updater dir, plugin update packages, ~/.dsh/cache, Electron caches, GPU shader caches, and empty dsh-* dirs under %TEMP%. Reports size, age-gated candidates, whether each entry is deletable, and the protected runtime/user-data dirs it will never touch. Deletes nothing.\\n只读盘点已知的「可再生系统缓存」：DSH 更新包、旧版更新器目录、插件更新包、~/.dsh/cache、Electron 缓存、GPU 着色器缓存、%TEMP% 下的 dsh-* 空目录。报告每项大小、按天数判定的候选、是否可删，以及永不触碰的运行时/用户数据目录。不删除任何文件。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute() {
          const result = await runSystemStatus({});
          if (result.ok) return prettyJson(result.data);
          return compactJson({ error: result.error.code, message: result.error.message });
        },
      });
    } catch (error) {
      log.warn(`[cache-cleaner] 注册 system_cache_status 失败：${error?.message || error}`);
    }

    // --- v5：system_cache_clean（默认 dry-run；apply 必须 confirm） ---------
    try {
      tools.register({
        name: 'system_cache_clean',
        description: 'Clean age-gated candidates from the known system caches (see system_cache_status). Dry-run by default (apply:false); apply:true requires confirm:true. Updater packages are only deleted when allowUpdaterCleanup:true in plugin config AND the pending package version <= the installed DSH version; otherwise they are reported and kept. Locked files are skipped, never forced.\\n清理已知系统缓存中按天数过期的候选（见 system_cache_status）。默认 dry-run（apply:false）；apply:true 必须同时 confirm:true。更新包只有在插件配置 allowUpdaterCleanup:true 且 pending 包版本 <= 已安装 DSH 版本时才会删；否则只报告、保留。被占用的文件跳过，不强制删除。',
        parameters: {
          type: 'object',
          properties: {
            apply: { type: 'boolean', description: 'true = actually delete (confirm:true required); default false = return the plan only.\\ntrue = 真实删除（需同时 confirm:true）；默认 false = 只返回计划。' },
            confirm: { type: 'boolean', description: 'Must be true when apply:true — the second confirmation.\\napply:true 时必须为 true 的二次确认。' },
            ids: {
              type: 'array',
              items: { type: 'string', enum: SYSTEM_CACHE_IDS },
              description: 'Only clean these catalog ids; default cleans every deletable entry.\\n只清理这些 catalog id；默认处理全部可删项。',
            },
          },
          additionalProperties: false,
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args) {
          const result = await runSystemClean(args && typeof args === 'object' ? args : {});
          if (result.ok) return prettyJson(result.data);
          if (result.error.code === 'UNKNOWN_PARAMETER') {
            return compactJson({ error: 'UNKNOWN_PARAMETER', details: result.error.details ?? {} });
          }
          return compactJson({ error: result.error.code, message: result.error.message });
        },
      });
    } catch (error) {
      log.warn(`[cache-cleaner] 注册 system_cache_clean 失败：${error?.message || error}`);
    }
  } else {
    log.warn('[cache-cleaner] tools 服务不可用，未注册 cache_*/conversation_*/workspace_* 工具');
  }

  // 路由注册在工具之后、定时器之前（DESIGN-v4 §2.2；v4.1 起带服务就绪重试）。
  const apiRouteMode = mountApiRouteWithRetry();

  // --- 6. 自动清理（启动延时 / 周期 / idle 静默 debounce） -----------------
  // v3：工作区目录自动清理只跑 kind=temp && auto:true 的根（DESIGN-v3 §5）。
  // archive 根永不自动删；先 plan（dry-run 语义）再 apply，报告由 apply 落盘。
  async function autoWorkspaceRun(reason) {
    const now = Date.now();
    const normalized = workspaceNormalized(now);
    const autoRoots = normalized.roots.filter((root) => root.auto === true && root.kind === 'temp');
    if (autoRoots.length === 0) return;
    const plan = await serialized(() =>
      planWorkspaceCleanup(autoRoots, { now, includeArchives: false, manageArchives: cfg.manageArchives }),
    );
    const result = await applyWorkspaceCleanup(plan, {
      apply: true,
      confirm: true,
      reportPath: workspaceReportPath('apply'),
      cacheRoot: cfg.cacheRoot,
    });
    log.info(
      `[cache-cleaner] workspace 清理(${reason})：候选 ${plan.totals?.entries ?? 0} 项 / ` +
        `${formatBytes(plan.totals?.bytes ?? 0)}，删除 ${result.deleted.entries} 项 / ` +
        `${formatBytes(result.deleted.bytes)}，跳过 ${result.skipped.length}，拒绝 ${result.refusals.length}，` +
        `报告 ${result.reportPath ?? '(未写)'}`,
    );
    for (const warning of result.warnings ?? []) log.warn(`[cache-cleaner] workspace 清理警告：${warning}`);
  }

  async function autoRun(reason) {
    if (state.disposed || !cfg.autoClean) return;
    try {
      const report = await serialized(() => cleanup({ ...cleanupOptions(), apply: true, includeLegacy: cfg.autoCleanLegacy }));
      state.lastReport = summarizeReport(report);
      const totals = report?.totals ?? {};
      log.info(
        `[cache-cleaner] 自动清理(${reason})完成：回收 ${formatBytes(totals.deletedBytes ?? 0)} / ${totals.deletedFiles ?? 0} 文件，` +
          `跳过 ${totals.skippedFiles ?? 0}，error=${report?.error ?? '无'}`,
      );
    } catch (error) {
      log.warn(`[cache-cleaner] 自动清理(${reason})失败：${error?.message || error}`);
    }
    try {
      if (!state.disposed && cfg.autoClean) await autoWorkspaceRun(reason);
    } catch (error) {
      log.warn(`[cache-cleaner] 工作区自动清理(${reason})失败：${error?.message || error}`);
    }
  }

  if (cfg.autoClean) {
    trackTimer(setTimeout(() => void autoRun('startup'), secondsToMs(cfg.startupDelaySeconds)));

    if (cfg.intervalHours > 0) {
      const intervalMs = Math.min(Math.round(cfg.intervalHours * 3600000), 2147483647);
      const tick = async () => {
        await autoRun('interval');
        if (!state.disposed && cfg.autoClean) intervalTimer = trackTimer(setTimeout(tick, intervalMs));
      };
      intervalTimer = trackTimer(setTimeout(tick, intervalMs));
    }
  }

  if (typeof ctx.on === 'function') {
    ctx.on('agent/status', (payload) => {
      if (state.disposed || !cfg.autoClean) return;
      const status = payload && typeof payload === 'object' ? payload.status : undefined;
      if (status !== 'idle') return;
      if (idleTimer) {
        clearTimeout(idleTimer);
        timers.delete(idleTimer);
      }
      idleTimer = trackTimer(
        setTimeout(() => {
          idleTimer = null;
          void autoRun('idle');
        }, secondsToMs(cfg.idleQuietMinutes * 60)),
      );
    });
  }

  // --- 7. 卸载：清掉所有定时器 -------------------------------------------------
  ctx.effect(
    () => () => {
      state.disposed = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (intervalTimer) clearTimeout(intervalTimer);
      for (const timer of timers) {
        clearTimeout(timer);
        clearInterval(timer);
      }
      timers.clear();
      idleTimer = null;
      intervalTimer = null;
    },
    'dsh-cache-cleaner: timers',
  );
}
