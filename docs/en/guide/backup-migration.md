# Data Backup & Migration

> This page explains exactly where lxserver writes its data, what each file is for, how to back it up, and how to move everything to a new machine (or new disk / reinstall).
> It complements the "four mounts" section of the [Deployment page](./deployment): that one covers "how to mount", this one covers "what's inside after mounting, and how to protect it".
> Where settings come from and how to change them: [App Settings & Rules](./app-settings). fnOS practice: [Deploying on fnOS](./deploy-fnOS).

---

## Table of Contents

- [1. One core principle first](#_1-one-core-principle-first)
- [2. Volume structure overview (container view)](#_2-volume-structure-overview-container-view)
- [3. What each file / directory does](#_3-what-each-file-directory-does)
- [4. Four cache locations (root / data mode)](#_4-four-cache-locations-root-data-mode)
- [5. How to back up](#_5-how-to-back-up)
- [6. Migrate to a new machine](#_6-migrate-to-a-new-machine)
- [7. Common pitfalls](#_7-common-pitfalls)

---

## 1. One core principle first

> **All persistent data must live in your mounted volumes, not in the container writable layer.**

Rebuilding a container (upgrade, image swap, accidental delete) wipes the writable layer. As long as these directories are bound to host directories, rebuilding the container just "swaps the shell" — data stays intact.

The four **mandatory** volumes (`data` / `cache` / `music` / `cover_cache`) are all required; `logs` is optional. Mount meaning: [Getting Started](./getting-started#容器挂载卷-volume-mappings-) and [Deployment](./deployment#四生产级-docker-compose).

---

## 2. Volume structure overview (container view)

Fixed paths inside the container (`DATA_PATH` defaults to `/server/data`, overridable via env):

```
/server/
├── data/                         ← must mount ./data (host)
│   ├── config.js                ← system config (console-editable; auto daily backups kept)
│   ├── config.js.bak / daily/*  ← local config backup copies
│   ├── music-accounts.json      ← platform account cookies (encrypted)
│   ├── qishui-pending.json      ← Soda pending tasks
│   ├── logs/                    ← default log location (LOG_PATH defaults to /server/data/logs)
│   ├── backups/                 ← WebDAV / local backup destination
│   └── users/
│       ├── <username>/
│       │   ├── users.json       ← user profile (nickname, avatar, prefs)
│       │   ├── states.json      ← source states (which are disabled: disabledSources)
│       │   ├── sources.json     ← this user's private custom source list
│       │   ├── settings.json    ← user-level settings (incl. serverCacheLocation)
│       │   ├── radioStations.json ←自建自建 radio stations
│       │   └── (in data mode) cache/ music/   ← cache & downloads (see section 4)
│       └── source/              ← custom source scripts & shared lists
│           ├── _open/           ← public (unauthenticated) shared sources
│           │   ├── sources.json
│           │   ├── states.json
│           │   └── order.json
│           └── <username>/
│               ├── <source>.js  ← source implementation script
│               ├── states.json
│               ├── order.json
│               └── sources.json
├── cache/                       ← must mount ./cache (root mode: play cache /server/cache/<user>)
├── music/                       ← must mount ./music (root mode: downloads /server/music/<user>)
└── cover_cache/                 ← must mount ./cover_cache (cover cache, always in working dir)
```

> `data/users/<username>/` and `data/users/source/<username>/` are **two different directories**:
> - the former is "user data" (profile, settings, private source list, radio);
> - the latter is "custom source code / shared lists" (source `.js` scripts, order).
> Back up both.

---

## 3. What each file / directory does

| File / directory | Purpose | If lost | Backup? |
| :--- | :--- | :--- | :--- |
| `data/config.js` | System config: admin password, player path, cache location, WebDAV, toggles | resets to factory (admin password back to `123456`, reconfigure) | ✅ must |
| `data/music-accounts.json` | Platform accounts (NetEase/QQ/WeChat/Kugou/**Soda**/**Bilibili**) cookies, **encrypted** | platform accounts need re-scan / re-fill cookies | ✅ must (else re-login) |
| `data/users/<user>/users.json` | User profile | user config lost (playlists usually survive in sync data) | ✅ keep |
| `data/users/<user>/states.json` | Source toggle states (`disabledSources`). Auto-written when a platform fails repeatedly | disabled sources try again (may hang again) | ✅ keep |
| `data/users/<user>/sources.json` | This user's private custom source list | private source list lost (scripts under source/ may still exist, re-link) | ✅ keep |
| `data/users/source/**` | Custom source `.js` scripts + public/private lists (`_open` = shared) | all custom sources break, re-upload needed | ✅ must |
| `data/users/<user>/settings.json` | User-level settings, incl. `serverCacheLocation` (root/data) | cache location reverts to default | ⚠️ recommended |
| `data/users/<user>/radioStations.json` | Self-built radio stations | stations lost | ⚠️ optional |
| `data/qishui-pending.json` | Soda pending tasks | in-progress Soda tasks lost | ⚠️ optional |
| `data/logs/` | Runtime logs (troubleshooting entry) | history lost, no runtime impact | ⚠️ optional |
| `data/backups/` | Auto / manual backup artifacts | lose one backup copy (source data still fine) | ⚠️ optional |
| `cache/` `music/` | play cache / downloaded audio | cache/downloads lost, re-cacheable | ⚠️ large, as needed |
| `cover_cache/` | cover thumbnails | covers re-fetched, no playback impact | ⚠️ rebuildable, optional |

> **Minimum backup set** (what really hurts if lost): `data/config.js` + `data/music-accounts.json` + `data/users/` (whole dir). Everything else is rebuildable.

---

## 4. Four cache locations (root / data mode)

The **actual location** of play cache and downloads is decided by `serverCacheLocation` (user-level `settings.json` can override system-level `config.js`):

| Mode | Cache | Downloads | Mount needed |
| :--- | :--- | :--- | :--- |
| `root` (default) | `/server/cache/<user>` | `/server/music/<user>` | mount `./cache`, `./music` |
| `data` | `/server/data/cache/<user>` | `/server/data/music/<user>` | mounting `./data` is enough |

- Index files: `cache_index.json` (cache index), `music_index.json` (download index), under their respective `cache/` `music/` dirs.
- **In either mode, `cover_cache` always writes to `/server/cover_cache`** (container working dir), unaffected by the toggle → must mount `./cover_cache` separately.
- Switching root↔data does not auto-migrate old cache/downloads; you need manual rsync or re-cache.

---

## 5. How to back up

### 5.1 Built-in WebDAV incremental backup (recommended)

Console "System Settings → Backup" can configure a WebDAV target (Nutstore / Synology / self-hosted, etc.). Features:

- **Incremental**: only changed files transfer, saves bandwidth.
- Auto by policy; lands in `data/backups/` (local) and syncs to WebDAV.
- Restore pulls from WebDAV and unzips; it confirms `config.js` exists in `data` before overwriting, avoiding clobbering with an empty cloud config.

> No WebDAV? `data/config.js` itself keeps a **daily local copy** (auto-saved when config.js is written), a built-in safety net.

### 5.2 Manual cold backup (copy the data volume)

Simplest and most reliable: stop the container, tar the whole host `./data`.

```bash
# stop container (avoid writes during backup)
docker stop lx-sync-server

# pack data (cache/music/cover_cache optional, can be huge)
tar -czf lxserver-data-$(date +%F).tar.gz ./data

# optional: include cache too (large, watch disk)
# tar -czf lxserver-full-$(date +%F).tar.gz ./data ./cache ./music ./cover_cache

docker start lx-sync-server
```

### 5.3 Backup checklist: the minimum to keep

| Priority | Path | Note |
| :--- | :--- | :--- |
| 🔴 must | `./data/config.js` | system config |
| 🔴 must | `./data/music-accounts.json` | platform credentials (else re-login) |
| 🔴 must | `./data/users/` | all user profiles + source scripts |
| 🟡 recommended | `./data/users/*/settings.json` | user cache-location prefs |
| 🟡 recommended | `./data/logs/` | troubleshooting history |
| 🟢 optional | `./cache` `./music` `./cover_cache` | audio/covers, rebuildable |

---

## 6. Migrate to a new machine

Scenario: old machine container `lxserver-old` → new machine `lxserver-new` (same image version, data moved intact).

**Step 1 — Stop writes on the old machine**
```bash
docker stop lxserver-old        # ensure nothing writes during backup
```

**Step 2 — Export data**
Copy out at least `./data` from the old machine. Safest is `tar` to a removable disk / network share, or `docker cp` `/server/data` out of the container first.
```bash
# old machine
tar -czf lxserver-data.tar.gz ./data
# transfer to new machine (scp / USB / share, any)
```

**Step 3 — Build directory structure on new machine**
Prepare the four mount dirs and extract `data` into it:
```bash
# new machine
mkdir -p /opt/lxserver/{data,cache,music,cover_cache}
tar -xzf lxserver-data.tar.gz -C /opt/lxserver/   # extracts data/
```

**Step 4 — Start with the same version**
New machine `docker run` / `docker-compose` uses the **same image version** (not `latest`, to avoid old-data/new-code incompatibility), mounts the same four volumes, and keeps env (especially `ADMIN_PASSWORD`, `TZ`, `PROXY_HEADER`) consistent.
```bash
docker run -d \
  -p 9527:9527 \
  -v /opt/lxserver/data:/server/data \
  -v /opt/lxserver/cache:/server/cache \
  -v /opt/lxserver/music:/server/music \
  -v /opt/lxserver/cover_cache:/server/cover_cache \
  --name lx-sync-server --restart always \
  ghcr.io/zues0077/lxserver:1.5.35
```

**Step 5 — Verify**
```
http://<new-ip>:9527/health     # JSON = OK
```
In console confirm: users present, platform accounts (read from `music-accounts.json`) still logged in, custom source scripts under `data/users/source/` intact.

**Step 6 — Wrap-up after address change**
- If the new machine IP / domain changed: update LX client, Subsonic client connection URLs; point proxy rules to the new host port.
- If you also bumped the version: back up old `data` first, then after start use `/health` to confirm source count and probe are normal; on anomaly, change back to the old version tag (data volume untouched, roll back anytime).

> ⚠️ **Do not mount the same host `data` dir into both** a "running old container" and "new container" (double-write corrupts). Keep the old container `stop`ped during migration.

---

## 7. Common pitfalls

| Symptom | Cause / Fix |
| :--- | :--- |
| Admin password wrong after restore | Cloud backup `config.js` is old; use the `ADMIN_PASSWORD` from backup time or reset. Restore logic avoids empty-config overwrite, but verify across big version gaps |
| Platform accounts need re-login on new machine | `music-accounts.json` wasn't moved → it's a 🔴 must in the checklist, bring it along |
| Cache/downloads empty on new machine | was `root` mode, data in `./cache` `./music`, only `data` moved → transfer `cache`/`music` too, or switch to `data` mode and re-cache |
| Covers all gone | `cover_cache` not mounted/moved → add mount, covers re-fetch |
| New machine won't start / permission error | `data` dir owner isn't the container user → `chown -R` to correct uid, or confirm mount is RW |
| Custom sources broken after upgrade | Across major versions the source API may change → check `data/users/source/` scripts are intact, re-upload per new version if needed |

> Deployment / proxy issues: [Deployment](./deployment); fnOS practice: [Deploying on fnOS](./deploy-fnOS); settings & config rules: [App Settings & Rules](./app-settings).
