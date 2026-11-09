// dsh-cache-cleaner — Web 客户端半（v0.4.10）
// 设置 → 缓存守卫：状态、四类清理的预览/执行、清理选项保存。
// 契约见 DESIGN-v4.md；皮肤只用 --dsw-alias-* token；不写 DOM、不 append body。
window.__ModuleLoader__.load({
  id: 'dsh-cache-cleaner',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-cache-cleaner';
    const API_PATH = '/api/cache-cleaner.api';
    const RETAIN_DAY_PRESETS = [1, 3, 7, 15, 30];
    const SCAN_INTERVAL_PRESETS = [1, 3, 7, 15, 30];

    function intervalDaysFromHours(hours) {
      const value = Number(hours);
      if (!Number.isFinite(value)) return '';
      const days = value / 24;
      return Number.isInteger(days) && SCAN_INTERVAL_PRESETS.indexOf(days) >= 0 ? String(days) : '';
    }
    const GIB = 1024 * 1024 * 1024;

    // ---------------------------------------------------------------- i18n
    const ZH = {
      nav: '缓存守卫',
      title: 'DSH 缓存清理',
      subtitle: '把 DSH 临时缓存迁到 D 盘，按天数与配额闸门清理；这里可以查看归属、预览与执行清理。',
      refresh: '刷新',
      loading: '加载中…',
      detecting: '检测中…（界面已就绪，后台扫描完成后自动填入）',
      sectionError: '这一段检测失败，点「刷新」重试（其他区块不受影响）',
      loadFailed: '加载失败：{msg}',
      apiUnavailable: '宿主接口不可用：设置页拿不到 /api 的 JSON 响应。诊断记录在该插件缓存根下的 .dsh-cache-cleaner-api.json。',
      overview: '概览',
      redirectOn: 'TEMP/TMP 已重定向',
      redirectOff: 'TEMP/TMP 未重定向',
      cacheRoot: '缓存根',
      tempRoot: '临时根',
      legacyTitle: '旧 %TEMP% 遗留',
      legacySummary: '{dirs} 个目录 · {bytes}',
      lastReport: '最近清理',
      never: '无',
      cleanSection: '缓存清理',
      cleanHint: '只清 dsh-workspace-changes-*/objects/<2 位 hex>/tmp_obj_* 白名单文件；默认先预览。',
      mode: '档位',
      modeSafe: '保守（30 天）',
      modeNormal: '标准（14 天 / 50GiB）',
      modeAggressive: '激进（24 小时 / 30GiB）',
      retainDays: '保留天数',
      retainDaysHint: '留空 = 用档位默认',
      retainDaysDefault: '档位默认',
      retainDaysCustom: '自定义…',
      retainDaysSuffix: '天',
      scanFrequency: '自动扫描频率',
      scanFrequencyHint: '多久跑一次自动清理（保存后会重启插件定时器）',
      scanKeepCurrent: '当前 {hours} 小时（保持不变）',
      scanKeepCurrentUnknown: '保持当前值',
      quotaGB: '配额上限（GB）',
      quotaGBHint: '留空 = 不设上限；超过后按 mtime 从旧到新降到 80%',
      includeLegacy: '本次同时清理旧 %TEMP% 遗留目录',
      preview: '预览',
      runClean: '清理缓存',
      confirmClean: '确认清理？',
      cancel: '取消',
      wsSection: '工作区目录',
      wsHint: '只清配置根下过期的直接子项（按子树最新 mtime + 根自带保留天数）；.git/.keep/KEEP/.dsh-cache-cleaner-keep 永远保留。',
      wsKind: '性质',
      wsExists: '存在',
      wsBytes: '大小',
      wsStale: '过期',
      wsMissing: '不存在',
      kindTemp: '临时',
      kindArchive: '归档',
      includeArchives: '本次包含归档目录（_archive）',
      archiveGate: '归档根需要插件配置 manageArchives:true 才会真正执行；勾选仅代表本次请求。',
      previewWs: '预览工作区',
      runWs: '清理工作区',
      confirmWs: '确认清理？',
      convSection: '已归档会话',
      convSummary: '{count} 条 · 日志 {bytes} · 投影缓存 {projcache}',
      convListTitle: '已归档会话清单',
      convId: '会话',
      convWorkspace: '工作区',
      convFirst: '首条消息',
      convLogSize: '日志',
      convProjSize: '投影缓存',
      convGhostTag: '日志缺失',
      convMore: '还有 {count} 条未显示',
      convNoRows: '没有已归档会话。',
      convTargets: '预览：将删除以下 {count} 项（共 {bytes}）',
      convActions: '操作',
      convMenuKeep: '删除会话保留产物',
      convMenuArtifacts: '删除会话和产物',
      convTrashTitle: '删除会话（默认保留产物）',
      convMenuMore: '更多删除方式',
      convDeleteTitle: '删除已归档会话',
      convDeleteKeepBody: '将永久删除会话 {id}（{bytes}）的日志，保留附件与投影缓存。',
      convDeleteArtifactsBody: '将永久删除会话 {id}（{bytes}）及其独占的附件与投影缓存；其他会话共享的附件会保留。',
      convDeleteIrreversible: '删除后不可恢复（不经过回收站）。',
      convDeleteConfirm: '永久删除',
      includeArtifacts: '连同产物（附件 / 投影缓存）',
      includeTempDirs: '连同临时快照目录（时间窗推断，需勾选产物）',
      previewConv: '预览删除',
      runConv: '删除已归档',
      confirmConv: '确认删除？',
      optionsSection: '清理选项',
      optionsHint: '保存会写入 profile 的 cordis.patch.yml，并让插件重新加载；工具与定时任务读同一份配置。',
      autoClean: '定时自动清理',
      autoCleanLegacy: '自动清理时包含旧 %TEMP%',
      manageArchives: '允许清理归档目录',
      save: '保存设置',
      saving: '保存中…',
      saved: '已保存（插件已重新加载）',
      previewOnly: '这是预览，没有删除任何文件。',
      result: '结果',
      raw: '原始 JSON',
      error: '错误',
      yes: '是',
      no: '否',
      activeNow: '当前值',
    };
    const EN = {
      nav: 'Cache Guard',
      title: 'DSH Cache Cleaner',
      subtitle: 'Moves DSH temporary caches to D: and cleans them by age and quota gates. Inspect ownership, preview and run cleanups here.',
      refresh: 'Refresh',
      loading: 'Loading…',
      detecting: 'Checking… (UI is ready; values fill in after the scan finishes)',
      sectionError: 'This section failed to load — click Refresh to retry (other sections are unaffected)',
      loadFailed: 'Load failed: {msg}',
      apiUnavailable: 'Host API unavailable: the panel got no JSON response from /api. See the route record in .dsh-cache-cleaner-api.json under the plugin cache root.',
      overview: 'Overview',
      redirectOn: 'TEMP/TMP redirected',
      redirectOff: 'TEMP/TMP not redirected',
      cacheRoot: 'Cache root',
      tempRoot: 'Temp root',
      legacyTitle: 'Legacy %TEMP%',
      legacySummary: '{dirs} dirs · {bytes}',
      lastReport: 'Last cleanup',
      never: 'none',
      cleanSection: 'Cache cleanup',
      cleanHint: 'Only whitelisted tmp_obj_* files under dsh-workspace-changes-*/objects/<hex>/. Preview first.',
      mode: 'Mode',
      modeSafe: 'Safe (30d)',
      modeNormal: 'Normal (14d / 50GiB)',
      modeAggressive: 'Aggressive (24h / 30GiB)',
      retainDays: 'Retain days',
      retainDaysHint: 'blank = mode default',
      retainDaysDefault: 'Mode default',
      retainDaysCustom: 'Custom…',
      retainDaysSuffix: 'd',
      scanFrequency: 'Auto scan frequency',
      scanFrequencyHint: 'How often auto-clean runs (saving restarts the plugin timer)',
      scanKeepCurrent: 'Current {hours} h (keep)',
      scanKeepCurrentUnknown: 'Keep current value',
      quotaGB: 'Quota (GB)',
      quotaGBHint: 'blank = no quota; above it, oldest files are pruned to 80%',
      includeLegacy: 'Also clean legacy %TEMP% dirs this run',
      preview: 'Preview',
      runClean: 'Clean cache',
      confirmClean: 'Confirm cleanup?',
      cancel: 'Cancel',
      wsSection: 'Workspace directories',
      wsHint: 'Only stale direct children of configured roots (newest mtime of the subtree + per-root retain days); .git/.keep/KEEP/.dsh-cache-cleaner-keep always kept.',
      wsKind: 'Kind',
      wsExists: 'Exists',
      wsBytes: 'Size',
      wsStale: 'Stale',
      wsMissing: 'missing',
      kindTemp: 'temp',
      kindArchive: 'archive',
      includeArchives: 'Include archive root (_archive) this run',
      archiveGate: 'Archive roots also need manageArchives:true in the plugin config; this checkbox is for this request only.',
      previewWs: 'Preview workspace',
      runWs: 'Clean workspace',
      confirmWs: 'Confirm cleanup?',
      convSection: 'Archived conversations',
      convSummary: '{count} archived · logs {bytes} · projcache {projcache}',
      convListTitle: 'Archived conversation list',
      convId: 'Session',
      convWorkspace: 'Workspace',
      convFirst: 'First message',
      convLogSize: 'Log',
      convProjSize: 'Projcache',
      convGhostTag: 'log missing',
      convMore: '{count} more not shown',
      convNoRows: 'No archived conversations.',
      convTargets: 'Preview: {count} target(s), {bytes} total will be deleted',
      convActions: 'Actions',
      convMenuKeep: 'Delete session, keep artifacts',
      convMenuArtifacts: 'Delete session + artifacts',
      convTrashTitle: 'Delete session (keeps artifacts)',
      convMenuMore: 'More delete options',
      convDeleteTitle: 'Delete archived session',
      convDeleteKeepBody: 'Permanently delete the log of session {id} ({bytes}); artifacts and projcache are kept.',
      convDeleteArtifactsBody: 'Permanently delete session {id} ({bytes}) and its exclusive artifacts/projcache; artifacts shared with other sessions are kept.',
      convDeleteIrreversible: 'This cannot be undone (no recycle bin).',
      convDeleteConfirm: 'Delete permanently',
      includeArtifacts: 'Include artifacts (attachments / projcache)',
      includeTempDirs: 'Include temp snapshot dirs (time-window inferred; needs artifacts)',
      previewConv: 'Preview deletion',
      runConv: 'Delete archived',
      confirmConv: 'Confirm deletion?',
      optionsSection: 'Cleanup options',
      optionsHint: 'Saving writes the profile cordis.patch.yml and reloads the plugin; tools and timers read the same config.',
      autoClean: 'Scheduled auto cleanup',
      autoCleanLegacy: 'Include legacy %TEMP% in auto cleanup',
      manageArchives: 'Allow archive cleanup',
      save: 'Save settings',
      saving: 'Saving…',
      saved: 'Saved (plugin reloaded)',
      previewOnly: 'Preview only — no file was deleted.',
      result: 'Result',
      raw: 'Raw JSON',
      error: 'Error',
      yes: 'yes',
      no: 'no',
      activeNow: 'current',
    };

    const DICTS = { zh: ZH, en: EN };

    // ------------------------------------------------------------- helpers
    function formatBytes(n) {
      if (!Number.isFinite(n) || n <= 0) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let value = n;
      let index = 0;
      while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
      }
      return (index === 0 ? String(Math.round(value)) : value.toFixed(value >= 10 ? 1 : 2)) + ' ' + units[index];
    }

    function formatTime(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return '';
      try {
        return new Date(ms).toLocaleString();
      } catch {
        return new Date(ms).toISOString();
      }
    }

    function interpolate(text, vars) {
      let out = String(text);
      for (const key of Object.keys(vars || {})) out = out.split('{' + key + '}').join(String(vars[key]));
      return out;
    }

    function errorText(json, t) {
      const error = json && json.error;
      if (error && (error.message || error.code)) return (error.code ? error.code + '：' : '') + (error.message || '');
      return t('loadFailed', { msg: 'UNKNOWN' });
    }

    function formFromOptions(options) {      const o = options || {};
      const q = Number(o.quotaBytes);
      return {
        mode: typeof o.mode === 'string' && ['safe', 'normal', 'aggressive'].indexOf(o.mode) >= 0 ? o.mode : 'normal',
        retainDays: o.retainDays === null || o.retainDays === undefined ? '' : String(o.retainDays),
        quotaGB: Number.isFinite(q) && q > 0 ? String(Math.round((q / GIB) * 10) / 10) : '',
        autoClean: o.autoClean !== false,
        autoCleanLegacy: o.autoCleanLegacy === true,
        manageArchives: o.manageArchives === true,
        intervalDays: intervalDaysFromHours(o.intervalHours),
        intervalHoursCurrent: Number.isFinite(Number(o.intervalHours)) ? Number(o.intervalHours) : null,
      };
    }

    function archivedTotals(conversations) {
      const list = conversations && Array.isArray(conversations.archived) ? conversations.archived : [];
      let bytes = 0;
      let projcache = 0;
      for (const row of list) {
        bytes += Number(row.sizeBytes) || 0;
        projcache += Number(row.projcacheBytes) || 0;
      }
      return { count: list.length, bytes, projcache };
    }

    function workspaceRows(workspace) {
      return workspace && Array.isArray(workspace.roots) ? workspace.roots : [];
    }

    function lastReportLine(report, t) {
      if (!report) return t('never');
      const totals = report.totals || {};
      const when = report.at ? formatTime(Date.parse(report.at)) : '';
      const verb = report.apply ? t('activeNow') : t('preview');
      return (
        (when ? when + ' · ' : '') +
        verb +
        '：' +
        (totals.deletedFiles || 0) +
        ' files / ' +
        formatBytes(totals.deletedBytes || 0)
      );
    }

    function summarize(action, data, t) {
      if (!data || typeof data !== 'object') return [];
      if (action === 'clean') {
        const totals = data.totals || {};
        return [
          'candidateFiles=' + (totals.candidateFiles || 0) + ' candidateBytes=' + formatBytes(totals.candidateBytes || 0),
          'deletedFiles=' + (totals.deletedFiles || 0) + ' deletedBytes=' + formatBytes(totals.deletedBytes || 0),
          'skippedFiles=' + (totals.skippedFiles || 0) + ' dirsRemoved=' + (totals.dirsRemoved || 0),
          (data.warnings || []).length ? 'warnings=' + data.warnings.length : '',
        ].filter(Boolean);
      }
      if (action === 'workspace-clean') {
        const plan = data.plan || {};
        const deleted = data.deleted || {};
        return [
          'plan entries=' + ((plan.totals && plan.totals.entries) || 0) + ' bytes=' + formatBytes((plan.totals && plan.totals.bytes) || 0),
          'deleted entries=' + (deleted.entries || 0) + ' bytes=' + formatBytes(deleted.bytes || 0),
          'skipped=' + ((data.skipped || []).length) + ' refusals=' + ((data.refusals || []).length),
        ];
      }
      if (action === 'conversation-delete') {
        const plan = data.plan || {};
        const deleted = data.deleted || {};
        return [
          'targets=' + ((plan.targets || []).length) + ' totalBytes=' + formatBytes((plan.totals && plan.totals.totalBytes) || 0),
          'deleted sessions=' + (deleted.sessions || 0) + ' bytes=' + formatBytes(deleted.bytes || 0),
          'projcache=' + (deleted.projcacheFiles || 0) + ' attachments=' + (deleted.attachments || 0) + ' tempDirs=' + (deleted.tempDirs || 0),
        ];
      }
      if (action === 'options-save') {
        return [t('saved')];
      }
      return [];
    }

    function shortSessionId(id) {
      const text = String(id || '');
      return (text.indexOf('session-') === 0 ? text.slice(8) : text).slice(0, 8);
    }

    function flattenText(value, max) {
      const text = String(value || '').replace(/\s+/g, ' ').trim();
      if (text.length <= max) return text;
      return text.slice(0, Math.max(0, max - 1)) + '…';
    }

    // --------------------------------------------------------------- panel
    function Panel(props) {
      const api = props.api;
      const t = props.t;

      const [view, setView] = React.useState({ loading: true, error: null, data: null });
      const [sections, setSections] = React.useState({ sizes: 'idle', workspace: 'idle', conversations: 'idle' });
      const [form, setForm] = React.useState(null);
      const [flags, setFlags] = React.useState({ includeLegacy: false, includeArchives: false, artifacts: false, tempDirs: false });
      const [busy, setBusy] = React.useState(null);
      const [pending, setPending] = React.useState(null);
      const [menuFor, setMenuFor] = React.useState(null);
      const [deleteTarget, setDeleteTarget] = React.useState(null);
      const [outcome, setOutcome] = React.useState(null);
      const alive = React.useRef(true);
      const timer = React.useRef(null);

      React.useEffect(function () {
        if (!menuFor && !deleteTarget) return undefined;
        function onKey(event) {
          if (event.key === 'Escape') {
            setMenuFor(null);
            setDeleteTarget(null);
          }
        }
        window.addEventListener('keydown', onKey);
        return function () {
          window.removeEventListener('keydown', onKey);
        };
      }, [menuFor, deleteTarget]);

      function retainPresetValue() {
        const raw = form ? String(form.retainDays).trim() : '';
        if (raw === '') return '';
        return RETAIN_DAY_PRESETS.indexOf(Number(raw)) >= 0 ? raw : 'custom';
      }

      function hintFor(name) {
        return sections[name] === 'error' ? t('sectionError') : t('detecting');
      }

      function mergeSection(name, payload) {
        setView(function (prev) {
          if (!prev || !prev.data) return prev;
          const next = Object.assign({}, prev.data);
          if (name === 'sizes') {
            next.status = Object.assign({}, prev.data.status, {
              roots: payload.status && payload.status.roots,
              rootsError: payload.status && payload.status.rootsError,
              complete: payload.status && payload.status.complete,
            });
          } else if (name === 'workspace') {
            next.workspace = payload.workspace || {};
          } else if (name === 'conversations') {
            next.conversations = payload.conversations || {};
          }
          return { loading: false, error: null, data: next };
        });
      }

      // v0.4.4：首屏只取 meta，扫描类数据块随后后台补拉，各自显示"检测中…"。
      async function loadSection(name) {
        setSections(function (prev) {
          const next = Object.assign({}, prev);
          next[name] = 'loading';
          return next;
        });
        try {
          const json = await api('status', { sections: [name] });
          if (!alive.current) return;
          setSections(function (prev) {
            const next = Object.assign({}, prev);
            next[name] = json && json.ok === true ? 'done' : 'error';
            return next;
          });
          if (json && json.ok === true) mergeSection(name, json.data);
        } catch {
          if (!alive.current) return;
          setSections(function (prev) {
            const next = Object.assign({}, prev);
            next[name] = 'error';
            return next;
          });
        }
      }

      const load = React.useCallback(
        async function load() {
          try {
            const json = await api('status', { sections: ['meta'] });
            if (!alive.current) return;
            if (!json || json.ok !== true) {
              setView({ loading: false, error: errorText(json, t), data: null });
              return;
            }
            setView({ loading: false, error: null, data: json.data });
            setForm(formFromOptions(json.data.options));
            loadSection('sizes');
            loadSection('workspace');
            loadSection('conversations');
          } catch (error) {
            if (alive.current) setView({ loading: false, error: (error && error.message) || String(error), data: null });
          }
        },
        [api, t],
      );

      React.useEffect(
        function () {
          alive.current = true;
          load();
          return function () {
            alive.current = false;
            if (timer.current) {
              clearTimeout(timer.current);
              timer.current = null;
            }
          };
        },
        [load],
      );

      function clearPending() {
        if (timer.current) {
          clearTimeout(timer.current);
          timer.current = null;
        }
        setPending(null);
      }

      async function run(action, params) {
        setBusy(action);
        setOutcome(null);
        try {
          const json = await api(action, params || {});
          if (!alive.current) return;
          setOutcome({ action, json });
          if (json && json.ok === true && action !== 'status') await load();
        } catch (error) {
          if (alive.current) {
            setOutcome({ action, json: { ok: false, error: { code: 'TRANSPORT', message: (error && error.message) || String(error) } } });
          }
        } finally {
          if (alive.current) setBusy(null);
        }
      }

      function ask(key, action, params) {
        if (pending && pending.key === key) {
          clearPending();
          run(action, Object.assign({}, params, { apply: true, confirm: true }));
          return;
        }
        setPending({ key });
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(function () {
          timer.current = null;
          setPending(null);
        }, 5000);
      }

      function setField(name, value) {
        setForm(function (prev) {
          const next = Object.assign({}, prev);
          next[name] = value;
          return next;
        });
      }

      function setFlag(name, value) {
        setFlags(function (prev) {
          const next = Object.assign({}, prev);
          next[name] = value;
          return next;
        });
      }

      async function saveOptions() {
        if (!form) return;
        const patch = {
          mode: form.mode,
          retainDays: String(form.retainDays).trim() === '' ? null : Number(form.retainDays),
          quotaBytes: String(form.quotaGB).trim() === '' ? null : Math.round(Number(form.quotaGB) * GIB),
          autoClean: form.autoClean === true,
          autoCleanLegacy: form.autoCleanLegacy === true,
          manageArchives: form.manageArchives === true,
        };
        if (form.intervalDays !== '') patch.intervalHours = Number(form.intervalDays) * 24;
        setBusy('options-save');
        setOutcome(null);
        try {
          const json = await api('options-save', patch);
          if (!alive.current) return;
          setOutcome({ action: 'options-save', json });
          if (json && json.ok === true) {
            // 保存会触发插件 reload（Host 半短暂不可用），等一拍再重取，避免把 reload 窗口当成加载失败。
            await new Promise(function (resolve) { setTimeout(resolve, 700); });
            await load();
          }
        } catch (error) {
          if (alive.current) {
            setOutcome({ action: 'options-save', json: { ok: false, error: { code: 'TRANSPORT', message: (error && error.message) || String(error) } } });
          }
        } finally {
          if (alive.current) setBusy(null);
        }
      }

      // ------------------------------------------------------------- styles
      const S = {
        wrap: { maxWidth: 860, padding: '4px 0 32px', color: 'var(--dsw-alias-label-primary)', fontSize: 13, lineHeight: 1.6 },
        titleRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 4 },
        title: { fontSize: 16, fontWeight: 600 },
        subtitle: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, marginBottom: 12 },
        card: {
          border: '1px solid var(--dsw-alias-border-l1)',
          borderRadius: 8,
          background: 'var(--dsw-alias-bg-layer-1)',
          padding: '12px 14px',
          marginBottom: 12,
        },
        cardTitle: { fontSize: 13, fontWeight: 600, marginBottom: 8 },
        hint: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, marginBottom: 8 },
        row: { display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 8 },
        label: { width: 210, flex: '0 0 210px', color: 'var(--dsw-alias-label-secondary)', paddingTop: 3 },
        control: { flex: '1 1 auto', minWidth: 0 },
        code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, wordBreak: 'break-all' },
        value: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 },
        input: {
          boxSizing: 'border-box',
          width: 180,
          height: 28,
          padding: '0 8px',
          borderRadius: 6,
          border: '1px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-base)',
          color: 'var(--dsw-alias-label-primary)',
          fontSize: 13,
        },
        select: {
          boxSizing: 'border-box',
          width: 220,
          height: 28,
          padding: '0 6px',
          borderRadius: 6,
          border: '1px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-base)',
          color: 'var(--dsw-alias-label-primary)',
          fontSize: 13,
        },
        btn: {
          height: 28,
          padding: '0 12px',
          borderRadius: 6,
          border: '1px solid var(--dsw-alias-border-l2)',
          background: 'transparent',
          color: 'var(--dsw-alias-label-primary)',
          fontSize: 13,
          cursor: 'pointer',
        },
        btnPrimary: {
          height: 28,
          padding: '0 12px',
          borderRadius: 6,
          border: '1px solid transparent',
          background: 'var(--dsw-alias-brand-primary)',
          color: 'var(--dsw-alias-bg-base)',
          fontSize: 13,
          cursor: 'pointer',
        },
        btnDanger: {
          height: 28,
          padding: '0 12px',
          borderRadius: 6,
          border: '1px solid var(--dsw-alias-state-error-primary)',
          background: 'transparent',
          color: 'var(--dsw-alias-state-error-primary)',
          fontSize: 13,
          cursor: 'pointer',
        },
        iconBtn: {
          width: 24,
          height: 24,
          padding: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 6,
          border: '1px solid var(--dsw-alias-border-l2)',
          background: 'transparent',
          color: 'var(--dsw-alias-label-primary)',
          cursor: 'pointer',
        },
        menuWrap: { position: 'relative', display: 'inline-flex' },
        menuBackdrop: { position: 'fixed', inset: 0, zIndex: 30, background: 'transparent' },
        menu: {
          position: 'absolute',
          right: 0,
          top: '100%',
          marginTop: 4,
          zIndex: 40,
          minWidth: 190,
          padding: 4,
          borderRadius: 8,
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-bg-layer-1)',
          boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
        },
        menuItem: {
          display: 'block',
          width: '100%',
          textAlign: 'left',
          padding: '6px 8px',
          border: 'none',
          borderRadius: 4,
          background: 'transparent',
          color: 'var(--dsw-alias-label-primary)',
          fontSize: 12,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        },
        modalBackdrop: {
          position: 'fixed',
          inset: 0,
          zIndex: 60,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 16,
          background: 'rgba(0, 0, 0, 0.35)',
        },
        modal: {
          width: 'min(420px, 92vw)',
          padding: '14px 16px',
          borderRadius: 10,
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-bg-layer-1)',
          boxShadow: '0 12px 32px rgba(0, 0, 0, 0.25)',
        },
        modalTitle: { fontSize: 14, fontWeight: 600, marginBottom: 8 },
        btnRow: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
        table: { width: '100%', borderCollapse: 'collapse', fontSize: 12, tableLayout: 'fixed' },
        thNowrap: {
          textAlign: 'left',
          fontWeight: 500,
          color: 'var(--dsw-alias-label-secondary)',
          padding: '4px 6px',
          borderBottom: '1px solid var(--dsw-alias-border-l1)',
          whiteSpace: 'nowrap',
        },
        tdId: {
          padding: '4px 6px',
          borderBottom: '1px solid var(--dsw-alias-border-l1)',
          verticalAlign: 'middle',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        },
        tdWorkspace: {
          padding: '4px 6px',
          borderBottom: '1px solid var(--dsw-alias-border-l1)',
          verticalAlign: 'middle',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        },
        tdSize: {
          padding: '4px 6px',
          borderBottom: '1px solid var(--dsw-alias-border-l1)',
          verticalAlign: 'middle',
          whiteSpace: 'nowrap',
        },
        th: {
          textAlign: 'left',
          fontWeight: 500,
          color: 'var(--dsw-alias-label-secondary)',
          padding: '4px 6px',
          borderBottom: '1px solid var(--dsw-alias-border-l1)',
        },
        td: { padding: '4px 6px', borderBottom: '1px solid var(--dsw-alias-border-l1)', verticalAlign: 'middle' },
        tdFirst: {
          padding: '4px 6px',
          borderBottom: '1px solid var(--dsw-alias-border-l1)',
          verticalAlign: 'middle',
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
        },
        rowActions: { display: 'flex', flexDirection: 'row', gap: 4, alignItems: 'center' },
        pre: {
          margin: '6px 0 0',
          maxHeight: 240,
          overflow: 'auto',
          padding: 8,
          borderRadius: 6,
          background: 'var(--dsw-alias-bg-layer-2)',
          fontSize: 11,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        },
        error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, marginTop: 6 },
        ok: { color: 'var(--dsw-alias-state-success-primary)', fontSize: 12, marginTop: 6 },
        disabled: { opacity: 0.5, cursor: 'default' },
      };

      function btn(style, label, onClick, disabled, title) {
        const merged = disabled ? Object.assign({}, style, S.disabled) : style;
        return h(
          'button',
          { type: 'button', style: merged, disabled: disabled === true, onClick: onClick, title: title || label },
          label,
        );
      }

      function checkbox(id, checked, onChange, label) {
        return h(
          'label',
          { htmlFor: id, style: { display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 } },
          h('input', { id: id, type: 'checkbox', checked: checked === true, onChange: function (event) { onChange(event.target.checked); } }),
          h('span', null, label),
        );
      }

      function previewButton(onClick) {
        return btn(S.btn, t('preview'), onClick, busy !== null);
      }

      function dangerButton(key, idleLabel, confirmLabel, onConfirm) {
        const isPending = !!(pending && pending.key === key);
        if (!isPending) return btn(S.btnPrimary, idleLabel, onConfirm, busy !== null);
        return h(
          React.Fragment,
          null,
          btn(S.btnDanger, confirmLabel, onConfirm, busy !== null),
          btn(S.btn, t('cancel'), clearPending, busy !== null),
        );
      }

      // 行内垃圾桶图标：SVG 直接画在组件里（不读宿主 DOM、不 require 宿主控件包）。
      function trashIcon() {
        return h(
          'svg',
          {
            width: 14,
            height: 14,
            viewBox: '0 0 16 16',
            'aria-hidden': 'true',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.5,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          },
          h('path', { d: 'M2.5 4.5h11' }),
          h('path', { d: 'M5.5 4.5V3.2c0-.4.3-.7.7-.7h3.6c.4 0 .7.3.7.7v1.3' }),
          h('path', { d: 'M4.2 4.5l.6 8.6c0 .4.3.7.7.7h5c.4 0 .7-.3.7-.7l.6-8.6' }),
          h('path', { d: 'M6.6 7v4.2M9.4 7v4.2' }),
        );
      }

      // -------------------------------------------------------------- render
      if (view.loading && !view.data) {
        return h('div', { style: S.wrap }, h('div', { style: S.title }, t('title')), h('div', { style: S.hint }, t('loading')));
      }

      if (view.error && !view.data) {
        return h(
          'div',
          { style: S.wrap },
          h('div', { style: S.titleRow }, h('div', { style: S.title }, t('title')), btn(S.btn, t('refresh'), function () { load(); }, false)),
          h('div', { style: S.error }, t('loadFailed', { msg: view.error })),
          h('div', { style: S.hint }, t('apiUnavailable')),
        );
      }

      const data = view.data || {};
      const status = data.status || {};
      const options = data.options || {};
      const workspace = data.workspace || {};
      const conversations = data.conversations || {};
      const conv = archivedTotals(conversations);
      const archivedRows = Array.isArray(conversations.archived) ? conversations.archived : [];
      const previewData = outcome && outcome.action === 'conversation-delete' && outcome.json && outcome.json.ok === true ? outcome.json.data || {} : null;
      const previewTargets = previewData ? (previewData.plan && previewData.plan.targets) || [] : [];
      const roots = workspaceRows(workspace);
      const rootList = (status.roots && status.roots.cacheRootBytes) || {};

      return h(
        'div',
        { style: S.wrap, className: 'dcg-root' },
        h(
          'div',
          { style: S.titleRow },
          h('div', null, h('div', { style: S.title }, t('title')), h('div', { style: S.subtitle }, t('subtitle'))),
          btn(S.btn, t('refresh'), function () { load(); }, busy !== null),
        ),

        // 1. overview
        h(
          'div',
          { style: S.card, className: 'dcg-card dcg-overview' },
          h('div', { style: S.cardTitle }, t('overview')),
          h(
            'div',
            { style: S.row },
            h('div', { style: S.label }, t('redirectOn')),
            h(
              'div',
              { style: S.control },
              h(
                'span',
                { style: status.redirect && status.redirect.applied ? S.ok : S.error },
                status.redirect && status.redirect.applied ? t('yes') : t('no') + '（' + ((status.redirect && status.redirect.reason) || '') + '）',
              ),
            ),
          ),
          h(
            'div',
            { style: S.row },
            h('div', { style: S.label }, t('cacheRoot')),
            h(
              'div',
              { style: S.control },
              h('div', { style: S.code }, String(status.cacheRoot || '')),
              h(
                'div',
                { style: S.hint },
                status.roots
                  ? formatBytes(status.roots.cacheRootBytes) + ' · v' + ((status.plugin && status.plugin.version) || '?')
                  : hintFor('sizes'),
              ),
            ),
          ),
          h(
            'div',
            { style: S.row },
            h('div', { style: S.label }, t('tempRoot')),
            h(
              'div',
              { style: S.control },
              h('div', { style: S.code }, String(status.tempRoot || '')),
              h('div', { style: S.hint }, status.roots ? formatBytes(status.roots.tempRootBytes) : hintFor('sizes')),
            ),
          ),
          h(
            'div',
            { style: S.row },
            h('div', { style: S.label }, t('legacyTitle')),
            h(
              'div',
              { style: S.control },
              h(
                'div',
                null,
                status.roots
                  ? interpolate(t('legacySummary'), {
                      dirs: (status.roots.legacy && status.roots.legacy.dirCount) || 0,
                      bytes: formatBytes(status.roots.legacy && status.roots.legacy.bytes),
                    })
                  : hintFor('sizes'),
              ),
            ),
          ),
          h('div', { style: S.row }, h('div', { style: S.label }, t('lastReport')), h('div', { style: S.control }, lastReportLine(status.lastReport, t))),
        ),

        // 2. cache cleanup
        h(
          'div',
          { style: S.card, className: 'dcg-card dcg-clean' },
          h('div', { style: S.cardTitle }, t('cleanSection')),
          h('div', { style: S.hint }, t('cleanHint')),
          h(
            'div',
            { style: S.row },
            h('div', { style: S.label }, t('mode')),
            h(
              'div',
              { style: S.control },
              h(
                'select',
                { style: S.select, value: (form && form.mode) || 'normal', onChange: function (event) { setField('mode', event.target.value); }, disabled: busy !== null },
                h('option', { value: 'safe' }, t('modeSafe')),
                h('option', { value: 'normal' }, t('modeNormal')),
                h('option', { value: 'aggressive' }, t('modeAggressive')),
              ),
            ),
          ),
          h(
            'div',
            { style: S.row },
            h('div', { style: S.label }, t('retainDays')),
            h(
              'div',
              { style: S.control },
              h(
                'select',
                {
                  style: S.select,
                  value: retainPresetValue(),
                  onChange: function (event) {
                    const next = event.target.value;
                    if (next !== 'custom') {
                      setField('retainDays', next);
                      return;
                    }
                    const current = form ? String(form.retainDays).trim() : '';
                    const keep = current !== '' && RETAIN_DAY_PRESETS.indexOf(Number(current)) < 0;
                    setField('retainDays', keep ? current : '14');
                  },
                  disabled: busy !== null,
                },
                h('option', { value: '' }, t('retainDaysDefault')),
                RETAIN_DAY_PRESETS.map(function (days) {
                  return h('option', { key: String(days), value: String(days) }, String(days) + ' ' + t('retainDaysSuffix'));
                }),
                h('option', { value: 'custom' }, t('retainDaysCustom')),
              ),
              retainPresetValue() === 'custom'
                ? h('input', {
                    type: 'number',
                    min: 1,
                    max: 365,
                    style: S.input,
                    value: form ? form.retainDays : '',
                    placeholder: t('retainDaysHint'),
                    onChange: function (event) { setField('retainDays', event.target.value); },
                    disabled: busy !== null,
                  })
                : null,
            ),
          ),
          h(
            'div',
            { style: S.row },
            h('div', { style: S.label }, t('scanFrequency')),
            h(
              'div',
              { style: S.control },
              h(
                'select',
                {
                  style: S.select,
                  value: form ? form.intervalDays : '',
                  onChange: function (event) { setField('intervalDays', event.target.value); },
                  disabled: busy !== null,
                },
                form && form.intervalDays === ''
                  ? h(
                      'option',
                      { value: '' },
                      form.intervalHoursCurrent !== null && form.intervalHoursCurrent !== undefined
                        ? interpolate(t('scanKeepCurrent'), { hours: form.intervalHoursCurrent })
                        : t('scanKeepCurrentUnknown'),
                    )
                  : null,
                SCAN_INTERVAL_PRESETS.map(function (days) {
                  return h('option', { key: String(days), value: String(days) }, String(days) + ' ' + t('retainDaysSuffix'));
                }),
              ),
              h('div', { style: S.hint }, t('scanFrequencyHint')),
            ),
          ),
          h(
            'div',
            { style: S.row },
            h('div', { style: S.label }, t('quotaGB')),
            h(
              'div',
              { style: S.control },
              h('input', {
                type: 'number',
                min: 0,
                step: 0.5,
                style: S.input,
                value: form ? form.quotaGB : '',
                placeholder: t('quotaGBHint'),
                onChange: function (event) { setField('quotaGB', event.target.value); },
                disabled: busy !== null,
              }),
            ),
          ),
          h(
            'div',
            { style: S.row },
            h('div', { style: S.label }, null),
            h('div', { style: S.control }, checkbox('dcg-legacy', flags.includeLegacy, function (v) { setFlag('includeLegacy', v); }, t('includeLegacy'))),
          ),
          h(
            'div',
            { style: S.btnRow },
            previewButton(function () {
              clearPending();
              run('clean', { apply: false, includeLegacy: flags.includeLegacy, mode: form && form.mode });
            }),
            dangerButton('clean', t('runClean'), t('confirmClean'), function () {
              ask('clean', 'clean', { includeLegacy: flags.includeLegacy, mode: form && form.mode });
            }),
          ),
        ),

        // 3. workspace
        h(
          'div',
          { style: S.card, className: 'dcg-card dcg-workspace' },
          h('div', { style: S.cardTitle }, t('wsSection')),
          h('div', { style: S.hint }, t('wsHint')),
          data.workspace ? null : h('div', { style: S.hint }, hintFor('workspace')),
          data.workspace ? h(
            'table',
            { style: S.table },
            h('thead', null, h('tr', null, h('th', { style: S.th }, ''), h('th', { style: S.th }, t('wsKind')), h('th', { style: S.th }, t('wsExists')), h('th', { style: S.th }, t('wsBytes')), h('th', { style: S.th }, t('wsStale')))),
            h(
              'tbody',
              null,
              roots.map(function (root) {
                return h(
                  'tr',
                  { key: root.path },
                  h('td', { style: S.td }, h('span', { style: S.code }, String(root.path || ''))),
                  h('td', { style: S.td }, root.kind === 'archive' ? t('kindArchive') : t('kindTemp')),
                  h('td', { style: S.td }, root.exists ? t('yes') : t('wsMissing')),
                  h('td', { style: S.td }, formatBytes(root.bytes)),
                  h('td', { style: S.td }, String(root.staleCount || 0) + ' / ' + formatBytes(root.staleBytes || 0)),
                );
              }),
            ),
          ) : null,
          h(
            'div',
            { style: Object.assign({}, S.row, { marginTop: 8 }) },
            h('div', { style: S.label }, null),
            h('div', { style: S.control }, checkbox('dcg-archives', flags.includeArchives, function (v) { setFlag('includeArchives', v); }, t('includeArchives')), h('div', { style: S.hint }, t('archiveGate'))),
          ),
          h(
            'div',
            { style: S.btnRow },
            previewButton(function () {
              clearPending();
              run('workspace-clean', { apply: false, includeArchives: flags.includeArchives });
            }),
            dangerButton('workspace-clean', t('runWs'), t('confirmWs'), function () {
              ask('workspace-clean', 'workspace-clean', { includeArchives: flags.includeArchives });
            }),
          ),
        ),

        // 4. archived conversations
        h(
          'div',
          { style: S.card, className: 'dcg-card dcg-conversations' },
          h('div', { style: S.cardTitle }, t('convSection')),
          h(
            'div',
            { style: S.hint },
            data.conversations
              ? interpolate(t('convSummary'), { count: conv.count, bytes: formatBytes(conv.bytes), projcache: formatBytes(conv.projcache) })
              : hintFor('conversations'),
          ),
          data.conversations
            ? h(
                'div',
                { className: 'dcg-conv-list' },
                archivedRows.length
                  ? h(
                      'table',
                      { style: S.table },
                      h(
                        'colgroup',
                        null,
                        h('col', { style: { width: '13%' } }),
                        h('col', { style: { width: '25%' } }),
                        h('col', null),
                        h('col', { style: { width: '10%' } }),
                        h('col', { style: { width: '10%' } }),
                        h('col', { style: { width: '10%' } }),
                      ),
                      h(
                        'thead',
                        null,
                        h(
                          'tr',
                          null,
                          h('th', { style: S.thNowrap }, t('convId')),
                          h('th', { style: S.th }, t('convWorkspace')),
                          h('th', { style: S.th }, t('convFirst')),
                          h('th', { style: S.thNowrap }, t('convLogSize')),
                          h('th', { style: S.thNowrap }, t('convProjSize')),
                          h('th', { style: S.thNowrap }, t('convActions')),
                        ),
                      ),
                      h(
                        'tbody',
                        null,
                        archivedRows.slice(0, 20).map(function (row) {
                          const sid = String(row.id);
                          return h(
                            'tr',
                            { key: sid },
                            h(
                              'td',
                              { style: S.tdId },
                              h('span', { style: S.code }, shortSessionId(row.id)),
                              row.isGhost ? h('span', { style: S.hint }, ' · ' + t('convGhostTag')) : null,
                            ),
                            h('td', { style: S.tdWorkspace, title: row.cwd || '' }, row.cwd || '—'),
                            h('td', { style: S.tdFirst, title: flattenText(row.firstUserText, 200) || '' }, flattenText(row.firstUserText, 40) || '—'),
                            h('td', { style: S.tdSize }, formatBytes(row.sizeBytes || 0)),
                            h('td', { style: S.tdSize }, formatBytes(row.projcacheBytes || 0)),
                            h(
                              'td',
                              { style: S.td },
                              h(
                                'div',
                                { style: S.rowActions },
                                h(
                                  'button',
                                  {
                                    type: 'button',
                                    style: S.iconBtn,
                                    title: t('convTrashTitle'),
                                    'aria-label': t('convTrashTitle'),
                                    disabled: busy !== null,
                                    onClick: function () {
                                      setMenuFor(null);
                                      setDeleteTarget({ id: sid, cwd: row.cwd || '', sizeBytes: row.sizeBytes || 0, includeArtifacts: false });
                                    },
                                  },
                                  trashIcon(),
                                ),
                                h(
                                  'div',
                                  { style: S.menuWrap },
                                  h(
                                    'button',
                                    {
                                      type: 'button',
                                      style: S.iconBtn,
                                      title: t('convMenuMore'),
                                      'aria-label': t('convMenuMore'),
                                      'aria-haspopup': 'menu',
                                      'aria-expanded': menuFor === sid,
                                      disabled: busy !== null,
                                      onClick: function () {
                                        setMenuFor(menuFor === sid ? null : sid);
                                      },
                                    },
                                    h('span', { 'aria-hidden': 'true', style: { fontSize: 12, lineHeight: 1 } }, '▾'),
                                  ),
                                  menuFor === sid
                                    ? h(
                                        React.Fragment,
                                        null,
                                        h('div', { style: S.menuBackdrop, onClick: function () { setMenuFor(null); } }),
                                        h(
                                          'div',
                                          { style: S.menu, role: 'menu' },
                                          h(
                                            'button',
                                            {
                                              type: 'button',
                                              role: 'menuitem',
                                              style: S.menuItem,
                                              onClick: function () {
                                                setMenuFor(null);
                                                setDeleteTarget({ id: sid, cwd: row.cwd || '', sizeBytes: row.sizeBytes || 0, includeArtifacts: false });
                                              },
                                            },
                                            t('convMenuKeep'),
                                          ),
                                          h(
                                            'button',
                                            {
                                              type: 'button',
                                              role: 'menuitem',
                                              style: S.menuItem,
                                              onClick: function () {
                                                setMenuFor(null);
                                                setDeleteTarget({ id: sid, cwd: row.cwd || '', sizeBytes: row.sizeBytes || 0, includeArtifacts: true });
                                              },
                                            },
                                            t('convMenuArtifacts'),
                                          ),
                                        ),
                                      )
                                    : null,
                                ),
                              ),
                            ),
                          );
                        }),
                      ),
                    )
                  : h('div', { style: S.hint }, t('convNoRows')),
                archivedRows.length > 20
                  ? h('div', { style: S.hint }, interpolate(t('convMore'), { count: archivedRows.length - 20 }))
                  : null,
              )
            : null,
          h(
            'div',
            { style: S.row },
            h('div', { style: S.label }, null),
            h(
              'div',
              { style: S.control },
              checkbox('dcg-artifacts', flags.artifacts, function (v) { setFlag('artifacts', v); if (!v) setFlag('tempDirs', false); }, t('includeArtifacts')),
              checkbox('dcg-tempdirs', flags.tempDirs && flags.artifacts, function (v) { setFlag('tempDirs', v); }, t('includeTempDirs')),
            ),
          ),
          h(
            'div',
            { style: S.btnRow },
            previewButton(function () {
              clearPending();
              run('conversation-delete', { allArchived: true, apply: false, includeArtifacts: flags.artifacts, includeTempDirs: flags.tempDirs && flags.artifacts });
            }),
            dangerButton('conversation-delete', t('runConv'), t('confirmConv'), function () {
              ask('conversation-delete', 'conversation-delete', { allArchived: true, includeArtifacts: flags.artifacts, includeTempDirs: flags.tempDirs && flags.artifacts });
            }),
          ),
          outcome && outcome.action === 'conversation-delete'
            ? h(
                'div',
                { style: { marginTop: 8 }, 'aria-live': 'polite' },
                outcome.json && outcome.json.ok === true
                  ? h(
                      React.Fragment,
                      null,
                      h(
                        'div',
                        { style: S.hint },
                        interpolate(t('convTargets'), {
                          count: previewTargets.length,
                          bytes: formatBytes((previewData.plan && previewData.plan.totals && previewData.plan.totals.totalBytes) || 0),
                        }),
                      ),
                      h(
                        'table',
                        { style: S.table },
                        h(
                          'tbody',
                          null,
                          previewTargets.slice(0, 20).map(function (target) {
                            return h(
                              'tr',
                              { key: String(target.id) },
                              h('td', { style: S.td }, h('span', { style: S.code }, shortSessionId(target.id))),
                              h('td', { style: S.td }, formatBytes(target.sizeBytes || 0)),
                              h('td', { style: S.td }, target.blocked ? String(target.blocked.reason || '') : (target.isGhost ? t('convGhostTag') : '')),
                            );
                          }),
                        ),
                      ),
                      previewTargets.length > 20
                        ? h('div', { style: S.hint }, interpolate(t('convMore'), { count: previewTargets.length - 20 }))
                        : null,
                    )
                  : h('div', { style: S.error }, t('error') + '：' + errorText(outcome.json, t)),
              )
            : null,
        ),

        // 5. options
        h(
          'div',
          { style: S.card, className: 'dcg-card dcg-options' },
          h('div', { style: S.cardTitle }, t('optionsSection')),
          h('div', { style: S.hint }, t('optionsHint')),
          h(
            'div',
            { style: S.row },
            h('div', { style: S.label }, t('autoClean')),
            h('div', { style: S.control }, checkbox('dcg-autoclean', form && form.autoClean, function (v) { setField('autoClean', v); }, t('autoClean'))),
          ),
          h(
            'div',
            { style: S.row },
            h('div', { style: S.label }, t('autoCleanLegacy')),
            h('div', { style: S.control }, checkbox('dcg-autolegacy', form && form.autoCleanLegacy, function (v) { setField('autoCleanLegacy', v); }, t('autoCleanLegacy'))),
          ),
          h(
            'div',
            { style: S.row },
            h('div', { style: S.label }, t('manageArchives')),
            h('div', { style: S.control }, checkbox('dcg-managearchives', form && form.manageArchives, function (v) { setField('manageArchives', v); }, t('manageArchives'))),
          ),
          h(
            'div',
            { style: S.btnRow },
            btn(busy === 'options-save' ? S.btn : S.btnPrimary, busy === 'options-save' ? t('saving') : t('save'), saveOptions, busy !== null),
            options.retainDays !== null && options.retainDays !== undefined ? h('span', { style: S.hint }, t('retainDays') + ': ' + String(options.retainDays)) : null,
          ),
        ),

        // outcome
        outcome
          ? h(
              'div',
              { style: S.card, 'aria-live': 'polite', className: 'dcg-card dcg-outcome' },
              h(
                'div',
                { style: S.cardTitle },
                t('result') + '：' + outcome.action,
                outcome.json && outcome.json.ok === true ? (outcome.action === 'options-save' ? '' : '') : '',
              ),
              outcome.json && outcome.json.ok === true
                ? h(
                    'div',
                    null,
                    summarize(outcome.action, outcome.json.data, t).map(function (line, index) {
                      return h('div', { key: index, style: S.hint }, line);
                    }),
                    outcome.action !== 'options-save' && outcome.action !== 'status'
                      ? h('div', { style: S.ok }, outcome.json.data && outcome.json.data.apply === false ? t('previewOnly') : '')
                      : null,
                  )
                : h('div', { style: S.error }, t('error') + '：' + errorText(outcome.json, t)),
              h('details', null, h('summary', { style: S.hint }, t('raw')), h('pre', { style: S.pre }, JSON.stringify(outcome.json, null, 2))),
            )
          : null,

        // 删除确认对话框（垃圾桶 / 下拉菜单任意一项都会先经过这里）
        deleteTarget
          ? h(
              'div',
              {
                style: S.modalBackdrop,
                onClick: function (event) {
                  if (event.target === event.currentTarget) setDeleteTarget(null);
                },
              },
              h(
                'div',
                { style: S.modal, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dcg-delete-title' },
                h('div', { style: S.modalTitle, id: 'dcg-delete-title' }, t('convDeleteTitle')),
                h(
                  'div',
                  { style: S.hint },
                  shortSessionId(deleteTarget.id) + ' · ' + (deleteTarget.cwd || '—') + ' · ' + formatBytes(deleteTarget.sizeBytes || 0),
                ),
                h(
                  'div',
                  { style: { marginBottom: 8 } },
                  interpolate(deleteTarget.includeArtifacts ? t('convDeleteArtifactsBody') : t('convDeleteKeepBody'), {
                    id: shortSessionId(deleteTarget.id),
                    bytes: formatBytes(deleteTarget.sizeBytes || 0),
                  }),
                ),
                h('div', { style: S.error }, t('convDeleteIrreversible')),
                h(
                  'div',
                  { style: S.btnRow },
                  btn(S.btnDanger, t('convDeleteConfirm'), function () {
                    const target = deleteTarget;
                    setDeleteTarget(null);
                    run('conversation-delete', {
                      sessionIds: [target.id],
                      includeArtifacts: target.includeArtifacts === true,
                      includeTempDirs: false,
                      apply: true,
                      confirm: true,
                    });
                  }, busy !== null),
                  btn(S.btn, t('cancel'), function () { setDeleteTarget(null); }, false),
                ),
              ),
            )
          : null,
      );
    }

    // ----------------------------------------------------------- plugin api
    function apply(ctx) {
      const locale = ctx.locale;
      let t = function (key, vars) {
        let active = 'zh';
        try {
          if (locale && typeof locale.getLocale === 'function') active = locale.getLocale().active || 'zh';
        } catch {
          active = 'zh';
        }
        const dict = active === 'en' ? EN : ZH;
        const text = dict[key] !== undefined ? dict[key] : ZH[key] !== undefined ? ZH[key] : key;
        return vars ? interpolate(text, vars) : text;
      };
      if (locale && typeof locale.register === 'function') {
        ctx.effect(function () {
          return locale.register(NS, DICTS);
        }, 'dsh-cache-cleaner: locale dictionaries');
      }
      if (locale && typeof locale.bind === 'function') {
        const bound = locale.bind(NS);
        // bound() 只吃 key；本面板的固定文案里带 {msg}/{dirs} 占位符，统一在这里补插值。
        t = function (key, vars) {
          const text = bound(key);
          return vars ? interpolate(text, vars) : text;
        };
      }

      // 只走 Host 半用 connection.fetch 注册的 /api 精确路由（认证 cookie 由浏览器自动携带）。
      // v4.2：webServer exact 回退对 POST 返回 405，已移除；失败时把 HTTP 状态写进错误里便于定位。
      const api = async function (action, params) {
        const body = JSON.stringify({ action: action, params: params || {} });
        let response;
        try {
          response = await fetch(API_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: body,
          });
        } catch (error) {
          return {
            ok: false,
            error: {
              code: 'HOST_API_UNAVAILABLE',
              message: t('apiUnavailable') + ' [network: ' + ((error && error.message) || String(error)) + ']',
            },
          };
        }
        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
          return {
            ok: false,
            error: {
              code: 'HOST_API_UNAVAILABLE',
              message: t('apiUnavailable') + ' [HTTP ' + response.status + ' ' + contentType + ']',
            },
          };
        }
        if (!response.ok) {
          return { ok: false, error: { code: 'HTTP_' + response.status, message: 'HTTP ' + response.status } };
        }
        try {
          return await response.json();
        } catch (error) {
          return { ok: false, error: { code: 'BAD_RESPONSE', message: (error && error.message) || String(error) } };
        }
      };

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          {
            name: 'settings.section',
            id: 'cache-guard',
            order: 30,
            label: function () {
              return t('nav');
            },
          },
          function (props) {
            return h(Panel, Object.assign({}, props, { api: api, t: t }));
          },
        );
      });
    }

    return { inject: ['slots', 'locale'], apply: apply };
  },
});
