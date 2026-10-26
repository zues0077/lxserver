# 部署、反代与 HTTPS 实战

> 本页是 [快速开始](./getting-started) 的**延伸**：前者讲「怎么把服务跑起来」，本页讲「怎么跑得稳、跑得安全、跑在公网」——反向代理 + HTTPS、拿到真实客户端 IP、安全加固、生产级 Compose、升级回滚、NAS / 小主机实战，以及部署排错。
> 基础的环境变量全集见 [应用设置与配置规则](./app-settings)，高频踩坑见 [常见问题与排错](./faq)。

<DeploymentChecklist lang="zh" />

---

## 目录

- [一、部署形态速选](#一、部署形态速选)
- [二、反向代理与 HTTPS（重点）](#二、反向代理与-https-重点)
- [三、安全加固清单](#三、安全加固清单)
- [四、生产级 docker-compose](#四、生产级-docker-compose)
- [五、升级与回滚](#五、升级与回滚)
- [六、NAS / 小主机实战提示](#六、nas-小主机实战提示)
- [七、部署排错](#七、部署排错)

---

## 一、部署形态速选

| 形态 | 适用 | 说明 |
| :--- | :--- | :--- |
| **Docker 容器** | 生产 / 长期运行 | 推荐。镜像发布在 GHCR，支持按版本号固定与回滚 |
| **桌面客户端** | 个人单机 | 自带服务 + 播放器，托盘常驻，零部署 |
| **源码运行** | 二次开发 | `npm ci && npm run build && npm start`，建议用 `pm2` 托管 |

Docker 的 `docker run` / 基础 `docker-compose` 写法、四目录挂载含义、Web / 后台 / 客户端 / Subsonic 的访问地址，**已在 [快速开始](./getting-started) 写完**，本页不再重复，直接往下看进阶部分。

---

## 二、反向代理与 HTTPS（重点）

### 2.1 为什么要在前面架一层反代

- **HTTPS 加密**：避免播放器页面用 https 打开时，音频 / 封面资源走 http 触发「混合内容」被浏览器拦截。
- **隐藏端口**：不把 `9527` 直接暴露在公网，只对外开 `80/443`。
- **统一证书与续期**：证书在反代层集中管理。
- **取真实客户端 IP**：配合 `PROXY_HEADER` 让服务端看到真实来源（见 2.5）。

> 注意：lxserver 自身的 `9527` 仍要对**本机 / 内网**可达（反代与客户端不在同一台时，防火墙只放行反代所在机器的来源）。

### 2.2 Nginx + Let's Encrypt（certbot）

下面是「HTTP 80 仅做 ACME 校验 + 301 跳转 HTTPS + 443 反代」的完整可抄配置。把 `music.example.com` 换成你的域名。

```nginx
# 80：ACME 校验 + 全部跳 HTTPS
server {
    listen 80;
    server_name music.example.com;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://$host$request_uri; }
}

# 443：反代到 lxserver
server {
    listen 443 ssl;
    server_name music.example.com;

    ssl_certificate     /etc/letsencrypt/live/music.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/music.example.com/privkey.pem;
    # 可选：开启 HSTS
    # add_header Strict-Transport-Security "max-age=31536000" always;

    client_max_body_size 50m;          # 上传自定义音源脚本可能较大
    proxy_read_timeout 300s;           # 下载 / 长轮询别被早早掐断
    proxy_send_timeout 300s;

    location / {
        proxy_pass http://127.0.0.1:9527;

        # 透传客户端信息（取真实 IP 用 2.5）
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket / SSE 升级（同步通道需要）
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

申请证书（certbot，以 Debian/Ubuntu 为例）：

```bash
sudo apt install certbot
sudo certbot certonly --webroot -w /var/www/certbot -d music.example.com
# 自动续期已在 certbot 安装时写入 systemd timer；改配置后 nginx -s reload
```

> 所有路径（`/`、`/admin`、`/api/*`、`/rest` Subsonic、`/health`）都走上面这个 `location /`，**无需为子路径单独开转发**。

### 2.3 Caddy（自动 HTTPS，最简）

Caddy 会自动申请并续期证书，配置量最小：

```caddyfile
music.example.com {
    reverse_proxy 127.0.0.1:9527
    # Caddy 默认已带 WebSocket 透传、X-Forwarded-* 头、自动 HTTPS
}
```

适合不想手管 certbot 的场景。

### 2.4 NAS / 群晖 / fnOS 内置反代

群晖（SRM）、威联通、fnOS 等 NAS 系统大多自带「反向代理」图形界面：

- **上游服务器**：`127.0.0.1`（或容器 IP），端口 `9527`
- **协议**：HTTP
- **务必开启 WebSocket / 长连接支持**（不同系统叫法不同，有的叫「启用 WebSocket」、有的要手动加 `Upgrade`/`Connection` 头）
- 证书在该 NAS 的反代 / 证书管理里配置（通常支持 Let's Encrypt 或自有证书）

本质与 Nginx 反代一致，只是不用手敲配置。

### 2.5 拿到真实客户端 IP

默认情况下，Node 看到的请求来源是反代地址（`127.0.0.1`），于是 `/health` 的访问审计、登录 IP 记录都会失真。要让服务端读真实 IP：

1. 反代侧已发出 `X-Real-IP` 或 `X-Forwarded-For`（2.2 / 2.3 已含）。
2. lxserver 侧设置环境变量告诉它从哪个头取：

```yaml
environment:
  # 与反代发出的头对应：用 X-Real-IP 就填 x-real-ip；用 X-Forwarded-For 就填 x-forwarded-for
  - PROXY_HEADER=x-real-ip
```

`Dockerfile` 里该项的默认示例即 `ENV PROXY_HEADER 'x-real-ip'`。设好后，服务端取到的就是客户端公网 IP。

---

## 三、安全加固清单

| 项 | 做法 | 环境变量 / 位置 |
| :--- | :--- | :--- |
| **改管理员默认密码** | 出厂默认 `123456`，必须改 | `ADMIN_PASSWORD=你的强密码` |
| **播放器加访问密码** | 默认免密，公网建议开启 | `ENABLE_WEBPLAYER_AUTH=true` + `WEBPLAYER_PASSWORD=...` |
| **预建用户并设强密码** | 用环境变量在首次启动即创建账号 | `LX_USER_用户名=密码` 或 JSON 形式 `LX_USER_u1={"password":"强密码","maxSnapshotNum":10}` |
| **别直曝 9527** | 只让反代可达，公网只开 `80/443` | 防火墙 / 安全组 |
| **定期备份** | 备份 `data` 卷（含 `config.js`、用户、歌单、日志） | 见 [应用设置](./app-settings) |

> 后台管理员路径与播放器路径可在 `data/config.js` 里改（`admin.path` 默认 `/admin`，`player.path` 默认 `/`），进一步降低被扫风险。

---

## 四、生产级 docker-compose

在 [快速开始](./getting-started) 的基础上，生产环境建议补上**重启策略、健康检查、时区、可选独立日志**：

```yaml
services:
  lx-sync-server:
    image: ghcr.io/zues0077/lxserver:1.5.35   # 生产固定版本，别用 latest
    container_name: lx-sync-server
    restart: always                            # 面板「重启服务」靠它拉起，绝不能省
    ports:
      - "9527:9527"
      # - "4533:4533"                         # 仅当设了 SUBSONIC_PORT 才需要
    volumes:
      - ./data:/server/data                    # 必须：配置/用户/日志/备份
      - ./cache:/server/cache                  # 播放缓存
      - ./music:/server/music                  # 下载目录
      - ./cover_cache:/server/cover_cache      # 封面缓存（恒定写工作目录，需单独挂）
      # - ./logs:/server/logs                  # 可选：独立日志（需配 LOG_PATH）
    environment:
      - NODE_ENV=production
      - TZ=Asia/Shanghai                       # 日志时间正确
      - EVENT_LOOP_WATCHDOG_TIMEOUT_MS=120000  # 主线程卡死自动重启
      - ADMIN_PASSWORD=改成强密码
      - ENABLE_WEBPLAYER_AUTH=true
      - WEBPLAYER_PASSWORD=播放器密码
      # - LOG_PATH=/server/logs                # 仅当挂了 ./logs 时启用
      # - PROXY_HEADER=x-real-ip              # 放在反代后时启用（见 2.5）
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:9527/health',{signal:AbortSignal.timeout(10000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 60s
      timeout: 15s
      retries: 3
      start_period: 40s
```

四目录挂载（`data` / `cache` / `music` / `cover_cache`）缺一不可，否则对应数据会写进容器可写层、重建即丢；`cover_cache` 尤其容易漏——它**恒定写在容器工作目录**，不受后台「缓存位置」开关影响。`logs` 是可选挂载（默认日志已在 `data/logs`，单独挂需配 `LOG_PATH`）。

---

## 五、升级与回滚

**升级（推荐用 Compose）：**

```bash
# 改 image 标签到新版本后
docker compose pull lx-sync-server
docker compose up -d lx-sync-server
```

**回滚：** 因为镜像按版本号保留，把 `image` 改回旧版本号（如 `:1.5.34`）再 `docker compose up -d` 即可。

> 强烈建议 `image` 写**具体版本号**而非 `latest`：升级前备份 `./data`，出问题直接改标签回滚，数据卷不受影响。

---

## 六、NAS / 小主机实战提示

- **镜像拉取慢**：GHCR 在部分网络拉取慢，可换用镜像源（如国内教育网 / 公益镜像）后再 `docker tag` 成本仓库格式；NAS 上通常也能直接填镜像加速器地址。
- **端口映射**：宿主端口可换成高位（例如 `17950:9527`），只要反代 / 客户端填对应宿主端口即可，容器内部始终是 `9527`。
- **卷放共享目录**：把 `./data` 等挂到 NAS 的共享文件夹（如 `/volume1/docker/lxserver/`），方便在文件管理器里直接备份。
- **用 NAS 自带反代**：见 2.4，上游填容器 IP + `9527`，开启 WebSocket 支持。
- **时间**：容器默认 UTC，设 `TZ` 让日志时间戳符合本地时区，排错更直观。

---

## 七、部署排错

| 现象 | 原因 / 解决 |
| :--- | :--- |
| 点后台「重启服务」后服务再也起不来 | `--restart` 策略漏写。容器里重启是结束进程、靠重启策略拉起；补 `restart: always`（或 `unless-stopped`）后重跑 |
| 升级后封面全丢 / 缓存不在 | `cover_cache` 没挂，数据写进了可写层。补挂载并重启（旧数据已丢，需重新缓存） |
| 反代后所有访问 IP 都是 `127.0.0.1` | 没设 `PROXY_HEADER`。按 2.5 配 `PROXY_HEADER=x-real-ip` 并确认反代发了对应头 |
| 浏览器报「混合内容」拦截音频 | 播放器页是 https，但资源走 http。统一走反代（本页方案）后同源即解决 |
| `/health` 返回异常 / 容器反复重启 | 看日志（默认 `data/logs/app.log`，或挂了 `./logs` 后看宿主 `./logs`）。先确认 `data` 卷已挂、权限可写 |
| 客户端连不上 | 确认反代 `location /` 转发了 `/api/*`；若改过 `admin.path` / `player.path` 需同步调整连接 URL |

健康检查端点：`http://<host>:9527/health`（返回 JSON，含音源数、巡检、护栏状态）。`data/logs/app.log` 是首选排错入口。
