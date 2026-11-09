// dsh-cache-cleaner: deterministic cache cleaner for DSH workspace-change temp objects.
//
// Scope of what may be deleted (DESIGN.md D3):
//   <root>/dsh-workspace-changes-<suffix>/objects/<two hex>/tmp_obj_<6 alnum>
// Nothing else is ever touched. Dry-run is the default; `apply: true` deletes.
//
// No third-party dependencies: this module must also run under plain `node`.

import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  GIB, DAY_MS, sleep, nowIso, formatBytes, volumeRoot, freeBytes,
  isInside, countFiles, removeEmptyTree, writeJsonFile, stampForFile,
} from './util.mjs'

export const SCHEMA = 'dsh-cache-cleaner/v1'
export const MARKER_SCHEMA = 'dsh-cache-cleaner-root'
export const MARKER_FILE = '.dsh-cache-cleaner.json'
export const SESSION_DIR_PREFIX = 'dsh-workspace-changes-'
export const SESSION_DIR_PATTERN = /^dsh-workspace-changes-[A-Za-z0-9]{4,16}$/
export const TMP_OBJ_PATTERN = /^tmp_obj_[A-Za-z0-9]{6}$/
const HEX2 = /^[0-9a-fA-F]{2}$/

/** Named presets from the requirement document §3.4. */
export const MODES = Object.freeze({
  safe: { retainDays: 30, quotaBytes: 50 * GIB },
  normal: { retainDays: 14, quotaBytes: 50 * GIB },
  aggressive: { retainDays: 1, quotaBytes: 30 * GIB },
})

export function defaultCacheRoot() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'dsh-cache-cleaner');
  }
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'dsh-cache-cleaner');
}

export const DEFAULT_CONFIG = Object.freeze({
  cacheRoot: null,
  tempSubdir: 'temp',
  /** null means "capture os.tmpdir() now"; the plugin must pass the pre-redirect value explicitly. */
  legacyTempDir: null,
  legacyTempDirs: [],
  /** os.tmpdir() before any redirect; used to reject a tempRoot that would clean the system temp dir. */
  originalTemp: null,
  mode: 'normal',
  retainDays: null,
  quotaBytes: null,
  quotaTargetRatio: 0.8,
  legacyMinAgeHours: 24,
  includeLegacy: true,
  batchSize: 45,
  apply: false,
  verifyFreeSpace: true,
  removeEmptyDirs: true,
  allowUnmarkedRoot: false,
  reportDir: null,
  reportKeep: 30,
  writeReport: true,
  markerFileName: MARKER_FILE,
})

export function cacheTempRoot (config = {}) {
  const cacheRoot = path.resolve(config.cacheRoot ?? defaultCacheRoot())
  const sub = config.tempSubdir ?? DEFAULT_CONFIG.tempSubdir
  return sub ? path.join(cacheRoot, sub) : cacheRoot
}

function stripUndefined (object) {
  const out = {}
  for (const [key, value] of Object.entries(object ?? {})) {
    if (value !== undefined) out[key] = value
  }
  return out
}

function samePath (a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
}

/** Merge defaults, preset gates and explicit overrides into one resolved config. */
export function normalizeConfig (options = {}) {
  const mode = Object.hasOwn(MODES, options.mode) ? options.mode : 'normal'
  const preset = MODES[mode]
  const cfg = { ...DEFAULT_CONFIG, ...stripUndefined(options), mode }
  if (options.retainDays === undefined || options.retainDays === null) cfg.retainDays = preset.retainDays
  if (options.quotaBytes === undefined || options.quotaBytes === null) cfg.quotaBytes = preset.quotaBytes
  cfg.cacheRoot = path.resolve(cfg.cacheRoot)
  cfg.tempRoot = cacheTempRoot(cfg)
  cfg.originalTemp = cfg.originalTemp ? path.resolve(cfg.originalTemp) : null
  cfg.retainDays = Number(cfg.retainDays)
  cfg.quotaBytes = Number(cfg.quotaBytes)
  cfg.quotaTargetRatio = Number(cfg.quotaTargetRatio) > 0 && Number(cfg.quotaTargetRatio) <= 1
    ? Number(cfg.quotaTargetRatio)
    : 0.8
  cfg.quotaTargetBytes = Math.floor(cfg.quotaBytes * cfg.quotaTargetRatio)
  cfg.batchSize = Math.max(1, Math.floor(Number(cfg.batchSize) || 45))
  cfg.legacyMinAgeHours = Math.max(1, Number(cfg.legacyMinAgeHours) || 24)
  cfg.reportDir = path.resolve(cfg.reportDir ?? path.join(cfg.cacheRoot, 'reports'))
  // legacy roots: explicit list + single legacyTempDir, resolved and de-duplicated
  const legacyInput = [
    ...(Array.isArray(options.legacyTempDirs) ? options.legacyTempDirs : []),
    cfg.legacyTempDir,
  ].filter((value) => typeof value === 'string' && value.trim() !== '')
  const legacy = []
  for (const candidate of legacyInput) {
    const resolved = path.resolve(candidate)
    if (samePath(resolved, cfg.tempRoot) || samePath(resolved, cfg.cacheRoot)) continue
    if (!legacy.some((existing) => samePath(existing, resolved))) legacy.push(resolved)
  }
  cfg.resolvedLegacyRoots = cfg.includeLegacy ? legacy : []
  return cfg
}

// ---------------------------------------------------------------------------
// Root marker
// ---------------------------------------------------------------------------

export async function hasRootMarker (cacheRoot) {
  const marker = path.join(path.resolve(cacheRoot), MARKER_FILE)
  try {
    const parsed = JSON.parse(await fsp.readFile(marker, 'utf8'))
    return parsed?.schema === MARKER_SCHEMA
  } catch {
    return false
  }
}

/** Create the marker file that marks a directory as a dsh-cache-cleaner cache root. */
export async function ensureRootMarker (cacheRoot, { force = false } = {}) {
  const root = path.resolve(cacheRoot)
  await fsp.mkdir(root, { recursive: true })
  const marker = path.join(root, MARKER_FILE)
  let existing = null
  try { existing = JSON.parse(await fsp.readFile(marker, 'utf8')) } catch { existing = null }
  if (existing?.schema === MARKER_SCHEMA) return marker
  if (existing !== null && !force) {
    throw new Error(`refusing to mark ${root}: existing ${MARKER_FILE} is not a ${MARKER_SCHEMA} file`)
  }
  await writeJsonFile(marker, {
    schema: MARKER_SCHEMA,
    createdAt: new Date().toISOString(),
    createdBy: 'dsh-cache-cleaner',
    note: 'This directory is managed by the dsh-cache-cleaner DSH plugin. Removing this file disables automatic cleanup.',
  })
  return marker
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/** Inspect one `dsh-workspace-changes-*` directory without following symlinks. */
async function inspectSessionDir (dirPath) {
  let stat
  try { stat = await fsp.lstat(dirPath) } catch { return null }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return null
  const info = {
    path: dirPath,
    name: path.basename(dirPath),
    mtimeMs: stat.mtimeMs,
    totalFiles: 0,
    otherFiles: 0,
    bytes: 0,
    candidates: [],
  }
  const walk = async (current) => {
    let entries
    try { entries = await fsp.readdir(current, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name)
      if (entry.isSymbolicLink()) { info.otherFiles += 1; continue }
      if (entry.isDirectory()) { await walk(entryPath); continue }
      if (!entry.isFile()) { info.otherFiles += 1; continue }
      let fileStat
      try { fileStat = await fsp.lstat(entryPath) } catch { continue }
      info.totalFiles += 1
      info.bytes += fileStat.size
      const parentName = path.basename(path.dirname(entryPath))
      const grandParentName = path.basename(path.dirname(path.dirname(entryPath)))
      const isWhitelisted = grandParentName === 'objects' && HEX2.test(parentName) && TMP_OBJ_PATTERN.test(entry.name)
      if (isWhitelisted) {
        info.candidates.push({ path: entryPath, size: fileStat.size, mtimeMs: fileStat.mtimeMs })
      } else {
        info.otherFiles += 1
      }
    }
  }
  await walk(dirPath)
  return info
}

function rootKind (kind, root) {
  return { kind, root }
}

/** Scan one root for session directories. Missing roots are reported, not thrown. */
export async function scanRoot (root, kind = 'cache') {
  const result = { ...rootKind(kind, root), exists: false, dirs: [], bytes: 0, files: 0 }
  let entries
  try { entries = await fsp.readdir(root, { withFileTypes: true }) } catch { return result }
  result.exists = true
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    if (!SESSION_DIR_PATTERN.test(entry.name)) continue
    const dir = await inspectSessionDir(path.join(root, entry.name))
    if (dir === null) continue
    result.dirs.push(dir)
    result.bytes += dir.bytes
    result.files += dir.totalFiles
  }
  result.dirs.sort((a, b) => a.mtimeMs - b.mtimeMs)
  return result
}

/**
 * Read-only inventory of the cache roots. Used by `cache_status` and the CLI.
 */
export async function inspectCache (options = {}) {
  const cfg = normalizeConfig(options)
  const cacheRootScan = await scanRoot(cfg.tempRoot, 'cache')
  const legacyScans = []
  for (const root of cfg.resolvedLegacyRoots) legacyScans.push(await scanRoot(root, 'legacy'))
  return {
    schema: SCHEMA,
    generatedAt: nowIso(),
    config: {
      cacheRoot: cfg.cacheRoot,
      tempRoot: cfg.tempRoot,
      legacyRoots: cfg.resolvedLegacyRoots,
      mode: cfg.mode,
      retainDays: cfg.retainDays,
      quotaBytes: cfg.quotaBytes,
    },
    cache: {
      root: cfg.tempRoot,
      exists: cacheRootScan.exists,
      sessionDirs: cacheRootScan.dirs.length,
      bytes: cacheRootScan.bytes,
      files: cacheRootScan.files,
      dirs: cacheRootScan.dirs.map((dir) => ({
        name: dir.name,
        bytes: dir.bytes,
        files: dir.totalFiles,
        candidates: dir.candidates.length,
        mtime: new Date(dir.mtimeMs).toISOString(),
      })),
    },
    legacy: legacyScans.map((scan) => ({
      root: scan.root,
      exists: scan.exists,
      sessionDirs: scan.dirs.length,
      bytes: scan.bytes,
      files: scan.files,
      dirs: scan.dirs.map((dir) => ({
        name: dir.name,
        bytes: dir.bytes,
        files: dir.totalFiles,
        candidates: dir.candidates.length,
        mtime: new Date(dir.mtimeMs).toISOString(),
      })),
    })),
  }
}

// ---------------------------------------------------------------------------
// Candidate selection (G1 age / L1 legacy / G2 quota)
// ---------------------------------------------------------------------------

function selectCandidates (scans, cfg, now) {
  const retainCutoff = now - cfg.retainDays * DAY_MS
  const legacyCutoff = now - cfg.legacyMinAgeHours * 60 * 60 * 1000
  const picked = new Map()
  const ordered = []
  let cacheBytes = 0

  for (const scan of scans) {
    const isLegacy = scan.kind === 'legacy'
    const dirCutoff = isLegacy ? legacyCutoff : retainCutoff
    for (const dir of scan.dirs) {
      ordered.push({ dir, scan })
      if (!isLegacy) cacheBytes += dir.bytes
      if (dir.mtimeMs > dirCutoff) continue
      for (const candidate of dir.candidates) {
        if (candidate.mtimeMs > dirCutoff) continue
        picked.set(candidate.path, {
          path: candidate.path,
          size: candidate.size,
          mtime: new Date(candidate.mtimeMs).toISOString(),
          mtimeMs: candidate.mtimeMs,
          dir: dir.path,
          dirMtimeMs: dir.mtimeMs,
          dirKind: scan.kind,
          dirRoot: scan.root,
          reason: isLegacy ? 'legacy' : 'age',
        })
      }
    }
  }

  if (cfg.quotaBytes > 0 && cacheBytes > cfg.quotaBytes) {
    let projected = cacheBytes
    for (const candidate of picked.values()) {
      if (candidate.dirKind === 'cache') projected -= candidate.size
    }
    if (projected > cfg.quotaTargetBytes) {
      const cacheDirs = ordered
        .filter(({ scan }) => scan.kind === 'cache')
        .sort((a, b) => a.dir.mtimeMs - b.dir.mtimeMs)
      let done = false
      for (const { dir, scan } of cacheDirs) {
        if (done) break
        const files = [...dir.candidates].sort((a, b) => a.mtimeMs - b.mtimeMs)
        for (const candidate of files) {
          if (projected <= cfg.quotaTargetBytes) { done = true; break }
          if (picked.has(candidate.path)) continue
          picked.set(candidate.path, {
            path: candidate.path,
            size: candidate.size,
            mtime: new Date(candidate.mtimeMs).toISOString(),
            mtimeMs: candidate.mtimeMs,
            dir: dir.path,
            dirMtimeMs: dir.mtimeMs,
            dirKind: 'cache',
            dirRoot: scan.root,
            reason: 'quota',
          })
          projected -= candidate.size
        }
      }
    }
  }

  return { candidates: [...picked.values()], cacheBytes, retainCutoff, legacyCutoff }
}

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

async function clearReadOnly (filePath) {
  try { await fsp.chmod(filePath, 0o666) } catch { /* best effort; unlink decides */ }
}

function errorReason (error) {
  return error?.code ?? error?.message ?? 'UNKNOWN'
}

async function measureVolumes (volumes) {
  const result = []
  for (const volume of volumes) {
    const free = await freeBytes(volume)
    result.push({ path: volume, free })
  }
  return result
}

async function pruneReports (reportDir, keep) {
  let entries
  try { entries = await fsp.readdir(reportDir) } catch { return }
  const reports = []
  for (const name of entries) {
    if (!/^cleanup-.*\.json$/.test(name)) continue
    const filePath = path.join(reportDir, name)
    try {
      const stat = await fsp.stat(filePath)
      reports.push({ filePath, mtimeMs: stat.mtimeMs })
    } catch { /* ignore */ }
  }
  reports.sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const stale of reports.slice(Math.max(0, keep))) {
    try { await fsp.unlink(stale.filePath) } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Scan, decide and (when `apply`) delete whitelisted temporary objects.
 * Never throws for expected filesystem failures: they are returned in the report.
 */
export async function cleanup (options = {}) {
  const startedAt = Date.now()
  const cfg = normalizeConfig(options)
  const report = {
    schema: SCHEMA,
    generatedAt: nowIso(startedAt),
    apply: cfg.apply === true,
    mode: cfg.mode,
    roots: {
      cacheRoot: cfg.cacheRoot,
      tempRoot: cfg.tempRoot,
      legacy: cfg.resolvedLegacyRoots,
    },
    gates: {
      retainDays: cfg.retainDays,
      quotaBytes: cfg.quotaBytes,
      quotaTargetBytes: cfg.quotaTargetBytes,
      legacyMinAgeHours: cfg.legacyMinAgeHours,
    },
    totals: {
      scannedDirs: 0,
      scannedFiles: 0,
      scannedBytes: 0,
      candidateFiles: 0,
      candidateBytes: 0,
      deletedFiles: 0,
      deletedBytes: 0,
      skippedFiles: 0,
      dirsRemoved: 0,
    },
    volumes: [],
    candidates: [],
    deleted: [],
    skipped: [],
    warnings: [],
    truncated: false,
    error: null,
    durationMs: 0,
  }

  // --- root safety -------------------------------------------------------
  if (!cfg.cacheRoot || cfg.cacheRoot === path.parse(cfg.cacheRoot).root) {
    report.error = 'INVALID_ROOT'
    report.warnings.push(`cacheRoot ${JSON.stringify(cfg.cacheRoot)} is a volume root or empty`)
    report.durationMs = Date.now() - startedAt
    return report
  }
  if (!isInside(cfg.cacheRoot, cfg.tempRoot)) {
    report.error = 'INVALID_ROOT'
    report.warnings.push('tempRoot must stay inside cacheRoot')
    report.durationMs = Date.now() - startedAt
    return report
  }
  if (cfg.originalTemp && samePath(cfg.tempRoot, cfg.originalTemp)) {
    report.error = 'INVALID_ROOT'
    report.warnings.push('tempRoot must not equal the system temporary directory')
    report.durationMs = Date.now() - startedAt
    return report
  }
  if (!cfg.allowUnmarkedRoot && !(await hasRootMarker(cfg.cacheRoot))) {
    report.error = 'UNMARKED_ROOT'
    report.warnings.push(`refusing to clean ${cfg.cacheRoot}: missing ${MARKER_FILE}`)
    report.durationMs = Date.now() - startedAt
    return report
  }

  // --- scan --------------------------------------------------------------
  const scans = []
  try {
    const cacheScan = await scanRoot(cfg.tempRoot, 'cache')
    if (cacheScan.exists) scans.push(cacheScan)
    else report.warnings.push(`cache temp root does not exist yet: ${cfg.tempRoot}`)
    for (const root of cfg.resolvedLegacyRoots) {
      const legacyScan = await scanRoot(root, 'legacy')
      if (!legacyScan.exists) { report.warnings.push(`legacy root does not exist: ${root}`); continue }
      scans.push(legacyScan)
    }
  } catch (error) {
    report.error = `SCAN_FAILED: ${errorReason(error)}`
    report.durationMs = Date.now() - startedAt
    return report
  }

  for (const scan of scans) {
    report.totals.scannedDirs += scan.dirs.length
    report.totals.scannedFiles += scan.files
    report.totals.scannedBytes += scan.bytes
  }

  const now = Date.now()
  const selection = selectCandidates(scans, cfg, now)
  report.totals.candidateFiles = selection.candidates.length
  report.totals.candidateBytes = selection.candidates.reduce((sum, item) => sum + item.size, 0)
  const allCandidates = [...selection.candidates].sort(
    (a, b) => (a.dirMtimeMs ?? 0) - (b.dirMtimeMs ?? 0) || a.mtimeMs - b.mtimeMs,
  )
  report.truncated = allCandidates.length > 2000
  report.candidates = allCandidates.slice(0, 2000).map(({ dirMtimeMs, dirKind, dirRoot, ...rest }) => rest)

  // --- delete -------------------------------------------------------------
  if (cfg.apply === true && allCandidates.length > 0) {
    const volumes = [...new Set([cfg.cacheRoot, ...cfg.resolvedLegacyRoots].map(volumeRoot))]
    const before = await measureVolumes(volumes)
    const beforeByVolume = new Map(before.map((item) => [item.path, item.free]))
    const deletedByVolume = new Map()
    const deletedByDir = new Map()
    const deletedLedger = []
    for (const [index, candidate] of allCandidates.entries()) {
      const volume = volumeRoot(candidate.path)
      try {
        await clearReadOnly(candidate.path)
        await fsp.unlink(candidate.path)
        report.totals.deletedFiles += 1
        report.totals.deletedBytes += candidate.size
        deletedByVolume.set(volume, (deletedByVolume.get(volume) ?? 0) + candidate.size)
        deletedByDir.set(candidate.dir, (deletedByDir.get(candidate.dir) ?? 0) + 1)
        deletedLedger.push({ dir: candidate.dir })
        if (report.deleted.length < 2000) {
          report.deleted.push({
            path: candidate.path,
            size: candidate.size,
            mtime: candidate.mtime,
            dir: candidate.dir,
            reason: candidate.reason,
          })
        }
      } catch (error) {
        report.totals.skippedFiles += 1
        if (report.skipped.length < 2000) {
          report.skipped.push({ path: candidate.path, size: candidate.size, reason: errorReason(error) })
        }
      }
      if ((index + 1) % cfg.batchSize === 0) await sleep(50)
    }
    const after = await measureVolumes(volumes)
    for (const item of after) {
      const freeBefore = beforeByVolume.get(item.path) ?? null
      const delta = freeBefore !== null && item.free !== null ? item.free - freeBefore : null
      const expected = deletedByVolume.get(item.path) ?? 0
      report.volumes.push({ path: item.path, freeBefore, freeAfter: item.free, delta, expected })
      if (cfg.verifyFreeSpace && expected > 0 && delta !== null) {
        if (delta <= 0) {
          report.warnings.push(`${item.path}: deleted ${formatBytes(expected)} but free space did not grow (delta ${formatBytes(delta)}); deletion may have been redirected to the recycle bin`)
        } else if (delta < expected * 0.95) {
          report.warnings.push(`${item.path}: freed ${formatBytes(delta)} < deleted ${formatBytes(expected)} (tolerance 5%)`)
        }
      }
    }

    // --- remove now-empty session directories ---------------------------
    if (cfg.removeEmptyDirs) {
      for (const { dir, scan } of collectDirs(scans)) {
        const remaining = dir.totalFiles - (deletedByDir.get(dir.path) ?? 0)
        if (remaining > 0) continue
        const cutoff = scan.kind === 'legacy' ? selection.legacyCutoff : selection.retainCutoff
        if (dir.mtimeMs > cutoff) continue
        try {
          if (await countFiles(dir.path) !== 0) continue
          if (await removeEmptyTree(dir.path)) report.totals.dirsRemoved += 1
        } catch { /* best effort */ }
      }
    }
  }

  // --- report -------------------------------------------------------------
  report.durationMs = Date.now() - startedAt
  if (cfg.writeReport) {
    try {
      const filePath = path.join(cfg.reportDir, `cleanup-${stampForFile()}-${cfg.apply ? 'apply' : 'dryrun'}.json`)
      await writeJsonFile(filePath, report)
      report.reportPath = filePath
      await pruneReports(cfg.reportDir, cfg.reportKeep)
    } catch (error) {
      report.warnings.push(`report write failed: ${errorReason(error)}`)
    }
  }
  return report
}

function collectDirs (scans) {
  const out = []
  for (const scan of scans) for (const dir of scan.dirs) out.push({ dir, scan })
  return out
}

export { formatBytes }
