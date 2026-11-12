#!/usr/bin/env node
// test/smoke-v6.mjs —— dsh-cache-cleaner v0.6.0 系统缓存治理自测（临时夹具，不碰真实系统目录）。
//
// 覆盖：catalog 固定、天数闸门、更新包默认拒绝、版本匹配才删、安装版本未知、
// dry-run 零删除、apply 必须 confirm、空目录只删空且超龄、catalog 外路径拒绝。
//
// 运行: node test/smoke-v6.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  applySystemCleanup,
  normalizeSystemConfig,
  planSystemCleanup,
  scanSystemCaches,
  DEFAULT_SYSTEM_RETAIN_DAYS,
  SYSTEM_CACHE_IDS,
} from '../lib/system.mjs'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.now()

let passed = 0
const failures = []
function check (name, ok, extra) {
  if (ok) {
    passed += 1
    return
  }
  failures.push(`${name}${extra === undefined ? '' : `  ← ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`}`)
}
function eq (name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected })
}

// ---------------------------------------------------------------------------
// 夹具：假 LOCALAPPDATA / APPDATA / TEMP / DSH_HOME
// ---------------------------------------------------------------------------

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-cleaner-smoke-v6-'))
const ENV = {
  LOCALAPPDATA: path.join(ROOT, 'local'),
  APPDATA: path.join(ROOT, 'roaming'),
  TEMP: path.join(ROOT, 'temp'),
  USERPROFILE: path.join(ROOT, 'home'),
}
const DSH_HOME = path.join(ROOT, 'dsh-home')
const CACHE_ROOT = path.join(ROOT, 'cache')

function mkdirp (dir) { fs.mkdirSync(dir, { recursive: true }) }
function write (file, content = 'x') {
  mkdirp(path.dirname(file))
  fs.writeFileSync(file, content)
  return file
}
function age (target, ms) {
  const when = new Date(NOW - ms)
  fs.utimesSync(target, when, when)
}

mkdirp(ENV.LOCALAPPDATA)
mkdirp(ENV.APPDATA)
mkdirp(ENV.TEMP)
mkdirp(DSH_HOME)

const UPDATER = path.join(ENV.LOCALAPPDATA, '@deepseek-aidsh-desktop-updater')
const PENDING_OLD = write(path.join(UPDATER, 'pending', 'deepseek-harness-0.2.1-win-x64.exe'), 'old-1'.repeat(100))
const PENDING_NEW = write(path.join(UPDATER, 'pending', 'deepseek-harness-0.3.0-win-x64.exe'), 'new-3'.repeat(100))
const INSTALLER_LOG = write(path.join(UPDATER, 'installer-logs', 'failed-2026-10-01.log'), 'log')
for (const file of [PENDING_OLD, PENDING_NEW, INSTALLER_LOG]) age(file, 30 * DAY)
age(path.join(UPDATER, 'pending'), 30 * DAY)
age(path.join(UPDATER, 'installer-logs'), 30 * DAY)

const LEGACY = write(path.join(ENV.LOCALAPPDATA, 'dsh-desktop-updater', 'old-installer.exe'), 'legacy')
age(LEGACY, 30 * DAY)

const PLUGIN_OLD = write(path.join(DSH_HOME, 'plugin-updates', 'pkg-1.0.0.tgz'), 'a'.repeat(200))
const PLUGIN_FRESH = write(path.join(DSH_HOME, 'plugin-updates', 'pkg-2.0.0.tgz'), 'b'.repeat(200))
age(PLUGIN_OLD, 20 * DAY)

const CACHE_OLD = write(path.join(DSH_HOME, 'cache', 'old.bin'), 'c'.repeat(64))
age(CACHE_OLD, 20 * DAY)

const ELECTRON_OLD = write(path.join(ENV.APPDATA, 'dsh-desktop', 'GPUCache', 'data_1'), 'd'.repeat(128))
age(ELECTRON_OLD, 20 * DAY)

const D3D_OLD = write(path.join(ENV.LOCALAPPDATA, 'D3DSCache', 'shader.bin'), 'e'.repeat(96))
const NV_OLD = write(path.join(ENV.LOCALAPPDATA, 'NVIDIA', 'DXCache', 'shader.nvph'), 'f'.repeat(96))
age(D3D_OLD, 20 * DAY)
age(NV_OLD, 20 * DAY)

const TEMP_OLD_EMPTY = path.join(ENV.TEMP, 'dsh-subprocess-OLD')
const TEMP_FRESH_EMPTY = path.join(ENV.TEMP, 'dsh-subprocess-FRESH')
const TEMP_NONEMPTY = path.join(ENV.TEMP, 'dsh-subprocess-NONEMPTY')
mkdirp(TEMP_OLD_EMPTY)
mkdirp(TEMP_FRESH_EMPTY)
mkdirp(TEMP_NONEMPTY)
write(path.join(TEMP_NONEMPTY, 'keep.txt'))
age(TEMP_OLD_EMPTY, 48 * 60 * 60 * 1000)
age(TEMP_FRESH_EMPTY, 60 * 1000)

const installed = (raw) => {
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/)
  return {
    raw,
    parsed: {
      raw: match ? match[0] : raw,
      parts: [Number(match[1]), Number(match[2]), Number(match[3])],
      pre: match[4] ? match[4].split('.') : [],
    },
  }
}

async function scan (extra = {}) {
  return scanSystemCaches({
    env: ENV,
    dshHome: DSH_HOME,
    cacheRoot: CACHE_ROOT,
    now: NOW,
    installedVersion: installed('0.2.2'),
    allowUpdaterCleanup: false,
    ...extra,
  })
}

function entryOf (status, id) {
  return (status.entries ?? []).find((entry) => entry.id === id) ?? { id, candidates: [], candidateItems: 0 }
}

// ---------------------------------------------------------------------------
// S1：catalog 固定
// ---------------------------------------------------------------------------

const statusBase = await scan()
eq('S1 catalog ids', statusBase.entries.map((entry) => entry.id), SYSTEM_CACHE_IDS)
eq('S1 schema', statusBase.schema, 'dsh-cache-cleaner/system-status/v1')
eq('S1 retainDays', statusBase.retainDays, DEFAULT_SYSTEM_RETAIN_DAYS)
eq('S1 protected 包含 sessions', statusBase.protected.some((row) => row.id === 'sessions'), true)

// ---------------------------------------------------------------------------
// S2：天数闸门
// ---------------------------------------------------------------------------

const pluginEntry = entryOf(statusBase, 'plugin-updates')
eq('S2 plugin-updates candidates 只含旧文件', pluginEntry.candidates.map((row) => path.basename(row.path)), ['pkg-1.0.0.tgz'])
eq('S2 plugin-updates candidateItems', pluginEntry.candidateItems, 1)

// ---------------------------------------------------------------------------
// S3：更新包默认拒绝（即使版本匹配）
// ---------------------------------------------------------------------------

const updaterDefault = entryOf(statusBase, 'updater-packages')
eq('S3 更新包默认不可删', updaterDefault.deletable, false)
check('S3 refuseReason 包含 UPDATER_CLEANUP_DISABLED', String(updaterDefault.refuseReason).includes('UPDATER_CLEANUP_DISABLED'), updaterDefault.refuseReason)
eq('S3 默认不产生更新包候选', updaterDefault.candidates.length, 0)

// ---------------------------------------------------------------------------
// S4：allowUpdaterCleanup + 版本匹配才删
// ---------------------------------------------------------------------------

const statusOn = await scan({ allowUpdaterCleanup: true })
const updaterOn = entryOf(statusOn, 'updater-packages')
eq('S4 只删 <= 已安装版本（0.2.1）', updaterOn.candidates.map((row) => path.basename(row.path)).sort(),
  ['deepseek-harness-0.2.1-win-x64.exe', 'failed-2026-10-01.log'].sort())
check('S4 0.3.0 保留', !updaterOn.candidates.some((row) => String(row.path).includes('0.3.0')), updaterOn.candidates)

const statusUnknown = await scan({ allowUpdaterCleanup: true, installedVersion: null })
const updaterUnknown = entryOf(statusUnknown, 'updater-packages')
eq('S4 安装版本未知时不产生候选', updaterUnknown.candidates.length, 0)
check('S4 安装版本未知标记', String(updaterUnknown.refuseReason).includes('INSTALLED_VERSION_UNKNOWN'), updaterUnknown.refuseReason)

// ---------------------------------------------------------------------------
// S5：空目录只删空且超龄
// ---------------------------------------------------------------------------

const tempEntry = entryOf(statusBase, 'temp-empty-dirs')
eq('S5 空目录候选只含超龄空目录', tempEntry.candidates.map((row) => path.basename(row.path)), ['dsh-subprocess-OLD'])
check('S5 非空目录不在候选', !tempEntry.candidates.some((row) => String(row.path).includes('NONEMPTY')), tempEntry.candidates)

// ---------------------------------------------------------------------------
// S6：dry-run 零删除 / confirm 必需
// ---------------------------------------------------------------------------

const plan = planSystemCleanup(statusOn)
check('S6 计划含候选', plan.totals.files >= 4, plan.totals)

const dry = await applySystemCleanup(plan, { apply: false, env: ENV, dshHome: DSH_HOME, cacheRoot: CACHE_ROOT })
eq('S6 dry-run 零删除', dry.deleted, { files: 0, bytes: 0, dirs: 0 })
check('S6 dry-run 后旧文件仍在', fs.existsSync(PENDING_OLD), PENDING_OLD)

const refused = await applySystemCleanup(plan, { apply: true, confirm: false, env: ENV, dshHome: DSH_HOME, cacheRoot: CACHE_ROOT })
eq('S6 无 confirm 拒绝', refused.error, 'CONFIRM_REQUIRED')
check('S6 无 confirm 文件仍在', fs.existsSync(PENDING_OLD), PENDING_OLD)

// ---------------------------------------------------------------------------
// S7：apply 只删计划内文件
// ---------------------------------------------------------------------------

const applied = await applySystemCleanup(plan, { apply: true, confirm: true, env: ENV, dshHome: DSH_HOME, cacheRoot: CACHE_ROOT })
check('S7 applied=true', applied.applied === true, applied)
check('S7 旧 pending 已删', !fs.existsSync(PENDING_OLD), PENDING_OLD)
check('S7 新 pending 保留', fs.existsSync(PENDING_NEW), PENDING_NEW)
check('S7 未过期插件包保留', fs.existsSync(PLUGIN_FRESH), PLUGIN_FRESH)
check('S7 旧插件包已删', !fs.existsSync(PLUGIN_OLD), PLUGIN_OLD)
check('S7 旧空目录已删', !fs.existsSync(TEMP_OLD_EMPTY), TEMP_OLD_EMPTY)
check('S7 未超龄空目录保留', fs.existsSync(TEMP_FRESH_EMPTY), TEMP_FRESH_EMPTY)
check('S7 非空目录保留', fs.existsSync(path.join(TEMP_NONEMPTY, 'keep.txt')), TEMP_NONEMPTY)

// ---------------------------------------------------------------------------
// S8：catalog 外路径拒绝
// ---------------------------------------------------------------------------

const outside = path.join(ROOT, 'outside.txt')
write(outside, 'keep me')
const fakePlan = {
  schema: 'dsh-cache-cleaner/system-report/v1',
  items: [{ id: 'plugin-updates', label: 'fake', bytes: 1, files: [{ path: outside, size: 7 }] }],
  totals: { entries: 1, files: 1, bytes: 7 },
}
const escape = await applySystemCleanup(fakePlan, { apply: true, confirm: true, env: ENV, dshHome: DSH_HOME, cacheRoot: CACHE_ROOT })
eq('S8 catalog 外跳过', escape.skipped.map((row) => row.code), ['OUTSIDE_CATALOG_ROOT'])
check('S8 catalog 外文件仍在', fs.existsSync(outside), outside)

// ---------------------------------------------------------------------------
// S9：normalize 配置
// ---------------------------------------------------------------------------

eq('S9 默认启用', normalizeSystemConfig({}).enabled, true)
eq('S9 ids 过滤非法值', normalizeSystemConfig({ systemCacheIds: ['plugin-updates', 'nope'] }).ids, ['plugin-updates'])
eq('S9 空 ids 回落全量', normalizeSystemConfig({ systemCacheIds: [] }).ids, SYSTEM_CACHE_IDS)
eq('S9 retainDays 越界回落', normalizeSystemConfig({ systemCacheRetainDays: 0 }).retainDays, DEFAULT_SYSTEM_RETAIN_DAYS)
eq('S9 allowUpdaterCleanup 默认 false', normalizeSystemConfig({}).allowUpdaterCleanup, false)

// ---------------------------------------------------------------------------
// S10：宿主工具（fake ctx）
// ---------------------------------------------------------------------------

const { apply } = await import('../index.js')
const tools = new Map()
const pluginCtx = {
  logger: { info () {}, warn () {} },
  tools: { register (definition) { tools.set(definition.name, definition); return { name: definition.name } } },
  effect (fn) {
    const disposer = typeof fn === 'function' ? fn() : undefined
    return () => { if (typeof disposer === 'function') disposer() }
  },
  on () {},
  inject (_deps, callback) { if (typeof callback === 'function') callback() },
  get () { return undefined },
}
await apply(pluginCtx, { cacheRoot: CACHE_ROOT, autoClean: false, workspaceBases: [], workspaceRoots: [] })
check('S10 注册 system_cache_status', tools.has('system_cache_status'), [...tools.keys()])
check('S10 注册 system_cache_clean', tools.has('system_cache_clean'), [...tools.keys()])

const toolStatus = JSON.parse(await tools.get('system_cache_status').execute({}))
eq('S10 system_cache_status schema', toolStatus.schema, 'dsh-cache-cleaner/system-status/v1')
check('S10 system_cache_status entries 是数组', Array.isArray(toolStatus.entries), toolStatus)

const toolClean = JSON.parse(await tools.get('system_cache_clean').execute({}))
eq('S10 默认 dry-run', toolClean.applied, false)
check('S10 dry-run 有 plan', toolClean.plan && Array.isArray(toolClean.plan.items), toolClean)

// ---------------------------------------------------------------------------
// 清理夹具
// ---------------------------------------------------------------------------

fs.rmSync(ROOT, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`smoke-v6: ${passed} passed, ${failures.length} failed`)
  for (const failure of failures) console.error(`FAIL: ${failure}`)
  process.exitCode = 1
} else {
  console.log(`smoke-v6: ${passed} passed, 0 failed`)
}
