# Application Settings & Configuration Rules

> After reading this document, you will understand **where every setting comes from, where it lands, and what it takes for a change to actually take effect**.

---

## Table of Contents

- [I. Sources of Configuration & Effective Priority](#i-sources-of-configuration-effective-priority)
- [II. System-level Configuration `data/config.js` (changeable via Admin Console)](#ii-system-level-configuration-dataconfigjs-changeable-via-admin-console)
- [III. User-level Configuration — The User's "Private Superset of Defaults"](#iii-user-level-configuration-the-users-private-superset-of-defaults)
- [IV. Web Player Client Settings `DEFAULT_SETTINGS` (in `app.js`)](#iv-web-player-client-settings-default_settings-in-appjs)
- [V. Source File (`data/users/source/<user>/`)](#v-source-file-datauserssourceuser)
- [VI. File/Cache Rules (`fileCache.ts`)](#vi-filecache-rules-filecachets)
- [VII. Environment Variables (`environment variables`)](#vii-environment-variables-environment-variables)
- [VIII. Priority Topology & Effective Ways](#viii-priority-topology-effective-ways)
- [IX. Troubleshooting](#ix-troubleshooting)
- [Extended Reading](#extended-reading)

---

## I. Sources of Configuration & Effective Priority

Every configurable variable in the system only takes the highest-weight value from a **five-layer chain**. Weight (high → low):

| Priority | From | How to change | How it takes effect |
| :---: | :--- | :--- | :--- |
| **1** | **Environment variables** (Docker `environment` / `export`) | compose or `docker run -e` | On service start / load config |
| **2** | **WebDAV cloud** (cloud drive configured by `WEBDAV_URL`) | WebDAV remote `config.js` | On start and on "Recover from Cloud" in the console |
| **3** | **External file specified by `CONFIG_PATH`** | Edit the external file | On service start |
| **4** | **`data/config.js`** | Admin Console "System Config" save / manual edit / restored file | **Auto hot reload** (admin UI writes back `config.js`) |
| **5** | **System defaults `src/defaultConfig.ts`** | Written into pure code | Changes only when code is edited / version is upgraded |

> ⚠️ **Key Design**: A variable explicitly set to `false` / `null` is always **higher than an empty** one. e.g. `serverCacheLocation: "root"` written into `config.js`, even if the backend's default value is `"data"`, the effective one is `"root"`.

### Quick reference for Effectiveness

- Edit `config.js` (console/file) → **takes effect immediately** (write-back engine triggers a semi-hot reload `POST /api/admin/reload`)
- Edit env vars → needs a **"Restart Service"** (`POST /api/restart`) or reload config
- Variables read only **once at startup** (e.g. `PORT`, `SINGER_SOURCE_PRIORITY`) → must restart after env modification

---

## II. System-level Configuration `data/config.js` (changeable via Admin Console)

It is the **JSON mirror of `src/defaultConfig.ts`**, editable via Admin Console's "System Config". Structure is roughly:

```json
{
  "port": 9527,
  "admin": { "path": "/admin", "password": "123456" },
  "player": { "path": "/", "name": "LX Music Web", "enableAuth": false, "password": "123456" },
  "serverName": "LX Sync Server",
  "debug": { "enabled": false },
  "maxSnapshotNum": 10,
  "assets": { "path": "./assets", "theme": "./assets/theme" },
  "user": {
    "enableRoot": false,
    "enablePath": true,
    "enablePublicRestriction": true,
    "enablePublicNonAdminLocalMusic": false,
    "enablePublicNonAdminBrowserDownload": true,
    "enablePublicNonAdminServerCache": false,
    "enablePublicFavorites": false,
    "enablePublicNonAdminAccess": false,
    "enableCustomMusicDir": false,
    "enableLoginCacheRestriction": false,
    "enableCacheSizeLimit": false,
    "cacheSizeLimit": 2000,
    "enableCoffee": true
  },
  "webdav": { "enable": false, "url": "", "username": "", "password": "", "syncPath": "/lx-sync", "backupPath": "/lx-sync-backups" },
  "sync": { "interval": 60, "backupInterval": 24, "excludeCache": false, "excludeMusic": false },
  "configBackup": { "enable": true, "retentionDays": 7, "dir": "" },
  "snapshot": { "backupPath": "" },
  "list": { "addMusicLocationType": "top" },
  "proxy": { "all": { "enabled": false, "address": "" } },
  "singer": { "sourcePriority": "tx,wy" },
  "subsonic": {
    "enable": true,
    "path": "/rest",
    "port": 0,
    "enableDebug": false,
    "onlineSearch": true,
    "onlineSearchMode": "fallback",
    "onlineSearchSources": "wy,tx,kw,kg,mg",
    "publicLeaderboards": false,
    "leaderboardSource": "tx",
    "lyricTranslation": true,
    "cacheOnPlay": false,
    "playCacheFirst": true,
    "quality": { "enabled": true, "priority": "flac,320k,128k" }
  },
  "artist": { "maxFetchPages": 20 },
  "cache": { "namingPattern": "simple" },
  "system": { "allowUnsafeVM": false },
  "users": [ ... ],
  "customSource": {
    "probe": { "enabled": true, "intervalMinutes": 180, "failThreshold": 2, "autoDisablePlatform": true, "autoRemoveSource": true },
    "sourceGuard": { "enabled": true, "safeChannel": true, "vmInjections": false, "allocatedDeclarations": ... },
    "delaySince": true,
    "lyric": { "weakTrusted": ["kugou", "qq", "kuwo", "netease", "migu", "open"] }
  },
  "xiaoai": { ... XiaoAi casting config ... }
}
```

### Admin Console buttons ("Server Management")

| Button | Underlying operation | When |
| :--- | :--- | :--- |
| **Restart Network** | `POST /api/admin/reload` reloads config + users + sources; **use it after config edits** | After non-port edits |
| **Restart Service** | `POST /api/restart` ends the process | After env var changes (`PORT` etc.) |
| **Logout Memory** | Clear Session and cache memory | After registration/errors |

> ⚠️ In **Docker**, clicking "Restart Service" requires the container `--restart unless-stopped` policy to be able to restart; without it, the service stops permanently.

---

## III. User-level Configuration — The User's "Private Superset of Defaults"

In the `users` array of `data/config.js` (or `data/users.json`):

```json
{ "name": "user1", "password": "pass123", "enableCustomMusicDir": false, "customMusicDir": "", "allowOperateCustomMusicDir": false, "allowWriteCustomMusicDir": false, "enablePublicNonAdminAccess": false, "enablePublicNonAdminLocalMusic": false, "enablePublicNonAdminServerCache": false, "enablePublicFavorites": false, "users": [...] }
```

Each user should also have a **user setting directory (`data/<username>/config.js` or `data/<username>/settings.json`)** recording a preference:

- Preferred **quality** / lyrics / list page count / language preferences / remote-sync url
- WebDAV's **user-isolated** `data/<username>` directory for isolation

### Write Permission

| User Type | Modify Channel | Limitation |
| :--- | :--- | :--- |
| **Admin** | Admin Console "User Management" / System Config | No restriction |
| **Logged-in user** | Web Player "Settings" (bottom-right) | Only modifies own play/display/cache preferences |
| **Guest (not logged in)** | Cannot modify any system setting | Limited public viewing |

> Passing `LX_USER_<username>=<password>` is **for init via env** and `users.json` gets persisted after the service starts.

---

## IV. Web Player Client Settings `DEFAULT_SETTINGS` (in `app.js`)

`public/music/app.js` defines a **complete dictionary of client-side default values** (layered over the backend `plugin.settings` write-down as the final modifiable config):

| Field | Default | Description |
| :--- | :--- | :--- |
| `itemsPerPage` | `20` (`'all'`=all) | List pagination |
| `defaultEntry` | `favorites` | Default entry page |
| `preferredQuality` | `flac` | Preferred sound quality |
| `enablePublicSources` | `true` | Whether to display public sources |
| `enableProxyPlayback`/`enableProxyDownload` | `false` | Play/Download proxy |
| `enableAutoProxy` | `true` | Auto Proxy (HTTP resources under HTTPS) |
| `enableCustomProxy`/`customProxyUrl` | `false`/`''` | Custom Proxy Template (`${url}`) |
| `enableOnlyDownloadMode` | `true` | Only-Download Mode (writes to **`music`** dir) |
| `downloadConcurrency` | `3` (1–5) | Concurrent downloads |
| `hotSearchLimit` | `20` | Hot search entries |
| `lyricFontSize` | `1.25` | Lyrics font size (rem) |
| `lyricFontFamily` | `''` | Lyrics font |
| `switchPlaylistOnSearchPlay` | `true` | Switch playlist when searching |
| `switchPlaylistOnSongListPlay` | `true` | Switch playlist when playlist plays |
| `autoFilterDislikedSongs` | `true` | Auto-filter disliked |
| `autoResume` | `true` | Auto-resume progress |
| `showSidebarSongInfo` | `false` | Show song info in sidebar |
| `enableCrossfade` | `true` | Crossfade |
| `keepScreenAwake` | `true` | Keep screen awake |
| `enableKeyboardShortcuts` | `true` | Keyboard shortcuts |
| `showLyricTranslation`/`showLyricRoma`/`swapLyricTransRoma` | `true`/`false`/`false` | Lyrics Trans/Roma/Swap |
| `autoCompactPlaybar` | `true` | Auto-compact playbar |
| `enableAutoSwitchSource`/`enableAutoSwitchApiSource` | `true` | Auto-switch source on failure |
| `enableAutoSkipOnError` | `true` | Auto-next on error |
| `enableAutoDegradeQuality` | `true` | Auto-degrade quality (`flac → 320k → 128k`) |
| `playbackErrorPriority` | `platform,quality,next` | Error handling priority |
| `enablePreloader`/`disablePreloadSkip` | `true`/`false` | Preload |
| `enableSmtcLyric` | `true` | SMTC Lyrics (lock screen) |
| `showFooterVisualizer`/`footerVisualizerStyle` | `true`/`bars` | Footer Visualizer |
| `enableServerCache`/`enableServerLyricCache`/`embedLyricToFile` | `true` | Server cache & lyrics/label |
| `serverCacheLocation` | `root` | `root` (container volume) / `data` (synced) |
| `serverCacheNamingPattern` | `simple` | File naming (`simple`/`standard`) |
| `enableRemaster` | `false` | Remaster/Downshift |
| `enableLyricCache`/`enableSongUrlCache` | `true` | Local link cache |
| `enableLyricGlow` | `true` | Lyrics Glow |
| `enablePersistentToken` | `false` | Persistent Token |
| `playerBackground` | `blur` | Background effect |
| `saveAccountSettingsToFile` | `true` | Write player settings to file |
| `autoUpdateNetworkList`/`networkListAutoCheckInterval` | `false`/`6h` | Auto-update Network Lists |
| `remoteSyncUrl`/`remoteSyncCode` | `''` | Client Offline Sync URL & Code |
| `enableClientModeSync` | `false` | Simulate desktop client sync |
| `lastRemoteSyncMode` | `merge_remote_local` | Last sync mode |
| `deduplicatePlaylistByQuality` | `true` | Only add highest quality for same ID |

> Search **Health Model**: On `error`, the auto-degradation order is `flac → 320k → 192k → 128k`, governed by `playbackErrorPriority` and `enableAutoSwitchSource`.

Changes on the UI (bottom-right settings panel) → written to the front-end settings `localStorage` (WeakRef), pushed via `POST /api/user/catalog`.

---

## V. Source File (`data/users/source/<user>/`)

Third-party source scripts and status are managed in this directory, **independent per user**:

| File | Responsibility | Note |
| :--- | :--- | :--- |
| `<js>/<script>.js` | Public/Private source script本体 | Uploaded by admin to `_open` after login; uploaded by you to `<user>` |
| `states.json` | Personal source status (Enable/Disable/Block) | Public source status **changes only for the user** |
| `order.json` | Drag-and-drop sort | Grouped: **Enabled first**; public/private merge |
| `_open` | Default directory for public sources | Admin adds public sources here |
| `platforms/` | Platform setup | May include platform private keys |
| `sources.json` | Source info body (`name`, `url`, `content`) | `qualitys` declares each platform's quality |
| `order` / `platforms` | else | Other settings |

**Isolation Levels**:
- Private source with the same ID as a public one → **overwrites the public source** (use private, drop public)
- If you disable your private source in `states.json` → No reduction to the public source
- If the admin deleted a public source → locally falls back to the public sort

---

## VI. File/Cache Rules (`fileCache.ts`)

Modified via **System Config → File Cache**, it lands in `src/server/musicAccount/fileCache.ts`.

**Core Parameters**:

| Parameter | Default | Description |
| :--- | :--- | :--- |
| `serverCacheLocation` | `root` | `root` mounts `/server/cache`; `data` mounts `/server/data/<user>/cache` |
| `preferredQuality` | `flac` | Preferred quality |
| `downloadConcurrency` | `3` | Simultaneous downloads (1–5) |
| `enableCacheSizeLimit` | `false` | Switch |
| `cacheSizeLimit` | `2000`MB | LRU deletion if exceeded |
| `cacheNamingPattern` | `simple` | `simple`/`standard` (different filenames) |
| `worker` | `true` | Whether AS thread runs download |

**`ensureDir` behavior**:

```js
ensureDir(username, isOnlyDownload) // Write to music on only-download, cache otherwise
```

- **Only writes to one dir**: `music/<username>` / `cache/<username>`; with `root` enabled, both `cache`/`music` under `data`.
- Same-name conflict → append `(i)` suffix
- If `.lrc` + `.mp3` are mutually associated, they clear together
- Repeated download → same noise quality/file exists → **copy directly, don't re-download**

**File Name**: `<Song> - <Artist> - <Quality> - <Album>` (simple), illegal chars replaced with `_`, truncated at 200 chars.

---

## VII. Environment Variables (`environment variables`)

They do not serve `config.js`; they are the **fastest, most stable startup parameters** (later deformable via the console hot reload).

### Explicit enabling must be written in custom entries like `LX_USER`, e.g.:

| Variable | Description | Note |
| :--- | :--- | :--- |
| `PORT` | 9527 | Service port |
| `ADMIN_PASSWORD` | 123456 | Admin PW |
| `ENABLE_WEBPLAYER_AUTH` | boolean | Player Auth Switch |
| `WEBPLAYER_PASSWORD` | 123456 | Player PW |
| `ENABLE_DEBUG` | boolean | Debug mode |
| `CONFIG_PATH` | /path/ | External config file |
| `DATA_PATH` | /server/data | Data path |
| `LOG_PATH` | /server/data/logs | If missing, logs go to `data/logs` |
| `LX_USER_<name>` | password | Auto-register user |
| `SUBSONIC_PORT` | 4533 | Requires `-p 4533:4533` (or compose ports) |
| `ENABLE_PUBLIC_USER_RESTRICTION` | bool | Public user restriction |
| ... | | More in Configuration Guide |

### Other env vars
- `LX_USER_<username>` first char **cannot be a digit** (must be letter/underscore)
- **Default Password**: `admin.password` / `player.password` = `862080` (`src/defaultConfig.ts`)

### Boolean values
- **True**: `1`, `true`, `yes`, `on`, `y`; **False**: `0`, `false`, `no`, `off`, `n`.

---

## VIII. Priority Topology & Effective Ways

```
[ Environment Variables / Cloud WebDAV ]  → Highest Priority —— Needs restart
        ↓
[ Custom config.js ]
        ↓
[ Admin Console Changes ]  → Writes immediately to data/config.js (semi-hot reload)
        ↓
[ System Defaults src/defaultConfig.ts ]  → Lowest
```

- **Every change**: consider its "level":
  - Not in the console → configure in `config.js` (add), because the console lists only explicit items
  - In the console → immediately effective
- **Change `PORT`**: must restart the service (backend listens, reload is useless)
- **Change `ENABLE_WEBPLAYER_AUTH`**: some forced cookie re-login needed

---

## IX. Troubleshooting

- Changed `config.js` and it's not effective → **Did not restart the panel service**? Use "Restart Network" or "Restart Service"
- If `config.js` not effective → front-end and back-end pushed separately; check env vars (`-e` in Docker)
- **Panel edits don't take effect** → possibly `config.js` was not saved or `WEBPLAYER_PASSWORD` mismatch causing token re-creation
- **Multiple users with max sync only one**: did you enable `enablePublicRestriction`?
- Don't want the admin to see public favorites/lists → in "User Management" toggle **"Private/Public"**
- Source lock-screen/SMTC not showing → `enableSmtcLyric` (default true), check `ls`
- `enablePublicFavorites` = public favorites, disabled → only visible in the front-end

---

## Extended Reading

- [Configuration Guide (detailed table)](./configuration.md)
- [Getting Started / Deployment](./getting-started.md)
- [Web Player Guide](./web-player.md)
- [Sync Server Settings](./sync-server.md)
- [Source Guard](./source-guard.md) · [Probe](./source-probe.md) · [XiaoAi Casting](./xiaoai.md)
- [App Settings & Configuration Rules](./app-settings.md) — Priority chain of all settings
- [Server API Reference](../api/reference.md) — RESTful API
