/**
 * dsh-cache-cleaner —— 系统缓存扫描/清理引擎（v5，0.6.0）。
 *
 * 目标：把 DSH 之外、但同样占 C 盘的「可再生缓存」纳入同一套扫描/清理流程，
 * 同时用显式规则拒绝一切运行时数据与用户数据。
 *
 * 安全口径（DESIGN-v5.md）：
 *  - 只认本文件里的 catalog（固定路径 + 固定策略），不接受外部传路径；
 *  - 只删 catalog 根「严格内部」的文件，不跟随符号链接/junction；
 *  - 默认 dry-run；apply 必须 confirm:true；
 *  - 更新包只有在「安装版本 == pending 包版本」时才允许删（否则保留）；
 *  - 缺省 allowUpdaterCleanup:false，即更新包只报告、不删除；
 *  - GPU/Electron/插件更新包按天数闸门（默认 7 天）；
 *  - %TEMP% 下只删「空目录」，且 mtime 超过 emptyDirMinAgeHours（默认 24h）。
 *
 * 零依赖：只用 node: 内置模块 + ./util.mjs。
 */
import fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DAY_MS, nowIso } from './util.mjs'

export const SYSTEM_STATUS_SCHEMA = 'dsh-cache-cleaner/system-status/v1'
export const SYSTEM_REPORT_SCHEMA = 'dsh-cache-cleaner/system-report/v1'

/** 默认保留天数（GPU/Electron/插件更新包）。 */
export const DEFAULT_SYSTEM_RETAIN_DAYS = 7

/** 默认：%TEMP% 空目录至少 24h 未动才回收，避免删掉刚创建、尚未写入的会话目录。 */
export const DEFAULT_EMPTY_DIR_MIN_AGE_HOURS = 24

/** 可治理的系统缓存 id（也是 CLI/API 的 ids 取值）。 */
export const SYSTEM_CACHE_IDS = [
  'updater-packages',
  'updater-legacy',
  'plugin-updates',
  'dsh-cache-dir',
  'electron-cache',
  'gpu-shader-cache',
  'temp-empty-dirs',
]

/** 永不删除、但状态里要显示的运行时/用户数据。 */
const PROTECTED_ROOTS = [
  { id: 'sessions', label: '会话数据', reason: '删除会丢会话；请用 conversation_delete' },
  { id: 'attachments', label: '附件对象', reason: '可能被保留会话引用' },
  { id: 'storages', label: '存储索引', reason: 'DSH 运行时状态' },
  { id: 'profiles', label: '插件/配置', reason: '删了 DSH 与插件都起不来' },
  { id: 'dsh-ops', label: 'dsh-ops 运行数据', reason: 'shell 历史/ACL 备份，只建议迁移' },
  { id: 'bili-duty', label: 'bili-duty 环境', reason: 'Python venv + ASR 模型，只建议迁移' },
  { id: 'dsh-runtimes', label: 'DSH 运行时', reason: '删了要重新下载' },
]

const MAX_WALK_NODES = 60000

function localAppData(env) {
  if (env.LOCALAPPDATA) return env.LOCALAPPDATA
  return path.join(os.homedir(), 'AppData', 'Local')
}

function appData(env) {
  if (env.APPDATA) return env.APPDATA
  return path.join(os.homedir(), 'AppData', 'Roaming')
}

function tempDir(env) {
  const raw = env.TEMP || env.TMP || os.tmpdir()
  return path.resolve(raw)
}

function lower(value) {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function samePath(a, b) {
  try {
    return lower(a) === lower(b)
  } catch {
    return false
  }
}

function parseVersion(text) {
  if (typeof text !== 'string') return null
  const match = text.match(/(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/)
  if (!match) return null
  return {
    raw: match[0],
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split('.') : [],
  }
}

function compareVersion(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left.parts[index] !== right.parts[index]) return left.parts[index] - right.parts[index]
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0
  if (left.pre.length === 0) return 1
  if (right.pre.length === 0) return -1
  const length = Math.max(left.pre.length, right.pre.length)
  for (let index = 0; index < length; index += 1) {
    const a = left.pre[index]
    const b = right.pre[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const na = Number(a)
    const nb = Number(b)
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb
    if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

/** 从 `deepseek-harness-0.2.2-rc.2-win-x64.exe` 这类文件名取版本。 */
function versionFromFileName(name) {
  return parseVersion(String(name).replace(/^deepseek-harness-/, ''))
}

/**
 * 读取已安装 DSH 的 FileVersion。Windows 上用 PowerShell 读 PE 版本资源；
 * 读不到时返回 null（调用方据此保留全部更新包）。
 */
export function readInstalledVersion(exePath = process.execPath) {
  if (process.platform !== 'win32' || typeof exePath !== 'string' || !exePath) return null
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Item -LiteralPath '${exePath.replace(/'/g, "''")}').VersionInfo.FileVersion`,
      ],
      { timeout: 6000, windowsHide: true, encoding: 'utf8' },
    ).trim()
    return out ? { raw: out, parsed: parseVersion(out) } : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// catalog
// ---------------------------------------------------------------------------

function buildCatalog({ env, dshHome }) {
  const local = localAppData(env)
  const roaming = appData(env)
  const temp = tempDir(env)
  return [
    {
      id: 'updater-packages',
      label: 'DSH 更新包（当前更新器）',
      kind: 'dsh',
      strategy: 'updater',
      paths: [path.join(local, '@deepseek-aidsh-desktop-updater')],
      note: '只删 pending 包版本 <= 已安装版本；installer-logs 按天数删',
    },
    {
      id: 'updater-legacy',
      label: 'DSH 旧版更新器目录',
      kind: 'dsh',
      strategy: 'updater-legacy',
      paths: [path.join(local, 'dsh-desktop-updater')],
      note: '旧版更新包；默认只报告',
    },
    {
      id: 'plugin-updates',
      label: 'DSH 插件更新包',
      kind: 'dsh',
      strategy: 'age',
      paths: [path.join(dshHome, 'plugin-updates')],
    },
    {
      id: 'dsh-cache-dir',
      label: 'DSH 缓存目录（~/.dsh/cache）',
      kind: 'dsh',
      strategy: 'age',
      paths: [path.join(dshHome, 'cache')],
    },
    {
      id: 'electron-cache',
      label: 'DSH Electron 缓存',
      kind: 'electron',
      strategy: 'age',
      paths: [
        path.join(roaming, 'dsh-desktop', 'Cache'),
        path.join(roaming, 'dsh-desktop', 'Code Cache'),
        path.join(roaming, 'dsh-desktop', 'GPUCache'),
        path.join(roaming, 'dsh-desktop', 'DawnGraphiteCache'),
        path.join(roaming, 'dsh-desktop', 'DawnWebGPUCache'),
        path.join(roaming, 'dsh-desktop', 'http-cache-origin'),
      ],
      note: 'Electron 会自动重建；被占用文件跳过',
    },
    {
      id: 'gpu-shader-cache',
      label: 'GPU 着色器缓存',
      kind: 'os',
      strategy: 'age',
      paths: [
        path.join(local, 'D3DSCache'),
        path.join(local, 'NVIDIA', 'DXCache'),
      ],
      note: '非 DSH 数据，可自动重建；被驱动占用文件跳过',
    },
    {
      id: 'temp-empty-dirs',
      label: '%TEMP% 下 DSH 空目录',
      kind: 'dsh',
      strategy: 'empty-dirs',
      paths: [temp],
      pattern: /^dsh[-_]/,
      note: '只删空目录；mtime 超门槛才动',
    },
  ]
}

function protectedEntries({ env, dshHome, cacheRoot }) {
  const roaming = appData(env)
  const rows = PROTECTED_ROOTS.map((item) => ({
    ...item,
    path: path.join(dshHome, item.id),
  }))
  rows.push(
    { id: 'harness', label: 'DSH 代码代际', path: path.join(roaming, 'dsh-desktop', 'harness'), reason: '删了 DSH 起不来' },
    { id: 'credentials', label: '凭据', path: path.join(dshHome, '.credentials.yaml'), reason: '登录态' },
    { id: 'cache-root', label: '插件缓存根', path: cacheRoot, reason: '这是本插件的缓存根，不是普通缓存' },
  )
  return rows
}

// ---------------------------------------------------------------------------
// scan helpers
// ---------------------------------------------------------------------------

async function measureTree(target, deadline) {
  const stat = await fsp.lstat(target).catch(() => null)
  if (!stat) return { exists: false, bytes: 0, files: 0, dirs: 0, complete: true, errors: [] }
  if (stat.isSymbolicLink()) {
    return { exists: true, bytes: 0, files: 0, dirs: 0, complete: false, errors: ['SYMLINK_SKIPPED'] }
  }
  if (stat.isFile()) {
    return { exists: true, bytes: stat.size, files: 1, dirs: 0, complete: true, errors: [] }
  }
  let bytes = 0
  let files = 0
  let dirs = 0
  let complete = true
  const errors = []
  const stack = [target]
  let seen = 0
  while (stack.length > 0) {
    if (Date.now() > deadline) {
      complete = false
      errors.push('TIME_BUDGET_EXCEEDED')
      break
    }
    const dir = stack.pop()
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch (error) {
      complete = false
      errors.push(`${dir}: ${error?.code || error}`)
      continue
    }
    dirs += 1
    for (const entry of entries) {
      seen += 1
      if (seen > MAX_WALK_NODES) {
        complete = false
        errors.push('NODE_BUDGET_EXCEEDED')
        break
      }
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile()) {
        try {
          const info = await fsp.lstat(full)
          bytes += info.size
          files += 1
        } catch {
          complete = false
        }
      }
    }
    if (errors.includes('NODE_BUDGET_EXCEEDED')) break
  }
  return { exists: true, bytes, files, dirs, complete, errors }
}

async function collectOldFiles(root, retainDays, now, deadline) {
  const cutoff = now - retainDays * DAY_MS
  const files = []
  let bytes = 0
  let scannedFiles = 0
  let complete = true
  const errors = []
  const stat = await fsp.lstat(root).catch(() => null)
  if (!stat) return { exists: false, files, bytes, scannedFiles, complete, errors }
  if (stat.isSymbolicLink()) {
    return { exists: true, files, bytes, scannedFiles, complete: false, errors: ['SYMLINK_SKIPPED'] }
  }
  if (stat.isFile()) {
    if (stat.mtimeMs <= cutoff) {
      files.push({ path: root, size: stat.size, mtimeMs: stat.mtimeMs })
      bytes += stat.size
    }
    return { exists: true, files, bytes, scannedFiles: 1, complete, errors }
  }
  const stack = [root]
  while (stack.length > 0) {
    if (Date.now() > deadline) {
      complete = false
      errors.push('TIME_BUDGET_EXCEEDED')
      break
    }
    const dir = stack.pop()
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch (error) {
      complete = false
      errors.push(`${dir}: ${error?.code || error}`)
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!entry.isFile()) continue
      scannedFiles += 1
      try {
        const info = await fsp.lstat(full)
        if (info.mtimeMs <= cutoff) {
          files.push({ path: full, size: info.size, mtimeMs: info.mtimeMs })
          bytes += info.size
        }
      } catch {
        complete = false
      }
    }
  }
  return { exists: true, files, bytes, scannedFiles, complete, errors }
}

async function scanAgeEntry(entry, ctx) {
  const rows = []
  let bytes = 0
  let files = 0
  let dirs = 0
  let scanned = 0
  let complete = true
  const errors = []
  const perPath = []
  for (const target of entry.paths) {
    const measured = await measureTree(target, ctx.deadline)
    const old = await collectOldFiles(target, ctx.retainDays, ctx.now, ctx.deadline)
    perPath.push({
      path: target,
      exists: measured.exists,
      bytes: measured.bytes,
      files: measured.files,
      candidates: old.files.length,
      candidatesBytes: old.bytes,
    })
    bytes += measured.bytes
    files += measured.files
    dirs += measured.dirs
    scanned += old.scannedFiles
    complete = complete && measured.complete && old.complete
    errors.push(...measured.errors, ...old.errors)
    for (const file of old.files) rows.push({ ...file, root: target })
  }
  return {
    exists: perPath.some((row) => row.exists),
    bytes,
    files,
    dirs,
    scannedFiles: scanned,
    candidates: rows,
    paths: perPath,
    complete,
    errors: [...new Set(errors)],
    deletable: rows.length > 0,
  }
}

async function scanUpdaterEntry(entry, ctx) {
  const root = entry.paths[0]
  const measured = await measureTree(root, ctx.deadline)
  const perPath = [{ path: root, exists: measured.exists, bytes: measured.bytes, files: measured.files, candidates: 0, candidatesBytes: 0 }]
  const rows = []
  const errors = []
  let complete = measured.complete
  const reasons = []
  if (!measured.exists) {
    return {
      exists: false, bytes: 0, files: 0, dirs: 0, scannedFiles: 0, candidates: [],
      paths: perPath, complete, errors, deletable: false, refuseReason: null,
    }
  }
  if (ctx.allowUpdaterCleanup !== true) {
    reasons.push('UPDATER_CLEANUP_DISABLED')
  }
  if (!ctx.installedVersion || !ctx.installedVersion.parsed) {
    reasons.push('INSTALLED_VERSION_UNKNOWN')
  }
  const pending = path.join(root, 'pending')
  const pendingStat = await fsp.lstat(pending).catch(() => null)
  if (pendingStat && pendingStat.isDirectory()) {
    let names = []
    try {
      names = await fsp.readdir(pending, { withFileTypes: true })
    } catch (error) {
      complete = false
      errors.push(`${pending}: ${error?.code || error}`)
    }
    for (const dirent of names) {
      if (!dirent.isFile() || !/\.exe$/i.test(dirent.name)) continue
      const full = path.join(pending, dirent.name)
      const info = await fsp.lstat(full).catch(() => null)
      if (!info) continue
      const pkg = versionFromFileName(dirent.name)
      if (!pkg) continue
      if (reasons.length > 0) continue
      if (compareVersion(pkg, ctx.installedVersion.parsed) <= 0) {
        rows.push({ path: full, size: info.size, mtimeMs: info.mtimeMs, version: pkg.raw })
      }
    }
  }
  const logs = path.join(root, 'installer-logs')
  // 更新包清理整体关闭（或版本未知）时，installer-logs 也只报告、不列入候选。
  const logsOld = reasons.length > 0
    ? { files: [], bytes: 0, scannedFiles: 0, complete, errors: [] }
    : await collectOldFiles(logs, ctx.retainDays, ctx.now, ctx.deadline)
  for (const file of logsOld.files) rows.push({ ...file, root: logs })
  complete = complete && logsOld.complete
  errors.push(...logsOld.errors)
  const bytes = rows.reduce((sum, row) => sum + row.size, 0)
  perPath[0].candidates = rows.length
  perPath[0].candidatesBytes = bytes
  return {
    exists: true,
    bytes: measured.bytes,
    files: measured.files,
    dirs: measured.dirs,
    scannedFiles: measured.files,
    candidates: rows,
    paths: perPath,
    complete,
    errors: [...new Set(errors)],
    deletable: rows.length > 0,
    refuseReason: reasons.length > 0 ? reasons.join('+') : null,
  }
}

async function scanEmptyDirs(entry, ctx) {
  const root = entry.paths[0]
  const measured = await measureTree(root, ctx.deadline)
  const perPath = [{ path: root, exists: measured.exists, bytes: measured.bytes, files: measured.files, candidates: 0, candidatesBytes: 0 }]
  const rows = []
  const errors = []
  let complete = measured.complete
  const cutoff = ctx.now - ctx.emptyDirMinAgeHours * 3600 * 1000
  let entries = []
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      complete = false
      errors.push(`${root}: ${error?.code || error}`)
    }
  }
  for (const dirent of entries) {
    if (!dirent.isDirectory() || dirent.isSymbolicLink()) continue
    if (!entry.pattern.test(dirent.name)) continue
    const full = path.join(root, dirent.name)
    const info = await fsp.lstat(full).catch(() => null)
    if (!info || !info.isDirectory()) continue
    if (info.mtimeMs > cutoff) continue
    let children = []
    try {
      children = await fsp.readdir(full)
    } catch {
      continue
    }
    if (children.length > 0) continue
    rows.push({ path: full, size: 0, mtimeMs: info.mtimeMs, dir: true })
  }
  perPath[0].candidates = rows.length
  return {
    exists: measured.exists,
    bytes: measured.bytes,
    files: measured.files,
    dirs: measured.dirs,
    scannedFiles: measured.files,
    candidates: rows,
    paths: perPath,
    complete,
    errors: [...new Set(errors)],
    deletable: rows.length > 0,
    refuseReason: null,
  }
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

export function normalizeSystemConfig(config = {}) {
  const enabled = config.systemCacheEnabled !== false
  const retainDays = Number(config.systemCacheRetainDays)
  const emptyHours = Number(config.systemCacheEmptyDirHours)
  let ids = Array.isArray(config.systemCacheIds) ? config.systemCacheIds.filter((id) => SYSTEM_CACHE_IDS.includes(id)) : null
  if (!ids || ids.length === 0) ids = [...SYSTEM_CACHE_IDS]
  return {
    enabled,
    ids,
    retainDays: Number.isFinite(retainDays) && retainDays >= 1 && retainDays <= 365 ? Math.floor(retainDays) : DEFAULT_SYSTEM_RETAIN_DAYS,
    emptyDirMinAgeHours:
      Number.isFinite(emptyHours) && emptyHours >= 1 && emptyHours <= 24 * 30
        ? Math.floor(emptyHours)
        : DEFAULT_EMPTY_DIR_MIN_AGE_HOURS,
    allowUpdaterCleanup: config.allowUpdaterCleanup === true,
  }
}

/**
 * 扫描全部 catalog 条目（只读）。返回可直接 JSON 化的 status。
 */
export async function scanSystemCaches(options = {}) {
  const env = options.env ?? process.env
  const dshHome = path.resolve(options.dshHome ?? path.join(os.homedir(), '.dsh'))
  const cfg = normalizeSystemConfig(options)
  const now = options.now ?? Date.now()
  const deadline = Date.now() + (options.budgetMs ?? 8000)
  const installedVersion = options.installedVersion !== undefined ? options.installedVersion : readInstalledVersion()
  const cacheRoot = options.cacheRoot ? path.resolve(options.cacheRoot) : null
  const selected = new Set(cfg.ids)
  const catalog = buildCatalog({ env, dshHome }).filter((entry) => selected.has(entry.id))
  const entries = []
  const errors = []
  if (!cfg.enabled) {
    return {
      schema: SYSTEM_STATUS_SCHEMA,
      generatedAt: nowIso(now),
      enabled: false,
      retainDays: cfg.retainDays,
      emptyDirMinAgeHours: cfg.emptyDirMinAgeHours,
      allowUpdaterCleanup: cfg.allowUpdaterCleanup,
      installedVersion: installedVersion ? installedVersion.raw : null,
      entries: [],
      protected: [],
      totals: { bytes: 0, candidateBytes: 0, candidateItems: 0 },
      errors: ['SYSTEM_CACHE_DISABLED'],
    }
  }
  for (const entry of catalog) {
    const ctx = { now, deadline, retainDays: cfg.retainDays, emptyDirMinAgeHours: cfg.emptyDirMinAgeHours, allowUpdaterCleanup: cfg.allowUpdaterCleanup, installedVersion }
    let scanned
    try {
      if (entry.strategy === 'age') scanned = await scanAgeEntry(entry, ctx)
      else if (entry.strategy === 'updater') scanned = await scanUpdaterEntry(entry, ctx)
      else if (entry.strategy === 'updater-legacy') {
        scanned = cfg.allowUpdaterCleanup === true ? await scanAgeEntry(entry, ctx) : await scanAgeEntry({ ...entry, paths: [] }, ctx)
        if (cfg.allowUpdaterCleanup !== true) scanned.refuseReason = 'UPDATER_CLEANUP_DISABLED'
      } else scanned = await scanEmptyDirs(entry, ctx)
    } catch (error) {
      errors.push(`${entry.id}: ${error?.message || error}`)
      continue
    }
    const candidateBytes = scanned.candidates.reduce((sum, row) => sum + (row.size || 0), 0)
    const candidateRows = scanned.candidates.slice(0, 500)
    entries.push({
      id: entry.id,
      label: entry.label,
      kind: entry.kind,
      strategy: entry.strategy,
      note: entry.note ?? null,
      exists: scanned.exists,
      bytes: scanned.bytes,
      files: scanned.files,
      dirs: scanned.dirs,
      candidates: candidateRows,
      candidateItems: scanned.candidates.length,
      candidatesTruncated: scanned.candidates.length > candidateRows.length,
      candidateBytes,
      deletable: scanned.deletable === true && scanned.candidates.length > 0,
      refuseReason: scanned.refuseReason ?? null,
      complete: scanned.complete !== false,
      errors: scanned.errors ?? [],
      paths: scanned.paths,
    })
  }
  const protectedRows = protectedEntries({ env, dshHome, cacheRoot }).map((row) => {
    const exists = row.path ? fs.existsSync(row.path) : false
    return { ...row, exists }
  })
  return {
    schema: SYSTEM_STATUS_SCHEMA,
    generatedAt: nowIso(now),
    enabled: true,
    retainDays: cfg.retainDays,
    emptyDirMinAgeHours: cfg.emptyDirMinAgeHours,
    allowUpdaterCleanup: cfg.allowUpdaterCleanup,
    installedVersion: installedVersion ? installedVersion.raw : null,
    entries,
    protected: protectedRows,
    totals: {
      bytes: entries.reduce((sum, row) => sum + row.bytes, 0),
      candidateBytes: entries.reduce((sum, row) => sum + row.candidateBytes, 0),
      candidateItems: entries.reduce((sum, row) => sum + (row.candidateItems ?? 0), 0),
    },
    errors,
  }
}

/**
 * 把 status 转成可执行计划：只允许删 status 里列出的候选（路径重新校验在 apply 时再做一次）。
 */
export function planSystemCleanup(status, options = {}) {
  const ids = Array.isArray(options.ids) && options.ids.length > 0 ? new Set(options.ids) : null
  const items = []
  for (const entry of status?.entries ?? []) {
    if (ids && !ids.has(entry.id)) continue
    if (!entry.deletable) continue
    items.push({
      id: entry.id,
      label: entry.label,
      files: Array.isArray(entry.candidates) ? entry.candidates : [],
      bytes: entry.candidateBytes,
    })
  }
  return {
    schema: SYSTEM_REPORT_SCHEMA,
    generatedAt: nowIso(),
    retainDays: status?.retainDays,
    installedVersion: status?.installedVersion ?? null,
    items,
    totals: {
      entries: items.length,
      files: items.reduce((sum, item) => sum + item.files.length, 0),
      bytes: items.reduce((sum, item) => sum + item.bytes, 0),
    },
  }
}

async function removeEmptyParents(filePath, stopAt) {
  let dir = path.dirname(filePath)
  while (isInside(stopAt, dir) || samePath(stopAt, dir)) {
    if (samePath(stopAt, dir)) break
    let children = []
    try {
      children = await fsp.readdir(dir)
    } catch {
      break
    }
    if (children.length > 0) break
    try {
      await fsp.rmdir(dir)
    } catch {
      break
    }
    dir = path.dirname(dir)
  }
}

/**
 * 执行计划。apply:false 时只返回计划（零删除）；apply:true 必须 confirm:true。
 */
export async function applySystemCleanup(plan, options = {}) {
  const apply = options.apply === true
  const confirm = options.confirm === true
  if (apply && !confirm) {
    return {
      applied: false,
      error: 'CONFIRM_REQUIRED',
      deleted: { files: 0, bytes: 0 },
      skipped: [],
      plan,
    }
  }
  const deleted = { files: 0, bytes: 0, dirs: 0 }
  const skipped = []
  if (!apply) return { applied: false, deleted, skipped, plan }
  const catalog = buildCatalog({ env: options.env ?? process.env, dshHome: options.dshHome ?? path.join(os.homedir(), '.dsh') })
  const roots = new Map()
  for (const entry of catalog) {
    roots.set(entry.id, entry.paths)
  }
  for (const item of plan?.items ?? []) {
    const allowedRoots = roots.get(item.id) ?? []
    for (const file of item.files ?? []) {
      const target = file.path
      const root = allowedRoots.find((candidate) => isInside(candidate, target))
      if (!root) {
        skipped.push({ path: target, code: 'OUTSIDE_CATALOG_ROOT' })
        continue
      }
      try {
        const info = await fsp.lstat(target)
        if (info.isSymbolicLink()) {
          skipped.push({ path: target, code: 'SYMLINK_SKIPPED' })
          continue
        }
        if (file.dir === true) {
          const children = await fsp.readdir(target)
          if (children.length > 0) {
            skipped.push({ path: target, code: 'DIR_NOT_EMPTY' })
            continue
          }
          await fsp.rmdir(target)
          deleted.dirs += 1
          continue
        }
        try {
          await fsp.unlink(target)
        } catch (error) {
          if (error?.code === 'EPERM' || error?.code === 'EACCES') {
            await fsp.chmod(target, 0o666).catch(() => {})
            await fsp.unlink(target)
          } else throw error
        }
        deleted.files += 1
        deleted.bytes += info.size || 0
        await removeEmptyParents(target, root)
      } catch (error) {
        skipped.push({ path: target, code: error?.code || String(error) })
      }
    }
  }
  return { applied: true, deleted, skipped, plan }
}
