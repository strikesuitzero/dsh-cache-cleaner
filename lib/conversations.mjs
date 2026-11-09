/**
 * dsh-cache-cleaner v2 —— 会话（对话）归属与已归档会话删除引擎。
 *
 * 契约：dsh-cache-cleaner/DESIGN-v2.md（§1 数据模型、§3 安全规则、§4 引擎 API）。
 *
 * 纯 Node 实现（只依赖 node: 内置模块和 ./util.mjs），不 import 宿主服务；
 * 因此 CLI 可以离线使用，夹具测试也不需要起 DSH。
 *
 * 诚实边界：
 *  - 会话日志、projcache、附件（sha256 引用）是「精确归属」；
 *  - %TEMP%\dsh-workspace-changes-* 没有任何持久化归属信息，只能按
 *    目录活动时间窗与会话 [createdAt, lastActivityAt] 的交集推断，
 *    所有这类结论都带 confidence:'time-window'，不得表述为「属于某会话」。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { DAY_MS, stampForFile, writeJsonFile } from './util.mjs';

/** 报告 schema（S11：<cacheRoot>/reports/conversation-<ts>-{plan|apply}.json）。 */
export const CONVERSATION_SCHEMA = 'dsh-cache-cleaner/conversation/v2';

const ZSTD_MAGIC = 4247762216;
const SESSION_LOG_RE = /^session\.v(\d+)\.jsonl\.zstd$/;
const SESSION_DIR_RE = /^dsh-workspace-changes-[A-Za-z0-9]{4,16}$/;
const TMP_OBJ_RE = /^tmp_obj_[A-Za-z0-9]{6}$/;
const ATTACHMENT_ID_RE = /sha256:([0-9a-f]{64})/gi;
const REPORT_RE = /^conversation-.*\.json$/;
const REPORT_KEEP = 30;

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

/** DSH_HOME：显式参数优先，其次 DSH_HOME 环境变量，最后 %USERPROFILE%\.dsh。 */
export function dshHomePath(env = process.env) {
  const fromEnv = env?.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return path.resolve(fromEnv);
  return path.join(os.homedir(), '.dsh');
}

export function sessionsRoot(dshHome) {
  return path.join(path.resolve(dshHome), 'sessions');
}

function projcacheRoot(dshHome) {
  return path.join(path.resolve(dshHome), 'storages', 'session_projcache', 'sessions');
}

function projcacheFile(dshHome, sessionId) {
  return path.join(projcacheRoot(dshHome), `${sessionId}.json`);
}

function attachmentsRoot(dshHome) {
  return path.join(path.resolve(dshHome), 'attachments', 'v1');
}

function workspaceJsonPath(dshHome) {
  return path.join(path.resolve(dshHome), 'storages', 'workspace.json');
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function errorReason(error) {
  return error?.code ?? error?.message ?? String(error);
}

function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function statSafe(target) {
  try {
    return await fsp.stat(target);
  } catch {
    return null;
  }
}

async function lstatSafe(target) {
  try {
    return await fsp.lstat(target);
  } catch {
    return null;
  }
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(Number(limit) || 1, items.length || 1));
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    }),
  );
  return results;
}

// ---------------------------------------------------------------------------
// 会话日志：多帧 zstd 容器
// ---------------------------------------------------------------------------

/**
 * 扫描一个拼接 zstd 容器里的帧边界。
 * 规则与 @deepseek-ai/dsh-session-persistence-jsonl 的 scanZstdFrames 一致：
 * 结构不完整（末尾 torn 帧）时返回已解析帧与 tornStart，不抛错。
 * @returns {{ frames: Array<{start:number,end:number}>, tornStart?: number }}
 */
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    try {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return { frames, tornStart: start };
      offset += 4;
      if (offset >= buffer.length) return { frames, tornStart: start };
      const descriptor = buffer.readUInt8(offset);
      offset += 1;
      if ((descriptor & 0x18) !== 0) return { frames, tornStart: start };
      const contentSizeFlag = descriptor >>> 6;
      const singleSegment = (descriptor & 0x20) !== 0;
      const hasChecksum = (descriptor & 0x04) !== 0;
      const dictionaryFlag = descriptor & 0x03;
      const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
      const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
      offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
      for (;;) {
        if (buffer.length - offset < 3) return { frames, tornStart: start };
        const header = buffer.readUIntLE(offset, 3);
        offset += 3;
        const last = (header & 1) === 1;
        const blockType = (header >>> 1) & 0x03;
        const blockSize = header >>> 3;
        if (blockType === 3) return { frames, tornStart: start };
        offset += blockType === 1 ? 1 : blockSize;
        if (offset > buffer.length) return { frames, tornStart: start };
        if (last) break;
      }
      if (hasChecksum) offset += 4;
      if (offset > buffer.length) return { frames, tornStart: start };
      frames.push({ start, end: offset });
    } catch {
      return { frames, tornStart: start };
    }
  }
  return { frames };
}

function decodeLogBuffer(buffer) {
  const { frames, tornStart } = scanZstdFrames(buffer);
  const chunks = [];
  const warnings = [];
  for (const frame of frames) {
    try {
      chunks.push(zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8'));
    } catch (error) {
      warnings.push(`frame decode failed at ${frame.start}: ${errorReason(error)}`);
    }
  }
  const text = chunks.join('');
  const events = [];
  let badLines = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      badLines += 1;
    }
  }
  if (badLines > 0) warnings.push(`${badLines} unparsable log line(s)`);
  const header = events.find((event) => event && event.type === 'session') ?? null;
  return { text, events, header, frameCount: frames.length, tornStart, warnings };
}

/**
 * 只读文件前 maxBytes 字节。会话日志是拼接 zstd 帧，头部事件和第一条用户消息通常都在前几帧，
 * 因此列会话时没必要把整份日志（实测单份可达 37MB 明文）全部读进来再解压。
 */
async function readFilePrefix(file, maxBytes) {
  const handle = await fsp.open(file, 'r');
  try {
    const stat = await handle.stat();
    const size = Math.min(stat.size, maxBytes);
    const buffer = Buffer.allocUnsafe(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

const LOG_HEAD_BYTES = 16 * 1024;
const LOG_FIRST_TEXT_BYTES = 256 * 1024;
const LOG_FIRST_TEXT_ESCALATED_BYTES = 4 * 1024 * 1024;

/** 从日志前缀里拿 header 和第一条用户消息；前缀不够时只升一级，不退回全量解码。 */
async function readSessionHead(logPaths, { maxBytes = LOG_FIRST_TEXT_BYTES, escalate = true } = {}) {
  const warnings = [];
  let header = null;
  let firstUserText = null;
  for (const file of logPaths) {
    let buffer;
    try {
      buffer = await readFilePrefix(file, maxBytes);
    } catch (error) {
      warnings.push(`${file}: ${errorReason(error)}`);
      continue;
    }
    let decoded = decodeLogBuffer(buffer);
    header = header ?? decoded.header;
    firstUserText = firstUserText ?? extractFirstUserText(decoded.events);
    if (escalate && !firstUserText && buffer.length === maxBytes) {
      try {
        const bigger = await readFilePrefix(file, LOG_FIRST_TEXT_ESCALATED_BYTES);
        if (bigger.length > buffer.length) {
          decoded = decodeLogBuffer(bigger);
          firstUserText = extractFirstUserText(decoded.events);
        }
      } catch {
        /* 升级读取失败就保留已有结果 */
      }
    }
    warnings.push(...decoded.warnings);
    if (header && firstUserText) break;
  }
  return { header, firstUserText, warnings };
}

function logVersion(fileName) {
  const match = SESSION_LOG_RE.exec(fileName);
  return match ? Number(match[1]) : 0;
}

async function decodeSessionLogs(logPaths, cache) {
  const key = logPaths.join('|');
  if (cache?.has(key)) return cache.get(key);
  let text = '';
  let header = null;
  let frameCount = 0;
  let tornStart;
  const warnings = [];
  for (const file of logPaths) {
    let buffer;
    try {
      buffer = await fsp.readFile(file);
    } catch (error) {
      warnings.push(`${file}: ${errorReason(error)}`);
      continue;
    }
    const decoded = decodeLogBuffer(buffer);
    text += decoded.text;
    frameCount += decoded.frameCount;
    if (decoded.tornStart !== undefined) tornStart = decoded.tornStart;
    warnings.push(...decoded.warnings);
    if (!header && decoded.header) header = decoded.header;
  }
  const events = [];
  let badLines = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      badLines += 1;
    }
  }
  if (badLines > 0) warnings.push(`${badLines} unparsable log line(s)`);
  const value = {
    text,
    events,
    header: header ?? events.find((event) => event?.type === 'session') ?? null,
    warnings,
    frameCount,
    tornStart,
  };
  cache?.set(key, value);
  return value;
}

/** 一条用户消息的第一段文本，压平空白后截 80 字。 */
function extractFirstUserText(events) {
  for (const event of events) {
    if (!event || event.type !== 'user/message') continue;
    const content = event.data?.content;
    const texts = [];
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part.text === 'string') texts.push(part.text);
      }
    }
    if (texts.length === 0 && typeof event.data?.text === 'string') texts.push(event.data.text);
    const text = texts.join(' ').replace(/\s+/g, ' ').trim();
    if (text) return text.slice(0, 80);
  }
  return null;
}

/** 日志里出现过的附件 sha256（精确引用：attachmentId:'sha256:<64hex>'）。 */
function collectAttachmentRefs(text, into = new Set()) {
  for (const match of text.matchAll(ATTACHMENT_ID_RE)) into.add(match[1].toLowerCase());
  return into;
}

// ---------------------------------------------------------------------------
// 会话扫描
// ---------------------------------------------------------------------------

async function readSessionMeta(dir, { includeFirstUserText = true } = {}) {
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch {
    return null;
  }
  const logs = names.filter((name) => SESSION_LOG_RE.test(name));
  if (logs.length === 0) return null;
  logs.sort((a, b) => logVersion(b) - logVersion(a));
  const logPaths = logs.map((name) => path.join(dir, name));
  let sizeBytes = 0;
  let mtime = 0;
  for (const file of logPaths) {
    const stat = await statSafe(file);
    if (!stat) continue;
    sizeBytes += stat.size;
    mtime = Math.max(mtime, stat.mtimeMs);
  }
  const head = await readSessionHead(logPaths, {
    maxBytes: includeFirstUserText ? LOG_FIRST_TEXT_BYTES : LOG_HEAD_BYTES,
    escalate: includeFirstUserText,
  });
  const header = head.header;
  const warnings = [];
  const id = typeof header?.id === 'string' && header.id ? header.id : path.basename(dir);
  return {
    id,
    dir,
    logPaths,
    sizeBytes,
    mtime,
    header: header ?? { id },
    firstUserText: includeFirstUserText ? head.firstUserText : null,
    warnings,
  };
}

/**
 * 扫描 DSH_HOME 下所有会话目录。
 * 解析失败或无 header 的目录只记 warning，不中断。
 * @returns {Promise<Array>} SessionMeta[]；数组上带一个不可枚举的 warnings 属性。
 */
export async function scanSessions({ dshHome = dshHomePath(), concurrency = 4, includeFirstUserText = true } = {}) {
  const root = sessionsRoot(dshHome);
  const warnings = [];
  let workspaceNames = [];
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    workspaceNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    warnings.push(`sessions root unreadable: ${errorReason(error)}`);
  }
  const dirs = [];
  for (const workspaceName of workspaceNames) {
    const workspacePath = path.join(root, workspaceName);
    let entries = [];
    try {
      entries = await fsp.readdir(workspacePath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) dirs.push(path.join(workspacePath, entry.name));
    }
  }
  const metas = await mapLimit(dirs, concurrency, async (dir) => {
    try {
      const meta = await readSessionMeta(dir, { includeFirstUserText });
      if (!meta) return null;
      warnings.push(...meta.warnings);
      return meta;
    } catch (error) {
      warnings.push(`${dir}: ${errorReason(error)}`);
      return null;
    }
  });
  const out = metas
    .filter(Boolean)
    .sort((a, b) => (a.header?.createdAt ?? 0) - (b.header?.createdAt ?? 0));
  Object.defineProperty(out, 'warnings', { value: warnings, enumerable: false });
  return out;
}

// ---------------------------------------------------------------------------
// 归档集合
// ---------------------------------------------------------------------------

/**
 * 只读 workspace.json 的归档集合。缺失/损坏时抛错——不能静默当成空集合，
 * 否则「非归档会话」会被误判为可删。
 * @returns {{ ids: string[], path: string }}
 */
export function readArchivedIds(dshHome) {
  const file = workspaceJsonPath(dshHome);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`WORKSPACE_JSON_UNREADABLE: ${errorReason(error)} (${file})`);
  }
  if (!raw || typeof raw !== 'object' || typeof raw.global !== 'object' || raw.global === null) {
    throw new Error(`WORKSPACE_JSON_INVALID: missing global section (${file})`);
  }
  const ids = Array.isArray(raw.global.archivedSessionIds)
    ? raw.global.archivedSessionIds.filter((id) => typeof id === 'string' && id)
    : [];
  return { ids, path: file };
}

// ---------------------------------------------------------------------------
// 对话列表
// ---------------------------------------------------------------------------

export async function listConversations({ dshHome = dshHomePath() } = {}) {
  // 列表只需要 header 与大小；第一条用户消息只为归档行补，避免给所有会话解日志前缀。
  const metas = await scanSessions({ dshHome, includeFirstUserText: false });
  const warnings = [...(metas.warnings ?? [])];
  const byId = new Map(metas.map((meta) => [meta.id, meta]));
  const childrenByParent = new Map();
  for (const meta of metas) {
    const parent = meta.header?.parentSession;
    if (typeof parent === 'string' && parent) {
      if (!childrenByParent.has(parent)) childrenByParent.set(parent, []);
      childrenByParent.get(parent).push(meta.id);
    }
  }
  let archivedIds = [];
  try {
    archivedIds = readArchivedIds(dshHome).ids;
  } catch (error) {
    warnings.push(errorReason(error));
  }
  const archived = [];
  for (const id of archivedIds) {
    const meta = byId.get(id);
    const projPath = projcacheFile(dshHome, id);
    const projStat = await statSafe(projPath);
    const projcacheBytes = projStat?.isFile() ? projStat.size : 0;
    const projcachePath = projStat?.isFile() ? projPath : null;
    const childIds = [...(childrenByParent.get(id) ?? [])];
    if (!meta) {
      archived.push({
        id,
        dir: null,
        cwd: null,
        createdAt: null,
        sizeBytes: 0,
        logDays: null,
        parentSession: null,
        origin: null,
        isGhost: true,
        projcachePath,
        projcacheBytes,
        childIds,
        firstUserText: null,
      });
      continue;
    }
    const createdAt = typeof meta.header?.createdAt === 'number' ? meta.header.createdAt : null;
    const firstUserText = meta.firstUserText ?? (await readSessionHead(meta.logPaths)).firstUserText;
    archived.push({
      id,
      dir: meta.dir,
      cwd: typeof meta.header?.cwd === 'string' ? meta.header.cwd : null,
      createdAt,
      sizeBytes: meta.sizeBytes,
      logDays: createdAt === null ? null : Math.floor(Math.max(0, Date.now() - createdAt) / DAY_MS),
      parentSession: typeof meta.header?.parentSession === 'string' ? meta.header.parentSession : null,
      origin: typeof meta.header?.origin === 'string' ? meta.header.origin : null,
      isGhost: false,
      projcachePath,
      projcacheBytes,
      childIds,
      firstUserText,
    });
    warnings.push(...(meta.warnings ?? []));
  }
  const totalBytes = metas.reduce((sum, meta) => sum + meta.sizeBytes, 0);
  return { archived, all: { count: metas.length, totalBytes }, warnings };
}

// ---------------------------------------------------------------------------
// 删除计划
// ---------------------------------------------------------------------------

function emptyTotals() {
  return {
    sessions: 0,
    sessionBytes: 0,
    projcacheBytes: 0,
    attachmentBytes: 0,
    tempBytes: 0,
    totalBytes: 0,
  };
}

function blockedTarget(id, reason) {
  return { id, logPaths: [], dir: null, sizeBytes: 0, isGhost: false, children: [], blocked: { id, reason } };
}

async function collectRefsBySession(metas, cache) {
  const refsBySession = new Map();
  for (const meta of metas) {
    const decoded = await decodeSessionLogs(meta.logPaths, cache);
    refsBySession.set(meta.id, collectAttachmentRefs(decoded.text));
  }
  return refsBySession;
}

/**
 * 目录活动窗（mtime 最小/最大）与内容测量。
 * Windows 上 birthtime 不可控，所以一律用文件 mtime 作为活动时间，
 * 这也是「时间窗推断」这个 confidence 的来源。
 */
async function measureTree(root) {
  const rootStat = await statSafe(root);
  if (!rootStat) return null;
  const result = {
    sizeBytes: 0,
    fileCount: 0,
    counts: { tmpObj: 0, captures: 0, objects: 0 },
    firstWriteAt: rootStat.mtimeMs,
    lastWriteAt: rootStat.mtimeMs,
  };
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await statSafe(full);
      if (!stat) continue;
      result.sizeBytes += stat.size;
      result.fileCount += 1;
      result.firstWriteAt = Math.min(result.firstWriteAt, stat.mtimeMs);
      result.lastWriteAt = Math.max(result.lastWriteAt, stat.mtimeMs);
      const parts = path.relative(root, full).split(path.sep);
      if (parts[0] === 'captures') result.counts.captures += 1;
      else if (parts[0] === 'objects') {
        if (TMP_OBJ_RE.test(path.basename(full))) result.counts.tmpObj += 1;
        else result.counts.objects += 1;
      }
    }
  }
  return result;
}

async function tempDirCandidates(tempRoots, sessions, includedIds) {
  const windows = [];
  for (const meta of sessions) {
    const start = meta.header?.createdAt;
    if (typeof start !== 'number' || !Number.isFinite(start)) continue;
    windows.push({ sessionId: meta.id, start, end: Math.max(start, meta.mtime) });
  }
  const dirs = [];
  const warnings = [];
  for (const tempRoot of tempRoots) {
    if (!tempRoot) continue;
    let entries = [];
    try {
      entries = await fsp.readdir(tempRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !SESSION_DIR_RE.test(entry.name)) continue;
      const dirPath = path.join(tempRoot, entry.name);
      const measured = await measureTree(dirPath);
      if (!measured) continue;
      const overlapping = windows.filter(
        (window) => window.start < measured.lastWriteAt && window.end > measured.firstWriteAt,
      );
      const containing = windows.filter(
        (window) => window.start <= measured.firstWriteAt && window.end >= measured.lastWriteAt,
      );
      if (containing.length !== 1) {
        warnings.push(`temp dir kept (no unique containing session): ${dirPath}`);
        continue;
      }
      const owner = containing[0].sessionId;
      if (overlapping.some((window) => window.sessionId !== owner)) {
        warnings.push(`temp dir kept (overlapping sessions): ${dirPath}`);
        continue;
      }
      if (!includedIds.has(owner)) {
        warnings.push(`temp dir kept (owning session not deleted): ${dirPath}`);
        continue;
      }
      dirs.push({ path: dirPath, bytes: measured.sizeBytes, confidence: 'time-window', sessionId: owner });
    }
  }
  return { dirs, warnings };
}

/**
 * 生成删除计划（不写文件系统）。
 * 安全规则：只有 archivedSessionIds 里的会话可删；活跃会话、非归档会话一律 blocked 且零写入。
 */
export async function planConversationDeletion({
  dshHome = dshHomePath(),
  sessionIds = null,
  allArchived = false,
  includeArtifacts = false,
  includeTempDirs = false,
  cascade = true,
  legacyTempDir = null,
  legacyTempDirs = [],
  cacheTempDir = null,
  isLive = () => false,
  archivedIds = null,
} = {}) {
  const metas = await scanSessions({ dshHome });
  const warnings = [...(metas.warnings ?? [])];
  const plan = {
    targets: [],
    projcacheFiles: [],
    attachments: [],
    tempDirs: [],
    retainedBy: [],
    tempRoots: [],
    totals: emptyTotals(),
    warnings,
  };

  let archived = Array.isArray(archivedIds) ? archivedIds.slice() : null;
  if (!archived) {
    try {
      archived = readArchivedIds(dshHome).ids;
    } catch (error) {
      warnings.push(errorReason(error));
      archived = [];
    }
  }
  const archivedSet = new Set(archived.filter((id) => typeof id === 'string' && id));
  const byId = new Map(metas.map((meta) => [meta.id, meta]));
  const childrenByParent = new Map();
  for (const meta of metas) {
    const parent = meta.header?.parentSession;
    if (typeof parent === 'string' && parent) {
      if (!childrenByParent.has(parent)) childrenByParent.set(parent, []);
      childrenByParent.get(parent).push(meta.id);
    }
  }

  const requested = allArchived ? archived.slice() : Array.isArray(sessionIds) ? sessionIds.slice() : [];
  const seen = new Set();
  for (const raw of requested) {
    if (typeof raw !== 'string' || !raw) {
      warnings.push(`ignored invalid session id: ${String(raw)}`);
      continue;
    }
    if (seen.has(raw)) continue;
    seen.add(raw);
    if (!archivedSet.has(raw)) {
      plan.targets.push(blockedTarget(raw, 'not_archived'));
      continue;
    }
    if (isLive(raw)) {
      plan.targets.push(blockedTarget(raw, 'live_session'));
      continue;
    }
    plan.targets.push({
      id: raw,
      logPaths: [],
      dir: null,
      sizeBytes: 0,
      isGhost: !byId.has(raw),
      children: [],
    });
  }

  const includedIds = new Set(plan.targets.filter((target) => !target.blocked).map((target) => target.id));
  if (cascade) {
    const queue = [...includedIds];
    while (queue.length > 0) {
      const parent = queue.shift();
      for (const childId of childrenByParent.get(parent) ?? []) {
        if (includedIds.has(childId) || plan.targets.some((target) => target.id === childId)) continue;
        if (isLive(childId)) {
          plan.targets.push(blockedTarget(childId, 'live_session'));
          continue;
        }
        plan.targets.push({
          id: childId,
          logPaths: [],
          dir: null,
          sizeBytes: 0,
          isGhost: !byId.has(childId),
          children: [],
        });
        includedIds.add(childId);
        queue.push(childId);
      }
    }
  }

  const cache = new Map();
  for (const target of plan.targets) {
    if (target.blocked) continue;
    const meta = byId.get(target.id);
    if (meta) {
      target.dir = meta.dir;
      target.logPaths = [...meta.logPaths];
      target.sizeBytes = meta.sizeBytes;
      target.isGhost = false;
      plan.totals.sessions += 1;
      plan.totals.sessionBytes += meta.sizeBytes;
    }
    const projPath = projcacheFile(dshHome, target.id);
    const projStat = await statSafe(projPath);
    if (projStat?.isFile()) {
      plan.projcacheFiles.push({ path: projPath, bytes: projStat.size });
      plan.totals.projcacheBytes += projStat.size;
    }
  }
  for (const target of plan.targets) {
    if (target.blocked) continue;
    target.children = (childrenByParent.get(target.id) ?? []).filter((childId) => includedIds.has(childId));
  }

  // --- 附件（精确归属：sha256 引用）---------------------------------------
  if (includeArtifacts) {
    const deletedMetas = metas.filter((meta) => includedIds.has(meta.id));
    const retainedMetas = metas.filter((meta) => !includedIds.has(meta.id));
    const deletedRefs = await collectRefsBySession(deletedMetas, cache);
    const retainedRefs = await collectRefsBySession(retainedMetas, cache);
    const retainedUnion = new Set();
    for (const refs of retainedRefs.values()) for (const sha of refs) retainedUnion.add(sha);
    const protectors = new Set();
    for (const [sessionId, refs] of retainedRefs) {
      for (const sha of refs) {
        for (const refsOfDeleted of deletedRefs.values()) {
          if (refsOfDeleted.has(sha)) {
            protectors.add(sessionId);
            break;
          }
        }
        if (protectors.has(sessionId)) break;
      }
    }
    plan.retainedBy = [...protectors].sort();

    const root = attachmentsRoot(dshHome);
    const shares = new Set();
    for (const refs of deletedRefs.values()) for (const sha of refs) shares.add(sha);
    for (const sha of [...shares].sort()) {
      if (retainedUnion.has(sha)) continue;
      const objectPath = path.join(root, 'objects', sha.slice(0, 2), sha);
      const fileObjectPath = path.join(root, 'file-objects', sha.slice(0, 2), sha);
      const aliasDir = path.join(root, 'files', sha.slice(0, 2), sha);
      const objectStat = await statSafe(objectPath);
      const fileObjectStat = await statSafe(fileObjectPath);
      const aliasStat = await statSafe(aliasDir);
      const aliasDirs = [];
      let bytes = 0;
      if (objectStat?.isFile()) bytes += objectStat.size;
      if (fileObjectStat?.isFile()) bytes += fileObjectStat.size;
      if (aliasStat?.isDirectory()) {
        aliasDirs.push(aliasDir);
        const measured = await measureTree(aliasDir);
        if (measured) bytes += measured.sizeBytes;
      }
      if (!objectStat?.isFile() && !fileObjectStat?.isFile() && aliasDirs.length === 0) continue;
      plan.attachments.push({
        sha256: sha,
        bytes,
        objectPath: objectStat?.isFile() ? objectPath : null,
        fileObjectPath: fileObjectStat?.isFile() ? fileObjectPath : null,
        aliasDirs,
      });
      plan.totals.attachmentBytes += bytes;
    }
  }

  // --- 临时快照目录（时间窗推断，默认不纳入）-----------------------------
  if (includeTempDirs) {
    const roots = [];
    if (cacheTempDir) roots.push(path.resolve(cacheTempDir));
    if (legacyTempDir) roots.push(path.resolve(legacyTempDir));
    for (const extra of Array.isArray(legacyTempDirs) ? legacyTempDirs : []) {
      if (extra) roots.push(path.resolve(extra));
    }
    plan.tempRoots = [...new Set(roots)];
    const { dirs, warnings: tempWarnings } = await tempDirCandidates(plan.tempRoots, metas, includedIds);
    plan.tempDirs = dirs;
    warnings.push(...tempWarnings);
    for (const dir of dirs) plan.totals.tempBytes += dir.bytes;
  }

  plan.totals.totalBytes =
    plan.totals.sessionBytes +
    plan.totals.projcacheBytes +
    plan.totals.attachmentBytes +
    plan.totals.tempBytes;
  return plan;
}

// ---------------------------------------------------------------------------
// 执行删除
// ---------------------------------------------------------------------------

async function removeFileChecked(filePath) {
  const stat = await lstatSafe(filePath);
  if (!stat) return { status: 'missing' };
  if (stat.isSymbolicLink()) return { status: 'skipped', reason: 'symlink' };
  if (!stat.isFile()) return { status: 'skipped', reason: 'not-file' };
  try {
    if ((stat.mode & 0o200) === 0) await fsp.chmod(filePath, 0o666);
  } catch {
    /* 清只读位失败仍尝试删除 */
  }
  try {
    await fsp.unlink(filePath);
    return { status: 'deleted', bytes: stat.size };
  } catch (error) {
    return { status: 'error', error: errorReason(error) };
  }
}

async function removeAliasDirChecked(dirPath) {
  const stat = await lstatSafe(dirPath);
  if (!stat) return { status: 'missing', bytes: 0 };
  if (stat.isSymbolicLink() || !stat.isDirectory()) return { status: 'skipped', reason: 'not-directory', bytes: 0 };
  const measured = await measureTree(dirPath);
  const bytes = measured?.sizeBytes ?? 0;
  try {
    await fsp.rm(dirPath, { recursive: true, force: true, maxRetries: 2 });
    return { status: 'deleted', bytes };
  } catch (error) {
    return { status: 'error', error: errorReason(error), bytes: 0 };
  }
}

async function removeTempDirChecked(dirPath, tempRoots) {
  const base = path.basename(dirPath);
  if (!SESSION_DIR_RE.test(base)) return { status: 'skipped', reason: 'not-workspace-changes-dir', bytes: 0 };
  if (!Array.isArray(tempRoots) || !tempRoots.some((root) => isInside(root, dirPath))) {
    return { status: 'skipped', reason: 'outside-temp-roots', bytes: 0 };
  }
  const stat = await lstatSafe(dirPath);
  if (!stat) return { status: 'missing', bytes: 0 };
  if (stat.isSymbolicLink() || !stat.isDirectory()) return { status: 'skipped', reason: 'not-directory', bytes: 0 };
  const measured = await measureTree(dirPath);
  const bytes = measured?.sizeBytes ?? 0;
  try {
    await fsp.rm(dirPath, { recursive: true, force: true, maxRetries: 2 });
    return { status: 'deleted', bytes };
  } catch (error) {
    return { status: 'error', error: errorReason(error), bytes: 0 };
  }
}

async function pruneReports(reportDir) {
  let entries = [];
  try {
    entries = await fsp.readdir(reportDir);
  } catch {
    return;
  }
  const reports = [];
  for (const name of entries) {
    if (!REPORT_RE.test(name)) continue;
    const filePath = path.join(reportDir, name);
    const stat = await statSafe(filePath);
    if (stat) reports.push({ filePath, mtimeMs: stat.mtimeMs });
  }
  reports.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const stale of reports.slice(REPORT_KEEP)) {
    try {
      await fsp.unlink(stale.filePath);
    } catch {
      /* best effort */
    }
  }
}

function summarizePlan(plan) {
  return {
    targets: (plan?.targets ?? []).map((target) => ({
      id: target.id,
      isGhost: Boolean(target.isGhost),
      sizeBytes: target.sizeBytes ?? 0,
      blocked: target.blocked ?? null,
    })),
    projcacheFiles: (plan?.projcacheFiles ?? []).length,
    projcacheBytes: plan?.totals?.projcacheBytes ?? 0,
    attachments: (plan?.attachments ?? []).length,
    attachmentBytes: plan?.totals?.attachmentBytes ?? 0,
    tempDirs: (plan?.tempDirs ?? []).length,
    tempBytes: plan?.totals?.tempBytes ?? 0,
    retainedBy: [...(plan?.retainedBy ?? [])],
    totals: plan?.totals ?? emptyTotals(),
  };
}

async function writeConversationReport(reportPath, payload) {
  await fsp.mkdir(path.dirname(reportPath), { recursive: true });
  await writeJsonFile(reportPath, payload);
  await pruneReports(path.dirname(reportPath));
}

/**
 * 执行计划。dryRun 只写报告、不动文件系统；apply 时按 S6 顺序：
 * 先删文件，再清 registry 归档状态；单个文件失败只记 skipped，不中断。
 */
export async function applyConversationDeletion(
  plan,
  { registry = null, dryRun = false, reportPath = null, dshHome = dshHomePath() } = {},
) {
  const startedAt = Date.now();
  const result = {
    ok: true,
    deleted: { sessions: 0, sessionBytes: 0, projcacheFiles: 0, attachments: 0, tempDirs: 0, bytes: 0 },
    skipped: [],
    warnings: [...(plan?.warnings ?? [])],
    reportPath: null,
  };
  const included = (plan?.targets ?? []).filter((target) => target && !target.blocked);

  if (!dryRun) {
    const failedIds = new Set();
    for (const target of included) {
      let removedAny = false;
      for (const logPath of target.logPaths ?? []) {
        const outcome = await removeFileChecked(logPath);
        if (outcome.status === 'deleted') {
          removedAny = true;
          result.deleted.sessionBytes += outcome.bytes ?? 0;
        } else if (outcome.status === 'error') {
          failedIds.add(target.id);
          result.skipped.push({ id: target.id, path: logPath, reason: 'delete-failed', error: outcome.error });
          result.ok = false;
        }
      }
      if (target.dir) {
        try {
          await fsp.rmdir(target.dir);
        } catch {
          /* 目录非空或已不存在：保留它 */
        }
      }
      if (removedAny) result.deleted.sessions += 1;
      else if (!target.isGhost) result.skipped.push({ id: target.id, reason: 'already-deleted' });
    }

    for (const entry of plan?.projcacheFiles ?? []) {
      const outcome = await removeFileChecked(entry.path);
      if (outcome.status === 'deleted') {
        result.deleted.projcacheFiles += 1;
        result.deleted.bytes += outcome.bytes ?? 0;
      } else if (outcome.status === 'error') {
        result.skipped.push({ path: entry.path, reason: 'delete-failed', error: outcome.error });
        result.ok = false;
      }
    }

    for (const attachment of plan?.attachments ?? []) {
      let removed = false;
      if (attachment.objectPath) {
        const outcome = await removeFileChecked(attachment.objectPath);
        if (outcome.status === 'deleted') {
          removed = true;
          result.deleted.bytes += outcome.bytes ?? 0;
        } else if (outcome.status === 'error') {
          result.skipped.push({ path: attachment.objectPath, reason: 'delete-failed', error: outcome.error });
          result.ok = false;
        }
      }
      if (attachment.fileObjectPath) {
        const outcome = await removeFileChecked(attachment.fileObjectPath);
        if (outcome.status === 'deleted') {
          removed = true;
          result.deleted.bytes += outcome.bytes ?? 0;
        } else if (outcome.status === 'error') {
          result.skipped.push({ path: attachment.fileObjectPath, reason: 'delete-failed', error: outcome.error });
          result.ok = false;
        }
      }
      for (const aliasDir of attachment.aliasDirs ?? []) {
        const outcome = await removeAliasDirChecked(aliasDir);
        if (outcome.status === 'deleted') {
          removed = true;
          result.deleted.bytes += outcome.bytes ?? 0;
        } else if (outcome.status === 'error') {
          result.skipped.push({ path: aliasDir, reason: 'delete-failed', error: outcome.error });
          result.ok = false;
        }
      }
      if (removed) result.deleted.attachments += 1;
    }

    for (const dir of plan?.tempDirs ?? []) {
      const outcome = await removeTempDirChecked(dir.path, plan?.tempRoots ?? []);
      if (outcome.status === 'deleted') {
        result.deleted.tempDirs += 1;
        result.deleted.bytes += outcome.bytes ?? 0;
      } else if (outcome.status === 'error') {
        result.skipped.push({ path: dir.path, reason: 'delete-failed', error: outcome.error });
        result.ok = false;
      }
    }

    result.deleted.bytes += result.deleted.sessionBytes;

    // --- S6/S8：文件删完后再清 registry 状态；失败只警告 ------------------
    const registryIds = included.filter((target) => !failedIds.has(target.id)).map((target) => target.id);
    if (registry) {
      for (const id of registryIds) {
        try {
          if (typeof registry.unarchive === 'function') await registry.unarchive(id);
        } catch (error) {
          result.warnings.push(`unarchive ${id} failed: ${errorReason(error)}`);
        }
        try {
          if (typeof registry.detachWorkspaceSlot === 'function') await registry.detachWorkspaceSlot(id);
        } catch (error) {
          result.warnings.push(`detachWorkspaceSlot ${id} failed: ${errorReason(error)}`);
        }
      }
    } else if (registryIds.length > 0) {
      result.warnings.push(
        'REGISTRY_UNAVAILABLE: session files were deleted but archived state was not cleared (run from a live host or use CLI --offline-registry)',
      );
    }
  }

  if (reportPath) {
    try {
      await writeConversationReport(reportPath, {
        schema: CONVERSATION_SCHEMA,
        generatedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        apply: !dryRun,
        direction: 'conversation-delete',
        dshHome: path.resolve(dshHome),
        plan: summarizePlan(plan),
        deleted: result.deleted,
        skipped: result.skipped,
        warnings: result.warnings,
      });
      result.reportPath = reportPath;
    } catch (error) {
      result.warnings.push(`report write failed: ${errorReason(error)}`);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// 归属报告
// ---------------------------------------------------------------------------

/**
 * 当前缓存归属：每个 workspace-changes 目录的大小/类别计数/活动窗，
 * 以及与会话活动窗相交的候选（时间窗推断，不是精确归属）。
 */
export async function ownershipReport({
  dshHome = dshHomePath(),
  cacheRoots = [],
  legacyRoots = [],
  now = Date.now(),
} = {}) {
  const metas = await scanSessions({ dshHome });
  const warnings = [...(metas.warnings ?? [])];
  let archivedSet = new Set();
  try {
    archivedSet = new Set(readArchivedIds(dshHome).ids);
  } catch (error) {
    warnings.push(errorReason(error));
  }

  const roots = [];
  (Array.isArray(cacheRoots) ? cacheRoots : []).forEach((root, index) => {
    if (root) roots.push({ path: path.resolve(root), rootKey: index === 0 ? 'cache' : `cache-${index + 1}` });
  });
  (Array.isArray(legacyRoots) ? legacyRoots : []).forEach((root, index) => {
    if (root) roots.push({ path: path.resolve(root), rootKey: index === 0 ? 'legacy' : `legacy-${index + 1}` });
  });

  const dirs = [];
  for (const entryRoot of roots) {
    let entries = [];
    try {
      entries = await fsp.readdir(entryRoot.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !SESSION_DIR_RE.test(entry.name)) continue;
      const dirPath = path.join(entryRoot.path, entry.name);
      const measured = await measureTree(dirPath);
      if (!measured) continue;
      const candidates = [];
      for (const meta of metas) {
        const start = meta.header?.createdAt;
        if (typeof start !== 'number' || !Number.isFinite(start)) continue;
        const end = Math.max(start, meta.mtime);
        // 目录活动窗可能是「一个点」（所有文件同一 mtime），所以用严格不等式判相交，
        // 与 tempDirCandidates 的包含判定保持同一口径。
        const intersects = start < measured.lastWriteAt && end > measured.firstWriteAt;
        if (intersects) {
          const overlapMs = Math.max(
            0,
            Math.round(Math.min(end, measured.lastWriteAt) - Math.max(start, measured.firstWriteAt)),
          );
          candidates.push({
            sessionId: meta.id,
            cwd: typeof meta.header?.cwd === 'string' ? meta.header.cwd : null,
            overlapMs,
            confidence: 'time-window',
          });
        }
      }
      candidates.sort((a, b) => b.overlapMs - a.overlapMs);
      dirs.push({
        path: dirPath,
        rootKey: entryRoot.rootKey,
        sizeBytes: measured.sizeBytes,
        counts: measured.counts,
        firstWriteAt: measured.firstWriteAt,
        lastWriteAt: measured.lastWriteAt,
        candidates,
        confidence: candidates.length > 0 ? 'time-window' : 'unattributed',
      });
    }
  }
  dirs.sort((a, b) => b.lastWriteAt - a.lastWriteAt);

  const bySession = [];
  for (const meta of metas) {
    const projEdit = await statSafe(projcacheFile(dshHome, meta.id));
    const projcacheBytes = projEdit?.isFile() ? projEdit.size : 0;
    const cacheDirs = dirs
      .filter((dir) => dir.candidates.some((candidate) => candidate.sessionId === meta.id))
      .map((dir) => dir.path);
    let attribution = 'none';
    if (cacheDirs.length > 0) attribution = 'guess-cache';
    else if (projcacheBytes > 0) attribution = 'exact-cache';
    bySession.push({
      sessionId: meta.id,
      cwd: typeof meta.header?.cwd === 'string' ? meta.header.cwd : null,
      isArchived: archivedSet.has(meta.id),
      logBytes: meta.sizeBytes,
      projcacheBytes,
      cacheDirs,
      attribution,
    });
  }
  bySession.sort((a, b) => b.logBytes - a.logBytes);

  const dirBytes = dirs.reduce((sum, dir) => sum + dir.sizeBytes, 0);
  const unattributedBytes = dirs
    .filter((dir) => dir.confidence === 'unattributed')
    .reduce((sum, dir) => sum + dir.sizeBytes, 0);

  const report = {
    schema: CONVERSATION_SCHEMA,
    generatedAt: new Date(now).toISOString(),
    dirs,
    bySession,
    totals: { dirs: dirs.length, dirBytes, unattributedBytes },
  };
  Object.defineProperty(report, 'warnings', { value: warnings, enumerable: false });
  return report;
}

export { projcacheRoot, attachmentsRoot, projcacheFile };
