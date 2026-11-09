# dsh-cache-cleaner

[English](README.md) | **简体中文**

把 DeepSeek Harness（DSH）的临时缓存迁到可配置位置，按严格白名单清理，并管理已归档会话与工作区临时/归档目录——设置页、CLI、agent 工具三种入口都能用。

> 插件界面为**中英双语**：设置页文案随 DSH 语言切换，7 个 agent 工具的描述同时提供英文与中文。

## 功能

- **缓存迁移** — 插件把宿主进程的 `TEMP`/`TMP`（因而也包括 `os.tmpdir()` 与其子进程）重定向到 `<cacheRoot>/temp`，新会话快照不再落到系统盘。
- **白名单清理** — 只有匹配 `dsh-workspace-changes-*/objects/<2 位 hex>/tmp_obj_<6 位>` 的文件可被删除。`captures/`、sha1 对象、锁文件、会话、配置与凭据永不被触碰。
- **双闸门** — 天数（默认 14 天）与配额（缓存超过 50 GiB 时按最旧优先降到 80%）。旧 `%TEMP%/dsh-workspace-changes-*` 目录单独处理，最小年龄 24 小时。
- **归档会话** — 列出已归档会话、预览删除计划，再连带（或不带）附件与投影缓存一起删除。删除走宿主自己的注册表 API；活跃会话一律拒绝。
- **工作区根** — 报告并（可选）清理配置的临时/归档目录的直接子项，过期判定用每棵子树的最新 mtime。归档根在显式开启前只报告不删除。
- **设置页** — 设置下新增「缓存清理」区，含概览、缓存、工作区、归档会话与清理选项；面板先出界面，后台扫描完成后自动填入。
- **7 个 agent 工具** — `cache_status`、`cache_clean`、`cache_ownership`、`conversation_list`、`conversation_delete`、`workspace_status`、`workspace_clean`。

## 安装

```sh
# 从 GitHub 安装
dsh plugin add github:<owner>/dsh-cache-cleaner

# 或从本地目录安装
dsh plugin add file:D:/path/to/dsh-cache-cleaner
```

bundle patch 会声明插件行；宿主在下次重启（或插件禁用/启用重载）后加载。

## 配置

所有键都可选。改 profile 的 `cordis.patch.yml` 里本插件条目的 `config`（设置页也会持久化清理选项）。

| 键 | 默认值 | 含义 |
|---|---|---|
| `cacheRoot` | Windows：`%LOCALAPPDATA%\dsh-cache-cleaner`；其他：`$XDG_CACHE_HOME/dsh-cache-cleaner` 或 `~/.cache/dsh-cache-cleaner` | 重定向后的临时目录与报告的根。请放在有空间的盘。 |
| `redirectTemp` | `true` | 是否重定向宿主进程的 `TEMP`/`TMP`。 |
| `autoClean` | `true` | 是否跑定时清理（启动延迟 + 间隔 + 空闲去抖）。 |
| `autoCleanLegacy` | `false` | 自动清理是否包含旧 `%TEMP%/dsh-workspace-changes-*`。 |
| `startupDelaySeconds` | `60` | 首次自动清理前的延迟。 |
| `intervalHours` | `6` | 定时扫描间隔（界面预设：1/3/7/15/30 天）。 |
| `idleQuietMinutes` | `10` | agent 空闲超过该时长后再补跑一次。 |
| `mode` | `normal` | `safe`（30 天 / 50 GiB）、`normal`（14 天 / 50 GiB）、`aggressive`（1 天 / 30 GiB）。 |
| `retainDays` | `null` | 覆盖档位的天数闸门。 |
| `quotaBytes` | `null` | 覆盖档位的配额闸门。 |
| `workspaceBases` | `[]` | 配置的工作区根必须严格位于这些目录内部。 |
| `workspaceRoots` | `[]` | `[{path, kind: temp\|archive, retainDays, auto}]`；只考虑直接子项。 |
| `manageArchives` | `false` | 删除 `kind: archive` 根的总开关。 |

profile 里的覆盖示例：

```yaml
- id: dsh-cache-cleaner
  config:
    cacheRoot: 'D:\\Cache\\dsh-cache-cleaner'
    workspaceBases: ['D:/work/project']
    workspaceRoots:
      - { path: 'D:/work/project/_tmp', kind: temp, retainDays: 7, auto: true }
      - { path: 'D:/work/project/_archive', kind: archive, retainDays: 30, auto: false }
```

## 安全模型

- **只走白名单** — 不匹配 tmp 对象模式的一律不动；符号链接与 junction 既不跟随也不删除。
- **默认 dry-run** — CLI 与工具默认只报告计划，除非给 `--apply` / `apply:true`。真正执行需要 `confirm:true`；归档根还额外要求 `manageArchives:true` 与 `includeArchives:true`。
- **根标记** — 没有 `.dsh-cache-cleaner.json` 标记的 `cacheRoot` 会拒绝清理（标记由 `--init` 或插件写入），避免写错根目录被扫。
- **路径围栏** — 工作区根必须严格位于已配置的 base 内部；盘符根、家目录、`DSH_HOME` 与缓存根本身都会被拒绝。
- **真实空间校验** — 清理前后对比可用空间并报告差额（例如某些实现会把文件重定向到回收站）。
- **失败隔离** — 单个删不掉的文件记为 `skipped` 并带上路径与 errno，其余继续。

## 工具

| 工具 | 用途 |
|---|---|
| `cache_status` | 重定向状态、各根、大小、遗留目录、定时器、最近报告（只读）。 |
| `cache_clean` | 清理缓存临时对象；默认 dry-run。 |
| `cache_ownership` | 按创建时间窗把缓存临时目录归到会话（标注 `confidence: "time-window"`；该格式没有持久化归属）。 |
| `conversation_list` | 列出已归档会话（大小、工作区、首条消息、投影缓存）。 |
| `conversation_delete` | 计划或删除已归档会话；`includeArtifacts` 附带附件/投影缓存；`includeTempDirs` 附带时间窗临时目录。 |
| `workspace_status` | 报告配置的工作区根与过期直接子项。 |
| `workspace_clean` | 删除过期直接子项；归档根有闸门。 |

## CLI

```sh
node bin/dsh-cache-clean.mjs --init                 # 写入根标记
node bin/dsh-cache-clean.mjs                        # dry-run
node bin/dsh-cache-clean.mjs --apply                # 真正清理
node bin/dsh-cache-clean.mjs --status --json
node bin/dsh-cache-clean.mjs --ownership
node bin/dsh-cache-clean.mjs --conversations
node bin/dsh-cache-clean.mjs --delete-archived all --apply --confirm
node bin/dsh-cache-clean.mjs --workspace-status
node bin/dsh-cache-clean.mjs --workspace-clean --apply --confirm
```

宿主未运行时离线改注册表需加 `--offline-registry`；CLI 会在动 `workspace.json` 前写一份带时间戳的 `.bak-<ms>`，没有该标志会拒绝执行。

## 如实说明的边界

- 临时目录归属是**按创建时间窗推断**的，宿主并不存储该信息；报告会标 `confidence: "time-window"`。
- 附件与投影缓存的归属是精确的：被保留会话引用的共享附件永不删除。
- 宿主没有会话删除 API；删除做法是先删日志目录，再用 `unarchiveSession` 并在工作区注册表上 detach。未被跟踪的 ghost 会话没有注册表条目可清。
- 设置页访问的是 `/api/cache-cleaner.api`（宿主半注册的 Fetch 路由）。即便路由存在，直接无凭据 HTTP 探测也会被宿主的浏览器鉴权围栏挡成 `401`；验证要在浏览器里带着签名 cookie 做。
- 清理会校验可用空间是否真的增加；若系统的删除实现是把文件移入回收站，报告会给出警告而不是宣称成功。

## 测试

```sh
node test/smoke-v4.mjs     # 116 项断言
node test/smoke-v3.mjs     # 88
node test/smoke-v2.mjs     # 77
node test/smoke.mjs        # 19
```

测试用假宿主服务与固定目录，绝不触碰真实会话日志、真实附件或真实缓存根。

## 许可

MIT — 见 [LICENSE](LICENSE)。
