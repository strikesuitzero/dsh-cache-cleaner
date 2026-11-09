# dsh-cache-cleaner

Move the DeepSeek Harness temp cache to a configurable location, clean it with a strict allowlist, and manage archived sessions and workspace temp/archive folders — from a settings panel, CLI, or agent tools.

把 DeepSeek Harness 的临时缓存迁到可配置的位置，按「天数 + 配额」双闸门白名单清理，并管理已归档会话与工作区临时/归档目录。提供设置页、CLI 与 agent 工具三种入口。

## Features

- **Cache relocation** — the plugin redirects the host process's `TEMP`/`TMP` (and therefore `os.tmpdir()` and child processes) to `<cacheRoot>/temp`. New session snapshots stop landing on the system drive.
- **Allowlisted cleanup** — only `dsh-workspace-changes-*/objects/<2 hex>/tmp_obj_<6 chars>` files are removable. `captures/`, sha1 objects, lock files, sessions, config and credentials are never touched.
- **Two gates** — age (default 14 days) and quota (when the cache exceeds 50 GiB, evict oldest-first down to 80%). Legacy `%TEMP%/dsh-workspace-changes-*` directories are handled separately with a 24-hour minimum age.
- **Archived sessions** — list archived sessions, preview a deletion plan, then delete a session together with (or without) its artifacts: attachments and the session projection cache. Deletion goes through the host's own registry APIs; a live session is always refused.
- **Workspace roots** — report and (optionally) clean direct children of configured temp/archive folders using each subtree's newest mtime. Archives are report-only until explicitly enabled.
- **Settings panel** — a **缓存清理 / Cache cleaner** section under Settings with overview, cache, workspace, archived sessions and cleanup options; the panel renders immediately and fills data in as background scans finish.
- **7 agent tools** — `cache_status`, `cache_clean`, `cache_ownership`, `conversation_list`, `conversation_delete`, `workspace_status`, `workspace_clean`.

## Install

```sh
# from GitHub (once the repository is published)
dsh plugin add github:<owner>/dsh-cache-cleaner

# or from a local checkout
dsh plugin add file:D:/path/to/dsh-cache-cleaner
```

The bundle patch declares the plugin row; the host loads it after the next restart (or a plugin disable/enable reload).

## Configuration

All keys are optional. Set them by editing the plugin entry's `config` in your profile's `cordis.patch.yml` (Settings → Plugins → cache cleaner also persists the cleanup options).

| Key | Default | Meaning |
|---|---|---|
| `cacheRoot` | Windows: `%LOCALAPPDATA%\dsh-cache-cleaner`; others: `$XDG_CACHE_HOME/dsh-cache-cleaner` or `~/.cache/dsh-cache-cleaner` | Root for the redirected temp dir and reports. Put it on a drive with free space. |
| `redirectTemp` | `true` | Redirect `TEMP`/`TMP` for the host process. |
| `autoClean` | `true` | Run the scheduled cleanup (startup delay + interval + idle debounce). |
| `autoCleanLegacy` | `false` | Include legacy `%TEMP%/dsh-workspace-changes-*` dirs in automatic runs. |
| `startupDelaySeconds` | `60` | Delay before the first automatic run. |
| `intervalHours` | `6` | Scheduled scan interval (UI presets: 1/3/7/15/30 days). |
| `idleQuietMinutes` | `10` | Extra run after the agent has been idle this long. |
| `mode` | `normal` | `safe` (30 d / 50 GiB), `normal` (14 d / 50 GiB), `aggressive` (1 d / 30 GiB). |
| `retainDays` | `null` | Override the mode's age gate. |
| `quotaBytes` | `null` | Override the mode's quota gate. |
| `workspaceBases` | `[]` | Directories that configured workspace roots must live strictly inside. |
| `workspaceRoots` | `[]` | `[{path, kind: temp\|archive, retainDays, auto}]`; only direct children are considered. |
| `manageArchives` | `false` | Master switch for deleting `kind: archive` roots. |

Example override in the profile:

```yaml
- id: dsh-cache-cleaner
  config:
    cacheRoot: 'D:\\Cache\\dsh-cache-cleaner'
    workspaceBases: ['D:/work/project']
    workspaceRoots:
      - { path: 'D:/work/project/_tmp', kind: temp, retainDays: 7, auto: true }
      - { path: 'D:/work/project/_archive', kind: archive, retainDays: 30, auto: false }
```

## Safety model

- **Allowlist only** — anything not matching the tmp-object pattern is left alone; symlinks and junctions are never followed or deleted.
- **Dry-run by default** — CLI and tools report a plan unless `--apply` / `apply:true`. Applying requires `confirm:true`; archive roots additionally require `manageArchives:true` and `includeArchives:true`.
- **Root marker** — cleanup refuses a `cacheRoot` without the `.dsh-cache-cleaner.json` marker (written by `--init` or the plugin), so a mistyped root cannot be swept.
- **Path fences** — workspace roots must be strictly inside a configured base; volume roots, the home directory, `DSH_HOME` and the cache root are rejected.
- **Real-space check** — the cleaner compares free space before/after and reports any gap (for example a safe-delete implementation that redirects files to the recycle bin).
- **Failures are isolated** — one undeletable file is reported as `skipped` with its path and errno; the rest of the batch continues.

## Tools

| Tool | Purpose |
|---|---|
| `cache_status` | Redirect state, roots, sizes, legacy dirs, timers, last report (read-only). |
| `cache_clean` | Clean cache temp objects; default dry-run. |
| `cache_ownership` | Attribute cache temp dirs to sessions by creation-time window (reported as `confidence: "time-window"`; the format has no persistent ownership). |
| `conversation_list` | List archived sessions (size, workspace, first message, projection cache). |
| `conversation_delete` | Plan or delete archived sessions; `includeArtifacts` adds attachments/projection cache; `includeTempDirs` adds time-window temp dirs. |
| `workspace_status` | Report configured workspace roots and stale direct children. |
| `workspace_clean` | Remove stale direct children; archive roots are gated. |

## CLI

```sh
node bin/dsh-cache-clean.mjs --init                 # write the root marker
node bin/dsh-cache-clean.mjs                        # dry-run
node bin/dsh-cache-clean.mjs --apply                # clean
node bin/dsh-cache-clean.mjs --status --json
node bin/dsh-cache-clean.mjs --ownership
node bin/dsh-cache-clean.mjs --conversations
node bin/dsh-cache-clean.mjs --delete-archived all --apply --confirm
node bin/dsh-cache-clean.mjs --workspace-status
node bin/dsh-cache-clean.mjs --workspace-clean --apply --confirm
```

Offline registry edits (when the host is not running) require `--offline-registry`; the CLI writes a timestamped `.bak-<ms>` before touching `workspace.json`, and refuses without the flag.

## Honesty boundaries

- Temp-directory ownership is **inferred from a creation-time window**, not stored by the host; the report labels it `confidence: "time-window"`.
- Attachment and projection-cache ownership is exact: a shared attachment referenced by a retained session is never deleted.
- The host has no session-delete API; deletion removes the log directory and then uses `unarchiveSession` + detach on the workspace registry. Untracked/ghost sessions have no registry entry to clean.
- The settings panel talks to `/api/cache-guard.api` (a Fetch route registered by the host half). Direct unauthenticated HTTP probes receive `401` from the host's browser-auth fence even when the route exists; verification is done in the browser with the signed cookie.
- Cleanup verifies that free space actually increased; on systems whose delete implementation moves files to the recycle bin, the report warns instead of claiming success.

## Tests

```sh
node test/smoke-v4.mjs     # 116 assertions
node test/smoke-v3.mjs     # 88
node test/smoke-v2.mjs     # 77
node test/smoke.mjs        # 19
```

The test harness uses fake host services and fixture directories; it never touches real session logs, real attachments or the real cache root.

## License

MIT — see [LICENSE](LICENSE).
