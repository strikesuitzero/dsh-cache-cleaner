// dsh-cache-cleaner v0.4.0 自测：设置页 Host API（DESIGN-v4 §5 的 Z1–Z7 纯逻辑部分）。
//
// 风格：零依赖、临时夹具、跑完删夹具。绝不碰真实 ~/.dsh 或真实工作区目录。
// 运行：node test/smoke-v4.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, '..');
const pluginEntry = path.join(pluginRoot, 'index.js');
const pkgVersion = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8')).version;

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, condition, detail) {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(`${name}${detail === undefined ? '' : ` :: ${detail}`}`);
  }
}

function eq(name, actual, expected) {
  ok(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-guard-smoke-v4-'));
const cacheRoot = path.join(fixtureRoot, 'cache');
const dshHome = path.join(fixtureRoot, 'dsh');
const wsBase = path.join(fixtureRoot, 'ws');
const wsTemp = path.join(wsBase, '_tmp');
const wsArchive = path.join(wsBase, '_archive');
const reportsDir = path.join(cacheRoot, 'reports');

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const old8 = new Date(now - 8 * DAY);
const old40 = new Date(now - 40 * DAY);

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function touch(file, content, mtime) {
  mkdirp(path.dirname(file));
  fs.writeFileSync(file, content, 'utf8');
  if (mtime) fs.utimesSync(file, mtime, mtime);
}

function writeFixture() {
  mkdirp(cacheRoot);
  mkdirp(path.join(dshHome, 'sessions'));
  mkdirp(path.join(dshHome, 'storages', 'session_projcache', 'sessions'));
  mkdirp(path.join(dshHome, 'attachments', 'v1', 'objects'));
  fs.writeFileSync(
    path.join(dshHome, 'storages', 'workspace.json'),
    JSON.stringify({ global: { archivedSessionIds: [] }, tables: { workspaces: {} } }, null, 2),
    'utf8',
  );
  touch(path.join(wsTemp, 'old.txt'), 'old', old8);
  touch(path.join(wsTemp, 'fresh.txt'), 'fresh', new Date());
  touch(path.join(wsTemp, '.keep'), '', old8);
  touch(path.join(wsArchive, 'old-archive.txt'), 'archive-old', old40);
}

/** 目录快照：路径 -> 大小+mtime；用来证明 dry-run 零写入（忽略报告目录，报告是契约要求落盘的）。 */
function hashTree(dir, skipSubtree) {
  const rows = [];
  const walk = (current) => {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (skipSubtree && full === skipSubtree) continue;
      if (entry.isDirectory()) {
        rows.push(`${full}|dir`);
        walk(full);
      } else if (entry.isFile()) {
        const stat = fs.statSync(full);
        rows.push(`${full}|${stat.size}|${stat.mtimeMs}`);
      }
    }
  };
  walk(dir);
  return rows.join('\n');
}

function request(body, options = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const contentType = options.contentType ?? 'application/json';
  return {
    method: options.method ?? 'POST',
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => text,
  };
}

function makeEditor({ entries } = {}) {
  const calls = [];
  const list = entries ?? [
    { options: { id: 'dsh-cache-cleaner', name: '缓存守卫', config: { mode: 'normal' } }, fiber: {} },
  ];
  return {
    calls,
    entries: () => list,
    async edit(entry, change) {
      calls.push({ entry, change });
      return undefined;
    },
  };
}

function makeCtx({ withFetch = true, editor = null } = {}) {
  const tools = new Map();
  const effects = [];
  const disposers = [];
  const fetchRoutes = [];
  const warnings = [];
  const logs = [];
  const ctx = {
    logger: {
      info: (message) => logs.push(String(message)),
      warn: (message) => warnings.push(String(message)),
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return { name: definition.name };
      },
    },
    // Cordis 语义：ctx.effect(fn) **立即执行** fn，并把 fn 的返回值当作 dispose 回调。
    // 这里必须照实模拟，否则「挂载后立刻被 disposer 注销」这类缺陷会被假绿放过。
    effect(fn, label) {
      const disposer = typeof fn === 'function' ? fn() : undefined;
      effects.push({ fn, label, disposer });
      if (typeof disposer === 'function') disposers.push(disposer);
      return () => {
        if (typeof disposer === 'function') disposer();
      };
    },
    on() {},
  };
  // 官方可选服务写法：connection/webServer 只经 ctx.get 取，未注入时返回 undefined。
  ctx.get = (service) => {
    if (service === 'configEditor') return editor;
    if (service === 'connection') return ctx.connection;
    if (service === 'webServer') return ctx.webServer;
    return undefined;
  };
  if (withFetch) {
    ctx.connection = {
      fetch: {
        register(route) {
          fetchRoutes.push(route);
          // 真机 registerFetchRoute 返回的 disposer 会从路由表删除该 path；照实模拟。
          return () => {
            const index = fetchRoutes.indexOf(route);
            if (index >= 0) fetchRoutes.splice(index, 1);
          };
        },
      },
    };
  }
  return { ctx, tools, effects, disposers, fetchRoutes, warnings, logs };
}

async function callRoute(route, body, options) {
  const response = await route.fetch(request(body, options));
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

const baseConfig = {
  cacheRoot,
  redirectTemp: false,
  autoClean: false,
  mode: 'normal',
  workspaceBases: [wsBase],
  workspaceRoots: [
    { path: wsTemp, kind: 'temp', retainDays: 7, auto: true },
    { path: wsArchive, kind: 'archive', retainDays: 30, auto: false },
  ],
  manageArchives: false,
};

async function main() {
  writeFixture();
  const previousDshHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;

  try {
    const mod = await import(`${pathToFileURL(pluginEntry).href}?smoke-v4=${Date.now()}`);
    const ctxPack = makeCtx();
    await mod.apply(ctxPack.ctx, baseConfig);
    const route = ctxPack.fetchRoutes[0];

    // 关键回归（v4.2 修复）：ctx.effect 会立即执行 fn；注册成功后路由必须**仍然活着**，
    // 不能被挂进 effect 的 disposer 顺手注销。见 test-independent/RESULTS-v4.2.md 的 P0。
    eq('Z0 注册后路由仍然 active', ctxPack.fetchRoutes.length, 1);
    ok(
      'Z0 路由 disposer 已登记',
      ctxPack.effects.some((item) => item.label === 'dsh-cache-cleaner: api route' && typeof item.disposer === 'function'),
      JSON.stringify(ctxPack.effects.map((item) => item.label)),
    );
    ok('Z0 connection.fetch.register 只调用一次', ctxPack.fetchRoutes.length === 1 && typeof route?.fetch === 'function', String(ctxPack.fetchRoutes.length));

    // ---------------------------------------------------------------- Z1/Z6
    eq('Z1 工具数量', ctxPack.tools.size, 7);
    for (const name of [
      'cache_status',
      'cache_clean',
      'cache_ownership',
      'conversation_list',
      'conversation_delete',
      'workspace_status',
      'workspace_clean',
    ]) {
      ok(`Z1 工具 ${name} 已注册`, ctxPack.tools.has(name));
    }
    ok('Z6 路由已注册', Boolean(route));
    eq('Z6 路由 path', route?.path, '/api/cache-cleaner.api');
    eq('Z6 路由 methods', JSON.stringify(route?.methods), JSON.stringify(['POST']));
    eq('Z6 路由 requestBody', route?.requestBody, 'buffered');
    ok('Z6 disposer 由 ctx.effect 持有', ctxPack.effects.some((item) => item.label === 'dsh-cache-cleaner: api route'));
    ok('Z6 定时器 effect 存在', ctxPack.effects.some((item) => item.label === 'dsh-cache-cleaner: timers'));

    const before = hashTree(fixtureRoot, reportsDir);
    const status = await callRoute(route, { action: 'status' });
    eq('Z1 status HTTP', status.status, 200);
    ok('Z1 status ok', status.json?.ok === true, status.text.slice(0, 200));
    const data = status.json?.data ?? {};
    eq('Z1 status.cacheRoot', data.status?.cacheRoot, cacheRoot);
    eq('Z1 status 版本', data.status?.plugin?.version, pkgVersion);
    eq('Z1 status.options.mode', data.options?.mode, 'normal');
    for (const key of ['mode', 'retainDays', 'quotaBytes', 'autoClean', 'autoCleanLegacy', 'manageArchives', 'intervalHours']) {
      ok(`Z1 status.options 含 ${key}`, Object.prototype.hasOwnProperty.call(data.options ?? {}, key));
    }
    ok('Z1 status.workspace.roots', Array.isArray(data.workspace?.roots) && data.workspace.roots.length === 2);
    ok('Z1 status.conversations.archived 是数组', Array.isArray(data.conversations?.archived));
    eq('Z1 status 零删除', hashTree(fixtureRoot, reportsDir), before);

    // ------------------------------------------- Z13 v0.4.4 分段 status（首屏优先）
    const metaOnly = await callRoute(route, { action: 'status', params: { sections: ['meta'] } });
    eq('Z13 meta HTTP', metaOnly.status, 200);
    eq('Z13 meta 错误码', metaOnly.json?.ok, true);
    const metaData = metaOnly.json?.data ?? {};
    eq('Z13 meta 不返回 roots', metaData.status?.roots, undefined);
    eq('Z13 meta complete=false', metaData.status?.complete, false);
    eq('Z13 meta 不返回 workspace', metaData.workspace, undefined);
    eq('Z13 meta 不返回 conversations', metaData.conversations, undefined);
    ok('Z13 meta 有 timings.total', typeof metaData.timings?.total === 'number');
    eq('Z13 meta 不跑 sizes', metaData.timings?.sizes, undefined);
    ok('Z13 meta 带 options', typeof metaData.options?.mode === 'string');

    const wsOnly = await callRoute(route, { action: 'status', params: { sections: ['workspace'] } });
    ok('Z13 单段 workspace.roots', Array.isArray(wsOnly.json?.data?.workspace?.roots));
    eq('Z13 单段不带 status.roots', wsOnly.json?.data?.status?.roots, undefined);
    eq('Z13 单段不带 conversations', wsOnly.json?.data?.conversations, undefined);

    const badSection = await callRoute(route, { action: 'status', params: { sections: ['nope'] } });
    eq('Z13 非法 section 错误码', badSection.json?.error?.code, 'INVALID_ARGUMENT');
    const emptySection = await callRoute(route, { action: 'status', params: { sections: [] } });
    eq('Z13 空 sections 错误码', emptySection.json?.error?.code, 'INVALID_ARGUMENT');
    const dupSection = await callRoute(route, { action: 'status', params: { sections: ['meta', 'meta'] } });
    eq('Z13 重复 section 去重', JSON.stringify(dupSection.json?.data?.sections), '["meta"]');
    const fullAgain = await callRoute(route, { action: 'status' });
    ok('Z13 缺省仍全量', Array.isArray(fullAgain.json?.data?.workspace?.roots) && Array.isArray(fullAgain.json?.data?.conversations?.archived));
    eq('Z13 全量无删除', hashTree(fixtureRoot, reportsDir), before);

    // -------------------------------------------------------------------- Z2
    const cleanBlocked = await callRoute(route, { action: 'clean', params: { apply: true } });
    eq('Z2 clean 无 confirm HTTP', cleanBlocked.status, 200);
    eq('Z2 clean 无 confirm 错误码', cleanBlocked.json?.error?.code, 'CONFIRM_REQUIRED');
    eq('Z2 clean 无 confirm 未删文件', hashTree(fixtureRoot, reportsDir), before);

    const cleanDry = await callRoute(route, { action: 'clean', params: {} });
    ok('Z2 clean dry-run ok', cleanDry.json?.ok === true, cleanDry.text.slice(0, 200));
    eq('Z2 clean dry-run apply=false', cleanDry.json?.data?.apply, false);
    eq('Z2 clean dry-run deletedFiles=0', cleanDry.json?.data?.totals?.deletedFiles, 0);

    // 回归：协议层允许 confirm；工具层 CLEAN_KEYS 只有 3 个参数，API 闭包必须先剥掉 confirm 再进引擎。
    const cleanApply = await callRoute(route, { action: 'clean', params: { apply: true, confirm: true } });
    ok('Z2 clean apply+confirm 不被误判', cleanApply.json?.ok === true, cleanApply.text.slice(0, 300));
    ok('Z2 clean apply+confirm 无 UNKNOWN_PARAMETER', cleanApply.json?.error?.code !== 'UNKNOWN_PARAMETER');

    // -------------------------------------------------------------------- Z3
    const wsDry = await callRoute(route, { action: 'workspace-clean' });
    ok('Z3 workspace dry-run ok', wsDry.json?.ok === true, wsDry.text.slice(0, 200));
    eq('Z3 workspace dry-run 零删除', wsDry.json?.data?.deleted?.entries, 0);
    ok('Z3 workspace dry-run 有候选', (wsDry.json?.data?.plan?.totals?.entries ?? 0) >= 1);
    eq('Z3 workspace dry-run 未删旧文件', fs.existsSync(path.join(wsTemp, 'old.txt')), true);

    const wsArchiveBlocked = await callRoute(route, { action: 'workspace-clean', params: { includeArchives: true } });
    ok('Z3 archive 闸门 ok 信封', wsArchiveBlocked.json?.ok === true);
    const refusals = wsArchiveBlocked.json?.data?.refusals ?? [];
    ok(
      'Z3 archive 闸门拒绝',
      refusals.some((item) => item.reason === 'ARCHIVE_DISABLED'),
      JSON.stringify(refusals),
    );
    eq('Z3 archive 闸门未删归档文件', fs.existsSync(path.join(wsArchive, 'old-archive.txt')), true);

    const wsBlocked = await callRoute(route, { action: 'workspace-clean', params: { apply: true } });
    eq('Z3 workspace 无 confirm 错误码', wsBlocked.json?.error?.code, 'CONFIRM_REQUIRED');

    const wsBadRoot = await callRoute(route, {
      action: 'workspace-clean',
      params: { root: path.join(fixtureRoot, 'not-configured') },
    });
    eq('Z3 未配置根错误码', wsBadRoot.json?.error?.code, 'WORKSPACE_ROOT_INVALID');
    ok('Z3 未配置根带 path', Boolean(wsBadRoot.json?.error?.details?.path));

    // -------------------------------------------------------------------- Z4
    const delBoth = await callRoute(route, {
      action: 'conversation-delete',
      params: { sessionIds: ['session-x'], allArchived: true },
    });
    eq('Z4 互斥错误码', delBoth.json?.error?.code, 'INVALID_ARGUMENT');

    const delTempDirs = await callRoute(route, {
      action: 'conversation-delete',
      params: { allArchived: true, includeTempDirs: true },
    });
    eq('Z4 includeTempDirs 依赖错误码', delTempDirs.json?.error?.code, 'INVALID_ARGUMENT');

    const delBlocked = await callRoute(route, {
      action: 'conversation-delete',
      params: { allArchived: true, apply: true },
    });
    eq('Z4 无 confirm 错误码', delBlocked.json?.error?.code, 'CONFIRM_REQUIRED');

    const delDry = await callRoute(route, { action: 'conversation-delete', params: { allArchived: true } });
    ok('Z4 dry-run ok', delDry.json?.ok === true, delDry.text.slice(0, 200));
    eq('Z4 dry-run apply=false', delDry.json?.data?.apply, false);
    ok('Z4 dry-run 有 plan.targets', Array.isArray(delDry.json?.data?.plan?.targets));
    eq('Z4 dry-run 零删除', hashTree(fixtureRoot, reportsDir), before);

    // -------------------------------------------------------------------- Z5
    const editor = makeEditor();
    const saveCtx = makeCtx({ editor });
    await mod.apply(saveCtx.ctx, baseConfig);
    const saveRoute = saveCtx.fetchRoutes[0];
    const saved = await callRoute(saveRoute, {
      action: 'options-save',
      params: { autoClean: true, manageArchives: false, retainDays: 30 },
    });
    ok('Z5 options-save ok', saved.json?.ok === true, saved.text.slice(0, 200));
    eq('Z5 saved 标志', saved.json?.data?.saved, true);
    eq('Z5 reloaded 标志', saved.json?.data?.reloaded, true);
    eq('Z5 保存值回显 retainDays', saved.json?.data?.options?.retainDays, 30);
    eq('Z5 configEditor.edit 调用次数', editor.calls.length, 1);
    const change = editor.calls[0]?.change;
    ok('Z5 change 是函数', typeof change === 'function');
    const merged = typeof change === 'function' ? change({ mode: 'safe', autoClean: false }, {}) : null;
    eq('Z5 change 合并 mode', merged?.mode, 'safe');
    eq('Z5 change 合并 autoClean', merged?.autoClean, true);
    eq('Z5 change 合并 retainDays', merged?.retainDays, 30);

    const badMode = await callRoute(saveRoute, { action: 'options-save', params: { mode: 'turbo' } });
    eq('Z5 非法 mode 错误码', badMode.json?.error?.code, 'INVALID_ARGUMENT');
    const badRange = await callRoute(saveRoute, { action: 'options-save', params: { retainDays: 0 } });
    eq('Z5 retainDays 越界错误码', badRange.json?.error?.code, 'INVALID_ARGUMENT');
    const badType = await callRoute(saveRoute, { action: 'options-save', params: { autoClean: 'yes' } });
    eq('Z5 布尔项类型错误码', badType.json?.error?.code, 'INVALID_ARGUMENT');
    const badInterval = await callRoute(saveRoute, { action: 'options-save', params: { intervalHours: 0 } });
    eq('Z5 intervalHours 越界错误码', badInterval.json?.error?.code, 'INVALID_ARGUMENT');
    const badIntervalType = await callRoute(saveRoute, { action: 'options-save', params: { intervalHours: '168' } });
    eq('Z5 intervalHours 类型错误码', badIntervalType.json?.error?.code, 'INVALID_ARGUMENT');
    const savedInterval = await callRoute(saveRoute, { action: 'options-save', params: { intervalHours: 168 } });
    eq('Z5 intervalHours 保存回显', savedInterval.json?.data?.options?.intervalHours, 168);
    const emptyPatch = await callRoute(saveRoute, { action: 'options-save', params: {} });
    eq('Z5 空补丁错误码', emptyPatch.json?.error?.code, 'INVALID_ARGUMENT');
    eq('Z5 非法输入与合法保存后的 edit 次数', editor.calls.length, 2);

    const noEditorCtx = makeCtx({ editor: null });
    await mod.apply(noEditorCtx.ctx, baseConfig);
    const noEditor = await callRoute(noEditorCtx.fetchRoutes[0], {
      action: 'options-save',
      params: { autoClean: true },
    });
    eq('Z5 无 configEditor 错误码', noEditor.json?.error?.code, 'CONFIG_EDITOR_UNAVAILABLE');

    const missEditor = makeEditor({ entries: [{ options: { id: 'other-plugin' } }] });
    const missCtx = makeCtx({ editor: missEditor });
    await mod.apply(missCtx.ctx, baseConfig);
    const missEntry = await callRoute(missCtx.fetchRoutes[0], {
      action: 'options-save',
      params: { autoClean: true },
    });
    eq('Z5 无配置条目错误码', missEntry.json?.error?.code, 'CONFIG_ENTRY_NOT_FOUND');

    // -------------------------------------------------------------------- Z6
    // v4.2：只走 connection.fetch；无 connection 时不挂载（交给 inject/定时器等待），不再回退 webServer。
    const noConnCtx = makeCtx({ withFetch: false });
    await mod.apply(noConnCtx.ctx, baseConfig);
    eq('Z6 无 connection 时不挂载', noConnCtx.fetchRoutes.length, 0);
    eq('Z6 无 connection 时工具照常注册', noConnCtx.tools.size, 7);

    // cordis 对未 inject 的服务做直接属性访问会抛：只能经 ctx.get 取（host-plugin.md 可选服务写法）。
    const strictCtx = makeCtx({ withFetch: true });
    const realConnection = strictCtx.ctx.connection;
    Object.defineProperty(strictCtx.ctx, 'connection', {
      configurable: true,
      get() {
        throw new Error('Service "connection" is not injected');
      },
    });
    Object.defineProperty(strictCtx.ctx, 'webServer', {
      configurable: true,
      get() {
        throw new Error('Service "webServer" is not injected');
      },
    });
    strictCtx.ctx.get = (service) => (service === 'connection' ? realConnection : undefined);
    await mod.apply(strictCtx.ctx, baseConfig);
    eq('Z6 未 inject 服务不抛错并注册 fetch 路由', strictCtx.fetchRoutes.length, 1);

    // -------------------------------------------------------------------- Z7
    const wrongMethod = await callRoute(route, { action: 'status' }, { method: 'GET' });
    eq('Z7 GET 405', wrongMethod.status, 405);
    eq('Z7 GET 错误码', wrongMethod.json?.error?.code, 'METHOD_NOT_ALLOWED');

    const wrongType = await callRoute(route, { action: 'status' }, { contentType: 'text/plain' });
    eq('Z7 非 JSON content-type 415', wrongType.status, 415);
    eq('Z7 415 错误码', wrongType.json?.error?.code, 'UNSUPPORTED_MEDIA_TYPE');

    const badJson = await callRoute(route, '{"action":');
    eq('Z7 坏 JSON 400', badJson.status, 400);
    eq('Z7 坏 JSON 错误码', badJson.json?.error?.code, 'INVALID_JSON');

    const tooBig = await callRoute(route, 'x'.repeat(70 * 1024));
    eq('Z7 超 64KiB 413', tooBig.status, 413);
    eq('Z7 413 错误码', tooBig.json?.error?.code, 'BODY_TOO_LARGE');

    const badEnvelope = await callRoute(route, [1, 2, 3]);
    eq('Z7 信封非对象 400', badEnvelope.status, 400);
    eq('Z7 信封错误码', badEnvelope.json?.error?.code, 'INVALID_ENVELOPE');

    const unknownAction = await callRoute(route, { action: 'explode' });
    eq('Z7 未知 action 200', unknownAction.status, 200);
    eq('Z7 未知 action 错误码', unknownAction.json?.error?.code, 'UNKNOWN_ACTION');

    const unknownParam = await callRoute(route, { action: 'clean', params: { nope: 1 } });
    eq('Z7 未知参数错误码', unknownParam.json?.error?.code, 'UNKNOWN_PARAMETER');
    eq('Z7 未知参数 details.unknown', JSON.stringify(unknownParam.json?.error?.details?.unknown), '["nope"]');

    const thrown = await callRoute(route, { action: 'workspace-clean', params: { apply: true } });
    ok('Z7 业务错误不崩路由', thrown.status === 200 && thrown.json?.ok === false);

    // --------------------------------------------- Z10 工具输出形态未回归
    const statusTool = await ctxPack.tools.get('cache_status').execute({});
    const parsedStatus = JSON.parse(statusTool);
    eq('Z10 cache_status 版本', parsedStatus.plugin?.version, pkgVersion);
    const cleanTool = await ctxPack.tools.get('cache_clean').execute({});
    const parsedClean = JSON.parse(cleanTool);
    eq('Z10 cache_clean 默认 dry-run', parsedClean.apply, false);
    const unknownTool = await ctxPack.tools.get('workspace_status').execute({ nope: true });
    eq('Z10 workspace_status 未知参数', JSON.parse(unknownTool).error, 'UNKNOWN_PARAMETER');
    const confirmTool = await ctxPack.tools.get('workspace_clean').execute({ apply: true });
    eq('Z10 workspace_clean CONFIRM_REQUIRED', JSON.parse(confirmTool).error, 'CONFIRM_REQUIRED');
    const delTool = await ctxPack.tools.get('conversation_delete').execute({ allArchived: true, apply: true });
    eq('Z10 conversation_delete CONFIRM_REQUIRED', JSON.parse(delTool).error, 'CONFIRM_REQUIRED');
  } finally {
    if (previousDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousDshHome;
    fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 3 });
  }

  console.log(`smoke-v4: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    for (const failure of failures) console.error('FAIL:', failure);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('smoke-v4 fatal:', error && error.stack ? error.stack : error);
  process.exit(1);
});
