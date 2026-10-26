# Deployment, Reverse Proxy & HTTPS in Practice

> This page **extends** [Getting Started](./getting-started): that one covers "how to get the service running"; this one covers "how to run it stably, securely, and on the public internet" — reverse proxy + HTTPS, obtaining the real client IP, security hardening, a production-grade Compose file, upgrades/rollbacks, NAS / mini-server tips, and deployment troubleshooting.
> The full environment-variable reference lives in [App Settings & Rules](./app-settings); frequent gotchas are in [FAQ & Troubleshooting](./faq).

<DeploymentChecklist lang="en" />

---

## Table of Contents

- [1. Pick a Deployment Shape](#_1-pick-a-deployment-shape)
- [2. Reverse Proxy & HTTPS (the core)](#_2-reverse-proxy-https-the-core)
- [3. Security Hardening Checklist](#_3-security-hardening-checklist)
- [4. Production-grade docker-compose](#_4-production-grade-docker-compose)
- [5. Upgrade & Rollback](#_5-upgrade-rollback)
- [6. NAS / Mini-server Tips](#_6-nas-mini-server-tips)
- [7. Deployment Troubleshooting](#_7-deployment-troubleshooting)

---

## 1. Pick a Deployment Shape

| Shape | For | Notes |
| :--- | :--- | :--- |
| **Docker container** | Production / long-running | Recommended. Images are on GHCR, pinned by version for easy rollback |
| **Desktop client** | Personal single machine | Bundles server + player, tray-resident, zero setup |
| **From source** | Secondary development | `npm ci && npm run build && npm start`; use `pm2` to keep it alive |

The `docker run` / basic `docker-compose` snippets, the four volume mounts, and the Web / Admin / client / Subsonic access addresses are all **already written in [Getting Started](./getting-started)** — this page does not repeat them; read on for the advanced parts.

---

## 2. Reverse Proxy & HTTPS (the core)

### 2.1 Why put a proxy in front

- **HTTPS encryption**: prevents the player page (loaded over https) from being blocked by the browser for "mixed content" when audio / cover art is fetched over http.
- **Hide the port**: don't expose `9527` directly to the internet; only open `80/443` outward.
- **Centralized certificates**: certs are managed at the proxy layer.
- **Real client IP**: combined with `PROXY_HEADER` so the server sees the true source (see 2.5).

> Note: lxserver's own `9527` must still be reachable from **localhost / the LAN** (when proxy and client are not on the same host, the firewall only needs to allow the proxy's source).

### 2.2 Nginx + Let's Encrypt (certbot)

Below is a complete copy-paste config: "80 does ACME challenge + 301 redirect to HTTPS; 443 proxies to lxserver". Replace `music.example.com` with your domain.

```nginx
# 80: ACME challenge + redirect everything to HTTPS
server {
    listen 80;
    server_name music.example.com;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://$host$request_uri; }
}

# 443: proxy to lxserver
server {
    listen 443 ssl;
    server_name music.example.com;

    ssl_certificate     /etc/letsencrypt/live/music.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/music.example.com/privkey.pem;
    # optional: enable HSTS
    # add_header Strict-Transport-Security "max-age=31536000" always;

    client_max_body_size 50m;          # custom source scripts can be large
    proxy_read_timeout 300s;           # don't cut off downloads / long polling
    proxy_send_timeout 300s;

    location / {
        proxy_pass http://127.0.0.1:9527;

        # pass client info through (real IP via 2.5)
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket / SSE upgrade (sync channel needs it)
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

Issue the certificate (certbot, Debian/Ubuntu example):

```bash
sudo apt install certbot
sudo certbot certonly --webroot -w /var/www/certbot -d music.example.com
# auto-renew is already wired into a systemd timer at install; nginx -s reload after config changes
```

> All paths (`/`, `/admin`, `/api/*`, `/rest` for Subsonic, `/health`) go through this single `location /` — **no separate forwarding needed for sub-paths**.

### 2.3 Caddy (automatic HTTPS, simplest)

Caddy auto-issues and renews certificates with minimal config:

```caddyfile
music.example.com {
    reverse_proxy 127.0.0.1:9527
    # Caddy already handles WebSocket passthrough, X-Forwarded-* headers, and automatic HTTPS
}
```

Great when you don't want to hand-manage certbot.

### 2.4 NAS / Synology / fnOS built-in proxy

Synology (SRM), QNAP, fnOS and similar NAS systems usually ship a graphical "reverse proxy":

- **Upstream server**: `127.0.0.1` (or the container IP), port `9527`
- **Protocol**: HTTP
- **Enable WebSocket / long-connection support** (naming differs; some call it "Enable WebSocket", others require manually adding `Upgrade`/`Connection` headers)
- Certificates are configured in the NAS's proxy / certificate manager (often supports Let's Encrypt or your own cert)

It is functionally identical to the Nginx proxy — just without hand-writing the config.

### 2.5 Obtaining the real client IP

By default Node sees the proxy's address (`127.0.0.1`), so `/health` audits and login IP records are wrong. To make the server read the real IP:

1. The proxy already emits `X-Real-IP` or `X-Forwarded-For` (included in 2.2 / 2.3).
2. Tell lxserver which header to read via an environment variable:

```yaml
environment:
  # match the header the proxy sends: x-real-ip for X-Real-IP, x-forwarded-for for X-Forwarded-For
  - PROXY_HEADER=x-real-ip
```

The `Dockerfile`'s default example for this is `ENV PROXY_HEADER 'x-real-ip'`. Once set, the server sees the client's public IP.

---

## 3. Security Hardening Checklist

| Item | How | Env var / location |
| :--- | :--- | :--- |
| **Change the default admin password** | Factory default is `123456` — change it | `ADMIN_PASSWORD=your-strong-password` |
| **Password-protect the player** | Off by default; enable on public networks | `ENABLE_WEBPLAYER_AUTH=true` + `WEBPLAYER_PASSWORD=...` |
| **Pre-create users with strong passwords** | Create accounts at first boot | `LX_USER_username=password` or JSON `LX_USER_u1={"password":"strong","maxSnapshotNum":10}` |
| **Don't expose 9527 directly** | Only the proxy should reach it; open `80/443` publicly | Firewall / security group |
| **Back up regularly** | Back up the `data` volume (config.js, users, playlists, logs) | see [App Settings](./app-settings) |

> The admin path and player path can be changed in `data/config.js` (`admin.path` defaults to `/admin`, `player.path` defaults to `/`) to further reduce scan risk.

---

## 4. Production-grade docker-compose

On top of [Getting Started](./getting-started), production should add the **restart policy, healthcheck, timezone, and optional standalone logs**:

```yaml
services:
  lx-sync-server:
    image: ghcr.io/zues0077/lxserver:1.5.35   # pin a version in prod, not latest
    container_name: lx-sync-server
    restart: always                            # "Restart Service" in the UI relies on this; never omit
    ports:
      - "9527:9527"
      # - "4533:4533"                         # only if SUBSONIC_PORT is set
    volumes:
      - ./data:/server/data                    # required: config/users/logs/backups
      - ./cache:/server/cache                  # play cache
      - ./music:/server/music                  # download dir
      - ./cover_cache:/server/cover_cache      # cover cache (always in workdir, mount separately)
      # - ./logs:/server/logs                  # optional: standalone logs (needs LOG_PATH)
    environment:
      - NODE_ENV=production
      - TZ=Asia/Shanghai                       # correct log timestamps
      - EVENT_LOOP_WATCHDOG_TIMEOUT_MS=120000  # auto-restart on main-thread hang
      - ADMIN_PASSWORD=change-me
      - ENABLE_WEBPLAYER_AUTH=true
      - WEBPLAYER_PASSWORD=player-password
      # - LOG_PATH=/server/logs                # only with the ./logs mount
      # - PROXY_HEADER=x-real-ip              # enable behind a proxy (see 2.5)
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:9527/health',{signal:AbortSignal.timeout(10000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 60s
      timeout: 15s
      retries: 3
      start_period: 40s
```

All four mounts (`data` / `cache` / `music` / `cover_cache`) are required — otherwise that data lands in the container's writable layer and is lost on rebuild; `cover_cache` is the easy one to miss because it is **always written to the container workdir** and is unaffected by the "cache location" toggle in the UI. `logs` is optional (logs already live in `data/logs`; a separate mount needs `LOG_PATH`).

---

## 5. Upgrade & Rollback

**Upgrade (prefer Compose):**

```bash
# after changing the image tag to the new version
docker compose pull lx-sync-server
docker compose up -d lx-sync-server
```

**Rollback:** images are retained per version, so just set `image` back to the old tag (e.g. `:1.5.34`) and `docker compose up -d` again.

> Strongly recommend writing a **specific version** in `image` rather than `latest`: back up `./data` before upgrading, and on problems just change the tag to roll back — the data volume is untouched.

---

## 6. NAS / Mini-server Tips

- **Slow image pulls**: GHCR can be slow on some networks; use a mirror (e.g. an educational / public mirror) then `docker tag` it into the expected format, or configure the NAS's image accelerator address.
- **Port mapping**: the host port can be a high port (e.g. `17950:9527`); just point the proxy / client at the host port — inside the container it is always `9527`.
- **Volumes on a share**: mount `./data` etc. to a NAS shared folder (e.g. `/volume1/docker/lxserver/`) so you can back it up straight from the file manager.
- **Use the NAS's built-in proxy**: see 2.4, upstream = container IP + `9527`, enable WebSocket support.
- **Timezone**: the container defaults to UTC; set `TZ` so log timestamps match local time and troubleshooting is clearer.

---

## 7. Deployment Troubleshooting

| Symptom | Cause / Fix |
| :--- | :--- |
| Clicking "Restart Service" in the UI kills the service permanently | `--restart` policy omitted. The in-container restart ends the process and relies on the restart policy; add `restart: always` (or `unless-stopped`) and re-run |
| Covers gone / cache missing after upgrade | `cover_cache` wasn't mounted, data went to the writable layer. Add the mount and restart (old data is lost, re-cache needed) |
| All access IPs are `127.0.0.1` behind a proxy | `PROXY_HEADER` not set. Configure `PROXY_HEADER=x-real-ip` per 2.5 and confirm the proxy sends the matching header |
| Browser blocks audio as "mixed content" | Player page is https but resources load over http. Route everything through the proxy (this page's setup) so it is same-origin |
| `/health` abnormal / container keeps restarting | Check logs (default `data/logs/app.log`, or host `./logs` if mounted). First confirm `data` is mounted and writable |
| Client can't connect | Confirm the proxy's `location /` forwards `/api/*`; if you changed `admin.path` / `player.path`, update the connection URL accordingly |

Health endpoint: `http://<host>:9527/health` (returns JSON with source count, probe, and guard status). `data/logs/app.log` is the first place to look when debugging.
