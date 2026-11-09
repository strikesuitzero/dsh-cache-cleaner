/**
 * dsh-cache-cleaner —— 工作区临时/归档目录治理引擎（v3）。
 *
 * 契约：dsh-cache-cleaner/DESIGN-v3.md（§3 引擎 API、§4 安全规则 W1–W10、§9 报告）。
 * 零依赖：只用 node: 内置模块 + ./util.mjs；不 import 任何宿主包。
 *
 * 口径提醒（DESIGN-v3 §3）：
 *  - 只扫配置根的「直接子项」，不递归下钻删除；
 *  - 目录的最后活动时间 = 子树内最新 mtime（子树里最近有写入就不算过期）；
 *  - 删除只发生在配置根严格内部；根自身、围栏 base、盘符根、~/.dsh、cacheRoot 一律拒绝。
 */
import fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DAY_MS, nowIso, writeJsonFile } from './util.mjs'

/** 报告 schema（W9）。 */
export const WORKSPACE_SCHEMA = 'dsh-cache-cleaner/workspace-report/v1'

/** 状态 schema（workspace_status 输出用）。 */
export const WORKSPACE_STATUS_SCHEMA = 'dsh-cache-cleaner/workspace-status/v1'

/** 根的两种性质。 */
export const WORKSPACE_KINDS = ['temp', 'archive']

/** 保留名单（W3）：这些名字的直接子项永远不算 stale。 */
export const RESERVED_NAMES = ['.git', '.keep', 'KEEP', '.dsh-cache-cleaner-keep']

/** 报告保留份数（W8）。 */
export const REPORT_KEEP = 30

/** retainDays 缺失时回落到 config.retainDays（v1 默认 14），再回落此值。 */
export const DEFAULT_WORKSPACE_RETAIN_DAYS = 14

/** 单次扫描的节点预算，防御性上限（正常工作区远小于此值）。 */
const MAX_SCAN_NODES = 200000

/** 本机默认围栏与默认根（CLI 无 config 时使用；插件 config 会显式覆盖）。 */
export const DEFAULT_WORKSPACE_BASES = []

export const DEFAULT_WORKSPACE_ROOTS = []

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function resolveDshHome (env = process.env) {
  const fromEnv = env && typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '' ? env.DSH_HOME : null
  return path.resolve(fromEnv ?? path.join(os.homedir(), '.dsh'))
}

function lowerPath (value) {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function samePath (left, right) {
  try {
    return lowerPath(left) === lowerPath(right)
  } catch {
    return false
  }
}

/**
 * W2 围栏的核心：分段比较，不做字符串前缀。
 * @returns {{equal:boolean, inside:boolean}}
 */
function relInfo (parent, child) {
  let rel
  try {
    rel = path.relative(path.resolve(parent), path.resolve(child))
  } catch {
    return { equal: false, inside: false }
  }
  if (rel === '') return { equal: true, inside: false }
  const escaped = rel.startsWith('..') || path.isAbsolute(rel)
  return { equal: false, inside: !escaped }
}

function insideAny (parents, child) {
  return parents.some((parent) => relInfo(parent, child).inside)
}

function positiveNumber (value) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

function lstatSyncSafe (target) {
  try {
    return fs.lstatSync(target)
  } catch {
    return null
  }
}

/** W8/W9：只清理 <reportDir>/workspace-*.json，按 mtime 留 keep 份。 */
export async function pruneWorkspaceReports (reportDir, keep = REPORT_KEEP) {
  let names
  try {
    names = await fsp.readdir(reportDir)
  } catch {
    return { removed: 0, kept: 0 }
  }
  const rows = []
  for (const name of names) {
    if (!/^workspace-.*\.json$/.test(name)) continue
    const file = path.join(reportDir, name)
    try {
      const stat = await fsp.stat(file)
      if (stat.isFile()) rows.push({ file, mtimeMs: stat.mtimeMs })
    } catch {
      /* 已被并发的另一次清理删掉，忽略 */
    }
  }
  rows.sort((left, right) => right.mtimeMs - left.mtimeMs)
  let removed = 0
  for (const row of rows.slice(Math.max(0, keep))) {
    try {
      await fsp.rm(row.file, { force: true })
      removed += 1
    } catch {
      /* 保留失败不阻断清理 */
    }
  }
  return { removed, kept: Math.min(rows.length, keep) }
}

// ---------------------------------------------------------------------------
// 1. normalizeWorkspaceRoots —— 围栏与配置归一化（W1/W2/W4）
// ---------------------------------------------------------------------------

function guardReason (resolved, context) {
  const { bases, dshHome, cacheRoot } = context
  const parsed = path.parse(resolved)
  if (parsed.root && samePath(parsed.root, resolved)) return 'VOLUME_ROOT'
  if (samePath(os.homedir(), resolved)) return 'HOME_DIRECTORY'
  if (samePath(dshHome, resolved) || relInfo(dshHome, resolved).inside) return 'DSH_HOME'
  if (cacheRoot && (samePath(cacheRoot, resolved) || relInfo(cacheRoot, resolved).inside)) return 'CACHE_ROOT'
  if (bases.some((base) => samePath(base, resolved))) return 'EQUAL_TO_WORKSPACE_BASE'
  if (!insideAny(bases, resolved)) return 'OUTSIDE_WORKSPACE_BASE'
  return null
}

function invalid (rawPath, reason, extra = {}) {
  return { code: 'WORKSPACE_ROOT_INVALID', path: rawPath, reason, ...extra }
}

/**
 * 归一化并校验配置里的工作区根。
 * @param {object} config 插件 config（cacheRoot / workspaceBases / workspaceRoots / retainDays）
 * @param {{now?:number, dshHome?:string}} [options]
 * @returns {{roots:Array<{path:string,kind:string,retainDays:number,auto:boolean,base:string}>, errors:Array, bases:string[], dshHome:string, cacheRoot:string|null}}
 */
export function normalizeWorkspaceRoots (config = {}, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const dshHome = options.dshHome ?? resolveDshHome()
  const cacheRoot =
    config && typeof config.cacheRoot === 'string' && config.cacheRoot.trim() !== ''
      ? path.resolve(config.cacheRoot)
      : null

  const rawBases = Array.isArray(config.workspaceBases) && config.workspaceBases.length > 0
    ? config.workspaceBases
    : DEFAULT_WORKSPACE_BASES
  const bases = rawBases
    .filter((base) => typeof base === 'string' && base.trim() !== '')
    .map((base) => path.resolve(base.trim()))

  const fallbackRetain = positiveNumber(config.retainDays) ?? DEFAULT_WORKSPACE_RETAIN_DAYS
  const rawRoots = Array.isArray(config.workspaceRoots) ? config.workspaceRoots : DEFAULT_WORKSPACE_ROOTS

  const roots = []
  const errors = []
  const seen = new Set()

  for (const raw of rawRoots) {
    const item = typeof raw === 'string' ? { path: raw } : raw
    if (!item || typeof item !== 'object') {
      errors.push(invalid('', 'INVALID_ENTRY', { detail: '根配置必须是字符串或 {path,...}' }))
      continue
    }
    const rawPath = typeof item.path === 'string' ? item.path.trim() : ''
    if (rawPath === '') {
      errors.push(invalid('', 'EMPTY_PATH'))
      continue
    }
    if (!path.isAbsolute(rawPath)) {
      errors.push(invalid(rawPath, 'NOT_ABSOLUTE'))
      continue
    }
    let resolved
    try {
      resolved = path.resolve(rawPath)
    } catch (error) {
      errors.push(invalid(rawPath, 'INVALID_PATH', { detail: error?.message || String(error) }))
      continue
    }
    const kind = WORKSPACE_KINDS.includes(item.kind) ? item.kind : null
    if (!kind) {
      errors.push(invalid(resolved, 'UNKNOWN_KIND', { detail: `kind 必须是 ${WORKSPACE_KINDS.join(' / ')}` }))
      continue
    }
    if (seen.has(lowerPath(resolved))) {
      errors.push(invalid(resolved, 'DUPLICATE_ROOT'))
      continue
    }
    const reason = guardReason(resolved, { bases, dshHome, cacheRoot })
    if (reason) {
      errors.push(invalid(resolved, reason, { bases, dshHome, cacheRoot }))
      continue
    }
    const stat = lstatSyncSafe(resolved)
    if (stat && stat.isSymbolicLink()) {
      errors.push(invalid(resolved, 'SYMLINK_ROOT', { detail: '根本身是符号链接/junction，拒绝跟随' }))
      continue
    }
    const matchedBase = bases.find((base) => relInfo(base, resolved).inside) ?? null
    seen.add(lowerPath(resolved))
    roots.push({
      path: resolved,
      kind,
      retainDays: positiveNumber(item.retainDays) ?? fallbackRetain,
      auto: item.auto === true,
      base: matchedBase,
    })
  }

  return { roots, errors, bases, dshHome, cacheRoot, now }
}

// ---------------------------------------------------------------------------
// 2. scanWorkspaceRoot —— 只读扫描（W3/W10）
// ---------------------------------------------------------------------------

/**
 * 递归测量一棵子树：bytes/files/dirs/最新 mtime。不跟随符号链接。
 * @returns {Promise<{bytes:number,files:number,dirs:number,isDir:boolean,newestMtime:number,complete:boolean,skippedLinks:number}>}
 */
async function measureSubtree (target, deadline) {
  const out = {
    bytes: 0,
    files: 0,
    dirs: 0,
    isDir: false,
    newestMtime: 0,
    complete: true,
    skippedLinks: 0,
  }
  let first
  try {
    first = await fsp.lstat(target)
  } catch {
    out.complete = false
    return out
  }
  if (first.isSymbolicLink()) {
    out.complete = false
    out.skippedLinks = 1
    out.newestMtime = first.mtimeMs
    return out
  }
  out.isDir = first.isDirectory()
  const stack = [{ target, stat: first }]
  let processed = 0
  while (stack.length > 0) {
    if (Date.now() > deadline || processed >= MAX_SCAN_NODES) {
      out.complete = false
      break
    }
    const node = stack.pop()
    processed += 1
    if (node.stat.mtimeMs > out.newestMtime) out.newestMtime = node.stat.mtimeMs
    if (node.stat.isDirectory()) {
      out.dirs += 1
      let children
      try {
        children = await fsp.readdir(node.target, { withFileTypes: true })
      } catch {
        out.complete = false
        continue
      }
      for (const child of children) {
        const childPath = path.join(node.target, child.name)
        let stat
        try {
          stat = await fsp.lstat(childPath)
        } catch {
          out.complete = false
          continue
        }
        if (stat.isSymbolicLink()) {
          out.skippedLinks += 1
          continue
        }
        stack.push({ target: childPath, stat })
      }
      continue
    }
    out.bytes += Number.isFinite(node.stat.size) ? node.stat.size : 0
    out.files += 1
  }
  return out
}

/**
 * 扫描一个配置根：整棵树的大小统计 + 直接子项的 stale 判定。
 * @param {{path:string,kind?:string,retainDays?:number,auto?:boolean}|string} root
 * @param {{now?:number, retainDays?:number, deadline?:number, kind?:string}} [options]
 */
export async function scanWorkspaceRoot (root, options = {}) {
  const input = typeof root === 'string' ? { path: root } : root && typeof root === 'object' ? root : {}
  const resolved = path.resolve(typeof input.path === 'string' && input.path !== '' ? input.path : '.')
  const kind = WORKSPACE_KINDS.includes(input.kind) ? input.kind : WORKSPACE_KINDS.includes(options.kind) ? options.kind : 'temp'
  const retainDays =
    positiveNumber(input.retainDays) ?? positiveNumber(options.retainDays) ?? DEFAULT_WORKSPACE_RETAIN_DAYS
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const deadline = Number.isFinite(options.deadline) ? options.deadline : now + 30000
  const cutoff = now - retainDays * DAY_MS

  const result = {
    path: resolved,
    kind,
    auto: input.auto === true,
    retainDays,
    exists: false,
    bytes: 0,
    files: 0,
    dirs: 0,
    staleBytes: 0,
    staleCount: 0,
    staleEntries: [],
    skippedLinks: 0,
    complete: true,
    scannedAt: nowIso(now),
    errors: [],
  }

  let stat
  try {
    stat = await fsp.lstat(resolved)
  } catch (error) {
    result.errors.push({ path: resolved, reason: 'ROOT_MISSING', code: error?.code ?? null })
    return result
  }
  if (stat.isSymbolicLink()) {
    result.errors.push({ path: resolved, reason: 'SYMLINK_ROOT' })
    return result
  }
  if (!stat.isDirectory()) {
    result.errors.push({ path: resolved, reason: 'NOT_A_DIRECTORY' })
    return result
  }
  result.exists = true

  let children
  try {
    children = await fsp.readdir(resolved, { withFileTypes: true })
  } catch (error) {
    result.complete = false
    result.errors.push({ path: resolved, reason: 'READDIR_FAILED', code: error?.code ?? null, error: error?.message || String(error) })
    return result
  }

  for (const child of children) {
    const childPath = path.join(resolved, child.name)
    const subtree = await measureSubtree(childPath, deadline)
    if (subtree.skippedLinks > 0) {
      result.skippedLinks += subtree.skippedLinks
      result.errors.push({ path: childPath, reason: 'SYMLINK_SKIPPED', count: subtree.skippedLinks })
    }
    if (!subtree.complete) result.complete = false
    result.bytes += subtree.bytes
    result.files += subtree.files
    result.dirs += subtree.dirs
    const mtimeMs = subtree.newestMtime || stat.mtimeMs
    const reserved = RESERVED_NAMES.includes(child.name)
    const stale = !reserved && mtimeMs < cutoff
    const entry = {
      path: childPath,
      name: child.name,
      type: subtree.isDir ? 'dir' : 'file',
      bytes: subtree.bytes,
      mtimeMs,
      mtimeIso: new Date(mtimeMs).toISOString(),
      ageDays: Math.round(((now - mtimeMs) / DAY_MS) * 1000) / 1000,
      stale,
      reason: stale ? 'age' : null,
    }
    if (stale) {
      result.staleEntries.push(entry)
      result.staleBytes += entry.bytes
    }
  }

  result.staleEntries.sort((left, right) => left.mtimeMs - right.mtimeMs)
  result.staleCount = result.staleEntries.length
  return result
}

// ---------------------------------------------------------------------------
// 3. planWorkspaceCleanup —— 闸门与候选（W3/W4）
// ---------------------------------------------------------------------------

/**
 * 生成清理计划。archive 根默认拒绝（W4）。
 * @param {Array} roots normalizeWorkspaceRoots().roots（也接受字符串）
 * @param {{now?:number, includeArchives?:boolean, manageArchives?:boolean, deadline?:number}} [options]
 */
export async function planWorkspaceCleanup (roots, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const deadline = Number.isFinite(options.deadline) ? options.deadline : now + 60000
  const includeArchives = options.includeArchives === true
  const manageArchives = options.manageArchives === true
  const list = Array.isArray(roots) ? roots : []

  const scans = []
  const entries = []
  const refusals = []
  const warnings = []

  for (const raw of list) {
    const root =
      typeof raw === 'string'
        ? { path: raw, kind: 'temp', retainDays: DEFAULT_WORKSPACE_RETAIN_DAYS, auto: false }
        : raw
    if (!root || typeof root.path !== 'string' || root.path === '') {
      warnings.push('WORKSPACE_ROOT_WITHOUT_PATH')
      continue
    }
    if (root.kind === 'archive' && !(manageArchives && includeArchives)) {
      refusals.push({
        path: path.resolve(root.path),
        reason: 'ARCHIVE_DISABLED',
        detail: manageArchives
          ? '调用未传 includeArchives:true'
          : 'manageArchives=false（archive 根默认只报告、不清理）',
      })
      continue
    }
    const scan = await scanWorkspaceRoot(root, {
      now,
      deadline,
      retainDays: root.retainDays,
      kind: root.kind,
    })
    scans.push({
      path: scan.path,
      kind: scan.kind,
      exists: scan.exists,
      auto: scan.auto,
      retainDays: scan.retainDays,
      bytes: scan.bytes,
      files: scan.files,
      dirs: scan.dirs,
      staleBytes: scan.staleBytes,
      staleCount: scan.staleCount,
      skippedLinks: scan.skippedLinks,
      complete: scan.complete,
      errors: scan.errors,
    })
    for (const entry of scan.staleEntries) entries.push(entry)
  }

  const bytes = entries.reduce((sum, entry) => sum + (Number.isFinite(entry.bytes) ? entry.bytes : 0), 0)
  const totals = {
    roots: scans.length,
    refused: refusals.length,
    entries: entries.length,
    bytes,
    staleBytes: bytes,
  }

  return {
    schema: WORKSPACE_SCHEMA,
    generatedAt: nowIso(now),
    now,
    includeArchives,
    manageArchives,
    scans,
    entries,
    refusals,
    warnings,
    totals,
  }
}

// ---------------------------------------------------------------------------
// 4. applyWorkspaceCleanup —— 删除与报告（W5/W6/W7/W8/W9）
// ---------------------------------------------------------------------------

/** 只摘出计划里可序列化的摘要（报告与工具返回共用）。 */
export function summarizeWorkspacePlan (plan) {
  const source = plan && typeof plan === 'object' ? plan : {}
  const scans = Array.isArray(source.scans) ? source.scans : []
  const entries = Array.isArray(source.entries) ? source.entries : []
  return {
    schema: WORKSPACE_SCHEMA,
    generatedAt: source.generatedAt ?? null,
    includeArchives: source.includeArchives === true,
    manageArchives: source.manageArchives === true,
    roots: scans.map((scan) => ({
      path: scan.path,
      kind: scan.kind,
      exists: scan.exists,
      auto: scan.auto,
      retainDays: scan.retainDays,
      bytes: scan.bytes,
      files: scan.files,
      dirs: scan.dirs,
      staleBytes: scan.staleBytes,
      staleCount: scan.staleCount,
      skippedLinks: scan.skippedLinks ?? 0,
      complete: scan.complete !== false,
      errors: scan.errors ?? [],
    })),
    entries: entries.map((entry) => ({
      path: entry.path,
      name: entry.name,
      type: entry.type,
      bytes: entry.bytes,
      mtimeMs: entry.mtimeMs,
      mtimeIso: entry.mtimeIso,
      ageDays: entry.ageDays,
      stale: entry.stale,
      reason: entry.reason,
    })),
    refusals: Array.isArray(source.refusals) ? source.refusals : [],
    warnings: Array.isArray(source.warnings) ? source.warnings : [],
    totals: source.totals ?? { roots: 0, refused: 0, entries: 0, bytes: 0, staleBytes: 0 },
  }
}

/** W7：递归清只读位（不跟随符号链接）。 */
async function clearReadonlyTree (target) {
  const stack = [target]
  while (stack.length > 0) {
    const current = stack.pop()
    let stat
    try {
      stat = await fsp.lstat(current)
    } catch {
      continue
    }
    if (stat.isSymbolicLink()) continue
    if (stat.isDirectory()) {
      try {
        await fsp.chmod(current, 0o777)
      } catch {
        /* 目录只读位在 Windows 上不阻止子项删除，失败忽略 */
      }
      let children
      try {
        children = await fsp.readdir(current)
      } catch {
        continue
      }
      for (const child of children) stack.push(path.join(current, child))
      continue
    }
    try {
      await fsp.chmod(current, 0o666)
    } catch {
      /* 清不掉就交给 rm 报错，记 skipped */
    }
  }
}

async function removeWorkspaceEntry (target) {
  const stat = await fsp.lstat(target)
  if (stat.isDirectory()) {
    await clearReadonlyTree(target)
    await fsp.rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 })
    return
  }
  try {
    await fsp.chmod(target, 0o666)
  } catch {
    /* 同上 */
  }
  await fsp.rm(target, { force: true })
}

/**
 * 执行计划。默认 dry-run（W5）；apply 需要 confirm。
 * @param {object} plan planWorkspaceCleanup 的结果
 * @param {{apply?:boolean, confirm?:boolean, reportPath?:string|null, cacheRoot?:string|null, now?:number, removeImpl?:Function}} [options]
 */
export async function applyWorkspaceCleanup (plan, options = {}) {
  const startedAt = Number.isFinite(options.now) ? options.now : Date.now()
  const apply = options.apply === true
  const confirm = options.confirm === true
  const reportPath = typeof options.reportPath === 'string' && options.reportPath !== '' ? options.reportPath : null
  const cacheRoot = typeof options.cacheRoot === 'string' && options.cacheRoot !== '' ? options.cacheRoot : null
  const warnings = Array.isArray(plan?.warnings) ? [...plan.warnings] : []
  const skipped = []
  const deleted = { entries: 0, bytes: 0 }
  const entries = Array.isArray(plan?.entries) ? plan.entries : []
  const rootPaths = (Array.isArray(plan?.scans) ? plan.scans : []).map((scan) => scan.path)
  const remover = typeof options.removeImpl === 'function' ? options.removeImpl : removeWorkspaceEntry

  const base = () => ({
    apply,
    confirm,
    skipped,
    warnings,
    refusals: Array.isArray(plan?.refusals) ? plan.refusals : [],
    deleted,
    reportPath: null,
    plan: summarizeWorkspacePlan(plan),
  })

  // W5：apply:true 必须同时 confirm:true；否则零写入。
  if (apply && confirm !== true) {
    return {
      ok: false,
      error: 'CONFIRM_REQUIRED',
      message: 'apply:true 必须同时 confirm:true（删除不可撤销，请先 dry-run 看计划）',
      ...base(),
      durationMs: Date.now() - startedAt,
    }
  }

  if (apply) {
    for (const entry of entries) {
      const target = entry && typeof entry.path === 'string' ? entry.path : ''
      if (target === '') {
        skipped.push({ path: target, reason: 'INVALID_ENTRY' })
        continue
      }
      // W1：只允许计划根严格内部的直接子项（再次校验，防御计划被篡改）。
      if (!rootPaths.some((rootPath) => relInfo(rootPath, target).inside)) {
        skipped.push({ path: target, reason: 'OUTSIDE_ROOT' })
        continue
      }
      try {
        const stat = await fsp.lstat(target)
        if (stat.isSymbolicLink()) {
          skipped.push({ path: target, reason: 'SYMLINK_SKIPPED' })
          continue
        }
        await remover(target, entry)
        deleted.entries += 1
        deleted.bytes += Number.isFinite(entry.bytes) ? entry.bytes : 0
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          skipped.push({ path: target, reason: 'ALREADY_GONE' })
          continue
        }
        // W6：单子项失败 → 记 skipped（带 errno），继续其余。
        skipped.push({
          path: target,
          reason: 'REMOVE_FAILED',
          code: error?.code ?? null,
          error: error?.message || String(error),
        })
      }
    }
  }

  let written = null
  if (reportPath) {
    const payload = {
      schema: WORKSPACE_SCHEMA,
      generatedAt: nowIso(startedAt),
      durationMs: Date.now() - startedAt,
      apply,
      confirm,
      cacheRoot,
      dshHome: resolveDshHome(),
      plan: summarizeWorkspacePlan(plan),
      deleted,
      skipped,
      warnings,
      refusals: Array.isArray(plan?.refusals) ? plan.refusals : [],
      totals: {
        planned: plan?.totals ?? null,
        deleted,
        skipped: skipped.length,
      },
    }
    try {
      await writeJsonFile(reportPath, payload)
      await pruneWorkspaceReports(path.dirname(reportPath), REPORT_KEEP)
      written = reportPath
    } catch (error) {
      warnings.push(`REPORT_WRITE_FAILED: ${error?.message || String(error)}`)
    }
  }

  return {
    ok: true,
    apply,
    confirm,
    deleted,
    skipped,
    warnings,
    refusals: Array.isArray(plan?.refusals) ? plan.refusals : [],
    reportPath: written,
    plan: summarizeWorkspacePlan(plan),
    durationMs: Date.now() - startedAt,
  }
}
