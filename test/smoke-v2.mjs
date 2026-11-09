#!/usr/bin/env node
// dsh-cache-cleaner v2 自测（实现者自测，不代替 task-5 的独立验收 C1–C12）。
//
// 全部在临时夹具 DSH_HOME 上跑：不碰真实 ~/.dsh，不删真实缓存。
//   node test/smoke-v2.mjs
//
// 覆盖：listConversations（含 ghost）、S1/S2 拒绝、级联、附件共享保护、
// dry-run 零写入、apply 删除 + registry 适配器调用、幂等、时间窗临时目录、
// ownershipReport、CLI 离线 registry 闸门与原子改写。

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  applyConversationDeletion,
  attachmentsRoot,
  listConversations,
  ownershipReport,
  planConversationDeletion,
  projcacheFile,
  readArchivedIds,
  sessionsRoot,
} from '../lib/conversations.mjs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-guard-smoke-v2-'));
const HOME = path.join(ROOT, 'dsh-home');
const CACHE_ROOT = path.join(ROOT, 'cache');
const TEMP_ROOT = path.join(CACHE_ROOT, 'temp');
const REPORT_DIR = path.join(ROOT, 'reports');
const CWD = 'C:\\work\\fixture';
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

const MAIN = 'session-11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const RETAINED = 'session-33333333-3333-4333-8333-333333333333';
const UNARCHIVED = 'session-44444444-4444-4444-8444-444444444444';
const GHOST = 'session-55555555-5555-4555-8555-555555555555';

const SHA = {
  a: 'aaaa'.padEnd(64, 'a'),
  shared: 'bbbb'.padEnd(64, 'b'),
  child: 'cccc'.padEnd(64, 'c'),
};

const failures = [];
let passed = 0;
function check (condition, label, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`PASS ${label}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function writeSessionLog (dirName, header, events, mtime) {
  const dir = path.join(sessionsRoot(HOME), '--D-Python-test-fixture--', dirName);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [header, ...events].map((event) => JSON.stringify(event)).join('\n') + '\n';
  const half = Math.floor(lines.length / 2);
  const cut = lines.lastIndexOf('\n', half) + 1;
  const buffer = Buffer.concat([
    zlib.zstdCompressSync(Buffer.from(lines.slice(0, cut), 'utf8')),
    zlib.zstdCompressSync(Buffer.from(lines.slice(cut), 'utf8')),
  ]);
  const logPath = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(logPath, buffer);
  if (mtime) fs.utimesSync(logPath, new Date(mtime), new Date(mtime));
  return { dir, logPath };
}

function attachmentEvent (refs) {
  return {
    type: 'agent/inbox/spliced',
    seq: 3,
    time: T0 + 10,
    data: {
      target: 'next-turn',
      start: 0,
      inserted: [
        {
          content: refs.map((ref) => ({
            type: 'file',
            attachment: { attachmentId: `sha256:${ref.sha}`, name: ref.name, bytes: ref.bytes },
          })),
        },
      ],
    },
  };
}

function writeJson (file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function snapshot (root) {
  const entries = [];
  function walk (dir) {
    let list = [];
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of list) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { entries.push(`d ${path.relative(root, full)}`); walk(full); }
      else if (entry.isFile()) entries.push(`f ${path.relative(root, full)} ${fs.statSync(full).size}`);
    }
  }
  walk(root);
  return entries.sort().join('\n');
}

function baseHeader (id, createdAt, parent) {
  const header = {
    type: 'session',
    version: 4,
    id,
    createdAt,
    cwd: CWD,
    isSeeded: false,
    delegationDepth: parent ? 1 : 0,
  };
  if (parent) { header.parentSession = parent; header.origin = 'subagent'; }
  return header;
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------
writeSessionLog(
  MAIN,
  baseHeader(MAIN, T0),
  [
    { type: 'user/message', seq: 2, time: T0 + 5, data: { content: [{ type: 'text', text: 'hello from A\nsecond line' }] } },
    attachmentEvent([{ sha: SHA.a, name: 'a.txt', bytes: 5 }, { sha: SHA.shared, name: 'shared.txt', bytes: 6 }]),
  ],
  T0 + 10000,
);
writeSessionLog(
  CHILD,
  baseHeader(CHILD, T0 + 200000, MAIN),
  [attachmentEvent([{ sha: SHA.child, name: 'child.txt', bytes: 7 }])],
  T0 + 210000,
);
writeSessionLog(
  RETAINED,
  baseHeader(RETAINED, T0 - 100000),
  [attachmentEvent([{ sha: SHA.shared, name: 'shared.txt', bytes: 6 }])],
  T0 - 90000,
);
writeSessionLog(UNARCHIVED, baseHeader(UNARCHIVED, T0 + 500000), [], T0 + 510000);

writeJson(path.join(HOME, 'storages', 'workspace.json'), {
  global: { archivedSessionIds: [MAIN] },
  tables: {
    workspaces: {
      fixture: { path: '--D-Python-test-fixture--', title: 'fixture', sessionIds: [MAIN, RETAINED], createdAt: T0, updatedAt: T0 },
    },
  },
});

function writeProjcache (id, bytes) {
  const file = projcacheFile(HOME, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ sessionId: id, pad: 'x'.repeat(bytes) }));
}
writeProjcache(MAIN, 64);
writeProjcache(CHILD, 32);

const ATT_ROOT = attachmentsRoot(HOME);
function writeAttachment (relative, bytes = 8) {
  const file = path.join(ATT_ROOT, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x'.repeat(bytes));
  return file;
}
writeAttachment(path.join('objects', SHA.a.slice(0, 2), SHA.a), 10);
writeAttachment(path.join('objects', SHA.shared.slice(0, 2), SHA.shared), 20);
writeAttachment(path.join('file-objects', SHA.child.slice(0, 2), SHA.child), 30);
const aliasDir = path.join(ATT_ROOT, 'files', SHA.shared.slice(0, 2), SHA.shared);
fs.mkdirSync(aliasDir, { recursive: true });
fs.writeFileSync(path.join(aliasDir, 'shared.txt'), 'alias!');

function writeTempDir (name, fileName, bytes, at) {
  const dir = path.join(TEMP_ROOT, name);
  const file = path.join(dir, 'objects', 'ab', fileName);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 't'.repeat(bytes));
  fs.utimesSync(file, new Date(at), new Date(at));
  fs.utimesSync(dir, new Date(at), new Date(at));
  return dir;
}
const tempOwned = writeTempDir('dsh-workspace-changes-SMOKE1', 'tmp_obj_ABC123', 100, T0 + 5000);
const tempOrphan = writeTempDir('dsh-workspace-changes-SMOKE2', 'tmp_obj_DEF456', 50, T0 - 500000);

// ---------------------------------------------------------------------------
// C1：conversation_list
// ---------------------------------------------------------------------------
let list = await listConversations({ dshHome: HOME });
check(list.archived.length === 1, 'C1 只列归档', `got ${list.archived.length}`);
const mainItem = list.archived[0];
check(mainItem.id === MAIN, 'C1 归档 id 正确');
check(mainItem.sizeBytes === fs.statSync(path.join(sessionsRoot(HOME), '--D-Python-test-fixture--', MAIN, 'session.v4.jsonl.zstd')).size, 'C1 sizeBytes = 日志大小');
check(mainItem.projcacheBytes > 0, 'C1 projcacheBytes > 0', String(mainItem.projcacheBytes));
check(mainItem.childIds.length === 1 && mainItem.childIds[0] === CHILD, 'C1 childIds 含子会话');
check(mainItem.firstUserText === 'hello from A second line', 'C1 firstUserText 压平截断', mainItem.firstUserText);
check(list.all.count === 4, 'C1 all.count = 4', String(list.all.count));

// ghost 可见
const wsFile = path.join(HOME, 'storages', 'workspace.json');
const ws = JSON.parse(fs.readFileSync(wsFile, 'utf8'));
ws.global.archivedSessionIds.push(GHOST);
writeJson(wsFile, ws);
list = await listConversations({ dshHome: HOME });
const ghost = list.archived.find((item) => item.id === GHOST);
check(Boolean(ghost) && ghost.isGhost === true, 'C1 ghost 可见且标记 isGhost');
check(readArchivedIds(HOME).ids.length === 2, 'C1 归档集合 2 个');

// ---------------------------------------------------------------------------
// C2：非归档 / 活跃会话拒绝
// ---------------------------------------------------------------------------
const beforeReject = snapshot(HOME);
let plan = await planConversationDeletion({ dshHome: HOME, sessionIds: [UNARCHIVED], includeArtifacts: true });
check(plan.targets[0].blocked?.reason === 'not_archived', 'C2 非归档 → not_archived');
check(plan.totals.totalBytes === 0, 'C2 非归档 totals = 0');
const registryCalls = [];
await applyConversationDeletion(plan, {
  registry: { async unarchive (id) { registryCalls.push(['unarchive', id]); }, async detachWorkspaceSlot (id) { registryCalls.push(['detach', id]); } },
});
check(registryCalls.length === 0, 'C2 registry 零调用');
check(snapshot(HOME) === beforeReject, 'C2 零文件删除');

plan = await planConversationDeletion({ dshHome: HOME, sessionIds: [MAIN], isLive: () => true });
check(plan.targets[0].blocked?.reason === 'live_session', 'C2 活跃会话 → live_session');

// ---------------------------------------------------------------------------
// C4：级联
// ---------------------------------------------------------------------------
plan = await planConversationDeletion({ dshHome: HOME, sessionIds: [MAIN], cascade: true });
check(plan.targets.some((target) => target.id === CHILD && !target.blocked), 'C4 默认级联子会话');
plan = await planConversationDeletion({ dshHome: HOME, sessionIds: [MAIN], cascade: false });
check(!plan.targets.some((target) => target.id === CHILD), 'C4 cascade:false 不含子会话');

// ---------------------------------------------------------------------------
// C5：附件共享保护
// ---------------------------------------------------------------------------
plan = await planConversationDeletion({ dshHome: HOME, sessionIds: [MAIN], includeArtifacts: true });
const plannedShas = plan.attachments.map((item) => item.sha256).sort();
check(plannedShas.includes(SHA.a), 'C5 删会话独有附件进入计划');
check(plannedShas.includes(SHA.child), 'C5 级联子会话附件进入计划');
check(!plannedShas.includes(SHA.shared), 'C5 被保留会话共享的附件不删');
check(plan.retainedBy.includes(RETAINED), 'C5 retainedBy 记录保护者会话');
plan = await planConversationDeletion({ dshHome: HOME, sessionIds: [MAIN], includeArtifacts: false });
check(plan.attachments.length === 0, 'C5 includeArtifacts:false 不列附件');

// ---------------------------------------------------------------------------
// C9：时间窗临时目录
// ---------------------------------------------------------------------------
plan = await planConversationDeletion({ dshHome: HOME, sessionIds: [MAIN], includeArtifacts: true, includeTempDirs: false });
check(plan.tempDirs.length === 0, 'C9 默认不含临时目录');
plan = await planConversationDeletion({
  dshHome: HOME, sessionIds: [MAIN], includeArtifacts: true, includeTempDirs: true,
  cacheTempDir: TEMP_ROOT, legacyTempDir: null,
});
check(plan.tempDirs.length === 1 && plan.tempDirs[0].path === tempOwned, 'C9 只纳入唯一包含且无重叠的目录');
check(plan.tempDirs[0].confidence === 'time-window' && plan.tempDirs[0].sessionId === MAIN, 'C9 标注时间窗推断');
check(plan.totals.tempBytes === 100, 'C9 tempBytes 正确', String(plan.totals.tempBytes));

// ---------------------------------------------------------------------------
// C10（删除前）：ownershipReport 的目录/候选会话
// ---------------------------------------------------------------------------
const ownershipBefore = await ownershipReport({ dshHome: HOME, cacheRoots: [TEMP_ROOT], legacyRoots: [] });
check(ownershipBefore.dirs.length === 2, 'C10 删除前目录 2 个', String(ownershipBefore.dirs.length));
const ownedDir = ownershipBefore.dirs.find((dir) => dir.path === tempOwned);
check(ownedDir?.confidence === 'time-window', 'C10 有重叠 → time-window');
check(ownedDir?.candidates.some((candidate) => candidate.sessionId === MAIN), 'C10 候选会话含主会话');
check(ownedDir?.counts.tmpObj === 1, 'C10 类别计数 tmpObj=1');
const mainRowBefore = ownershipBefore.bySession.find((row) => row.sessionId === MAIN);
check(mainRowBefore?.attribution === 'guess-cache', 'C10 有缓存目录 → guess-cache', mainRowBefore?.attribution);
const retainedRowBefore = ownershipBefore.bySession.find((row) => row.sessionId === RETAINED);
check(retainedRowBefore?.isArchived === false, 'C10 未归档标记正确');

// ---------------------------------------------------------------------------
// C6：dry-run 零写入
// ---------------------------------------------------------------------------
const beforeDry = snapshot(HOME);
const dryPlan = await planConversationDeletion({
  dshHome: HOME, sessionIds: [MAIN], includeArtifacts: true, includeTempDirs: true, cacheTempDir: TEMP_ROOT,
});
const dryResult = await applyConversationDeletion(dryPlan, { dryRun: true, reportPath: null });
check(dryResult.deleted.sessions === 0 && dryResult.deleted.attachments === 0, 'C6 dry-run deleted 全 0');
check(dryPlan.totals.totalBytes > 0, 'C6 plan.totals > 0');
check(snapshot(HOME) === beforeDry, 'C6 dry-run 文件系统不变');
check(fs.existsSync(tempOwned), 'C6 dry-run 临时目录还在');

// ---------------------------------------------------------------------------
// C11 准备：在 apply 之前复制夹具（离线和闸门测试需要完整文件）
// ---------------------------------------------------------------------------
const COPY = path.join(ROOT, 'copy');
fs.mkdirSync(COPY, { recursive: true });
fs.cpSync(HOME, path.join(COPY, 'dsh-home'), { recursive: true });
const copyHome = path.join(COPY, 'dsh-home');
const copyWs = path.join(copyHome, 'storages', 'workspace.json');
const copyWsBefore = fs.readFileSync(copyWs, 'utf8');

// ---------------------------------------------------------------------------
// C3 + C5：apply（fake registry）
// ---------------------------------------------------------------------------
const applyPlan = await planConversationDeletion({
  dshHome: HOME, sessionIds: [MAIN], includeArtifacts: true, includeTempDirs: true, cacheTempDir: TEMP_ROOT,
});
const expectedPlan = {
  sessions: applyPlan.totals.sessions,
  sessionBytes: applyPlan.totals.sessionBytes,
  attachmentBytes: applyPlan.totals.attachmentBytes,
};
const reportPath = path.join(REPORT_DIR, 'conversation-smoke-apply.json');
const calls = [];
const applyResult = await applyConversationDeletion(applyPlan, {
  registry: {
    async unarchive (id) { calls.push(['unarchive', id]); },
    async detachWorkspaceSlot (id) { calls.push(['detach', id]); },
  },
  reportPath,
  dshHome: HOME,
});
check(applyResult.ok === true, 'C3 apply ok');
check(applyResult.deleted.sessions === expectedPlan.sessions, 'C3 deleted.sessions 与 plan 一致');
check(applyResult.deleted.sessionBytes === expectedPlan.sessionBytes, 'C3 deleted.sessionBytes 与 plan 一致');
check(!fs.existsSync(path.join(sessionsRoot(HOME), '--D-Python-test-fixture--', MAIN)), 'C3 主会话日志目录已删');
check(!fs.existsSync(path.join(sessionsRoot(HOME), '--D-Python-test-fixture--', CHILD)), 'C4 子会话日志目录已删');
check(!fs.existsSync(projcacheFile(HOME, MAIN)), 'C3 projcache 已删');
check(!fs.existsSync(path.join(ATT_ROOT, 'objects', SHA.a.slice(0, 2), SHA.a)), 'C5 独有附件 object 已删');
check(!fs.existsSync(path.join(ATT_ROOT, 'file-objects', SHA.child.slice(0, 2), SHA.child)), 'C5 子会话附件已删');
check(fs.existsSync(path.join(ATT_ROOT, 'objects', SHA.shared.slice(0, 2), SHA.shared)), 'C5 共享附件仍保留');
check(fs.existsSync(path.join(aliasDir, 'shared.txt')), 'C5 共享附件 alias 仍保留');
check(!fs.existsSync(tempOwned), 'C9 时间窗临时目录已删');
check(fs.existsSync(tempOrphan), 'C9 无归属临时目录保留');
check(calls.some(([kind, id]) => kind === 'unarchive' && id === MAIN), 'C3 unarchive 被调用');
check(calls.some(([kind, id]) => kind === 'detach' && id === MAIN), 'C3 detachWorkspaceSlot 被调用');
check(fs.existsSync(reportPath), 'C3 报告已写');
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
check(report.apply === true && report.deleted.sessions === expectedPlan.sessions, 'C3 报告内容一致');
check(fs.existsSync(path.join(sessionsRoot(HOME), '--D-Python-test-fixture--', RETAINED)), 'C3 保留会话日志仍在');

// ---------------------------------------------------------------------------
// C7：幂等 + ghost 只清状态
// ---------------------------------------------------------------------------
const beforeIdempotent = snapshot(HOME);
const againPlan = await planConversationDeletion({ dshHome: HOME, sessionIds: [MAIN], includeArtifacts: true });
const ghostPlan = await planConversationDeletion({ dshHome: HOME, sessionIds: [GHOST] });
const ghostCalls = [];
const againResult = await applyConversationDeletion(againPlan, { registry: null });
const ghostResult = await applyConversationDeletion(ghostPlan, {
  registry: { async unarchive (id) { ghostCalls.push(['unarchive', id]); }, async detachWorkspaceSlot (id) { ghostCalls.push(['detach', id]); } },
});
check(againResult.deleted.sessions === 0, 'C7 第二次 deleted.sessions = 0');
check(snapshot(HOME) === beforeIdempotent, 'C7 幂等不产生文件变化');
check(ghostPlan.targets[0]?.isGhost === true, 'C7 ghost 标记');
check(ghostResult.deleted.sessions === 0 && ghostCalls.length === 2, 'C7 ghost 只清状态（registry 2 次调用）');
check((await planConversationDeletion({ dshHome: HOME, sessionIds: [GHOST] })).targets[0]?.isGhost === true, 'C7 ghost 计划仍可重现');

// ---------------------------------------------------------------------------
// C10（删除后）：ownershipReport 只剩孤儿目录
// ---------------------------------------------------------------------------
const ownership = await ownershipReport({ dshHome: HOME, cacheRoots: [TEMP_ROOT], legacyRoots: [] });
check(ownership.dirs.length === 1 && ownership.dirs[0].path === tempOrphan, 'C10 目录清单正确');
check(ownership.dirs[0].confidence === 'unattributed', 'C10 无重叠 → unattributed');
check(ownership.totals.unattributedBytes === 50, 'C10 unattributedBytes 正确', String(ownership.totals.unattributedBytes));
check(ownership.dirs[0].counts.tmpObj === 1, 'C10 类别计数 tmpObj=1');
check(ownership.bySession.length === 2, 'C10 bySession 只含存活会话', String(ownership.bySession.length));
const retainedRow = ownership.bySession.find((row) => row.sessionId === RETAINED);
check(retainedRow.isArchived === false, 'C10 未归档标记正确');
const unarchivedRow = ownership.bySession.find((row) => row.sessionId === UNARCHIVED);
check(unarchivedRow.attribution === 'none', 'C10 无缓存无 projcache → none', unarchivedRow.attribution);

const ownership2 = await ownershipReport({ dshHome: HOME, cacheRoots: [TEMP_ROOT], legacyRoots: [] });
check(ownership2.totals.dirs === 1, 'C10 ownership 可重复调用');

// ---------------------------------------------------------------------------
// C11：CLI 离线 registry 闸门
// ---------------------------------------------------------------------------
const binPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'dsh-cache-clean.mjs');
const bin = binPath;
function runCli (args, env = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: HOME, ...env },
  });
}

const listCli = runCli(['--conversations', '--json', '--dsh-home', HOME]);
check(listCli.status === 0, 'C11 CLI --conversations exit 0', listCli.stderr.slice(0, 200));
check(JSON.parse(listCli.stdout).archived.length >= 1, 'C11 CLI list 输出可解析');

// 复制夹具已在上方 apply 之前完成（C11 准备）
const denied = runCli(['--delete-archived', MAIN, '--apply', '--dsh-home', copyHome, '--no-legacy', '--report-dir', path.join(COPY, 'reports')]);
check(denied.status === 2, 'C11 无 --offline-registry → exit 2', String(denied.status));
check(fs.readFileSync(copyWs, 'utf8') === copyWsBefore, 'C11 无 flag 时 workspace.json 未改');
check(fs.existsSync(path.join(sessionsRoot(copyHome), '--D-Python-test-fixture--', MAIN)), 'C11 无 flag 时零文件删除');

const offline = runCli(['--delete-archived', MAIN, '--apply', '--offline-registry', '--dsh-home', copyHome, '--no-legacy', '--no-cascade', '--report-dir', path.join(COPY, 'reports')]);
check(offline.status === 0, 'C11 --offline-registry apply exit 0', offline.stderr.slice(0, 300));
const copyWsAfter = JSON.parse(fs.readFileSync(copyWs, 'utf8'));
check(!copyWsAfter.global.archivedSessionIds.includes(MAIN), 'C11 归档集合已移除');
check(!copyWsAfter.tables.workspaces.fixture.sessionIds.includes(MAIN), 'C11 工作区槽位已移除');
check(fs.readdirSync(path.dirname(copyWs)).some((name) => name.startsWith('workspace.json.bak-')), 'C11 生成 .bak-<ts>');
check(!fs.existsSync(path.join(sessionsRoot(copyHome), '--D-Python-test-fixture--', MAIN)), 'C11 apply 已删日志');
check(fs.existsSync(path.join(sessionsRoot(copyHome), '--D-Python-test-fixture--', CHILD)), 'C11 --no-cascade 保留子会话');
check(fs.existsSync(path.join(sessionsRoot(copyHome), '--D-Python-test-fixture--', RETAINED)), 'C11 未归档会话保留');

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------
fs.rmSync(ROOT, { recursive: true, force: true });

console.log('');
console.log(`smoke-v2: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('fixture cleaned:', ROOT);
