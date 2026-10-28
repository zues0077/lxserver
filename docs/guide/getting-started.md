# 快速启动部署指南

欢迎使用 LX Music 数据同步与 Web 播放中枢服务。该平台提供私有化云端数据同步集成方案，并随附功能齐备的在线媒体高品质流播放能力。

## 基础设施依赖

在启动本服务项目前，请确保承载该实例的主机系统（或虚拟机、容器化设施）符合以下最低先决条件：

**直接基于源码运行：**

- **Node.js**: `v20.x` 或更高版本（生产环境推荐采用 `v20.x` / `v22.x` 的长期支持 LTS 版本）。
- **网络资源**: 确保业务所需的监听端口（默认配置为 `9527`）已在主机防火墙策略及云服务商安全组规则中正确放行入口流量。

**基于容器化设施运行（生产首选）：**

- `Docker Engine` 引擎运行时。
- `Docker Compose`（当涉及声明式服务编排时必需）。

---

## 部署执行方案与最佳实践

### 方案一：使用桌面客户端

对于桌面用户，我们强烈推荐使用基于 Electron 的**桌面客户端**。它集成了服务器管理与播放器，且具备系统托盘常驻功能。

1. **前往下载**: [GitHub Releases](https://github.com/zues0077/lxserver/releases/latest)
2. **选择版本**:
   - **Windows**: 下载 `Universal.exe` (全架构合一) 或 `portable.exe` (绿色版)。
   - **macOS**: 下载 `universal.dmg` (支持 Intel/M1/M2)。
   - **Linux**: 提供 `.deb` (Debian/Ubuntu) 和 `.AppImage` 格式。
3. **初始化**: 首次运行将引导你选择数据存储位置，随后服务将自动在后台启动并在系统托盘可见。

### 方案二：基于 Docker 引擎的容器化部署

镜像发布到 **GitHub Packages（GHCR）**，**每次更新都会打上版本号标签**，便于固定版本与回滚：

| 标签 | 说明 |
| :--- | :--- |
| `latest` | 最新稳定版，跟随 `main` 分支 |
| `v1.5.43` / `1.5.43` | 当前版本（与 `package.json` 的 `version` 一致），**生产环境建议固定到具体版本** |
| `v*` | 每个已发布版本都会保留，可随时回滚到历史版本 |

```bash
# 固定版本（推荐）
docker pull ghcr.io/zues0077/lxserver:1.5.43

# 或跟随最新
docker pull ghcr.io/zues0077/lxserver:latest
```

执行以下指令启动容器：

```bash
docker run -d \
  -p 9527:9527 \
  -v $(pwd)/data:/server/data \
  -v $(pwd)/cache:/server/cache \
  -v $(pwd)/music:/server/music \
  -v $(pwd)/cover_cache:/server/cover_cache \
  --name lx-sync-server \
  --restart unless-stopped \
  ghcr.io/zues0077/lxserver:1.5.43
```

> ⚠️ `--restart` 不要省略：面板的「重启服务」（`POST /api/restart`）在容器内是结束进程实现的，靠容器重启策略拉起；漏写则点一次重启服务就彻底停了。

**容器挂载卷 (Volume Mappings) ：**

- `-v $(pwd)/data:/server/data`：**必须挂载**。存放配置（`data/config.js`）、用户数据、日志（`data/logs`）与备份。
- `-v $(pwd)/cache:/server/cache`：**建议挂载**。播放缓存。默认缓存位置为 `root`，缓存实际写在容器内的 `/server/cache/<用户名>`。
- `-v $(pwd)/music:/server/music`：**建议挂载**。下载目录。点「下载」或「移入下载目录」后，文件会从缓存目录移到这里，即容器内的 `/server/music/<用户名>`。
- `-v $(pwd)/cover_cache:/server/cover_cache`：**建议挂载**。歌曲封面缓存。它**恒定写在容器工作目录下，不受面板「缓存位置」开关影响**（切到 `data` 模式也一样），因此无法跟着上面的开关一起省掉，需要单独挂载。
- 若**不**挂 `cache` / `music`，这两类文件会写进容器的可写层 —— 宿主目录里看不到，容器重建即丢失。另一种做法是在面板把「缓存位置」由 `root` 切换为 `data`，缓存与下载会改为落在 `/server/data/cache/<用户名>`、`/server/data/music/<用户名>`，此时这两个目录只挂 `data` 即可；代价是这部分数据会纳入数据同步，数据卷体积会明显变大。注意该开关**不影响 `cover_cache`**。
- **关于 `./logs`**：镜像默认 `LOG_PATH=/server/data/logs`，日志本来就写在 `data` 卷里，所以单独挂 `./logs:/server/logs` 是个**空挂载**（上游默认行为也是如此）。想让日志落到宿主的 `./logs`，需要同时设置环境变量 `LOG_PATH=/server/logs`。

**声明式 Docker Compose ：**
针对需标准化长久管理的生产实施，创建名为 `docker-compose.yml` 的定义配置：

```yaml
services:
  lx-sync-server:
    image: ghcr.io/zues0077/lxserver:1.5.43   # 或 :latest
    container_name: lx-sync-server
    restart: unless-stopped      # 不要省：面板「重启服务」靠它把进程拉起来
    ports:
      - "9527:9527"
      # - "4533:4533"            # 仅当设置了 SUBSONIC_PORT（如 4533）时才需要
    volumes:
      - ./data:/server/data
      # 默认 root 缓存模式下必须一并挂载，否则缓存/下载会留在容器可写层
      - ./cache:/server/cache
      - ./music:/server/music
      # 封面缓存恒定写在容器工作目录，不受「缓存位置」开关影响，需单独挂载
      - ./cover_cache:/server/cover_cache
    environment:
      - NODE_ENV=production
      # - ADMIN_PASSWORD=123456
      # - ENABLE_WEBPLAYER_AUTH=true
      # - WEBPLAYER_PASSWORD=yourpassword
      # - LOG_PATH=/server/logs   # 仅当额外挂载了 ./logs:/server/logs 时才需要
```

配置审查无误后，通过指令 `docker-compose up -d` 启动基础架构实例集。

### 方案二：基于物理环境的源码编译部署

针对受限非容器化环境或二次研发拓展场景，需于操作系统直接组装并拉起进程：

```bash
# 1. 由远端代码仓库提取代码的 Main 主线状态至当前目录
git clone https://github.com/zues0077/lxserver.git 
cd lxserver

# 2. 调用严格解析流程初始化模块依赖库
npm ci 

# 3. 对 TypeScript 类型及 Vue DOM 模板进行预编译聚合处理
npm run build

# 4. 执行基于内置调度器的生产节点启动命令
npm start
```

*工程实践提示：在无人值守的服务器环境中执行原生应用托管，建议引入譬如 `pm2` 的进程级调度与重启控制系统：`pm2 start npm --name "lxserver" -- start`。*

---

## 负载前置与 Nginx 反向代理接入策略

在暴露至公网的主流程节点前，强烈建议接驳成熟的 Web 守护网关实例。此举旨在安全地应用 SSL 加密以及隐藏内部分发端口特性。

以下为适配系统 WebSocket 双工链接机制及追踪用户源端 IP Header 解析的标准化 Nginx 反派配置参考示例（承接通配 `80 / 443` 端向本服务 `9527` 进行流量穿网与隧道接管转发）：

```nginx
server {
    listen 80;
    server_name music.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:9527;
  
        # 定义 Header 头传递策略以确保 Node 层可取到客户端外网层 IP
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  
        # 补全长连接升级特性定义（对内部的同步通信套接字服务必要条件）
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

---

## 服务访问与客户端连接指引

在服务实例启动后，您可以通过以下方式访问 Web 端或配置客户端连接：

### 1. Web 界面访问
| 模块标识 | 访问地址 | 认证要求 | 说明 |
| :--- | :--- | :--- | :--- |
| **Web 播放器** | `http://<服务器IP>:9527/` | 默认免密（可配置 `ENABLE_WEBPLAYER_AUTH` 开启） | 现代化的在线音乐播放器，支持多源搜索与串流。 |
| **管理后台** | `http://<服务器IP>:9527/admin` | 管理员密码（默认 `123456`） | 用户管理、歌单与快照管理、WebDAV 备份配置及系统参数设置。 |

### 2. LX Music 客户端同步（桌面端 / 移动端）
在客户端「设置 → 同步设置」中选择自定义服务器连接：
- **用户路径模式（推荐，默认开启）**：连接 URL 填写 `http://<服务器IP>:9527/<用户名>`（例如 `http://192.168.1.100:9527/user1`），密码填写用户密码。**此模式允许多用户密码相同**。
- **根路径模式（需开启 `USER_ENABLE_ROOT`）**：连接 URL 填写 `http://<服务器IP>:9527`，密码填写用户密码。**此模式要求所有用户密码必须唯一**。

### 3. Subsonic 音乐客户端连接
- **服务器地址**：`http://<服务器IP>:9527/rest`（若配置了 `SUBSONIC_PORT` 独立端口，则为 `http://<服务器IP>:<端口>/rest`）。
- **认证方式**：使用在管理后台创建的用户账号和密码登录。

有关在实例化生命周期早期实现底层变量的静默导入、以及配置层级重写的更多前序细节知识，请移步浏览查阅《[配置引擎及环境变量注入指南](./configuration.md)》。
