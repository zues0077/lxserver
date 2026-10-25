# FAQ & Troubleshooting

> This page collects the most common gotchas when running lxserver. Each entry follows "Symptom → Cause → Fix".

---

## Table of Contents

- [1. Soda Music: scanned the QR but LX Music shows "no change"](#1-soda-music-scanned-the-qr-but-lx-music-shows-no-change)
- [2. What is the Soda signer and why do I need it](#2-what-is-the-soda-signer-and-why-do-i-need-it)
- [3. The "How to get" popup won't close](#3-the-how-to-get-popup-wont-close)
- [4. Where do downloaded files go? cache vs music](#4-where-do-downloaded-files-go-cache-vs-music)
- [5. Why did turning on "capacity cleanup" delete my downloaded songs](#5-why-did-turning-on-capacity-cleanup-delete-my-downloaded-songs)
- [6. Why must cover_cache be mounted separately](#6-why-must-cover_cache-be-mounted-separately)
- [7. Quality label doesn't match what I requested](#7-quality-label-doesnt-match-what-i-requested)
- [8. XiaoAi speaker casting: no sound / not found](#8-xiaoai-speaker-casting-no-sound-not-found)
- [9. Image version doesn't match the code version](#9-image-version-doesnt-match-the-code-version)
- [10. Is "Platform Accounts" a separate view](#10-is-platform-accounts-a-separate-view)
- [Extended Reading](#extended-reading)

---

## 1. Soda Music: scanned the QR but LX Music shows "no change"

**Symptom**: In the console "Platform Accounts → Soda", scanning the QR with your phone shows logged-in on the phone, but the LX Music client still isn't logged in and can't fetch songs.

**Cause**: New-device / remote logins trigger Soda's `account_flow=verify` (SMS second-factor, `error_code=2046`). The current web-QR flow only implements the web-passport QR and **does not implement this second-factor branch** → the phone takes over the login into the Soda app, the web token never receives `sessionid/sid_tt`, so LX Music sees "no change".

**Fix**:
- Log in via "Paste Cookie" (paste the cookie from your Soda web session); or
- Use the "Download extension" button in the popup to install the browser extension, then "One-click sync".

> Note: this is separate from "playing full / Hi-Res tracks". Scanning logs in the **account**; the signer signs songs for an **already-logged-in account**. They don't affect each other.

## 2. What is the Soda signer and why do I need it

**What**: `tools/qishui-signer/` (a Windows-side program, listens on `http://localhost:18080/` by default). Playing full / Hi-Res Soda tracks needs a signature from ByteDance's security component (`bdms.node` + `metasecml.dll`), which only exists on a **Windows machine that has the Soda client installed** (`app.asar.unpacked`). It's not inside the Docker image → the signer must run on Windows with the Soda client, not in the container.

**Scope**: affects **only "play full / Hi-Res"**. Unrelated to login. To listen offline, use "cache to server".

**Web config page** (v1.5.34+): open `http://localhost:18080/` in a browser to see a form for port / bind address / LX server list; saving is **hot-reloaded** (changing port hot-restarts the listener, server list re-registers immediately), config persists to `config.json`.

**Multi-server safety**: the signer is **stateless** (Soda account state lives in each LX server), so one signer can serve multiple LX servers / sign for them **without affecting each other's Soda accounts** → in the console "Soda signer" field you enter the signer address, and you can list multiple.

## 3. The "How to get" popup won't close

**Symptom**: click "Platform Accounts → Soda → How to get", the help popup won't close.

**Cause**: the close logic in source is correct (the close button sets `display:none`); "won't close" is almost always the browser **caching an old app.js**.

**Fix**: hard refresh (Windows `Ctrl+Shift+R` / Mac `Cmd+Shift+R`). For extra robustness we may later add Esc / click-overlay-to-close.

## 4. Where do downloaded files go? cache vs music

**Play-and-cache (default on)**: once an online URL is resolved, the **full audio** is auto-written to **cache** without blocking playback. Note this call does **not** pass `enableOnlyDownloadMode`, so play-cache always lands in cache.

**Manual download** goes through the download queue with `enableOnlyDownloadMode` (frontend default `true`) → **writes to music by default**; turn the switch off to write to cache, then move via "Move folder".

**Real entry points**:
- Right-click a track → "Download to server / Cache to server" — label changes with `enableOnlyDownloadMode`; if the target quality already exists in cache it **auto-moves over**;
- Local-music page → select files → orange "Move folder" button (cache ↔ music, two-way); tracks under music subfolders / categories can't move into cache;
- The blue "Cloud sync" button in the same bar is different — it switches `serverCacheLocation` (root ↔ data).

**Single source of truth**: `fileCache.ts` `ensureDir(username, isOnlyDownload)` (`true→music`, `false→cache`). If the file already exists in cache it is **copied** to music rather than re-downloaded.

## 5. Why did turning on "capacity cleanup" delete my downloaded songs

By default `user.enableCacheSizeLimit=false` (no cleanup). Once enabled, after every download it checks total size = **cache + music combined** (only mp3/flac/m4a/ogg/wav/lrc), and when over limit deletes oldest-by-mtime down to 95%, **deleting from cache AND music together** (so downloaded songs get removed too). If you only want to keep the download folder, don't enable capacity cleanup, or put music on separate storage.

## 6. Why must cover_cache be mounted separately

`cover_cache` is a special case that always uses `process.cwd()` → `/server/cover_cache`, **regardless of `serverCacheLocation`**. Switching to data mode still writes to `/server/cover_cache` → it must be mounted separately, otherwise cover art lands in the container writable layer and is lost on restart. Always mount `data + cache + music + cover_cache` on every container.

## 7. Quality label doesn't match what I requested

Before writing to disk, `file-type` + `inspectAudioFile` **measure the actual** quality — it's the **measured value, not the requested value**. Default naming `simple` = `title - artist - quality - album`; `standard` includes source+id; names are truncated at >200 chars and illegal chars replaced with `_`.

## 8. XiaoAi speaker casting: no sound / not found

Prerequisites: the XiaoAi speaker and lxserver are on the same LAN, and XiaoAi casting is enabled and bound in the console. Common blockers:
- speaker firmware too old;
- lxserver port not exposed (check firewall / reverse proxy);
- account not bound or binding expired — rebind once in the console.

## 9. Image version doesn't match the code version

The GHCR image can **lag behind the code** because `[skip ci]` commits are skipped by CI (e.g. code is at v1.5.34 but the live image is still v1.5.32). The version returned by `/health` follows the code; to update the live image, push a commit without `[skip ci]` (or build ghcr manually).

## 10. Is "Platform Accounts" a separate view

Yes. The console "Platform Accounts" is an independent nav view supporting NetEase / QQ / WeChat / Kugou / **Soda** / **Bilibili** via QR or Cookie login to fetch links, managed separately from "My Music / Sync".

## Extended Reading

- [Application Settings & Rules](./app-settings.md)
- [Quick Start Tutorial](./tutorial.md)
