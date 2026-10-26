# Deploying on fnOS (Step-by-Step)

> This page is the **fnOS-specific edition** of [Deployment, Proxy & HTTPS](./deployment): it breaks the "NAS tips" section into click-by-click steps.
> Audience: users installing lxserver on fnOS (FeiNiu private cloud). Other NAS (Synology / QNAP) follow the same idea, only the UI wording differs.
> General background (proxy, HTTPS, hardening, production Compose, troubleshooting) stays on the main deployment page; this page only covers "how to land it on fnOS".

---

## Table of Contents

- [0. Check these first](#_0-check-these-first)
- [1. Where to pull the image: use `ghcr.nju.edu.cn`](#_1-where-to-pull-the-image-use-ghcr-nju-edu-cn)
- [2. Open the fnOS Docker app](#_2-open-the-fnos-docker-app)
- [3. Pull the image (steps)](#_3-pull-the-image-steps)
- [4. Create the container (core, six steps)](#_4-create-the-container-core-six-steps)
- [5. Start and verify](#_5-start-and-verify)
- [6. HTTPS via fnOS built-in reverse proxy](#_6-https-via-fnos-built-in-reverse-proxy)
- [7. Connect clients / players](#_7-connect-clients-players)
- [Appendix A: Deploy via trim-cli (author's real path)](#appendix-a-deploy-via-trim-cli-author-s-real-path)
- [Appendix B: fnOS common errno reference](#appendix-b-fnos-common-errno-reference)
- [Troubleshooting](#troubleshooting)

---

## 0. Check these first

| Check | Note |
| :--- | :--- |
| fnOS has the "Docker" app installed | Install from App Center; you should see "Images / Containers / Compose" tabs |
| You can reach the fnOS console | Default `http://<NAS IP>:5670` (plain HTTP). This tutorial uses `192.168.1.246` as example |
| A shared folder is planned | e.g. `/vol1/1000/docker/lxserver/`, the four mounts go under it |
| Image source can reach GHCR | fnOS usually supports an accelerator. We use `ghcr.nju.edu.cn` throughout (next section) |
| Port is free | Container port is fixed `9527`; host port is your choice (we use `17950`), proxy / clients use the host port |

> Note: fnOS Docker has **no `docker logs`** subcommand. Verification goes through `http://<NAS IP>:<host port>/health` (JSON response = healthy). This is the key to all troubleshooting.

---

## 1. Where to pull the image: use `ghcr.nju.edu.cn`

The official image is on GitHub Packages (`ghcr.io/zues0077/lxserver`). Pulling `ghcr.io` directly from a domestic fnOS often times out.

**Recommended mirror:** `ghcr.nju.edu.cn/zues0077/lxserver`.

| Use | Image address |
| :--- | :--- |
| Domestic fnOS / NAS | `ghcr.nju.edu.cn/zues0077/lxserver:1.5.35` |
| Direct GitHub | `ghcr.io/zues0077/lxserver:1.5.35` |

> Pin a concrete version (e.g. `1.5.35`), **do not use `latest`**: back up `./data` before upgrading, then just change the tag to roll back. The current version matches `package.json`'s `version` (also on GitHub Releases).

---

## 2. Open the fnOS Docker app

1. Log into the fnOS console (`http://192.168.1.246:5670`).
2. Find the **Docker** app in App Center or on the desktop, and open it.
3. You'll see tabs: **Images**, **Containers**, **Compose** (names may vary slightly by version, but the functions are the same).

This tutorial takes the visual "Images → Container" path (most reliable, no CLI).

---

## 3. Pull the image (steps)

**Step 3.1** — Switch to the **Images** tab, click "**Pull / Download / Add Image**" (top-right, often a `+` or "Pull Image").

**Step 3.2** — Fill in the popup:

```
Registry: ghcr.nju.edu.cn
Namespace / Repository: zues0077/lxserver
Tag: 1.5.35
```

> Some fnOS versions merge these into one box; just paste: `ghcr.nju.edu.cn/zues0077/lxserver:1.5.35`.

**Step 3.3** — If pull is slow or fails, first add `ghcr.nju.edu.cn` to fnOS's "**Image Accelerator / Registry Settings**", then retry.

**Step 3.4** — After pulling, `zues0077/lxserver` (tag `1.5.35`) appears in the image list. Click "**Create Container**" next to it.

---

## 4. Create the container (core, six steps)

Clicking "Create Container" opens a **step wizard** (some versions use one long form split into "Basic / Ports / Storage / Environment / Network / Confirm"). Below, every step shows "what to fill in".

### 4.1 Basic settings

| Field | Value |
| :--- | :--- |
| Container name | `lx-sync-server` (or `lxserver-verify`, your call) |
| Image | auto-filled `ghcr.nju.edu.cn/zues0077/lxserver:1.5.35` |
| Restart policy | **"Always"** —— ⚠️ mandatory! The panel "Restart Service" relies on it to bring the process back; omit it and one restart kills the service for good |
| Command / Args | leave empty (the image already has the start command) |

### 4.2 Port mapping

| Container port | Host port | Protocol | Note |
| :--- | :--- | :--- | :--- |
| `9527` | `17950` | TCP | Container port is always `9527`; host port is free, proxy / clients use `17950` |

> If you need a separate Subsonic port (set `SUBSONIC_PORT=4533`), also map `4533 → 4533`.

### 4.3 Storage (all four mounts are mandatory)

In the "**Storage / Mounts / Folders**" page, add each of the four lines below (left "container path" is fixed, right "host path" is your real NAS directory):

| Host path (example) | Container path | Permission | Purpose |
| :--- | :--- | :--- | :--- |
| `/vol1/1000/docker/lxserver/data` | `/server/data` | RW | **Mandatory**: config, users, logs, backups |
| `/vol1/1000/docker/lxserver/cache` | `/server/cache` | RW | Play cache |
| `/vol1/1000/docker/lxserver/music` | `/server/music` | RW | Download dir |
| `/vol1/1000/docker/lxserver/cover_cache` | `/server/cover_cache` | RW | Cover cache |

> ⚠️ **`cover_cache` is the easiest to miss**: it always writes to the container working directory and is **not affected by the "cache location" toggle** in the console. If you skip it, cover cache lands in the container writable layer and is lost on rebuild.
>
> If you switch "cache location" from `root` to `data` in the console, cache / downloads land in `/server/data/cache`, `/server/data/music`, and mounting only `data` is then enough; but `cover_cache` still needs its own mount.
>
> Logs default to `data/logs`; to drop logs into a separate host directory, also mount `./logs:/server/logs` and set `LOG_PATH=/server/logs` (not required here).

### 4.4 Environment variables

In the "**Environment / Env**" page, add (at minimum change the admin password):

| Variable | Example | Note |
| :--- | :--- | :--- |
| `ADMIN_PASSWORD` | `your-strong-password` | **Must change**: default is `123456` |
| `ENABLE_WEBPLAYER_AUTH` | `true` | Recommended on public networks |
| `WEBPLAYER_PASSWORD` | `player-password` | with the above |
| `TZ` | `Asia/Shanghai` | correct log timestamps |
| `EVENT_LOOP_WATCHDOG_TIMEOUT_MS` | `120000` | auto-restart on main-thread hang |
| `PROXY_HEADER` | `x-real-ip` | get real IP behind a proxy (see section 6) |
| `LOG_PATH` | `/server/logs` | only if you also mounted `./logs` |

### 4.5 Network / Restart policy

- Network: default "bridge" is fine.
- Restart policy: double-check it's **Always** (set in 4.1, verify here).

### 4.6 Confirm and create

- Scroll to the bottom and click "**Confirm / Create**".
- The container list shows `lx-sync-server`, status quickly becomes "Running / healthy".

---

## 5. Start and verify

fnOS has no `docker logs`, so **verify with `/health`**:

```
http://192.168.1.246:17950/health
```

- Returns a JSON (with source count, probe, guard status) = service is healthy.
- You can also open the player directly: `http://192.168.1.246:17950/`, console: `http://192.168.1.246:17950/admin` (password = your `ADMIN_PASSWORD`).

> First step in the console: re-check admin password and player auth under "System Settings", and confirm the restart policy took effect.

---

## 6. HTTPS via fnOS built-in reverse proxy

Not mandatory, but **strongly recommended on public networks** (hide port + HTTPS + real client IP). fnOS has a built-in "Reverse Proxy":

1. Open fnOS "**Reverse Proxy / Reverse Proxy Management**" (sometimes under Docker app or system settings).
2. Create a rule:
   - **Name**: lxserver
   - **Source (public)**: `https://music.example.com` (your domain, DNS must point to the NAS first)
   - **Upstream server**: `127.0.0.1` (or container IP), port = **host port** `17950`
   - **Protocol**: HTTP
   - **Enable WebSocket / long-connection support** (key! fnOS may call it "Enable WebSocket" or require manual `Upgrade`/`Connection` headers)
3. Certificate: apply Let's Encrypt or upload your own in fnOS "Certificate Management", bind it to this rule.
4. If using fnOS proxy, add `PROXY_HEADER=x-real-ip` to container env, and confirm the proxy sends `X-Real-IP`, so server logs / login IPs reflect the real source.

> For Nginx / Caddy config, mixed-content errors, and real-IP troubleshooting, see the main deployment page [2. Reverse Proxy & HTTPS](./deployment#二反向代理与-https重点).

---

## 7. Connect clients / players

- **Web player**: `http://192.168.1.246:17950/` (or proxy domain `https://music.example.com/`).
- **LX Music client**: Settings → Sync Settings → custom server, URL `http://192.168.1.246:17950/<username>` (user-path mode), password = user password.
- **Subsonic client** (Navidrome-like / Feishin): server address `http://192.168.1.246:17950/rest`, log in with a console-created user.

> Behind a proxy use the proxy domain; port/path rules match the main deployment page [Service Access & Client Connection](./getting-started#服务访问与客户端连接指引).

---

## Appendix A: Deploy via trim-cli (author's real path)

If you prefer CLI, the author actually deployed on 246 using **trim-cli** (fnOS's CLI), not the GUI. Key points:

1. **Login**: `%TEMP%\fnos-login\driver6.py` (246-specific driver); after the callback returns a token, trim-cli can operate.
2. **Session binding**: trim-cli has session protection — if the current session targets machine A you can't hit machine B (it errors `saved proxy session targets ...`). 246 maps to profile `nas246`, 120 to `home`; don't mix them.
3. **Pull image** (write ops need `--yes`):
   ```bash
   # In Git Bash, /vol1 paths MUST have MSYS_NO_PATHCONV=1, otherwise the path gets rewritten -> "Unsupported path"
   MSYS_NO_PATHCONV=1 docker image pull ghcr.nju.edu.cn/zues0077/lxserver:1.5.35 --yes
   ```
4. **Same tag pointing to a different digest** errors `errno 52428822` (image already exists). First `docker image rm --force <image>` or use a different tag, then pull. "Image is downloading" errors `52428818`; just wait.
5. **No `docker logs` / `docker exec` / `docker cp`**: verify only via `/health`; to rescue in-container data, copy from the writable layer `upperdir` directly (get `UpperDir` via `inspect` first).
6. **`file upload` does not overwrite same name** (saved as `_1`); `file mv` / `rm` first; `file mv` target must be a directory path.

> This path is the author's real 246 practice, for users already comfortable with trim-cli. Newcomers should use the GUI six steps above.

---

## Appendix B: fnOS common errno reference

| errno | Meaning / Fix |
| :--- | :--- |
| `52428816` / `52429058` | `composeBuild` / `imageUpgrade` unsupported on this firmware → use `docker container` / `docker image pull` manual flow |
| `52428818` | Image is downloading → wait a moment then re-check |
| `52428822` | Image already exists (same tag, different digest) → `docker image rm --force` first or use another tag |

---

## Troubleshooting

| Symptom | Cause / Fix |
| :--- | :--- |
| Container stuck "starting" or restart loops | Check `/health`; usually `data` volume missing or not writable. Confirm all four mounts in 4.3 and that the fnOS account can RW the dirs |
| Covers lost / cache missing | `cover_cache` not mounted → add the 4th mount in 4.3 and restart (old data lost, re-cache needed) |
| "Restart Service" in console never comes back | Restart policy not "Always" → recreate container with Always, or re-run |
| All IPs are 127.0.0.1 behind proxy | No `PROXY_HEADER` → set `PROXY_HEADER=x-real-ip` per 4.4 / section 6 |
| Browser "mixed content" blocks audio | Player is https but resources are http → route everything through the proxy (section 6) to make it same-origin |
| Pull image times out | Switch to `ghcr.nju.edu.cn`, or add it to fnOS accelerator |

> Full deployment troubleshooting table: main deployment page [7. Deployment Troubleshooting](./deployment#七部署排错). Data / backup issues: [Data Backup & Migration](./backup-migration).
