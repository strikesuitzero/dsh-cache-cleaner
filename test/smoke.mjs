// Lead smoke test for the cleaner. Not the independent acceptance suite
// (that lives in ../test-independent and is owned by the verifier).
//
//   node test/smoke.mjs
//
// Builds a scaled fixture under ../_tmp (or os.tmpdir for the legacy root),
// runs dry-run + apply against it, and asserts the core invariants.

import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  cleanup, ensureRootMarker, hasRootMarker, cacheTempRoot, inspectCache,
} from '../lib/cleaner.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const base = path.resolve(here, '..', '_tmp', `smoke-${process.pid}-${Date.now()}`)
const cacheRoot = path.join(base, 'DSH cache')
const tempRoot = cacheTempRoot({ cacheRoot })
const legacyRoot = path.join(base, 'legacy-temp')

const DAY = 24 * 60 * 60 * 1000
const now = Date.now()
const failures = []
const results = []

function check (name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail })
  if (!condition) failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
}

async function writeFile (filePath, bytes) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  await fsp.writeFile(filePath, Buffer.alloc(bytes, 0x61))
}

async function age (target, msAgo) {
  const when = new Date(now - msAgo)
  await fsp.utimes(target, when, when)
}

async function makeSessionDir (root, name, { dirAgeMs, objectAgeMs, objects = [], keep = [] }) {
  const dir = path.join(root, name)
  for (const objectName of objects) {
    const filePath = path.join(dir, 'objects', '61', objectName)
    await writeFile(filePath, 1024 * 1024)
    await fsp.chmod(filePath, 0o444) // ReadOnly, like the real ones
    await age(filePath, objectAgeMs)
  }
  for (const keepName of keep) {
    const filePath = path.join(dir, keepName)
    await writeFile(filePath, 4096)
    await age(filePath, objectAgeMs)
  }
  await age(dir, dirAgeMs)
  return dir
}

async function exists (target) {
  try { await fsp.lstat(target); return true } catch { return false }
}

async function main () {
  // --- fixture ---------------------------------------------------------
  await fsp.mkdir(tempRoot, { recursive: true })
  await fsp.mkdir(legacyRoot, { recursive: true })
  await ensureRootMarker(cacheRoot)
  check('A? marker created', await hasRootMarker(cacheRoot))

  const oldDir = await makeSessionDir(tempRoot, 'dsh-workspace-changes-OLD111', {
    dirAgeMs: 20 * DAY,
    objectAgeMs: 20 * DAY,
    objects: ['tmp_obj_AAA111', 'tmp_obj_AAA222'],
    keep: [
      path.join('captures', 'a'.repeat(40)),
      path.join('objects', '03', 'b'.repeat(40)),
    ],
  })
  const newDir = await makeSessionDir(tempRoot, 'dsh-workspace-changes-NEW222', {
    dirAgeMs: 0,
    objectAgeMs: 0,
    objects: ['tmp_obj_BBB111'],
    keep: [path.join('captures', 'c'.repeat(40))],
  })
  const legacyDir = await makeSessionDir(legacyRoot, 'dsh-workspace-changes-LEG333', {
    dirAgeMs: 30 * 60 * 60 * 1000,
    objectAgeMs: 30 * 60 * 60 * 1000,
    objects: ['tmp_obj_CCC111'],
    keep: [path.join('objects', '03', 'd'.repeat(40))],
  })

  const common = {
    cacheRoot,
    tempSubdir: 'temp',
    legacyTempDirs: [legacyRoot],
    includeLegacy: true,
    mode: 'normal',
    originalTemp: path.join(base, 'system-temp'),
    writeReport: true,
    verifyFreeSpace: false,
  }

  // --- A4: unmarked root is refused -----------------------------------
  const unmarkedRoot = path.join(base, 'unmarked')
  await fsp.mkdir(path.join(unmarkedRoot, 'temp', 'dsh-workspace-changes-XXX111', 'objects', '61'), { recursive: true })
  const unmarkedReport = await cleanup({ ...common, cacheRoot: unmarkedRoot, legacyTempDirs: [], includeLegacy: false, apply: true })
  check('A4 unmarked root refused', unmarkedReport.error === 'UNMARKED_ROOT', String(unmarkedReport.error))
  check('A4 unmarked root deleted nothing', unmarkedReport.totals.deletedFiles === 0)

  // --- A1: dry-run set equals apply set --------------------------------
  const dry = await cleanup({ ...common, apply: false })
  check('A1 dry-run finds 3 candidates', dry.totals.candidateFiles === 3, `got ${dry.totals.candidateFiles}`)
  check('A1 dry-run deletes nothing', dry.totals.deletedFiles === 0)
  check('A1 dry-run leaves old object', await exists(path.join(oldDir, 'objects', '61', 'tmp_obj_AAA111')))

  const applied = await cleanup({ ...common, apply: true })
  const drySet = new Set(dry.candidates.map((item) => item.path))
  const applySet = new Set(applied.deleted.map((item) => item.path))
  check('A1 same candidate set', drySet.size === applySet.size && [...drySet].every((item) => applySet.has(item)),
    `dry=${drySet.size} apply=${applySet.size}`)
  check('A1 applied deletes 3', applied.totals.deletedFiles === 3, `got ${applied.totals.deletedFiles}`)
  check('A1 deleted bytes > 3MB', applied.totals.deletedBytes >= 3 * 1024 * 1024, String(applied.totals.deletedBytes))

  // --- A5: ReadOnly files were deleted --------------------------------
  check('A5 readonly old object deleted', !(await exists(path.join(oldDir, 'objects', '61', 'tmp_obj_AAA111'))))

  // --- A7: forbidden targets untouched --------------------------------
  check('A7 captures kept', await exists(path.join(oldDir, 'captures', 'a'.repeat(40))))
  check('A7 sha1 object kept', await exists(path.join(oldDir, 'objects', '03', 'b'.repeat(40))))
  check('A7 new session object kept', await exists(path.join(newDir, 'objects', '61', 'tmp_obj_BBB111')))
  check('A7 legacy captures kept', await exists(path.join(legacyDir, 'objects', '03', 'd'.repeat(40))))
  check('A7 marker kept', await hasRootMarker(cacheRoot))

  // --- A3: idempotent --------------------------------------------------
  const second = await cleanup({ ...common, apply: true })
  check('A3 second run deletes nothing', second.totals.deletedFiles === 0, `got ${second.totals.deletedFiles}`)

  // --- A9: quota gate --------------------------------------------------
  const quotaDir = path.join(tempRoot, 'dsh-workspace-changes-QTA444')
  for (let index = 0; index < 4; index += 1) {
    const filePath = path.join(quotaDir, 'objects', '61', `tmp_obj_Q${String(index).padStart(5, '0')}`)
    await writeFile(filePath, 1024 * 1024)
    await age(filePath, (index + 1) * 60 * 60 * 1000)
  }
  await age(quotaDir, 2 * DAY)
  const before = await inspectCache({ ...common, includeLegacy: false })
  const beforeBytes = before.cache.bytes
  const quotaReport = await cleanup({
    ...common,
    includeLegacy: false,
    legacyTempDirs: [],
    quotaBytes: Math.floor(beforeBytes * 0.75),
    quotaTargetRatio: 0.8,
    apply: true,
  })
  const after = await inspectCache({ ...common, includeLegacy: false })
  check('A9 quota gate reduced total', after.cache.bytes <= beforeBytes * 0.75 * 0.8 + 1,
    `before=${beforeBytes} after=${after.cache.bytes} target=${Math.floor(beforeBytes * 0.75 * 0.8)}`)
  check('A9 quota candidates had reason quota', quotaReport.deleted.some((item) => item.reason === 'quota'),
    JSON.stringify(quotaReport.deleted.map((item) => item.reason)))

  // --- report ----------------------------------------------------------
  const reports = await fsp.readdir(path.join(cacheRoot, 'reports'))
  check('report written', reports.some((name) => name.startsWith('cleanup-')), reports.join(','))

  // --- inventory export -------------------------------------------------
  console.log(JSON.stringify({ base, results }, null, 2))
  if (failures.length > 0) {
    console.error(`FAIL ${failures.length}/${results.length}`)
    for (const failure of failures) console.error(` - ${failure}`)
    process.exit(1)
  }
  console.log(`PASS ${results.length}/${results.length}`)
}

main().catch((error) => { console.error(error); process.exit(1) })
