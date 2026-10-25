# Usage Tutorial (Web Player / Client Sync / Subsonic / Download & Cache)

> From opening the first page to playing the first song, this tutorial walks you through **all core chains**; each operation is tagged with "where to change it / where it lands".

---

## Table of Contents

- [Step 1: Access the Web Player](#step-1-access-the-web-player)
- [Step 2: Login & User Creation](#step-2-login-user-creation)
- [Step 3: Search & Play](#step-3-search-play)
- [Step 4: Manage Playlists & Favorites](#step-4-manage-playlists-favorites)
- [Step 5: Download & Server Cache](#step-5-download-server-cache)
- [Step 6: Connect the LX Music Desktop/Mobile Client](#step-6-connect-the-lx-music-desktopmobile-client)
- [Step 7: Connect Subsonic Clients (Star Music/Feishin/Symfonium)](#step-7-connect-subsonic-clients-star-musicfeishinsymfonium)
- [Step 8: XiaoAi Speaker Casting](#step-8-xiaoai-speaker-casting)
- [Step 9: Admin Console (Users/Backup/Version/Restart)](#step-9-admin-console-usersbackupversionrestart)
- [FAQ Quick Lookup](#faq-quick-lookup)
- [Extended Reading](#extended-reading)

---

## Step 1: Access the Web Player

Default address (root path after extraction): `http://IP:9527` (in Docker `9527` needs `-p 9527:9527`, see [Docker Deployment](README_EN.md#docker-deployment)).

- If `ENABLE_WEBPLAYER_AUTH=true` is not configured → Play directly (guests can only access public playlists).
- If `WEBPLAYER_PASSWORD` is required (default `123456`) → enter it; this is independent of the admin password.

---

## Step 2: Login & User Creation

### Admin Login

`http://IP:9527/admin` → Default admin password `123456` (**please change it first in production**).

In "User Management" → **Create User** (`users` entry), features:
- Rename / Change Password / Add Permissions (`enableCustomMusicDir` lets them have a private audio directory)
- Public/Private visibility control (`enablePublicFavorites` etc.)

### User login

Bottom-right "Settings" in the Web Player → **Login** (or use the account you created), after login you get your personal `data/<username>` space.

> Login is the "User" icon in the top-left of the Web Player; user management (creation/password) is in the admin backend.

---

## Step 3: Search & Play

Web Player searches multi-source platforms: `wy`(Netease) / `tx`(Tencent) / `kw`(Kuwo) / `kg`(KuGou) / `mg`(Migu) — default is in `subsonic.onlineSearchSources`.

### Search → Play

1. Click search bar → select platforms or All → play (pick quality: `flac`/`320k`/`128k`, edit in settings `preferredQuality`)
2. If resolution fails → **Auto Degrade** (`flac → 320k → 128k`)
3. Don't want to wait for resolution? Hit **Server Cache** (needs `enableServerCache=true`) → cache first, then play
4. Click into the player details page to view lyrics, cover, scrolling

### Small details

- Shortcuts: `Space`(Pause/Play), `ArrowRight`(Next), `ArrowLeft`(Prev)
- Volume track is on the bottom-right slider.
- **Lyrics translation/Roma**: Settings switches `showLyricTranslation` / `showLyricRoma`

---

## Step 4: Manage Playlists & Favorites

After login:
- "Favorites" on the player's home page bottom-left → Add/Create → use `list.addMusicLocationType` (`top`/`bottom`) to control where new songs are added
- Drag the playlist: Long-press from the bottom-level list → drag to sort
- In the Admin Console → **Snapshot Management** → one-click backup/restore (playlists, favorites, enriched).

Another feature: Right sidebar of artist/album showcase (favorites & clear tools):
- **Pro tip**: In Settings, the switches `switchPlaylistOnSearchPlay`/`switchPlaylistOnSongListPlay` decide whether to **auto-switch playlists** after searching/playing a playlist (they recommend enabling both, otherwise after a playlist plays you can't find the next song)

---

## Step 5: Download & Server Cache

> These two things are **completely different paths**, landing directly in `fileCache.ts` files. Don't mix them up.

### 1) Server Cache (play-while-caching)

Hit "**Cache to Server**" in the player → backend drops the song into `cache/<username>` (`root` mode) or `data/<username>/cache` (`data` mode, syncable), **non-blocking**.

- When `enableServerCache=true`, when one pink progress bar finishes = this **audio file + same-quality lrc/cover tag** are all written.

### 2) Download (direct-link to disk)

Hit "**Download to Server**" in the right-click menu → lands under `music/<username>`.
- **`enableOnlyDownloadMode=true` (default)** → writes directly to `music`
- Want it in `cache`? Go to **Settings → Only Download Mode** → turn it off → then "**Move Directory**" into the music library (see below)

### 3) Move between cache & music

In the "Local Music" page, click "**Move Directory**" → `batchSwitchFolder` → bi-directional move, `music ← → cache`.
- **Note**: songs in `music` with subdirectories/categories cannot be migrated to `cache` (only source files move)
- If it was already cached during download, **same-name same-quality will directly copy** (saves disk space)

---

## Step 6: Connect the LX Music Desktop/Mobile Client

Go to the client's **Settings → Sync Settings** (see [Service Connection & Client Config](README_EN.md#service-connection--client-configuration)):

### User Path Mode (Recommended)

URL = `http://IP:9527/<username>`, Password = the user's own password.
- **Each user has their own playlist independently**; supports different users with the same password (iOS/Mac/Win same-code feasible).

### Root Path Mode

URL = `http://IP:9527`, requires `USER_ENABLE_ROOT=true` (add `- USER_ENABLE_ROOT=true` in `docker-compose.yml`); in this mode all users' passwords must be unique.

> PC clients need `ws://...` forwarding; set `- p 9527:9527` in the container; the nuxt root path (`PLAYER_PATH`) or `/socket` compatible.

---

## Step 7: Connect Subsonic Clients (Star Music/Feishin/Symfonium)

- Address: `http://IP:9527/rest` (`SUBSONIC_PATH` default `/rest`)
- Username/Password: the **user** you created in the backend.
- Don't forget to open `- p 4533:4533` in `docker-compose.yml` (if you configured `SUBSONIC_PORT=4533`)
- Online search: `wy:` / `tx:` / `kw:` / `kg:` / `mg:`, the default sources for `Subsonic Online Search` is in `subsonic.onlineSearchSources`.
- Server-side transcoding requires ffmpeg; the Docker image doesn't have ffmpeg by default; if it can't pass through, it **degrades gracefully to a 302 direct link** (no error).

---

## Step 8: XiaoAi Speaker Casting

`http://IP:9527` → Settings → "XiaoAi Speaker Casting":
- First scan to login (scan with Mi Home App) or password/cookie
- After the speaker list appears, select the target → click "**Cast**" in the player bottom
- Single-track `audioID` matching failure degrades to searching ` Nội dung` in the library
- Supports **multiple simultaneous playback**, auto continues

### Tutorial: Casting FAQ
- Screen doesn't show `audioID` → turn off the `xiaoai.hybrid` setting or update the script

---

## Step 9: Admin Console (Users/Backup/Version/Restart)

- **User Management**: Open/Close / rename/password/snapshots
- **System Config** (see [App Settings & Configuration Rules](./app-settings.md))
- **Version info**: `/api/status` (check the `version` field)
- **Restart**:
  - Panel switches → `POST /api/admin/reload` (**effective immediately after edit**)
  - Ports/Base env → click `POST /api/restart`; Docker relies on `--restart unless-stopped`

### Logs
- Admin Console → **System Logs** (`/api/logs?type=app`)
- Full logs in the container: `docker logs` (or look at `/server/data/logs/app.log` in the `logs/` volume)
- Update/Rollback path is in `changelog.md`

---

## FAQ Quick Lookup

| Scenario | Solution |
| :--- | :--- |
| Page doesn't open | Check whether firewall 9527 is open; Docker whether `-p 9527:9527` |
| Can't search songs | Check `subsonic.onlineSearchSources` / Whether each source is enabled |
| Cache songs but download fails | Check whether `enableCacheSizeLimit` was turned on + capacity limits, check in settings |
| Lyrics not showing / translation missing | Settings `showLyricTranslation=true`; in `data/<user>` check whether the lrc file exists |
| User same-password conflict | User Path Mode supports; Root Path Mode requires unique |
| Volume not loud | Check whether `audio.volume` is being controlled by the mini program; or may be affected by **Auto Proxy** (`enableAutoProxy=true`) |
| TS switch not effective | Settings → Default Quality `preferredQuality` |
| Repeated sync lag | Check the sync time `LX_USER` and the server-side `sync.interval` |

---

## Extended Reading

- [Getting Started / Deployment](./getting-started.md) — Image tags, volume mounts, deployment details
- [Configuration Guide](./configuration.md) — Full table of all env vars
- [Web Player Guide](./web-player.md) — Player details and architecture
- [Sync Server Settings](./sync-server.md) — Sync topology
- [XiaoAi Casting](./xiaoai.md)
- [App Settings & Configuration Rules](./app-settings.md) — Priority chain of all settings
- [Server API Reference](../api/reference.md) — RESTful API
