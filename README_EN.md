# lxserver · LX Music Sync Server (Enhanced Edition)

![lxserver](https://socialify.git.ci/zues0077/lxserver/image?description=1&forks=0&issues=0&logo=https://raw.githubusercontent.com/zues0077/lxserver/refs/heads/main/public/icon.svg&owner=1&pulls=0&stargazers=0&theme=Auto)

<div align="center">
  <p>
    <img src="https://img.shields.io/badge/build-passing-brightgreen?style=flat-square" alt="Build Status">
    <img src="https://img.shields.io/github/package-json/v/zues0077/lxserver?style=flat-square" alt="Version">
    <img src="https://img.shields.io/badge/node-%3E%3D20-green?style=flat-square" alt="Node Version">
    <img src="https://img.shields.io/github/license/zues0077/lxserver?style=flat-square" alt="License">
    <br>
    <br>
    <a href="https://github.com/zues0077/lxserver/stargazers"><img src="https://img.shields.io/github/stars/zues0077/lxserver?style=flat-square&color=ffe16b" alt="GitHub stars"></a>
    <a href="https://github.com/zues0077/lxserver/network/members"><img src="https://img.shields.io/github/forks/zues0077/lxserver?style=flat-square" alt="GitHub forks"></a>
    <a href="https://github.com/zues0077/lxserver/issues"><img src="https://img.shields.io/github/issues/zues0077/lxserver?style=flat-square&color=red" alt="GitHub issues"></a>
    <a href="https://github.com/zues0077/lxserver/commits/main"><img src="https://img.shields.io/github/last-commit/zues0077/lxserver?style=flat-square&color=blueviolet" alt="Last Commit"></a>
    <img src="https://img.shields.io/github/commit-activity/m/zues0077/lxserver?style=flat-square&color=ff69b4" alt="Commit Activity">
    <a href="https://github.com/zues0077/lxserver/releases"><img src="https://img.shields.io/github/downloads/zues0077/lxserver/total?style=flat-square&color=blue" alt="Total Downloads"></a>
  </p>
  <p>
    <a href="https://www.star-history.com/zues0077/lxserver">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/badge?repo=zues0077/lxserver&type=trending&theme=dark" />
        <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/badge?repo=zues0077/lxserver&type=trending" />
        <img alt="GitHub Trending Repository of the Day" src="https://api.star-history.com/badge?repo=zues0077/lxserver&type=trending" />
      </picture>
    </a>
  </p>
</div>

[Documentation](https://zues0077.github.io/lxserver/) | [SyncServer](md/lxserver_EN.md) | [Changelog](changelog.md) | [中文版](README.md)

---
**lxserver** turns a plain data-sync relay into a ready-to-use personal cloud music platform: a full-featured built-in **Web Player**, a multi-user **sync and permission system**, and stability governance for **custom music sources** (script self-check guard + platform availability probe). No extra client needed — just open it in a browser.

> This project is a fork of [xcq0607/lxserver](https://github.com/xcq0607/lxserver), which in turn is based on [lyswhut/lx-music-sync-server](https://github.com/lyswhut/lx-music-sync-server). Thanks to the original authors. Released under Apache-2.0.

## ✨ Web Player Key Features

### 1. Modern Interface & Full Playback Controls

Featuring a clean, responsive UI with automatic Light/Dark mode and full-screen lyrics mode. The integrated player bar offers sound quality switching, playback speed, and sleep timers.

<p align="center">
  <img src="md/player.png" width="800" alt="Web Player Interface">
</p>
<p align="center">
  <img src="md/controller.png" width="800" alt="Playback Controls">
</p>

### 2. Multi-source Search, Artists & Albums

Aggregates online resources across major platforms to quickly search tracks, artists, and complete albums with one-click favoriting and instant playback.

<p align="center">
  <img src="md/search.png" width="800" alt="Multi-source Search">
</p>
<p align="center">
  <img src="md/album.png" width="400" alt="Album Display">
  <img src="md/singer.png" width="400" alt="Artist Display">
</p>

### 3. Playlists & Queue Management

Browse and sync popular online playlists. Convenient side drawers provide intuitive queue drag-and-drop sorting and automated local caching.

<p align="center">
  <img src="md/musiclist.png" width="400" alt="Playlist Browsing">
  <img src="md/musiclist-detail.png" width="400" alt="Playlist Details">
</p>
<p align="center">
  <img src="md/playlist.png" width="280" alt="Playback Queue Drawer">
  <img src="md/cache.png" width="280" alt="Cache Management Drawer">
</p>

### 4. Local Music Library & Shared Favorites

Centrally manages local, downloaded, and cached music with audio specs parsing (Hi-Res / Lossless), Boolean logic search (`&`, `|`, `!`), integrity checks, and batch operations. Supports public shared libraries.

<p align="center">
  <img src="md/localmusic.png" width="800" alt="Local Music Library & Advanced Search">
</p>
<p align="center">
  <img src="md/favorite.png" width="800" alt="Favorites & Shared Library">
</p>

### 5. Themes, Lyric Cards & Custom Sources

Choose from multiple modern color palettes with light/dark modes. Generate high-res lyric cards with custom aspect ratios, and import custom scripts to expand music sources.

<p align="center">
  <img src="md/theme.png" width="400" alt="Modern Themes">
  <img src="md/settings.png" width="400" alt="System Configuration">
</p>
<p align="center">
  <img src="md/share.png" width="380" alt="Lyric Card Sharing">
  <img src="md/source.png" width="420" alt="Custom Source Management">
</p>

### 6. Subsonic Protocol Ecosystem

Fully compatible with the Subsonic API. Connect using third-party clients (such as Yinliu, Feishin, Symfonium) with global online search and local playback support.

<p align="center">
  <img src="md/subsonic.png" width="500" alt="Subsonic Support">
  <img src="md/subsonic-search.png" width="300" alt="Subsonic Online Search">
</p>

### 7. Xiaoai Speaker Casting

Cast the currently playing track from the Web Player straight to a Xiaoai speaker, with **multiple devices playing at the same time**.

- Sign-in: QR code (Mi Home app, no password) / account password / browser cookie
- Devices: picks up all Xiaoai speakers on the account automatically
- Controls: play, pause, next/previous, volume and stop — all inside the player
- **Auto-continue**: resolves the next track ahead of time and switches near the end, making playlist playback nearly seamless
- Server-side audio relay: avoids hotlink protection and http/https mixed-content issues

### 8. Custom Source Self-Check Guard

Third-party source scripts are a black box: some obfuscated scripts keep burning **~60% of a CPU core and grow to 270MB of memory** after loading successfully, with nothing suspicious in the logs. The guard inspects scripts before and after loading to surface this kind of silent spinning.

- **Static inspection** (before loading): detects empty infinite loops, `debugger` anti-debug traps, sandbox escapes and busy polling; high-risk (level A) scripts are quarantined by policy
- **Obfuscation only flagged** (level B): obfuscation is not malicious by itself — among 46 common sources, 12 were obfuscated yet perfectly fine, so these are only logged
- **Runtime sampling**: only sustained idle CPU usage counts as abnormal, then candidate sources are unloaded one by one to attribute the culprit
- **Recoverable**: quarantine only skips loading — it never deletes scripts or changes your toggles; updating a script (fingerprint change) lifts it automatically
- Results and current idle CPU are exposed in the `/health` `sourceGuard` field

> See [docs/guide/source-guard.md](docs/guide/source-guard.md) for grading rules, configuration and false-positive handling (Chinese only).

### 9. Custom Source Platform Availability Probe

Some platforms declared by a source script are simply broken (tightened anti-abuse, retired APIs, the author not catching up). Broken platforms make the playback path try and fail before switching, which users feel as "a few seconds of silence after pressing play". The probe finds and disables them:

- **Probe new sources immediately**: after upload/import every platform is resolved once for real; sources added within a 3-second window are merged into one round, and a round that collides with a running one is **queued** and re-run afterwards (`pendingNewSources` in `/health`) instead of being dropped
- **Scheduled re-check**: re-probes remaining usable platforms every `customSource.probe.intervalMinutes` (3 hours by default)
- **Auto-disable broken platforms**: only after `failThreshold` consecutive failures (2 by default); the state is written into the **same `states.json` as the panel's platform toggle**, so it stays visible and editable
- **Auto-restore**: an auto-disabled platform is re-enabled as soon as it probes successfully; **platforms you disabled by hand are never re-checked nor auto-enabled**
- **Auto-remove dead sources**: when every platform a source declares is dead, the source is moved to a sibling `.trash/` directory (recoverable) and the action is recorded in `probe-audit.log`
- **Three anti-false-positive safeguards**: ① probe quality follows the script's own `qualitys` instead of a hard-coded one; ② up to 3 candidate tracks per platform are retried, and any success counts as available; ③ when a link check gets a 4xx from `HEAD`, it is re-verified with a `Range: bytes=0-1` `GET`, so "does not support HEAD" is not mistaken for dead
- **Platform-side anomaly protection**: when a platform fails on most sources within the same round it is treated as a platform-side issue (test tracks without rights, rate limiting, etc.) and only recorded as `suspectPlatforms` — no platform is disabled and no source is removed
- Results live in the `/health` `sourceProbe` field (add `?probeDetail=1` for per-platform failure reasons)

> See [docs/guide/source-probe.md](docs/guide/source-probe.md) for criteria, test-track sources, all options and how to restore a removed source (Chinese only).

## 🧩 Enhancements over Upstream

| Area | Detail |
| :--- | :--- |
| **Source self-check guard** | Static inspection plus runtime CPU attribution to expose and quarantine "obfuscated script spinning silently"; quarantine is in-memory and lifts when the script changes |
| **Platform availability probe** | Immediate check for new sources, scheduled re-checks, auto-disable/auto-restore of platforms, auto-removal of fully dead sources (recoverable) |
| **Three anti-false-positive safeguards** | Quality follows the script's declaration, multi-track retries, Range GET re-check when HEAD returns 4xx |
| **Platform-side anomaly protection** | When a platform fails on most sources in one round it is only reported, never acted on |
| **Xiaoai speaker casting** | QR sign-in, multi-device playback, auto-continue, server-side audio relay |
| **Hot-reload optimisation** | A single changed script reloads only that source instead of the whole space |
| **Observability** | `/health` exposes guard and probe state, `?probeDetail=1` gives per-platform failure details, and destructive actions are logged to `probe-audit.log` |

## 🔒 Access Control & Security
To protect your privacy, the Web Player supports password protection.
### How to Enable

1. **Environment Variable** (Recommended for Docker users):
   - `ENABLE_WEBPLAYER_AUTH=true`: Enable authentication
   - `WEBPLAYER_PASSWORD=yourpassword`: Set access password
2. **Web Interface**:
   Log in to the management dashboard (default port 9527), go to **"System Config"**, check **"Enable Web Player Password"** and set your password.

### Permission & Custom Source Matrix (when `user.enablePublicRestriction` is enabled)

| User Type | View List | Use/Toggle (Personal) | Change Default Quality | Upload/Import Sources | Delete/Modify Public |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Admin** | ✅ Allowed | ✅ Allowed | ✅ Allowed | ✅ Allowed | ✅ Allowed |
| **Logged-in** | ✅ Allowed | ✅ Allowed | ✅ Allowed | ✅ Allowed | ❌ Denied |
| **Guest** | ❌ Hidden | ❌ Denied | ❌ Denied | ❌ Denied | ❌ Denied |

> **Actual rule** (`server.ts` + `customSourceHandlers.ts`): with the restriction on, write operations under `/api/custom-source/*` require **either** the admin password (`x-frontend-auth`) **or** a valid user login credential (`x-user-token`); deleting/modifying a `_open` public source is additionally hard-gated to the admin password inside `handleDelete`. Guests always get 403.

## 📱 Mobile Adaptation

The Web Player is deeply optimized for mobile devices, providing a near native App-like experience in mobile browsers:

- **Responsive layout**: on narrow screens the sidebar collapses into a drawer, and lists, the player bar and dialogs reflow automatically.
- **Gestures**: the lyrics page can be dismissed by swiping down, and tapping the bottom cover jumps straight to the lyrics.
- **Car / Bluetooth**: a 512×512 raster cover is provided and AVRCP BIP is supported (it does not accept SVG), fixing black or missing covers on car head units.
- **iOS note**: due to WebKit background limits, enabling the bottom waveform or EQ pauses playback when the screen locks — turn both off if you need background listening.

---

## 🚀 Quick Start

Built with **Node.js**, supporting multiple deployment methods.


### Option 1: Desktop Client

You can now run LX Music Sync Server more conveniently via our Desktop Client, available for Windows, macOS, and Linux.

- **📦 Download**: [GitHub Releases](https://github.com/zues0077/lxserver/releases) (desktop artifacts are built by `.github/workflows/release.yml` when a `v*` tag is pushed)
- **✨ Key Advantages**:
    - **Single Window**: Integrated management dashboard and Web player for a unified experience.
    - **System Tray**: Minimizes to tray on close, ensuring the sync service stays active in the background.
    - **Port Conflict Resolution**: Automatically detects and switches ports if the default is in use.
    - **Setup Wizard**: Guided data path selection on first launch, supports **Portable Mode**.
    - **Multi-Arch Support**: Builds for Windows (x64/x86/ARM64 Setup & Portable), macOS (Intel x64 & Apple Silicon arm64), and Linux (amd64/arm64/armv7l deb/AppImage).

### Option 2: Containerized Deployment via Docker

Images are published to **GitHub Packages (GHCR)**. **Every update also gets a version tag**, so you can pin a version and roll back easily:

| Tag | Meaning |
| :--- | :--- |
| `latest` | Latest stable, tracking the `main` branch |
| `v1.5.21` / `1.5.21` | Current version (matches `version` in `package.json`) — **pin to a concrete version in production** |
| `v*` | Every published version is kept, so you can roll back at any time |

```bash
# Pin a version (recommended)
docker pull ghcr.io/zues0077/lxserver:1.5.21

# Or follow the latest
docker pull ghcr.io/zues0077/lxserver:latest
```

**Docker Run Example:**

```bash
docker run -d \
  -p 9527:9527 \
  -v $(pwd)/data:/server/data \
  -v $(pwd)/cache:/server/cache \
  -v $(pwd)/music:/server/music \
  -v $(pwd)/cover_cache:/server/cover_cache \
  --name lx-sync-server \
  --restart unless-stopped \
  ghcr.io/zues0077/lxserver:1.5.21
```

> ⚠️ **Do not omit `--restart`**: the panel's "Restart Service" (`POST /api/restart`) works by terminating the
> process inside the container, so it relies entirely on the container restart policy to come back up.
> Without `--restart` (or with `no`), clicking "Restart Service" once leaves the service down for good.
> Use `--restart unless-stopped` or `always`.

> **Mount `data`, `cache`, `music` and `cover_cache` together.**
>
> - `/server/data` (required): config (written to `data/config.js`), user data, logs (`data/logs`), backups.
> - `/server/cache` (recommended): playback cache. The default cache location is `root`, so files are
>   actually written to `/server/cache/<user>` inside the container.
> - `/server/music` (recommended): download directory. After "download" or "move to download folder",
>   files are moved here, i.e. `/server/music/<user>` inside the container.
> - `/server/cover_cache` (recommended): song cover cache. **It is always written under the container's
>   working directory and is NOT affected by the "Cache Location" setting** — even if you switch to
>   `data` mode and mount `data` only, covers still land in the container's writable layer. Mount it separately.
>
> If you **do not** mount `cache` / `music`, those files land in the container's writable layer —
> invisible from the host and lost whenever the container is recreated. Alternatively, switch
> "Cache Location" from `root` to `data` in the panel; cache and downloads then go to
> `/server/data/cache/<user>` and `/server/data/music/<user>`, and mounting `data` alone is enough for
> those two — at the cost of pulling that data into sync and growing the data volume considerably.
> Note this switch **does not affect `cover_cache`**.
>
> **About `./logs`**: the image defaults to `LOG_PATH=/server/data/logs`, so logs already live inside the
> `data` volume. Mounting `./logs:/server/logs` on its own is therefore an **empty mount** (this is upstream's
> default behaviour too). To put logs in the host's `./logs` directory you must also set `LOG_PATH=/server/logs`.

**Docker Compose Example:**

Create a `docker-compose.yml` file:

```yaml
services:
  lx-sync-server:
    image: ghcr.io/zues0077/lxserver:1.5.21   # or :latest
    container_name: lx-sync-server
    restart: unless-stopped      # don't omit: the panel's "Restart Service" needs it to bring the process back
    ports:
      - "9527:9527"
      # - "4533:4533"            # only needed when SUBSONIC_PORT is set (e.g. 4533)
    volumes:
      - ./data:/server/data
      # Required with the default `root` cache mode, otherwise cache/downloads stay in the container layer
      - ./cache:/server/cache
      - ./music:/server/music
      # Cover cache is always written to the container working dir and ignores the "Cache Location" setting
      - ./cover_cache:/server/cover_cache
    environment:
      - NODE_ENV=production
      # - ADMIN_PASSWORD=yourpassword
      # - ENABLE_WEBPLAYER_AUTH=true
      # - WEBPLAYER_PASSWORD=yourpassword
      # - ADMIN_PATH=/admin
      # - PLAYER_PATH=/
      # - LOG_PATH=/server/logs   # only needed if you additionally mount ./logs:/server/logs
```

### Option 3: Manual Run (Git Clone)

```bash
# 1. Clone project
git clone https://github.com/zues0077/lxserver.git && cd lxserver

# 2. Install dependencies and build
npm ci && npm run build

# 3. Start service
npm start
```

### Option 4: Using Release Build

1. Download the archive from GitHub Releases.
2. Extract and run `npm install --omit=dev`.
3. Execute `npm start`.

---

## 🔌 Service Connection & Client Setup

### ① Web Interface Access
- **Web Player**: `http://<server-ip>:9527` (Default root path `/`, customizable via `PLAYER_PATH` env or backend settings, e.g., `/music`).
  - If password authentication is enabled (`ENABLE_WEBPLAYER_AUTH`), enter your player password (default: `123456`).
- **Sync Dashboard**: `http://<server-ip>:9527/admin` (Default path `/admin`, customizable via `ADMIN_PATH`, default admin password: `123456`).

### ② LX Music Client Sync Setup (Desktop / Mobile)
Go to LX Music client "Settings → Sync Settings" and choose Custom Server:
- **Mode 1: User Path Mode (Recommended, enabled by default `USER_ENABLE_PATH=true`)**
  - **Connection URL**: `http://<server-ip>:9527/<username>` (e.g., `http://192.168.1.100:9527/user1`)
  - **Connection Password**: Password of the corresponding user.
  - **Feature**: Routes directly to isolated user storage via username in the URL. **Allows different users to use identical passwords**.
- **Mode 2: Root Path Mode (Requires `USER_ENABLE_ROOT=true`)**
  - **Connection URL**: `http://<server-ip>:9527` (e.g., `http://192.168.1.100:9527`)
  - **Connection Password**: Password of the corresponding user.
  - **Feature**: Connect without username in the URL; server auto-matches user by password. **Note: In this mode, all user passwords must be strictly unique**.

### ③ Subsonic Music Client Setup (Yinliu / Feishin / Symfonium, etc.)
Fully compatible with Subsonic API protocol:
- **Server Address (Server URL)**:
  - **Default Shared Port**: `http://<server-ip>:9527/rest` (Subpath configured via `SUBSONIC_PATH`, default `/rest`).
  - **Standalone Port Mode** (if `SUBSONIC_PORT` > 0, e.g., `4533`): `http://<server-ip>:4533/rest`.
    - ⚠️ **Docker deployments must also publish that port**: setting `SUBSONIC_PORT=4533` alone is not enough —
      add `-p 4533:4533` to `docker run` (or expose `"4533:4533"` in the compose `ports` list), otherwise it is
      unreachable from outside the container.
- **Username & Password**: Sync username and password configured in the "User Management" dashboard.
- **Global Online Search**: Search and stream tracks across music platforms directly within Subsonic clients. Prefix keywords with `wy:`, `tx:`, `kw:`, `kg:`, `mg:` to specify sources, or `online:` / `local:` to toggle online/local search.
- **About server-side transcoding**: Subsonic `transcode` relies on `ffmpeg`, and the **Docker image ships `chromaprint` only — no `ffmpeg`**.
  The server probes for it at startup (`probeFfmpeg()`): when missing it disables transcoding and **gracefully falls back to a 302 direct link**
  (no errors, no playback failure) — only the client-requested bitrate/format conversion is skipped. If you need server-side transcoding,
  install `ffmpeg` into the image yourself or use an image variant that bundles it.

---

## 🏗️ Architecture

Separated frontend and backend architecture based on Node.js:

- **Backend (Node.js native http + WebSocket)**: Data sync, users & permissions, custom sources, Subsonic protocol, WebDAV backup.
- **WebPlayer (Vanilla JS)**: Handles music playback, default access path is root `/`.
- **Console (Vanilla JS)**: Located at `/admin` path, handles user and data management.

---

## 🛠️ Configuration

The configuration file is persisted by default in the data directory at `data/config.js` (in Docker deployments, mounting the `./data` volume keeps **the configuration itself** across container updates and restarts — note this covers configuration only; cache / downloads / cover cache each need their own mounts, see "Mount ... together" above; existing legacy `config.js` in root will be migrated automatically). Environment variables take precedence:

| Env Variable | Config Key | Description | Default |
| --- | --- | --- | --- |
| `PORT` | `port` | Service port | `9527` |
| `ADMIN_PATH` | `admin.path` | Backend management interface path | `/admin` |
| `PLAYER_PATH` | `player.path` | Web player access path (default root `/`) | `/` |
| `ADMIN_PASSWORD` | `admin.password` | Admin password (for management console and music player admin login) | `123456` |
| `SERVER_NAME` | `serverName` | Sync service name (shown in client pairing & admin console title) | `LX Sync Server` |
| `PLAYER_NAME` | `player.name` | Web player name (shown in web player title & login card) | `LX Music Web` |
| `ENABLE_DEBUG` | `debug.enabled` | Enable DEBUG mode (verbose debug and source sandbox logs, default false) | `false` |
| `MAX_SNAPSHOT_NUM` | `maxSnapshotNum` | Max snapshots to keep | `10` |
| `CONFIG_PATH` | - | Absolute path to external config file (defaults to `data/config.js`) | - |
| `DATA_PATH` | - | Absolute path to data storage directory (**the Docker image overrides this to `/server/data`**) | `./data` |
| `LOG_PATH` | - | Absolute path to log output directory (**the Docker image overrides this to `/server/data/logs`**, so logs land in `data/logs` rather than a separately mounted `./logs`) | `./logs` |
| `PROXY_HEADER` | `proxy.header` | Proxy IP header (e.g., `x-real-ip`) | - |
| `USER_ENABLE_ROOT` | `user.enableRoot` | Enable root path (use `ip:port`, password must be unique) | `false` |
| `USER_ENABLE_PATH` | `user.enablePath` | Enable user path (use `ip:port/username`, passwords can repeat) | `true` |
| `WEBDAV_ENABLE` | `webdav.enable` | Enable WebDAV sync and backup | `false` |
| `WEBDAV_URL` | `webdav.url` | WebDAV URL | - |
| `WEBDAV_USERNAME` | `webdav.username` | WebDAV Username | - |
| `WEBDAV_PASSWORD` | `webdav.password` | WebDAV Password | - |
| `WEBDAV_SYNC_PATH` | `webdav.syncPath` | WebDAV remote sync path | `/lx-sync` |
| `WEBDAV_BACKUP_PATH` | `webdav.backupPath` | WebDAV remote backup path | `/lx-sync-backups` |
| `SYNC_INTERVAL` | `sync.interval` | WebDAV incremental sync interval (min) | `60` |
| `BACKUP_INTERVAL` | `sync.backupInterval` | WebDAV full backup interval (hours) | `24` |
| `WEBDAV_EXCLUDE_CACHE` | `webdav.excludeCache` | Exclude cache dir from sync (`data/<user>/cache`). When enabled, skips incremental sync & full backup (already-synced files are NOT deleted) | `false` |
| `WEBDAV_EXCLUDE_MUSIC` | `webdav.excludeMusic` | Exclude music/download dir from sync (`data/<user>/music`). When enabled, skips incremental sync & full backup (already-synced files are NOT deleted) | `false` |
| `ENABLE_WEBPLAYER_AUTH` | `player.enableAuth` | Enable Web Player password | `false` |
| `WEBPLAYER_PASSWORD` | `player.password` | Web Player password | `123456` |
| `DISABLE_TELEMETRY` | `disableTelemetry` | Disable anonymous telemetry and update notifications | `false` |
| `ENABLE_PUBLIC_USER_RESTRICTION` | `user.enablePublicRestriction` | Enable public user permission restriction (restrict upload/delete public sources) | `true` |
| `ENABLE_PUBLIC_NON_ADMIN_LOCAL_MUSIC` | `user.enablePublicNonAdminLocalMusic` | Enable non-admin access to local music (allows non-admin public accounts to access local music) | `false` |
| `ENABLE_PUBLIC_NON_ADMIN_BROWSER_DOWNLOAD` | `user.enablePublicNonAdminBrowserDownload` | Enable non-admin browser download (allows non-admin/public accounts to download songs via browser) | `true` |
| `ENABLE_PUBLIC_NON_ADMIN_SERVER_CACHE` | `user.enablePublicNonAdminServerCache` | Enable non-admin server cache (allows non-admin/public accounts to cache songs on server) | `false` |
| `ENABLE_PUBLIC_FAVORITES` | `user.enablePublicFavorites` | Enable public favorites and songs (allows guest/public to view and play public favorites) | `false` |
| `ENABLE_PUBLIC_NON_ADMIN_ACCESS` | `user.enablePublicNonAdminAccess` | Enable non-admin access to public favorites & songs (allows non-admin public accounts to view) | `false` |
| `ENABLE_CUSTOM_MUSIC_DIR` | `user.enableCustomMusicDir` | Enable custom music directories feature globally | `false` |
| `ENABLE_LOGIN_USER_CACHE_RESTRICTION` | `user.enableLoginCacheRestriction` | Enable cache settings restriction for logged-in non-admin users | `false` |
| `ENABLE_CACHE_SIZE_LIMIT` | `user.enableCacheSizeLimit` | Enable cache size limit (auto-cleanup via LRU) | `false` |
| `CACHE_SIZE_LIMIT` | `user.cacheSizeLimit` | Cache size limit in MB | `2000` |
| `CONFIG_BACKUP_ENABLE` | `configBackup.enable` | Enable automatic config.js backup (creates daily backup copy) | `true` |
| `CONFIG_BACKUP_RETENTION_DAYS` | `configBackup.retentionDays` | Config backup retention period in days (auto cleans up expired backups) | `7` |
| `CONFIG_BACKUP_DIR` | `configBackup.dir` | Custom storage directory for config backups (absolute or relative to `./data`; empty means `<data>/backups`)| `-`       |
| `SNAPSHOT_BACKUP_PATH` | `snapshot.backupPath` | Custom storage path for playlist snapshots (absolute or relative to `./data`) | - |
| `LIST_ADD_MUSIC_LOCATION_TYPE` | `list.addMusicLocationType` | Position when adding songs to list (`top` / `bottom`) | `top` |
| `PROXY_ALL_ENABLED` | `proxy.all.enabled` | Enable outgoing request proxy (for Music SDK) | `false` |
| `PROXY_ALL_ADDRESS` | `proxy.all.address` | Proxy address (supports http:// or socks5://) | - |
| `SINGER_SOURCE_PRIORITY` | `singer.sourcePriority` | Singer info retrieval priority (e.g., `tx,wy` or `wy,tx`) | `tx,wy` |
| `SUBSONIC_ENABLE` | `subsonic.enable` | Enable Subsonic API support | `true` |
| `SUBSONIC_PATH` | `subsonic.path` | Subsonic API access path (default `/rest`) | `/rest` |
| `SUBSONIC_PORT` | `subsonic.port` | Standalone port for Subsonic (`0` means disabled, shares main port). **Docker deployments must also publish this port** (e.g. `-p 4533:4533`) | `0` |
| `SUBSONIC_ENABLE_DEBUG` | `subsonic.enableDebug` | Enable Subsonic debug log mode | `false` |
| `SUBSONIC_ONLINE_SEARCH` | `subsonic.onlineSearch` | Enable Subsonic online search | `true` |
| `SUBSONIC_ONLINE_SEARCH_MODE` | `subsonic.onlineSearchMode` | Subsonic online search mode (`fallback` / `merge` / `local_only`) | `fallback` |
| `SUBSONIC_ONLINE_SEARCH_SOURCES` | `subsonic.onlineSearchSources` | Subsonic online search default platforms | `wy,tx,kw,kg,mg` |
| `SUBSONIC_PUBLIC_LEADERBOARDS` | `subsonic.publicLeaderboards` | Enable Subsonic public leaderboards (map online charts to read-only playlists) | `false`|
| `SUBSONIC_LEADERBOARD_SOURCE` | `subsonic.leaderboardSource` | Subsonic public leaderboard default platform (single platform, e.g., `tx`, `wy`) | `tx` |
| `SUBSONIC_LYRIC_TRANSLATION` | `subsonic.lyricTranslation` | Include translations in Subsonic lyrics | `true` |
| `SUBSONIC_CACHE_ON_PLAY` | `subsonic.cacheOnPlay` | Trigger server caching on Subsonic playback (cached to user dir) | `false` |
| `SUBSONIC_PLAY_CACHE_FIRST` | `subsonic.playCacheFirst` | Prefer streaming local cached/downloaded files on Subsonic playback | `true` |
| `SUBSONIC_QUALITY_ENABLED` | `subsonic.quality.enabled` | Enable Subsonic audio quality selection | `true` |
| `SUBSONIC_QUALITY_PRIORITY` | `subsonic.quality.priority` | Subsonic audio quality priority order (e.g. `flac,320k,128k`) | `flac,320k,128k` |
| `ARTIST_MAX_FETCH_PAGES` | `artist.maxFetchPages` | Maximum fetch pages for artist tracks | `20` |
| `CACHE_NAMING_PATTERN` | `cache.namingPattern` | Cache file naming rule (`simple` / `custom`) | `simple` |
| `SYSTEM_ALLOW_UNSAFE_VM` | `system.allowUnsafeVM` | Allow VM mode custom source scripts (note security risks) | `false` |
| `LX_USER_<username>` | `users` array | Quickly add a user, value is the password (e.g., `LX_USER_test=123`) | - |

> **Advanced User Configuration Note**: The environment variable `LX_USER_<username>` is only used to quickly add users and set passwords. If you need to configure independent advanced options for specific users (such as enabling personal custom music directories, assigning operation permissions `allowOperateCustomMusicDir` or write permissions `allowWriteCustomMusicDir`, adjusting snapshot counts, etc.), please manually configure the corresponding fields for that user in the `users` array within `config.js`, or modify them through the GUI in the admin panel's User Management section.

> **Boolean Environment Variable Format**: All boolean env variables support flexible case-insensitive formats: `true`/`1`/`yes`/`y`/`on` for enabled, and `false`/`0`/`no`/`n`/`off` for disabled.

> **Note**: The service currently supports two types of sync connection URLs: `Root Path` (URL configuration is `ip:port`) and `User Path` (URL configuration is `ip:port/username`). If the User Path is disabled, all sync user passwords must be completely unique.

---

## 🛡️ Data Collection & Privacy

Anonymous telemetry via PostHog is used for:

1. **Bug Tracking**: Version number and environment type.
2. **Notifications**: **Update alerts** and **maintenance notices**.

- **Totally Anonymous**: No IP, username, or playlist content is collected.
- **How to Disable**: Set `DISABLE_TELEMETRY=true`. **Note: Disabling this prevents receiving update notifications.**

---

## 🤝 Credits & Acknowledgements

- This project is a fork of [xcq0607/lxserver](https://github.com/xcq0607/lxserver), which is based on [lyswhut/lx-music-sync-server](https://github.com/lyswhut/lx-music-sync-server).
- Web player logic inspired by [lx-music-desktop](https://github.com/lyswhut/lx-music-desktop).
- Thanks to the authors and contributors of the projects above.

### 👥 Contributors

<a href="https://github.com/zues0077/lxserver/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=zues0077/lxserver" />
</a>

## 📈 Star History


<a href="https://www.star-history.com/?repos=zues0077%2Flxserver&type=timeline&logscale=&releases=&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=zues0077/lxserver&type=timeline&theme=dark&logscale&legend=bottom-right" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=zues0077/lxserver&type=timeline&logscale&legend=bottom-right" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=zues0077/lxserver&type=timeline&logscale&legend=bottom-right" />
 </picture>
</a>


---

## 📄 License

This project is released under the Apache License 2.0. The following agreement is a supplement to the Apache License 2.0. In case of conflict, this agreement shall prevail.

Apache License 2.0 copyright (c) 2026 [zues0077](https://github.com/zues0077) (original copyright belongs to [xcq0607](https://github.com/xcq0607); attribution retained per Apache-2.0)

**Terminology**: "This Project" refers to LX Music Web Player; "User" refers to the user who agrees to this agreement; "Official Music Platforms" refers to the collective official platforms of the music sources built into this project, including Kuwo, Kugou, Migu, etc.; "Copyrighted Data" refers to data owned by others, including but not limited to images, audio, names, etc.

### I. Data Sources

1. **Official Platforms**: The online data from various official platforms in this project is pulled from their public servers. It is displayed after simple filtering and merging (the same as the data obtained from official apps in an unlogged state). Therefore, this project is not responsible for the legality or accuracy of the data.
2. **Audio Data**: This project itself does not have the ability to obtain specific audio data. The online audio data sources used come from the online links returned by the "Source" selected in the "Custom Source" settings. This project cannot verify its accuracy, and playback abnormalities may occur during use.
3. **Other Data**: Non-official platform data in this project (such as lists in "My List") comes from server-stored data. This project is not responsible for the legality or accuracy of this data.

### II. Disclaimer

1. **Copyrighted Data**: Copyrighted data may be generated during the use of this project. This project does not own ownership of this copyrighted data. To avoid infringement, users must clear the copyrighted data generated during the use of this project within **24 hours**.
2. **Liability**: Any direct, indirect, special, incidental, or consequential damages of any nature arising from this agreement or from the use or inability to use this project are the responsibility of the user.
3. **Laws and Regulations**: This project is completely free and open-sourced on GitHub for technical learning and exchange. Use of this project in violation of local laws and regulations is **PROHIBITED**. The user shall bear full responsibility for any illegal or non-compliant behavior caused by using this project, whether the user is aware of local laws and regulations or not.

### III. Miscellaneous

1. **Resource Usage**: Some resources used in this project, including but not limited to fonts and images, come from the internet. If there is any infringement, please contact this project for removal.
2. **Non-Commercial Nature**: This project is only for technical feasibility exploration and research. It does not accept any commercial cooperation (including but not limited to advertising) or donations.
3. **Acceptance of Agreement**: If you use this project, it means you accept this agreement.
