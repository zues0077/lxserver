# FAQ & Troubleshooting

> This page collects the most common gotchas when running lxserver. Each entry follows "Symptom → Cause → Fix".

---

## Table of Contents

- [1. Soda Music: scanned the QR but LX Music shows "no change"](#_1-soda-music-scanned-the-qr-but-lx-music-shows-no-change)
- [2. What is the Soda signer and why do I need it](#_2-what-is-the-soda-signer-and-why-do-i-need-it)
- [3. The "How to get" popup won't close](#_3-the-how-to-get-popup-won-t-close)
- [4. Where do downloaded files go? cache vs music](#_4-where-do-downloaded-files-go-cache-vs-music)
- [5. Why did turning on "capacity cleanup" delete my downloaded songs](#_5-why-did-turning-on-capacity-cleanup-delete-my-downloaded-songs)
- [6. Why must cover_cache be mounted separately](#_6-why-must-cover-cache-be-mounted-separately)
- [7. Quality label doesn't match what I requested](#_7-quality-label-doesn-t-match-what-i-requested)
- [8. XiaoAi speaker casting: no sound / not found](#_8-xiaoai-speaker-casting-no-sound-not-found)
- [9. Image version doesn't match the code version](#_9-image-version-doesn-t-match-the-code-version)
- [10. Is "Platform Accounts" a separate view](#_10-is-platform-accounts-a-separate-view)
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

**Scope**: affects **only "play full / Hi-Res"**. Unrelated to login. Playing a copyright-restricted Soda track normally stops at a 30-second preview; only after the signer adds the official client's signature headers for a logged-in VIP account can you get the full / Hi-Res stream (the header set follows the client version: `X-Helios` + `X-Medusa` on 3.7.x, **only `X-Neptune` from 3.8.x — a missing header there is normal**). To listen offline, use "cache to server". To listen offline, use "cache to server".

**Why it must be deployed separately**: signing needs ByteDance's official security component (`bdms.node` + `metasecml.dll`), which only exists on a **machine with the Soda client installed** (`app.asar.unpacked`). The main image has no such component → the signer is **not** part of the main image; run it somewhere that has these two binaries, then enter its address in the console under **Platform Accounts → Soda signer**.

**Two deployment options (pick one, same result)**

- **Option A: Windows host, `tools/qishui-signer/`** (when you have a Windows machine with the Soda client)
  - Ships in this repo under `tools/qishui-signer/` (listens on `http://localhost:18080/` by default); double-click `start-signer.bat` on Windows.
  - **Web config page** (v1.5.34+): open `http://localhost:18080/` for a form with port / bind address / LX server list. Saving is **hot-reloaded** (port change hot-restarts the listener, server list re-registers immediately); config persists to `config.json`.
  - The signer is **stateless** (Soda account state lives in each LX server), so one signer can register with / sign for multiple LX servers **without affecting each other's Soda accounts** → enter the signer address in the console, multiple entries allowed.
  - If the launcher window says it "cannot find bdms.node": open the Soda client once (components are unpacked on first launch). If that doesn't help, run `find-soda-client.bat` from the root of the [soda-signer repo](https://github.com/zues0077/lxserver-soda-signer) to see where it actually lives, then point at it with `--client "<that folder>"`.

- **Option B: Wine container on your NAS, `lxserver-soda-signer`** (for NAS-only setups, no Windows needed; running on our 120 / 246)
  - Separate image repo: [zues0077/lxserver-soda-signer](https://github.com/zues0077/lxserver-soda-signer). Its image versioning is **independent** (currently **1.0.1**; tags `1.0.1` / `1.0` / `latest`) and unrelated to the lxserver version.
  - Runs the official client's Windows-native signing component under Wine on linux/amd64 and generates signature headers on behalf of lxserver.
  - The image **does not contain** `bdms.node` / `metasecml.dll`: extract them from your own Soda client's `app.asar.unpacked` and **mount them read-only** (e.g. `/vol2/1000/Docker/soda-client:/soda-client:ro`).
  - linux/amd64 only (the Windows native module cannot be reliably translated on arm); the main image is untouched — pull it on demand.
  - **Same web panel** as Option A: open `http://<NAS IP>:18080/` to set port / bind address / multiple LX servers (URL + console password); saving is hot-reloaded. "Service status" shows the signer version, whether bdms loaded, UA, sign counters, and **whether each LX server currently sees it** (by asking LX's `GET /api/music/prefetch/signer`).
  - The client version is **auto-detected** — checked in order: `manifest.json` / `../manifest.json` / `../../config.json` / `version.json` / `package.json` / the directory name — and reported via `GET /config`; lxserver **1.5.36+** uses the reported UA and version code directly, so a client upgrade needs no server-side code change.
  - **How to obtain the client folder**: the repo root ships `find-soda-client.bat` (double-click on Windows). It scans for every `app.asar.unpacked` on the machine and reports each one's client version and where that version came from; add `-StageTo D:\soda-stage` and it assembles `bdms.node` + `metasecml.dll` + `manifest.json` into a mount-ready folder you can copy straight to the NAS — no manual digging through `%LOCALAPPDATA%\Programs\Soda Music`.
  - **⚠️ The panel shows an empty "client version"** (`detectedVersion: ""` in `/api/status`): the mounted folder has no version-bearing file and the directory name has no `x.y.z` (typical when only the contents of `app.asar.unpacked` were copied, without the outer `Packages/<ver>/`). The signer falls back to its built-in default `3.7.0` — signing still works but the reported version is wrong. Fix it by dropping a `manifest.json` into the mounted folder:
    ```json
    {"version":"3.8.0","shellMinVersion":"3.1.0"}
    ```
    Use your actual client version (`find-soda-client.bat` tells you), then restart the container — `detectedSource` becomes `manifest.json`.
  - Deployment and troubleshooting live in that repo's README (mount path, env vars, `/health` self-check, the stdin / stderr pipe pitfalls that cause instant exit or failing outbound requests, etc.).

**Which one**: a always-on Windows box with the Soda client → Option A is simplest; NAS-centric setup where you don't want to keep a Windows machine running just for signing → Option B. In the console, Option A's address is `http://<Windows IP>:18080`, Option B's is `http://<NAS IP>:18080`; everything else is identical.

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
