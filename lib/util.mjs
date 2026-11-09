// Small, dependency-free helpers shared by the cleaner, CLI and the DSH plugin.
import { promises as fsp } from 'node:fs'
import path from 'node:path'

export const GIB = 1024 ** 3
export const MIB = 1024 ** 2
export const DAY_MS = 24 * 60 * 60 * 1000

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function nowIso (now = Date.now ()) {
  return new Date(now).toISOString()
}

export function formatBytes (bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`
}

/** Volume root of an absolute path ("D:\\Python\\x" -> "D:\\"), used as a statfs key. */
export function volumeRoot (target) {
  const parsed = path.parse(path.resolve(target))
  return parsed.root || path.resolve(target)
}

/**
 * Bytes available on the volume that holds `target`, or null when the platform
 * cannot report it. Never throws: reporting is best-effort.
 */
export async function freeBytes (target) {
  try {
    const fsStat = await fsp.statfs(volumeRoot(target))
    const bytes = Number(fsStat.bavail) * Number(fsStat.bsize)
    return Number.isFinite(bytes) ? bytes : null
  } catch {
    return null
  }
}

/** True when `child` is strictly inside `parent` (no traversal escape, no prefix trick). */
export function isInside (parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** Count regular files below `dir` (symlinks are not followed and not counted). */
export async function countFiles (dir) {
  let count = 0
  let entries
  try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return 0 }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    if (entry.isFile()) { count += 1; continue }
    if (entry.isDirectory()) count += await countFiles(path.join(dir, entry.name))
  }
  return count
}

/** Remove a directory tree, best effort; returns true when the path is gone. */
export async function removeEmptyTree (dir) {
  try {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
    return true
  } catch {
    return false
  }
}

/** Atomic-ish JSON write: write a sibling temp file, then rename over the target. */
export async function writeJsonFile (filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await fsp.rename(tmp, filePath)
}

export function stampForFile (now = Date.now()) {
  const d = new Date(now)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}
