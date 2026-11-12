#!/usr/bin/env node
// dsh-cache-cleaner CLI — dry-run by default; --apply performs the deletion.
//
//   node bin/dsh-cache-clean.mjs                       # v1: dry-run cache cleanup, real roots
//   node bin/dsh-cache-clean.mjs --apply --legacy "C:\Users\me\AppData\Local\Temp"
//   node bin/dsh-cache-clean.mjs --init                # create marker + cache dirs
//   node bin/dsh-cache-clean.mjs --root D:\tmp\testroot --allow-unmarked --apply
//
// v2 (conversations):
//   node bin/dsh-cache-clean.mjs --ownership [--root <cacheRoot>] [--no-legacy] [--json]
//   node bin/dsh-cache-clean.mjs --conversations [--all] [--json]
//   node bin/dsh-cache-clean.mjs --delete-archived <id,id|all> [--apply] [--artifacts]
//        [--temp-dirs] [--no-cascade] [--offline-registry] [--dsh-home <path>] [--json]
//
// v3 (workspace directories, DESIGN-v3 §6):
//   node bin/dsh-cache-clean.mjs --workspace-status [--workspace-root <path>] [--json]
//   node bin/dsh-cache-clean.mjs --workspace-clean [--apply --confirm]
//        [--include-archives] [--workspace-root <path>] [--json]
//   退出码: 0 正常 / 2 参数或安全拒绝 / 1 运行错误
//
// Never deletes anything outside the whitelist documented in DESIGN.md / DESIGN-v2.md / DESIGN-v3.md.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  cleanup, inspectCache, ensureRootMarker, hasRootMarker,
  DEFAULT_CONFIG, MODES, cacheTempRoot, defaultCacheRoot, formatBytes,
} from '../lib/cleaner.mjs'
import {
  applyConversationDeletion, dshHomePath, listConversations, ownershipReport,
  planConversationDeletion,
} from '../lib/conversations.mjs'
import {
  applyWorkspaceCleanup, normalizeWorkspaceRoots, planWorkspaceCleanup, scanWorkspaceRoot,
  DEFAULT_WORKSPACE_BASES, DEFAULT_WORKSPACE_RETAIN_DAYS, DEFAULT_WORKSPACE_ROOTS,
  WORKSPACE_STATUS_SCHEMA,
} from '../lib/workspace.mjs'
import {
  applySystemCleanup, normalizeSystemConfig, planSystemCleanup, scanSystemCaches,
  SYSTEM_CACHE_IDS, SYSTEM_STATUS_SCHEMA,
  DEFAULT_SYSTEM_RETAIN_DAYS, DEFAULT_EMPTY_DIR_MIN_AGE_HOURS,
} from '../lib/system.mjs'
import { GIB } from '../lib/util.mjs'

const HELP = `dsh-cache-cleaner CLI

用法:
  node bin/dsh-cache-clean.mjs [选项]

v1 缓存清理:
  --apply               真的删除（默认只 dry-run）
  --dry-run             显式 dry-run（默认）
  --mode <safe|normal|aggressive>   档位（默认 normal；safe=30天/50GB，normal=14天/50GB，aggressive=1天/30GB）
  --root <dir>          缓存根（默认 ${defaultCacheRoot()}）
  --temp-subdir <name>  缓存根下的临时子目录（默认 ${DEFAULT_CONFIG.tempSubdir}）
  --legacy <dir>        旧临时根，可重复（默认取系统 TEMP）
  --no-legacy           不扫描旧临时根
  --retain-days <n>     覆盖天数闸门
  --quota-gb <n>        覆盖配额闸门（GB）
  --batch <n>           单批删除文件数（默认 45）
  --init                创建缓存根标记与目录（首次使用）
  --allow-unmarked      允许清理没有标记文件的根（仅测试用）
  --report-dir <dir>    报告目录（默认 <root>\\reports）
  --no-report           不写 JSON 报告
  --json                把完整报告 JSON 打到 stdout
  --status              只打印缓存现状，不清理

v2 会话归属与删除:
  --ownership           查看 workspace-changes 目录的缓存归属（只读）
  --conversations       列出已归档会话（含 ghost）
  --all                 配合 --conversations：同时给出全部会话计数
  --delete-archived <id,id|all>   删除已归档会话（默认只出计划；all = 全部已归档）
  --artifacts           连同附件对象与投影缓存一起删
  --temp-dirs           连同时间窗推断的临时快照目录一起删（需 --artifacts）
  --no-cascade          不级联删除子会话（subagent）
  --offline-registry    无宿主时允许离线改写 workspace.json（会先写 .bak-<ts>）
  --dsh-home <dir>      DSH_HOME（默认 $DSH_HOME 或 %USERPROFILE%\\.dsh）

v3 工作区目录治理:
  --workspace-status    只读盘点配置的工作区根（_tmp / _临时输出 / _archive）
  --workspace-clean     清理工作区根里过期的直接子项（默认 dry-run，零写入）
  --confirm             配合 --apply：二次确认（缺它会被拒绝，退出码 2）
  --include-archives    把 kind=archive 的根也纳入（还需 manageArchives 闸门，默认关）
  --workspace-root <path>  只处理这个根，可重复（默认用内置的三根配置）
  --json                把完整 JSON 打到 stdout
  （archive 闸门：默认 manageArchives=false；CLI 无插件配置，可用环境变量
    DSH_CACHE_CLEANER_MANAGE_ARCHIVES=1 显式打开，仅测试或明确授权时使用）

v5 已知系统缓存（DSH 更新包 / 插件更新包 / Electron / GPU 着色器 / 空目录）:
  --system-status       只读盘点已知系统缓存（catalog 固定，不删任何文件）
  --system-clean        清理系统缓存里按天数过期的候选（默认 dry-run，零写入）
  --apply               配合 --system-clean：真的删除
  --confirm             配合 --apply：二次确认（缺它会被拒绝，退出码 2）
  --system-ids <a,b>    只处理这些 catalog id（默认全部：${SYSTEM_CACHE_IDS.join(',')}）
  --system-retain-days <n>  天数闸门（默认 ${DEFAULT_SYSTEM_RETAIN_DAYS}）
  --system-empty-hours <n>  空目录最小年龄小时数（默认 ${DEFAULT_EMPTY_DIR_MIN_AGE_HOURS}）
  （更新包默认只报告不删；CLI 无插件配置，可用环境变量
    DSH_CACHE_CLEANER_ALLOW_UPDATER=1 显式允许，且仍需版本匹配）

  --help                显示本帮助
`

const argv = process.argv.slice(2)
const flags = []
const values = new Map()
const legacy = []
const workspaceRootArgs = []
for (let index = 0; index < argv.length; index += 1) {
  const token = argv[index]
  if (!token.startsWith('--')) { flags.push(token); continue }
  const eq = token.indexOf('=')
  if (eq > 0) {
    const key = token.slice(2, eq)
    if (key === 'workspace-root') workspaceRootArgs.push(token.slice(eq + 1))
    else values.set(key, token.slice(eq + 1))
    continue
  }
  const key = token.slice(2)
  const takesValue = ['mode', 'root', 'temp-subdir', 'legacy', 'retain-days', 'quota-gb', 'batch', 'report-dir', 'delete-archived', 'dsh-home', 'workspace-root', 'system-ids', 'system-retain-days', 'system-empty-hours']
  if (takesValue.includes(key)) {
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) { console.error(`缺少参数值: --${key}`); process.exit(2) }
    if (key === 'legacy') legacy.push(next)
    else if (key === 'workspace-root') workspaceRootArgs.push(next)
    else values.set(key, next)
    index += 1
  } else {
    flags.push(key)
  }
}

if (flags.includes('help')) { console.log(HELP); process.exit(0) }

function systemTemp () {
  const candidates = [process.env.TEMP, process.env.TMP, os.tmpdir()]
  for (const candidate of candidates) if (candidate && candidate.trim() !== '') return path.resolve(candidate)
  return os.tmpdir()
}

const cacheRoot = path.resolve(values.get('root') ?? defaultCacheRoot())
const tempSubdir = values.get('temp-subdir') ?? DEFAULT_CONFIG.tempSubdir
const tempRoot = cacheTempRoot({ cacheRoot, tempSubdir })

// If the DSH plugin already redirected TEMP into our cache root, the real legacy
// directory is the Windows per-user temp area instead of the inherited environment.
let legacyRoots = legacy.length > 0 ? legacy.map((item) => path.resolve(item)) : []
if (legacyRoots.length === 0 && !flags.includes('no-legacy')) {
  const inherited = systemTemp()
  const inheritedInsideCache = inherited.toLowerCase().startsWith(cacheRoot.toLowerCase())
  if (inheritedInsideCache) {
    const home = process.env.USERPROFILE ?? os.userInfo().homedir
    legacyRoots = [path.join(home, 'AppData', 'Local', 'Temp')]
  } else {
    legacyRoots = [inherited]
  }
}

const config = {
  cacheRoot,
  tempSubdir,
  legacyTempDirs: flags.includes('no-legacy') ? [] : legacyRoots,
  includeLegacy: !flags.includes('no-legacy'),
  mode: values.get('mode') ?? DEFAULT_CONFIG.mode,
  retainDays: values.has('retain-days') ? Number(values.get('retain-days')) : null,
  quotaBytes: values.has('quota-gb') ? Math.round(Number(values.get('quota-gb')) * GIB) : null,
  batchSize: values.has('batch') ? Number(values.get('batch')) : DEFAULT_CONFIG.batchSize,
  apply: flags.includes('apply'),
  allowUnmarkedRoot: flags.includes('allow-unmarked'),
  reportDir: values.has('report-dir') ? path.resolve(values.get('report-dir')) : null,
  writeReport: !flags.includes('no-report'),
  originalTemp: systemTemp(),
}

if (!Object.hasOwn(MODES, config.mode)) {
  console.error(`未知档位: ${config.mode}（可用: ${Object.keys(MODES).join(' / ')}）`)
  process.exit(2)
}

// ---------------------------------------------------------------------------
// v2：会话归属 / 已归档会话删除
// ---------------------------------------------------------------------------

const dshHome = path.resolve(values.get('dsh-home') ?? dshHomePath())
const reportDir = config.reportDir ?? path.join(cacheRoot, 'reports')
const writeReports = config.writeReport

function reportStamp (now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

function conversationReportPath (kind) {
  if (!writeReports) return null
  return path.join(reportDir, `conversation-${reportStamp()}-${kind}.json`)
}

function formatTime (ms) {
  if (!Number.isFinite(ms)) return '未知'
  try { return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) } catch { return '未知' }
}

function printOwnership (report, sessionId) {
  const totals = report.totals
  console.log(`缓存归属盘点（${report.generatedAt}）`)
  console.log(`目录 ${totals.dirs} 个，合计 ${formatBytes(totals.dirBytes)}；其中无法归因 ${formatBytes(totals.unattributedBytes)}`)
  console.log('')
  console.log('== 目录 -> 候选会话 ==')
  const dirs = sessionId ? report.dirs.filter((dir) => dir.candidates.some((c) => c.sessionId === sessionId)) : report.dirs
  if (dirs.length === 0) console.log('（没有发现 dsh-workspace-changes-* 目录）')
  for (const dir of dirs.slice(0, 50)) {
    const counts = dir.counts ?? {}
    console.log(`- ${dir.path}`)
    console.log(`  大小 ${formatBytes(dir.sizeBytes)}，${counts.tmpObj ?? 0} 个 tmp_obj / ${counts.captures ?? 0} 个 captures / ${counts.objects ?? 0} 个其他 objects；活动窗 ${formatTime(dir.firstWriteAt)} ~ ${formatTime(dir.lastWriteAt)}`)
    if (dir.candidates.length === 0) console.log('  [无法归因] 没有会话活动窗与它重叠')
    for (const candidate of dir.candidates.slice(0, 5)) console.log(`  [时间窗推断] ${candidate.sessionId}（重叠 ${Math.round(candidate.overlapMs / 1000)}s）`)
  }
  if (dirs.length > 50) console.log(`… 其余 ${dirs.length - 50} 个目录已截断（用 --json 看全量）`)
  console.log('')
  console.log('== 会话 -> 缓存 ==')
  const sessions = sessionId ? report.bySession.filter((item) => item.sessionId === sessionId) : report.bySession
  for (const item of sessions.slice(0, 50)) {
    const attribution = item.attribution === 'guess-cache' ? '时间窗推断' : item.attribution === 'exact-cache' ? '精确（projcache）' : '无缓存'
    console.log(`- ${item.sessionId}（${item.isArchived ? '已归档' : '未归档'}，${attribution}）：日志 ${formatBytes(item.logBytes)} / 投影缓存 ${formatBytes(item.projcacheBytes)} / 临时目录 ${item.cacheDirs.length} 个`)
    for (const cacheDir of item.cacheDirs.slice(0, 3)) console.log(`    [时间窗推断] ${cacheDir}`)
  }
  if (sessions.length > 50) console.log(`… 其余 ${sessions.length - 50} 个会话已截断（用 --json 看全量）`)
}

function printConversations (result, all) {
  console.log(`已归档会话 ${result.archived.length} 个${all ? `；全部会话 ${result.all.count} 个 / ${formatBytes(result.all.totalBytes)}` : ''}`)
  for (const item of result.archived) {
    const flagsText = [item.isGhost ? 'ghost' : 'archived', item.origin === 'subagent' ? 'subagent' : null].filter(Boolean).join(',')
    console.log(`- ${item.id} [${flagsText}] 大小 ${formatBytes(item.sizeBytes)}，投影缓存 ${formatBytes(item.projcacheBytes)}，子会话 ${item.childIds.length} 个，创建 ${formatTime(item.createdAt)}`)
    if (item.firstUserText) console.log(`    首条: ${item.firstUserText}`)
    if (item.isGhost) console.log('    （ghost：归档集合里有 id，但 sessions 根下已没有日志目录）')
  }
}

function printPlan (plan) {
  const targets = plan.targets
  console.log(`删除计划: ${targets.filter((t) => !t.blocked).length} 个可删 / ${targets.filter((t) => t.blocked).length} 个被拒绝`)
  for (const target of targets) {
    if (target.blocked) {
      console.log(`  [BLOCKED:${target.blocked.reason}] ${target.id}`)
      continue
    }
    console.log(`  ${target.id}${target.isGhost ? ' (ghost，只清状态)' : ''}  日志 ${formatBytes(target.sizeBytes)}${target.children.length ? `，级联子会话 ${target.children.length} 个` : ''}`)
    for (const logPath of target.logPaths) console.log(`      log: ${logPath}`)
    for (const child of target.children) console.log(`      child: ${child}`)
  }
  for (const entry of plan.projcacheFiles) console.log(`  projcache: ${entry.path} (${formatBytes(entry.bytes)})`)
  for (const attachment of plan.attachments) {
    console.log(`  attachment: sha256:${attachment.sha256} (${formatBytes(attachment.bytes)})`)
    if (attachment.objectPath) console.log(`      object: ${attachment.objectPath}`)
    if (attachment.fileObjectPath) console.log(`      file-object: ${attachment.fileObjectPath}`)
    for (const aliasDir of attachment.aliasDirs) console.log(`      alias-dir: ${aliasDir}`)
  }
  for (const dir of plan.tempDirs) console.log(`  temp[时间窗推断]: ${dir.path} (${formatBytes(dir.bytes)}，session ${dir.sessionId})`)
  if (plan.retainedBy.length > 0) console.log(`  被保留会话共享引用: ${plan.retainedBy.join(', ')}`)
  console.log(`合计: 会话 ${plan.totals.sessions} 个 / 日志 ${formatBytes(plan.totals.sessionBytes)} / 投影缓存 ${formatBytes(plan.totals.projcacheBytes)} / 附件 ${formatBytes(plan.totals.attachmentBytes)} / 临时 ${formatBytes(plan.totals.tempBytes)} = ${formatBytes(plan.totals.totalBytes)}`)
  for (const warning of plan.warnings) console.log(`提示: ${warning}`)
}

if (flags.includes('ownership')) {
  const overrideRoot = values.has('root') ? path.resolve(values.get('root')) : tempRoot
  const report = await ownershipReport({
    dshHome,
    cacheRoots: [overrideRoot],
    legacyRoots: flags.includes('no-legacy') ? [] : legacyRoots,
  })
  if (flags.includes('json')) console.log(JSON.stringify({ ...report, warnings: report.warnings ?? [] }, null, 2))
  else printOwnership(report, null)
  process.exit(0)
}

if (flags.includes('conversations')) {
  const result = await listConversations({ dshHome })
  if (flags.includes('json')) console.log(JSON.stringify(result, null, 2))
  else printConversations(result, flags.includes('all'))
  process.exit(0)
}

if (values.has('delete-archived')) {
  const spec = values.get('delete-archived')
  const allArchived = spec === 'all'
  const sessionIds = allArchived ? null : spec.split(',').map((item) => item.trim()).filter(Boolean)
  const includeArtifacts = flags.includes('artifacts')
  const includeTempDirs = flags.includes('temp-dirs')
  const cascade = !flags.includes('no-cascade')
  const apply = flags.includes('apply')
  if (!allArchived && sessionIds.length === 0) {
    console.error('--delete-archived 需要一个 id 列表或 all')
    process.exit(2)
  }
  if (includeTempDirs && !includeArtifacts) {
    console.error('--temp-dirs 需要同时给 --artifacts')
    process.exit(2)
  }
  const plan = await planConversationDeletion({
    dshHome,
    sessionIds,
    allArchived,
    includeArtifacts,
    includeTempDirs,
    cascade,
    legacyTempDir: flags.includes('no-legacy') ? null : systemTemp(),
    legacyTempDirs: legacyRoots,
    cacheTempDir: tempRoot,
  })
  // 无宿主时：必须先显式 --offline-registry 才允许改写 workspace.json。
  let registry = null
  if (apply) {
    if (!flags.includes('offline-registry')) {
      console.error('HOST_REGISTRY_UNAVAILABLE: 当前 CLI 没有宿主 registry；删除会话需要清理归档状态。')
      console.error('确认要在离线状态下改写 workspace.json（会先写 workspace.json.bak-<ts>）时，加 --offline-registry。')
      process.exit(2)
    }
    registry = createOfflineRegistry(dshHome)
  }
  const reportPath = conversationReportPath(apply ? 'apply' : 'plan')
  const result = await applyConversationDeletion(plan, { registry, dryRun: !apply, reportPath, dshHome })
  if (flags.includes('json')) {
    console.log(JSON.stringify({ apply, plan, result }, null, 2))
  } else {
    printPlan(plan)
    if (apply) {
      console.log('')
      console.log(`[APPLY] 已删会话 ${result.deleted.sessions} 个 / 日志 ${formatBytes(result.deleted.sessionBytes)}，投影缓存 ${result.deleted.projcacheFiles} 个，附件 ${result.deleted.attachments} 个，临时目录 ${result.deleted.tempDirs} 个，合计 ${formatBytes(result.deleted.bytes)}`)
      for (const item of result.skipped) console.log(`跳过: ${item.id ?? item.path}（${item.reason}${item.error ? `: ${item.error}` : ''}）`)
      for (const warning of result.warnings) console.log(`警告: ${warning}`)
    } else {
      console.log('（dry-run：没有删除任何文件；加 --apply 且通过 --offline-registry 才真删）')
    }
    if (result.reportPath) console.log(`报告: ${result.reportPath}`)
  }
  process.exit(result.ok ? 0 : 1)
}

// ---------------------------------------------------------------------------
// v3：工作区目录治理（DESIGN-v3 §6）
// ---------------------------------------------------------------------------

const manageArchivesFromEnv = process.env.DSH_CACHE_CLEANER_MANAGE_ARCHIVES === '1'

function envWorkspaceBases () {
  const raw = process.env.DSH_CACHE_CLEANER_WORKSPACE_BASES
  if (!raw) return DEFAULT_WORKSPACE_BASES
  return raw.split(path.delimiter).map((item) => item.trim()).filter(Boolean)
}

function envWorkspaceRoots () {
  const raw = process.env.DSH_CACHE_CLEANER_WORKSPACE_ROOTS
  if (!raw) return DEFAULT_WORKSPACE_ROOTS
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : DEFAULT_WORKSPACE_ROOTS
  } catch {
    return DEFAULT_WORKSPACE_ROOTS
  }
}

function workspaceCliConfig (now) {
  const retainDays = values.has('retain-days') ? Number(values.get('retain-days')) : DEFAULT_CONFIG.retainDays
  let rootsConfig = envWorkspaceRoots()
  if (workspaceRootArgs.length > 0) {
    rootsConfig = workspaceRootArgs.map((item) => {
      const resolved = path.resolve(item)
      const known = DEFAULT_WORKSPACE_ROOTS.find(
        (root) => path.resolve(root.path).toLowerCase() === resolved.toLowerCase(),
      )
      return known
        ? { ...known, path: resolved }
        : { path: resolved, kind: 'temp', retainDays: DEFAULT_WORKSPACE_RETAIN_DAYS, auto: false }
    })
  }
  return normalizeWorkspaceRoots(
    {
      cacheRoot,
      retainDays,
      workspaceBases: envWorkspaceBases(),
      workspaceRoots: rootsConfig,
      manageArchives: manageArchivesFromEnv,
    },
    { now },
  )
}

function printWorkspaceStatus (scans, errors) {
  for (const scan of scans) {
    const kind = scan.kind === 'archive' ? 'archive' : 'temp'
    const auto = scan.auto ? 'auto' : 'manual'
    console.log(`${scan.path}`)
    if (!scan.exists) {
      console.log(`  ${kind}/${auto}  (不存在)`)
      continue
    }
    console.log(
      `  ${kind}/${auto}  ${formatBytes(scan.bytes)} / ${scan.files} 文件 / ${scan.dirs} 目录  ` +
      `保留 ${scan.retainDays} 天  过期 ${scan.staleCount} 项 / ${formatBytes(scan.staleBytes)}` +
      (scan.complete === false ? '  [扫描超时，结果不完整]' : ''),
    )
    for (const entry of (scan.staleEntries ?? []).slice(0, 50)) {
      console.log(`    - ${entry.name}  ${entry.type === 'dir' ? '[目录]' : ''} ${formatBytes(entry.bytes)}  最近写入 ${entry.ageDays} 天前`)
    }
    if ((scan.staleEntries ?? []).length > 50) console.log(`    … 其余 ${scan.staleEntries.length - 50} 项省略`)
  }
  for (const issue of errors ?? []) {
    console.log(`${issue.code ?? 'WORKSPACE_ROOT_INVALID'}: ${issue.path}  ${issue.reason}${issue.detail ? `（${issue.detail}）` : ''}`)
  }
}

function printWorkspacePlan (plan) {
  console.log(`工作区清理计划（${plan.apply ? 'apply' : 'dry-run'}）  根 ${plan.totals?.roots ?? 0} 个，候选 ${plan.totals?.entries ?? 0} 项 / ${formatBytes(plan.totals?.bytes ?? 0)}`)
  for (const scan of plan.scans ?? []) {
    console.log(`  [${scan.kind}] ${scan.path}  ${formatBytes(scan.bytes)}  过期 ${scan.staleCount} 项 / ${formatBytes(scan.staleBytes)}`)
  }
  for (const entry of plan.entries ?? []) {
    console.log(`  候选 ${entry.path}  ${entry.type === 'dir' ? '[目录]' : ''} ${formatBytes(entry.bytes)}  最近写入 ${entry.ageDays} 天前`)
  }
  for (const refusal of plan.refusals ?? []) console.log(`  拒绝 ${refusal.path}（${refusal.reason}${refusal.detail ? `: ${refusal.detail}` : ''}）`)
  for (const warning of plan.warnings ?? []) console.log(`  警告 ${warning}`)
}

if (flags.includes('workspace-status')) {
  const now = Date.now()
  const normalized = workspaceCliConfig(now)
  const scans = []
  for (const root of normalized.roots) scans.push(await scanWorkspaceRoot(root, { now }))
  const payload = {
    schema: WORKSPACE_STATUS_SCHEMA,
    generatedAt: new Date(now).toISOString(),
    manageArchives: manageArchivesFromEnv,
    bases: normalized.bases,
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
      complete: scan.complete,
      errors: scan.errors,
      staleEntries: scan.staleEntries,
    })),
    errors: normalized.errors,
  }
  if (flags.includes('json')) console.log(JSON.stringify(payload, null, 2))
  else printWorkspaceStatus(scans, normalized.errors)
  process.exit(normalized.roots.length === 0 ? 2 : 0)
}

if (flags.includes('workspace-clean')) {
  const now = Date.now()
  const apply = flags.includes('apply')
  const confirm = flags.includes('confirm')
  const includeArchives = flags.includes('include-archives')
  const normalized = workspaceCliConfig(now)
  if (apply && !confirm) {
    console.error('CONFIRM_REQUIRED: --apply 必须同时给 --confirm（删除不可撤销，请先 dry-run 看计划）')
    process.exit(2)
  }
  if (normalized.roots.length === 0) {
    for (const issue of normalized.errors) console.error(`WORKSPACE_ROOT_INVALID: ${issue.path} ${issue.reason}`)
    console.error('WORKSPACE_ROOT_INVALID: 没有可用的工作区根')
    process.exit(2)
  }
  const plan = await planWorkspaceCleanup(normalized.roots, {
    now,
    includeArchives,
    manageArchives: manageArchivesFromEnv,
  })
  const reportDir = values.has('report-dir') ? path.resolve(values.get('report-dir')) : path.join(cacheRoot, 'reports')
  const reportPath = flags.includes('no-report')
    ? null
    : path.join(reportDir, `workspace-${reportStamp()}-${apply ? 'apply' : 'dryrun'}.json`)
  const result = await applyWorkspaceCleanup(plan, { apply, confirm, reportPath, cacheRoot })
  if (flags.includes('json')) {
    console.log(JSON.stringify({ apply, ...result, plan }, null, 2))
  } else {
    printWorkspacePlan({ ...plan, apply })
    if (apply) {
      console.log('')
      console.log(`[APPLY] 已删 ${result.deleted.entries} 项 / ${formatBytes(result.deleted.bytes)}，跳过 ${result.skipped.length}，拒绝 ${result.refusals.length}`)
      for (const item of result.skipped) console.log(`跳过: ${item.path}（${item.reason}${item.code ? ` ${item.code}` : ''}${item.error ? `: ${item.error}` : ''}）`)
      for (const warning of result.warnings) console.log(`警告: ${warning}`)
    } else {
      console.log('')
      console.log('（dry-run：没有删除任何文件；加 --apply --confirm 才真删）')
    }
    if (result.reportPath) console.log(`报告: ${result.reportPath}`)
    else if (result.warnings.includes('REPORT_WRITE_FAILED')) console.log('报告写入失败（见上方警告）')
  }
  const archiveRefused = (result.refusals ?? []).some((item) => item.reason === 'ARCHIVE_DISABLED')
  if (result.ok === false || (includeArchives && archiveRefused)) process.exit(2)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// v5：已知系统缓存（catalog 固定；更新包默认只报告不删）
// ---------------------------------------------------------------------------

function printSystemStatus (status, dshHome) {
  console.log(`[SYSTEM] 保留 ${status.retainDays} 天 / 空目录 ≥ ${status.emptyDirMinAgeHours}h / DSH_HOME=${dshHome}`)
  console.log(`DSH 已安装版本: ${status.installedVersion ?? '(未知)'}   更新包清理: ${status.allowUpdaterCleanup ? '允许（仍需版本匹配）' : '关闭（只报告）'}`)
  console.log(`合计: ${formatBytes(status.totals.bytes)} / 候选 ${status.totals.candidateItems} 项 ${formatBytes(status.totals.candidateBytes)}`)
  for (const entry of status.entries ?? []) {
    if (!entry.exists) {
      console.log(`  ${entry.id}  (不存在)`)
      continue
    }
    const verdict = !entry.deletable
      ? `不可删${entry.refuseReason ? `（${entry.refuseReason}）` : ''}`
      : (entry.candidateItems ?? 0) > 0
        ? `候选 ${entry.candidateItems} 项 / ${formatBytes(entry.candidateBytes)}`
        : '无过期项'
    console.log(`  ${entry.id}  ${formatBytes(entry.bytes)} / ${entry.files} 文件  ${verdict}`)
    for (const row of (entry.candidates ?? []).slice(0, 20)) {
      console.log(`    - ${row.path}  ${formatBytes(row.size ?? 0)}${row.dir ? '  [空目录]' : ''}`)
    }
  }
  for (const item of status.protected ?? []) {
    console.log(`  保护 ${item.id ?? item.path}  ${item.bytes != null ? formatBytes(item.bytes) : ''}  ${item.label ?? ''}`)
  }
  for (const error of status.errors ?? []) console.log(`  错误 ${error}`)
}

function printSystemPlan (plan, apply) {
  console.log(`[SYSTEM ${apply ? 'APPLY' : 'DRY-RUN'}] 候选 ${plan.totals.entries} 组 / ${plan.totals.files} 项 / ${formatBytes(plan.totals.bytes)}`)
  for (const item of plan.items ?? []) {
    console.log(`  ${item.id}: ${item.files.length} 项 / ${formatBytes(item.bytes)}`)
  }
}

if (flags.includes('system-status') || flags.includes('system-clean')) {
  const now = Date.now()
  const apply = flags.includes('apply')
  const confirm = flags.includes('confirm')
  const idsArg = values.get('system-ids')
  const ids = idsArg ? idsArg.split(',').map((item) => item.trim()).filter(Boolean) : null
  if (ids) {
    const invalid = ids.filter((id) => !SYSTEM_CACHE_IDS.includes(id))
    if (invalid.length > 0) {
      console.error(`INVALID_ARGUMENT: 未知 catalog id: ${invalid.join(', ')}`)
      process.exit(2)
    }
  }
  const dshHome = values.has('dsh-home')
    ? path.resolve(values.get('dsh-home'))
    : path.resolve(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'))
  const allowUpdaterCleanup = process.env.DSH_CACHE_CLEANER_ALLOW_UPDATER === '1'
  if (apply && !confirm) {
    console.error('CONFIRM_REQUIRED: --apply 必须同时给 --confirm（删除不可撤销，请先 dry-run 看计划）')
    process.exit(2)
  }
  const systemConfig = normalizeSystemConfig({
    systemCacheEnabled: true,
    systemCacheIds: ids ?? [...SYSTEM_CACHE_IDS],
    systemCacheRetainDays: values.has('system-retain-days')
      ? Number(values.get('system-retain-days'))
      : DEFAULT_SYSTEM_RETAIN_DAYS,
    systemCacheEmptyDirHours: values.has('system-empty-hours')
      ? Number(values.get('system-empty-hours'))
      : DEFAULT_EMPTY_DIR_MIN_AGE_HOURS,
    allowUpdaterCleanup,
  })
  // CLI 不是 DSH 进程：进程 exe 是 node，不能拿它当「已安装 DSH 版本」。
  // 传 null 让更新包条目如实返回 INSTALLED_VERSION_UNKNOWN（只报告，不删）。
  const status = await scanSystemCaches({ ...systemConfig, now, dshHome, cacheRoot, env: process.env, installedVersion: null })
  if (flags.includes('system-status')) {
    if (flags.includes('json')) console.log(JSON.stringify(status, null, 2))
    else printSystemStatus(status, dshHome)
    process.exit(0)
  }
  const plan = planSystemCleanup(status, { ids: systemConfig.ids })
  const result = await applySystemCleanup(plan, { apply, confirm, dshHome, cacheRoot, env: process.env })
  const reportDir = values.has('report-dir') ? path.resolve(values.get('report-dir')) : path.join(cacheRoot, 'reports')
  let reportPath = null
  if (!flags.includes('no-report')) {
    try {
      fs.mkdirSync(reportDir, { recursive: true })
      reportPath = path.join(reportDir, `system-${now}-${apply ? 'apply' : 'dryrun'}.json`)
      fs.writeFileSync(reportPath, JSON.stringify({
        schema: SYSTEM_STATUS_SCHEMA,
        generatedAt: new Date(now).toISOString(),
        apply,
        status,
        plan,
        result,
      }, null, 2))
    } catch (error) {
      console.error(`警告: 报告写入失败: ${error?.message || error}`)
      reportPath = null
    }
  }
  if (flags.includes('json')) {
    console.log(JSON.stringify({ apply, status, plan, result, reportPath }, null, 2))
  } else {
    printSystemStatus(status, dshHome)
    console.log('')
    printSystemPlan(plan, apply)
    if (result.applied) {
      console.log(`已删除 ${result.deleted.files} 个文件 / ${formatBytes(result.deleted.bytes)}，空目录 ${result.deleted.dirs} 个，跳过 ${result.skipped.length}`)
      const byCode = new Map()
      for (const item of result.skipped) byCode.set(item.code, (byCode.get(item.code) ?? 0) + 1)
      for (const [code, count] of byCode) console.log(`  跳过 ${code}: ${count}`)
    } else {
      console.log('（dry-run：没有删除任何文件；加 --apply --confirm 才真删）')
    }
    if (reportPath) console.log(`报告: ${reportPath}`)
  }
  process.exit(result.applied === false && apply ? 2 : 0)
}

/**
 * 离线 registry 适配器（仅 CLI）：直接改 workspace.json。
 * 首次写入前生成 workspace.json.bak-<ts>，然后用临时文件 + rename 原子替换。
 */
function createOfflineRegistry (home) {
  const file = path.join(home, 'storages', 'workspace.json')
  let state = null
  let backupPath = null
  const load = () => {
    if (state === null) state = JSON.parse(fs.readFileSync(file, 'utf8'))
    return state
  }
  const flush = () => {
    if (backupPath === null) {
      backupPath = `${file}.bak-${Date.now()}`
      fs.copyFileSync(file, backupPath)
    }
    const tempFile = `${file}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(tempFile, JSON.stringify(state, null, 2))
    fs.renameSync(tempFile, file)
  }
  return {
    async unarchive (sessionId) {
      const data = load()
      const archived = data?.global?.archivedSessionIds
      if (!Array.isArray(archived)) return
      const next = archived.filter((id) => id !== sessionId)
      if (next.length === archived.length) return
      data.global.archivedSessionIds = next
      flush()
    },
    async detachWorkspaceSlot (sessionId) {
      const data = load()
      const workspaces = data?.tables?.workspaces
      if (!workspaces || typeof workspaces !== 'object') return
      let changed = false
      for (const record of Object.values(workspaces)) {
        if (Array.isArray(record?.sessionIds) && record.sessionIds.includes(sessionId)) {
          record.sessionIds = record.sessionIds.filter((id) => id !== sessionId)
          changed = true
        }
      }
      if (changed) flush()
    },
  }
}

// ---------------------------------------------------------------------------
// v1：缓存清理
// ---------------------------------------------------------------------------

function pad (value) { return String(value).padStart(7) }

function printHuman (report) {
  const mode = report.mode
  const gates = report.gates
  console.log(`${report.apply ? '[APPLY]' : '[DRY-RUN]'} mode=${mode}  retain=${gates.retainDays}d  quota=${formatBytes(gates.quotaBytes)}  legacyCut=${gates.legacyMinAgeHours}h`)
  console.log(`当前缓存根: ${report.roots.tempRoot}`)
  const cacheDirCount = report.totals.scannedDirs
  const legacyLabel = report.roots.legacy.length > 0 ? report.roots.legacy.join(', ') : '(未扫描)'
  console.log(`legacy  : ${legacyLabel}`)
  console.log(`扫描: ${cacheDirCount} 个会话目录 / ${report.totals.scannedFiles} 个文件 / ${formatBytes(report.totals.scannedBytes)}`)
  console.log(`可回收: ${formatBytes(report.totals.candidateBytes)} / ${report.totals.candidateFiles} 个 tmp_obj${report.truncated ? '（清单已截断到 2000 条）' : ''}`)
  const byReason = new Map()
  for (const candidate of report.candidates) {
    byReason.set(candidate.reason, (byReason.get(candidate.reason) ?? 0) + candidate.size)
  }
  for (const [reason, bytes] of byReason) console.log(`  - ${reason}: ${formatBytes(bytes)}`)
  if (report.apply) {
    console.log(`已删除: ${formatBytes(report.totals.deletedBytes)} / ${report.totals.deletedFiles} 个文件，空目录 ${report.totals.dirsRemoved} 个`)
    if (report.totals.skippedFiles > 0) console.log(`跳过  : ${report.totals.skippedFiles} 个（被占用/无权限，见报告）`)
    for (const volume of report.volumes) {
      if (volume.delta === null) continue
      console.log(`空间  : ${volume.path} ${formatBytes(volume.freeBefore ?? 0)} -> ${formatBytes(volume.freeAfter ?? 0)} (${volume.delta >= 0 ? '+' : ''}${formatBytes(volume.delta)})`)
    }
    for (const warning of report.warnings) console.log(`警告  : ${warning}`)
  } else {
    const shown = report.candidates.slice(0, 60)
    for (const candidate of shown) {
      const dirName = path.basename(candidate.dir)
      console.log(`  ${pad(formatBytes(candidate.size))}  ${candidate.mtime.slice(0, 16)}  ${dirName}  ${path.basename(candidate.path)}  -> 删除 (${candidate.reason})`)
    }
    if (report.candidates.length > shown.length) console.log(`  ... 其余 ${report.candidates.length - shown.length} 个见 --json`)
    for (const warning of report.warnings) console.log(`提示  : ${warning}`)
    console.log('（dry-run：没有删除任何文件；加 --apply 才真删）')
  }
  if (report.reportPath) console.log(`报告: ${report.reportPath}`)
}

if (flags.includes('status')) {
  const inventory = await inspectCache(config)
  console.log(JSON.stringify(inventory, null, 2))
  process.exit(0)
}

if (flags.includes('init')) {
  try {
    const marker = await ensureRootMarker(cacheRoot)
    console.log(`缓存根标记: ${marker}`)
  } catch (error) {
    console.error(`创建标记失败: ${error.message}`)
    process.exit(1)
  }
}

const marked = await hasRootMarker(cacheRoot)
if (!marked && !config.allowUnmarkedRoot) {
  console.error(`拒绝执行: ${cacheRoot} 缺少 ${DEFAULT_CONFIG.markerFileName} 标记。`)
  console.error('这是越界防护（验收 A4）。首次使用请加 --init 创建标记，或确认 --root 是否写错。')
  process.exit(1)
}

const report = await cleanup(config)

if (flags.includes('json')) console.log(JSON.stringify(report, null, 2))
else printHuman(report)

if (report.error && report.error !== null) {
  console.error(`清理未完成: ${report.error}`)
  process.exit(report.error === 'UNMARKED_ROOT' || report.error === 'INVALID_ROOT' ? 1 : 3)
}
