#!/usr/bin/env node
// test/smoke-v3.mjs —— dsh-cache-cleaner v0.3.0 工作区目录治理自测（临时夹具，不碰真实工作区目录）。
//
// 覆盖 DESIGN-v3 §7 的 Y1–Y10（引擎级）、§5 的 7 个宿主工具（fake ctx），
// 以及 §6 CLI 的安全拒绝路径（只对真实根做只读 status / dry-run）。
//
// 运行: node test/smoke-v3.mjs

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  applyWorkspaceCleanup,
  normalizeWorkspaceRoots,
  planWorkspaceCleanup,
  scanWorkspaceRoot,
  WORKSPACE_SCHEMA,
  WORKSPACE_STATUS_SCHEMA,
} from '../lib/workspace.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.join(HERE, '..', 'bin', 'dsh-cache-clean.mjs')
const DAY = 24 * 60 * 60 * 1000

let passed = 0
const failures = []
function check (name, ok, extra) {
  if (ok) {
    passed += 1
    return
  }
  failures.push(`${name}${extra === undefined ? '' : `  ← ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`}`)
}
function checkEqual (name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected })
}

const NOW = Date.now()
const OLD8 = NOW - 8 * DAY
const OLD9 = NOW - 9 * DAY
const OLD40 = NOW - 40 * DAY
const FRESH = NOW - 60 * 60 * 1000

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-guard-smoke-v3-'))
const BASE = path.join(ROOT, 'base')
const TEMP_ROOT = path.join(BASE, '_tmp')
const ARCHIVE_ROOT = path.join(BASE, '_archive')
const MISSING_ROOT = path.join(BASE, '_missing')
const OUTSIDE = path.join(ROOT, 'outside')
const CACHE_ROOT = path.join(ROOT, 'cache')
const DSH_HOME = path.join(ROOT, 'fake-dsh')
const INJECT_ROOT = path.join(BASE, '_inject')

function writeFile (file, content, mtimeMs) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  if (mtimeMs) fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs))
}
function setMtime (target, mtimeMs) {
  fs.utimesSync(target, new Date(mtimeMs), new Date(mtimeMs))
}
function exists (target) {
  return fs.existsSync(target)
}
function hashTree (dir) {
  const lines = []
  const walk = (current) => {
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      const rel = path.relative(dir, full).split(path.sep).join('/')
      const stat = fs.lstatSync(full)
      if (stat.isSymbolicLink()) {
        lines.push(`${rel}|link`)
      } else if (stat.isDirectory()) {
        lines.push(`${rel}|dir|${stat.mtimeMs}`)
        walk(full)
      } else {
        lines.push(`${rel}|file|${stat.size}|${stat.mtimeMs}`)
      }
    }
  }
  walk(dir)
  lines.sort()
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex')
}

function buildFixture () {
  writeFile(path.join(TEMP_ROOT, 'old.txt'), 'old-file-1', OLD8)
  writeFile(path.join(TEMP_ROOT, 'new.txt'), 'new-file-1', FRESH)
  writeFile(path.join(TEMP_ROOT, 'olddir', 'inside.txt'), 'old-inside', OLD9)
  setMtime(path.join(TEMP_ROOT, 'olddir'), OLD9)
  // 目录 mtime 很旧，但子树里有新鲜写入 → 按「子树最新 mtime」不算过期。
  writeFile(path.join(TEMP_ROOT, 'dir-oldmtime-freshchild', 'late.txt'), 'late', FRESH)
  setMtime(path.join(TEMP_ROOT, 'dir-oldmtime-freshchild'), OLD9)
  writeFile(path.join(TEMP_ROOT, '.git', 'config'), 'git-config', OLD9)
  writeFile(path.join(TEMP_ROOT, '.keep'), 'keep', OLD9)
  writeFile(path.join(OUTSIDE, 'do-not-touch.txt'), 'outside', OLD40)
  fs.mkdirSync(path.join(ARCHIVE_ROOT), { recursive: true })
  writeFile(path.join(ARCHIVE_ROOT, 'old-archive.txt'), 'archive-old', OLD40)
  writeFile(path.join(ARCHIVE_ROOT, 'new-archive.txt'), 'archive-new', FRESH)
  fs.mkdirSync(CACHE_ROOT, { recursive: true })
  fs.mkdirSync(DSH_HOME, { recursive: true })
  writeFile(path.join(INJECT_ROOT, 'a.txt'), 'inject-a', OLD8)
  writeFile(path.join(INJECT_ROOT, 'b.txt'), 'inject-b', OLD8)
  // 根内的 junction（指向围栏外）只应被跳过，不应被删。
  fs.symlinkSync(OUTSIDE, path.join(TEMP_ROOT, 'linkdir'), 'junction')
}

// ---------------------------------------------------------------------------
// 引擎级 Y1–Y10
// ---------------------------------------------------------------------------

async function engineChecks () {
  const config = {
    cacheRoot: CACHE_ROOT,
    retainDays: 10,
    workspaceBases: [BASE],
    workspaceRoots: [
      { path: TEMP_ROOT, kind: 'temp', retainDays: 7, auto: true },
      { path: ARCHIVE_ROOT, kind: 'archive', retainDays: 30, auto: false },
      { path: MISSING_ROOT, kind: 'temp', retainDays: 7, auto: false },
    ],
    manageArchives: false,
  }
  const normalized = normalizeWorkspaceRoots(config, { now: NOW, dshHome: DSH_HOME })
  checkEqual('Y1 normalize 三根无错误', normalized.errors, [])
  checkEqual('Y1 根数量', normalized.roots.length, 3)
  checkEqual(
    'Y1 根性质/auto',
    normalized.roots.map((root) => [root.kind, root.auto]),
    [['temp', true], ['archive', false], ['temp', false]],
  )

  // --- Y1：status 语义 ---
  const tempScan = await scanWorkspaceRoot(normalized.roots[0], { now: NOW })
  check('Y1 temp 根存在', tempScan.exists === true)
  check('Y1 temp 根文件计数 > 0', tempScan.files > 0, tempScan.files)
  check('Y1 temp 根目录计数 > 0', tempScan.dirs > 0, tempScan.dirs)
  const staleNames = tempScan.staleEntries.map((entry) => entry.name).sort()
  checkEqual('Y3 过期候选集合', staleNames, ['old.txt', 'olddir'])
  check('Y3 老文件被判过期', tempScan.staleEntries.some((entry) => entry.name === 'old.txt' && entry.reason === 'age'))
  check('Y3 老目录按子树最新 mtime 判过期', tempScan.staleEntries.some((entry) => entry.name === 'olddir' && entry.type === 'dir'))
  check('Y3 新文件保留', !staleNames.includes('new.txt'))
  check('Y3 目录 mtime 旧但子树新鲜 → 保留', !staleNames.includes('dir-oldmtime-freshchild'))
  check('Y4 保留 .git', !staleNames.includes('.git'))
  check('Y4 保留 .keep', !staleNames.includes('.keep'))
  check('Y8 根内 junction 被跳过', tempScan.skippedLinks >= 1, tempScan.skippedLinks)
  check('Y3 staleBytes 只统计过期项', tempScan.staleBytes > 0 && tempScan.staleBytes < tempScan.bytes)

  const archiveScan = await scanWorkspaceRoot(normalized.roots[1], { now: NOW })
  check('Y1 archive 根存在', archiveScan.exists === true)
  checkEqual('Y1 archive 过期候选', archiveScan.staleEntries.map((entry) => entry.name), ['old-archive.txt'])

  const missingScan = await scanWorkspaceRoot(normalized.roots[2], { now: NOW })
  check('Y1 不存在的根 exists:false', missingScan.exists === false)
  check('Y1 不存在的根记 ROOT_MISSING', missingScan.errors.some((item) => item.reason === 'ROOT_MISSING'))

  // --- Y5：archive 闸门三态（不发生删除） ---
  const gate1 = await planWorkspaceCleanup(normalized.roots, { now: NOW, includeArchives: true, manageArchives: false })
  check('Y5 manageArchives=false + includeArchives=true → 拒绝', gate1.refusals.some((item) => item.reason === 'ARCHIVE_DISABLED'))
  check('Y5 被拒的 archive 根不产生候选', !gate1.entries.some((entry) => entry.path.startsWith(ARCHIVE_ROOT)))
  const gate2 = await planWorkspaceCleanup(normalized.roots, { now: NOW, includeArchives: false, manageArchives: true })
  check('Y5 manageArchives=true 但 includeArchives=false → 拒绝', gate2.refusals.some((item) => item.reason === 'ARCHIVE_DISABLED'))
  const gate3 = await planWorkspaceCleanup(normalized.roots, { now: NOW, includeArchives: true, manageArchives: true })
  check('Y5 两道闸门都开 → 纳入 archive 候选', gate3.entries.some((entry) => entry.path === path.join(ARCHIVE_ROOT, 'old-archive.txt')))
  check('Y5 闸门测试没有删除', exists(path.join(ARCHIVE_ROOT, 'old-archive.txt')))

  // --- Y2：dry-run 计划 == 实际删除集合 ---
  const plan = await planWorkspaceCleanup(normalized.roots, { now: NOW, includeArchives: false, manageArchives: false })
  checkEqual('Y2 计划候选数', plan.totals.entries, 2)
  check('Y2 计划拒绝 archive 根', plan.refusals.some((item) => item.reason === 'ARCHIVE_DISABLED'))
  const plannedPaths = plan.entries.map((entry) => entry.path).sort()
  const beforeHash = hashTree(TEMP_ROOT)
  const dry = await applyWorkspaceCleanup(plan, { apply: false, confirm: false, reportPath: null })
  check('Y2 dry-run ok', dry.ok === true && dry.deleted.entries === 0)
  check('Y2 dry-run 未改文件树', hashTree(TEMP_ROOT) === beforeHash)

  // --- Y6：apply 无 confirm → CONFIRM_REQUIRED 且零写入 ---
  const noConfirm = await applyWorkspaceCleanup(plan, { apply: true, confirm: false, reportPath: null })
  check('Y6 无 confirm 被拒', noConfirm.ok === false && noConfirm.error === 'CONFIRM_REQUIRED')
  check('Y6 无 confirm 零删除', noConfirm.deleted.entries === 0)
  check('Y6 无 confirm 文件树不变', hashTree(TEMP_ROOT) === beforeHash)

  // --- Y7：注入 EPERM，其余照删 ---
  const injectNormalized = normalizeWorkspaceRoots(
    { cacheRoot: CACHE_ROOT, retainDays: 10, workspaceBases: [BASE], workspaceRoots: [{ path: INJECT_ROOT, kind: 'temp', retainDays: 7, auto: false }] },
    { now: NOW, dshHome: DSH_HOME },
  )
  const injectPlan = await planWorkspaceCleanup(injectNormalized.roots, { now: NOW })
  checkEqual('Y7 注入夹具候选数', injectPlan.totals.entries, 2)
  let thrown = 0
  const injected = await applyWorkspaceCleanup(injectPlan, {
    apply: true,
    confirm: true,
    removeImpl: async () => {
      thrown += 1
      if (thrown === 1) {
        const error = new Error('simulated EPERM')
        error.code = 'EPERM'
        throw error
      }
    },
  })
  check('Y7 其余项继续删除', injected.deleted.entries === 1, injected.deleted)
  check('Y7 失败项进 skipped', injected.skipped.length === 1, injected.skipped)
  check('Y7 skipped 带 errno 与路径', injected.skipped[0]?.code === 'EPERM' && typeof injected.skipped[0]?.path === 'string', injected.skipped[0])

  // --- Y2/Y3/Y4/Y8：真实 apply 到夹具 ---
  const reportDir = path.join(CACHE_ROOT, 'reports')
  fs.mkdirSync(reportDir, { recursive: true })
  const applyReport = path.join(reportDir, 'workspace-20260101-000000-apply.json')
  const applied = await applyWorkspaceCleanup(plan, { apply: true, confirm: true, reportPath: applyReport, cacheRoot: CACHE_ROOT, now: NOW })
  check('Y2 apply ok', applied.ok === true)
  checkEqual('Y2 删除集合大小 == 计划', [applied.deleted.entries, plannedPaths.length], [2, 2])
  check('Y2 候选全部消失', plannedPaths.every((target) => !exists(target)))
  checkEqual('Y4 保留新文件', [exists(path.join(TEMP_ROOT, 'new.txt')), exists(path.join(TEMP_ROOT, 'dir-oldmtime-freshchild', 'late.txt'))], [true, true])
  checkEqual('Y4 保留 .git/.keep', [exists(path.join(TEMP_ROOT, '.git', 'config')), exists(path.join(TEMP_ROOT, '.keep'))], [true, true])
  check('Y4 保留根自身', exists(TEMP_ROOT) && exists(ARCHIVE_ROOT))
  check('Y4 围栏外文件不动', exists(path.join(OUTSIDE, 'do-not-touch.txt')))
  check('Y5 archive 文件未被删', exists(path.join(ARCHIVE_ROOT, 'old-archive.txt')))

  // --- Y10：幂等 ---
  const planAgain = await planWorkspaceCleanup(normalized.roots, { now: NOW })
  check('Y10 第二次计划 0 候选', planAgain.totals.entries === 0, planAgain.totals)
  const appliedAgain = await applyWorkspaceCleanup(planAgain, { apply: true, confirm: true, reportPath: null, now: NOW })
  check('Y10 第二次删除 0', appliedAgain.ok === true && appliedAgain.deleted.entries === 0)

  // --- Y9：报告 schema / 字段 / 保留 30 份 ---
  check('Y9 报告已写入', applied.reportPath === applyReport && exists(applyReport))
  const payload = JSON.parse(fs.readFileSync(applyReport, 'utf8'))
  checkEqual('Y9 报告 schema', payload.schema, WORKSPACE_SCHEMA)
  check('Y9 报告字段齐全', ['generatedAt', 'durationMs', 'apply', 'confirm', 'plan', 'deleted', 'skipped', 'warnings', 'refusals', 'totals'].every((key) => Object.hasOwn(payload, key)))
  check('Y9 报告 apply 标记', payload.apply === true && payload.deleted.entries === 2)
  check('Y9 报告含每根扫描摘要', Array.isArray(payload.plan.roots) && payload.plan.roots.length >= 1)

  for (let index = 0; index < 34; index += 1) {
    const file = path.join(reportDir, `workspace-seed-${String(index).padStart(2, '0')}.json`)
    fs.writeFileSync(file, '{}')
    setMtime(file, NOW - (index + 1) * 60000)
  }
  const emptyPlan = await planWorkspaceCleanup([], { now: NOW })
  await applyWorkspaceCleanup(emptyPlan, {
    apply: true,
    confirm: true,
    reportPath: path.join(reportDir, 'workspace-20260101-000001-apply.json'),
    now: NOW,
  })
  const keptReports = fs.readdirSync(reportDir).filter((name) => /^workspace-.*\.json$/.test(name))
  check('Y9 报告只保留 30 份', keptReports.length === 30, keptReports.length)

  // --- Y8：围栏拒绝 ---
  const fenceCases = [
    [{ path: BASE, kind: 'temp' }, 'EQUAL_TO_WORKSPACE_BASE'],
    [{ path: path.parse(BASE).root, kind: 'temp' }, 'VOLUME_ROOT'],
    [{ path: DSH_HOME, kind: 'temp' }, 'DSH_HOME'],
    [{ path: CACHE_ROOT, kind: 'temp' }, 'CACHE_ROOT'],
    [{ path: path.join(ROOT, 'elsewhere', '_x'), kind: 'temp' }, 'OUTSIDE_WORKSPACE_BASE'],
  ]
  for (const [rootConfig, reason] of fenceCases) {
    const outcome = normalizeWorkspaceRoots(
      { cacheRoot: CACHE_ROOT, retainDays: 10, workspaceBases: [BASE], workspaceRoots: [rootConfig] },
      { now: NOW, dshHome: DSH_HOME },
    )
    check(`Y8 围栏拒绝 ${reason}`, outcome.errors.some((item) => item.reason === reason) && outcome.roots.length === 0, outcome.errors)
  }
  const symlinkRoot = path.join(ROOT, 'link-root')
  fs.symlinkSync(OUTSIDE, symlinkRoot, 'junction')
  const symlinkOutcome = normalizeWorkspaceRoots(
    { cacheRoot: CACHE_ROOT, retainDays: 10, workspaceBases: [ROOT], workspaceRoots: [{ path: symlinkRoot, kind: 'temp' }] },
    { now: NOW, dshHome: DSH_HOME },
  )
  check('Y8 符号链接根被拒', symlinkOutcome.errors.some((item) => item.reason === 'SYMLINK_ROOT'), symlinkOutcome.errors)
  const escapeOutcome = normalizeWorkspaceRoots(
    { cacheRoot: CACHE_ROOT, retainDays: 10, workspaceBases: [BASE], workspaceRoots: [{ path: path.join(BASE, '..', 'outside'), kind: 'temp' }] },
    { now: NOW, dshHome: DSH_HOME },
  )
  check('Y8 `..` 逃逸被拒', escapeOutcome.errors.some((item) => item.reason === 'OUTSIDE_WORKSPACE_BASE'), escapeOutcome.errors)

  return { config, normalized }
}

// ---------------------------------------------------------------------------
// 宿主工具（fake ctx，动态 import index.js）
// ---------------------------------------------------------------------------

async function toolChecks (fixtureConfig) {
  const tools = new Map()
  const listeners = new Map()
  const effects = []
  const logs = []
  const ctx = {
    logger: { info: (msg) => logs.push(String(msg)), warn: (msg) => logs.push(String(msg)), debug () {} },
    tools: { register: (definition) => tools.set(definition.name, definition) },
    on: (event, handler) => listeners.set(event, handler),
    effect: (fn, label) => effects.push({ fn, label }),
    get: () => undefined,
  }
  const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, DSH_HOME: process.env.DSH_HOME }
  process.env.DSH_HOME = DSH_HOME
  const cacheRoot = path.join(ROOT, 'fake-cache')
  const fakeRoot = path.join(BASE, '_fake-clean')
  writeFile(path.join(fakeRoot, 'old.txt'), 'fake-old', OLD8)
  const config = {
    cacheRoot,
    tempSubdir: 'temp',
    redirectTemp: true,
    autoClean: false,
    autoCleanLegacy: false,
    startupDelaySeconds: 0,
    intervalHours: 0,
    idleQuietMinutes: 0,
    mode: 'normal',
    retainDays: 14,
    quotaBytes: null,
    workspaceBases: [BASE],
    workspaceRoots: [
      { path: TEMP_ROOT, kind: 'temp', retainDays: 7, auto: true },
      { path: fakeRoot, kind: 'temp', retainDays: 7, auto: true },
    ],
    manageArchives: false,
  }
  let plugin = null
  try {
    plugin = await import(`../index.js?smoke-v3=${Date.now()}`)
    await plugin.apply(ctx, config)
    const names = [...tools.keys()].sort()
    checkEqual('T1 7 个工具注册', names, [
      'cache_clean', 'cache_ownership', 'cache_status',
      'conversation_delete', 'conversation_list',
      'workspace_clean', 'workspace_status',
    ])
    const cacheStatus = JSON.parse(await tools.get('cache_status').execute({}))
    const pkgVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
    check('T2 版本与 package.json 一致', cacheStatus.plugin?.version === pkgVersion, cacheStatus.plugin)
    check('T3 只有 agent/status 监听', [...listeners.keys()].join(',') === 'agent/status', [...listeners.keys()])

    const statusTool = tools.get('workspace_status')
    const status = JSON.parse(await statusTool.execute({}))
    checkEqual('T4 workspace_status schema', status.schema, WORKSPACE_STATUS_SCHEMA)
    checkEqual('T5 workspace_status 根数量', status.roots.length, 2)
    check('T6 workspace_status 不写报告', !fs.existsSync(path.join(cacheRoot, 'reports')))

    const cleanTool = tools.get('workspace_clean')
    const beforeFake = hashTree(fakeRoot)
    const dry = JSON.parse(await cleanTool.execute({}))
    check('T7 dry-run 默认 apply=false', dry.apply === false, dry.apply)
    check('T7 dry-run 计划候选 >= 1', (dry.plan?.entries ?? []).length >= 1, dry.plan?.totals)
    check('T7 dry-run 零删除', dry.deleted.entries === 0 && hashTree(fakeRoot) === beforeFake)

    const refused = JSON.parse(await cleanTool.execute({ apply: true }))
    check('T8 apply 无 confirm → CONFIRM_REQUIRED', refused.error === 'CONFIRM_REQUIRED', refused)
    check('T8 拒绝后文件仍在', exists(path.join(fakeRoot, 'old.txt')))

    const unknown = JSON.parse(await cleanTool.execute({ nope: true }))
    check('T9 未知参数被拒', unknown.error === 'UNKNOWN_PARAMETER' && unknown.unknown.includes('nope'), unknown)

    const real = JSON.parse(await cleanTool.execute({ apply: true, confirm: true }))
    check('T10 apply+confirm 删除候选', real.apply === true && real.deleted.entries >= 1, real.deleted)
    check('T10 候选文件已删', !exists(path.join(fakeRoot, 'old.txt')))

    const logsText = logs.join('\n')
    check('T11 日志打印 workspace 清理', logsText.includes('workspace_clean'), logsText.slice(0, 200))
  } finally {
    for (const effect of effects) {
      try {
        await effect.fn()
      } catch {
        /* 卸载失败不影响断言 */
      }
    }
    if (saved.TEMP === undefined) delete process.env.TEMP
    else process.env.TEMP = saved.TEMP
    if (saved.TMP === undefined) delete process.env.TMP
    else process.env.TMP = saved.TMP
    if (saved.DSH_HOME === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved.DSH_HOME
  }
}

function pluginVersion (logs) {
  const text = logs.join('\n')
  const match = /dsh-cache-cleaner v?(\d+\.\d+\.\d+)/.exec(text)
  return match ? match[1] : null
}

// ---------------------------------------------------------------------------
// CLI（真实根只读 + 安全拒绝路径）
// ---------------------------------------------------------------------------

function runCli (args, env = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 120000,
  })
}

function cliChecks (fixtureOutsideBase) {
  const cliEnv = {
    DSH_CACHE_CLEANER_WORKSPACE_BASES: BASE,
    DSH_CACHE_CLEANER_WORKSPACE_ROOTS: JSON.stringify([
      { path: TEMP_ROOT, kind: 'temp', retainDays: 7, auto: true },
      { path: ARCHIVE_ROOT, kind: 'archive', retainDays: 30, auto: false },
      { path: MISSING_ROOT, kind: 'temp', retainDays: 7, auto: false },
    ]),
  }
  const status = runCli(['--workspace-status', '--json'], cliEnv)
  check('C1 CLI workspace-status exit 0', status.status === 0, status.stderr)
  let statusPayload = null
  try {
    statusPayload = JSON.parse(status.stdout)
  } catch {
    statusPayload = null
  }
  check('C2 CLI status 输出 JSON', statusPayload !== null)
  check('C3 CLI status schema', statusPayload?.schema === 'dsh-cache-cleaner/workspace-status/v1', statusPayload?.schema)
  check('C4 CLI status 三个配置根', statusPayload?.roots?.length === 3, statusPayload?.roots?.length)
  const archiveRoot = statusPayload?.roots?.find((root) => root.kind === 'archive')
  check('C5 CLI _archive 标 archive/manual', archiveRoot?.auto === false, archiveRoot)
  check('C6 CLI status 只读（无错误）', statusPayload?.errors?.length === 0, statusPayload?.errors)

  const dryRun = runCli(['--workspace-clean', '--json'], cliEnv)
  check('C7 CLI dry-run exit 0', dryRun.status === 0, dryRun.stderr)
  let dryPayload = null
  try {
    dryPayload = JSON.parse(dryRun.stdout)
  } catch {
    dryPayload = null
  }
  check('C8 CLI dry-run apply=false 且零删除', dryPayload?.apply === false && dryPayload?.deleted?.entries === 0, dryPayload?.deleted)

  const noConfirm = runCli(['--workspace-clean', '--apply'], cliEnv)
  check('C9 CLI apply 无 --confirm → exit 2', noConfirm.status === 2, noConfirm.status)
  check('C10 CLI 报 CONFIRM_REQUIRED', /CONFIRM_REQUIRED/.test(`${noConfirm.stdout}${noConfirm.stderr}`))

  const archiveGated = runCli(['--workspace-clean', '--apply', '--confirm', '--include-archives'], cliEnv)
  check('C11 CLI archive 闸门 → exit 2', archiveGated.status === 2, archiveGated.status)
  check('C12 CLI 报 ARCHIVE_DISABLED', /ARCHIVE_DISABLED/.test(`${archiveGated.stdout}${archiveGated.stderr}`))

  const outside = runCli(['--workspace-status', '--workspace-root', fixtureOutsideBase], cliEnv)
  check('C13 CLI 围栏外根 → exit 2', outside.status === 2, outside.status)
  check('C14 CLI 报 WORKSPACE_ROOT_INVALID', /WORKSPACE_ROOT_INVALID/.test(`${outside.stdout}${outside.stderr}`))

  const help = runCli(['--help'])
  check('C15 CLI help 提到 v3 子命令', help.status === 0 && /--workspace-clean/.test(help.stdout) && /--workspace-status/.test(help.stdout))
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

let exitCode = 1
try {
  buildFixture()
  const fixture = await engineChecks()
  await toolChecks(fixture.config)
  cliChecks(path.join(ROOT, 'outside'))
  exitCode = failures.length === 0 ? 0 : 1
} catch (error) {
  failures.push(`EXCEPTION: ${error?.stack || error}`)
} finally {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true })
  } catch {
    /* 清理失败不改判定 */
  }
}

if (failures.length > 0) {
  console.error(`\nsmoke-v3: ${passed} passed, ${failures.length} failed`)
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exit(exitCode === 0 ? 1 : exitCode)
}
console.log(`smoke-v3: ${passed} passed, 0 failed`)
process.exit(0)
