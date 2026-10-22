# lxserver · LX Music 数据同步服务端（增强版）

![lxserver](https://socialify.git.ci/zues0077/lxserver/image?description=1&forks=0&issues=0&logo=https://raw.githubusercontent.com/zues0077/lxserver/refs/heads/main/public/icon.svg&owner=1&pulls=0&stargazers=0&theme=Auto)

<div align="center">
  <!-- <img src="public/icon.svg" width="120" height="120" alt="Icon"> -->
  <!-- <br>
  <h1>LX Sync Server</h1> -->
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

[帮助文档 Documentation](https://zues0077.github.io/lxserver/) | [同步服务器 SyncServer](md/lxserver.md) | [更新日志 Changelog](changelog.md) | [English](README_EN.md)

---

**lxserver** 把一个单纯的数据同步中转站，扩展成了开箱即用的私人云音乐平台：内置功能完整的 **Web 播放器**、面向多用户的 **同步与权限体系**，以及围绕 **自定义音源** 的稳定性治理（脚本自检护栏 + 平台可用性巡检）。无需额外客户端，浏览器打开即可听歌、管理歌单、连接 Subsonic 客户端。

> 本项目基于 [xcq0607/lxserver](https://github.com/xcq0607/lxserver) 二次开发，其上游为 [lyswhut/lx-music-sync-server](https://github.com/lyswhut/lx-music-sync-server)。感谢原作者的工作，本项目以 Apache-2.0 协议继续开源。

## 📖 目录

- [核心特性](#-核心特性)
- [相对上游的主要增强](#-相对上游的主要增强)
- [Docker 部署](#-docker-部署)
- [访问控制与安全](#-访问控制与安全)
- [移动端适配](#-移动端适配)
- [快速启动](#-快速启动)
- [服务连接与客户端配置](#-服务连接与客户端配置)
- [项目架构](#️-项目架构)
- [配置说明](#️-配置说明)
- [数据收集与隐私说明](#️-数据收集与隐私说明)
- [贡献与致谢](#-贡献与致谢)
- [开源协议](#-开源协议)

## ✨ 核心特性

### 1. 现代化界面与全能播放控制

采用清新现代的响应式 UI 设计，支持深浅色模式切换与沉浸式全屏歌词；底栏集成音质切换、倍速播放、睡眠定时等完整控制。

<p align="center">
  <img src="md/player.png" width="800" alt="Web 播放器主界面">
</p>
<p align="center">
  <img src="md/controller.png" width="800" alt="播放控制栏">
</p>

### 2. 多源聚合搜索与歌手专辑

聚合各大音乐平台在线资源，秒级检索歌曲、歌手与完整专辑，支持一键收藏与作品快速回溯。

<p align="center">
  <img src="md/search.png" width="800" alt="多源搜索">
</p>
<p align="center">
  <img src="md/album.png" width="400" alt="专辑展示">
  <img src="md/singer.png" width="400" alt="歌手展示">
</p>

### 3. 多平台歌单与播放队列管理

支持同步浏览多平台热门网络歌单与详情；右侧便捷抽屉面板支持播放队列拖拽排序及自动化本地缓存管理。

<p align="center">
  <img src="md/musiclist.png" width="400" alt="歌单广场">
  <img src="md/musiclist-detail.png" width="400" alt="歌单详情">
</p>
<p align="center">
  <img src="md/playlist.png" width="280" alt="播放队列抽屉">
  <img src="md/cache.png" width="280" alt="缓存管理抽屉">
</p>

### 4. 本地音乐库与共享收藏

统一管理服务器本地存储、下载及缓存的音频文件，支持无损规格解析、布尔逻辑搜索（`&`、`|`、`!`）、状态查漏与批量操作；支持开启多用户公共共享曲库。

<p align="center">
  <img src="md/localmusic.png" width="800" alt="本地音乐库与高级检索">
</p>
<p align="center">
  <img src="md/favorite.png" width="800" alt="收藏与共享曲库">
</p>

### 5. 个性化主题、歌词卡片与自定义源

提供多套精美色彩主题与暗亮模式切换；支持一键生成多比例高清歌词分享卡片；支持导入自定义音源脚本扩展无限可能。

<p align="center">
  <img src="md/theme.png" width="400" alt="多套色彩主题">
  <img src="md/settings.png" width="400" alt="全方位系统配置">
</p>
<p align="center">
  <img src="md/share.png" width="380" alt="歌词卡片社交分享">
  <img src="md/source.png" width="420" alt="自定义源管理">
</p>

### 6. Subsonic 协议与多端互联

全面兼容 Subsonic API 协议，支持使用各类第三方客户端（音流、Feishin 等）连接播放，支持客户端内全网在线搜索与本地资源检索。

<p align="center">
  <img src="md/subsonic.png" width="500" alt="Subsonic 客户端连接">
  <img src="md/subsonic-search.png" width="300" alt="Subsonic 在线全网搜索">
</p>

### 7. 小爱音箱投播（新增）

把 Web 播放器正在播放的歌曲直接投送到小爱音箱，支持**多台设备同时播放**。

- 登录方式：**扫码登录**（米家 App 扫码，免密码）/ 小米账号密码 / 浏览器 Cookie
- 设备选择：登录后自动拉取账号下的小爱音箱，「播放目标」可一键切到小爱
- 播放控制：播放、暂停、上下首、音量、停止，全部可在播放器内完成；暂停会自动校验设备状态，机型不执行时降级为停止并提示
- **触屏封面歌词**：带屏音箱按歌名到小米曲库匹配 `audioID`，显示对应封面与歌词（可关闭）
- **服务地址自动探测**：自动给出本机局域网地址，一键填入，避免填 `127.0.0.1` 导致音箱拉不到音频
- **自动续播**：歌单播放时自动接续下一首，进度过半提前解析、接近结尾提前切歌，两首歌之间几乎无缝；随机 / 单曲循环 / 顺序播放与播放器行为一致
- 服务端中转音频流：在线歌曲由 lxserver 代为回源，绕开音源防盗链与 http/https 混用问题

> 详细说明（原理、配置项、常见问题）见 [docs/guide/xiaoai.md](docs/guide/xiaoai.md)

### 8. 自定义音源自检护栏（新增）

第三方音源脚本是黑盒：实测存在个别混淆脚本**加载成功后持续占用 ~60% 单核 CPU、内存涨到 270MB**，而日志上完全看不出异常。护栏在加载前后自动体检，把这类「静默空转」直接暴露出来。

- **静态体检**（加载前）：识别空死循环、`debugger` 反调试陷阱、沙箱逃逸、高频忙轮询等特征，命中高危（A 级）的脚本按策略自动隔离
- **混淆只标记不隔离**（B 级）：`jsjiami` 之类的混淆本身不等于恶意 —— 实测 46 个常见音源中有 12 个是混淆脚本但完全正常，因此这类只记日志、不隔离
- **运行期采样**：空闲状态下持续高占用才判定异常，随后逐个卸载候选音源做归因，直接指出「是哪个脚本在吃 CPU」
- **可恢复**：隔离只是跳过加载，不删除脚本、不改动你的音源开关；脚本一更新（内容指纹变化）**隔离自动解除**
- 命中结果与当前空闲 CPU 都可在 `/health` 的 `sourceGuard` 字段中查看

> 详细说明（判定分级、配置项、误报处理）见 [docs/guide/source-guard.md](docs/guide/source-guard.md)

### 9. 自定义源平台可用性巡检（新增）

音源脚本声明的平台里总有几个是坏的（官方风控收紧、接口下线、脚本作者没跟上）。坏平台会让播放路径先试错再切换，用户侧就是「点了播放要愣好几秒才出声」。巡检会主动把它们找出来并关掉：

- **新音源立即体检**：上传/导入成功后，逐个平台实际解析一次；多个源在 3 秒窗口内合并成一轮，撞上正在跑的轮次会**排队**等本轮结束后补跑（`/health` 的 `pendingNewSources` 可见），不会被丢掉
- **定时复检**：按 `customSource.probe.intervalMinutes`（默认 3 小时）对「剩余可用平台」再探测
- **自动关闭坏平台**：连续失败达阈值（默认 2 次）才关闭，单次失败只记状态；关闭状态写入 **与面板「平台禁用」同一份 `states.json`**，面板上可见可改
- **自动恢复**：被自动关闭的平台一旦探测成功会自动重新开启；**你手动关闭的平台永不参与复检、也不会被自动打开**
- **全平台失效自动移除音源**：默认移入同级 `.trash/` 目录（可恢复），并逐行写入 `probe-audit.log` 审计
- **三道防误伤**：① 探测音质跟随脚本自己声明的 `qualitys`，而不是硬编码；② 一个平台用多首候选曲目依次重试，任一成功即算可用；③ 链接校验在 `HEAD` 返回 4xx 时用 `Range: bytes=0-1` 的 `GET` 复核，避免把「不支持 HEAD」误判为失效
- **平台侧系统性异常保护**：某平台在同一轮里于过半音源上同时失败时，判定为平台侧问题（测试曲目无版权、平台限流等），本轮只记录 `suspectPlatforms` 并暂缓处置 —— 不关闭平台、不移除音源，避免测试曲目不可播导致一次误关整个音源库
- 结果在 `/health` 的 `sourceProbe` 字段（加 `?probeDetail=1` 可看逐平台失败原因），同时注册为后台任务 `custom_source_health_probe`

> 详细说明（判定标准、测试曲目来源、全部配置项、被移除音源的恢复方式）见 [docs/guide/source-probe.md](docs/guide/source-probe.md)

## 🧩 相对上游的主要增强

| 方向 | 内容 |
| :--- | :--- |
| **自定义源自检护栏** | 加载前静态体检 + 运行期 CPU 归因，把「混淆脚本静默空转吃 CPU」暴露并隔离；隔离为内存态，脚本更新自动解除 |
| **自定义源平台可用性巡检** | 新音源立即体检、定时复检、坏平台自动关闭、恢复自动开启、全平台失效自动移除（可恢复） |
| **三道防误伤** | 探测音质跟随脚本声明、多首测试曲目重试、链接 4xx 时 Range GET 复核 |
| **平台侧异常保护** | 某平台在同轮过半音源上同时失败时只报告不处置，避免一次误关整个音源库 |
| **小爱音箱投播** | 扫码登录、多设备同时播放、自动续播；服务端中转音频流绕开防盗链 |
| **音源热重载优化** | 单文件变动只增量重载该音源，不再全量重载整个空间 |
| **观测能力** | `/health` 暴露护栏与巡检状态，`?probeDetail=1` 查看逐平台失败明细；破坏性动作写入 `probe-audit.log` |

## 🐳 Docker 部署

镜像发布到 **GitHub Packages（GHCR）**，**每次更新都会打上版本号标签**，便于固定版本与回滚：

| 标签 | 说明 |
| :--- | :--- |
| `latest` | 最新稳定版，跟随 `main` 分支 |
| `v1.5.9` / `1.5.9` | 当前版本（与 `package.json` 的 `version` 一致），**生产环境建议固定到具体版本** |
| `v*` | 每个已发布版本都会保留，可随时回滚到历史版本 |

```bash
# 固定版本（推荐）
docker pull ghcr.io/zues0077/lxserver:1.5.9

# 或跟随最新
docker pull ghcr.io/zues0077/lxserver:latest
```

> - 镜像标签的来源是 `package.json` 的 `version`，由 `.github/workflows/docker-publish.yml` 在推送 `main` 时自动生成。修改版本号只需执行 `npm run version:set -- 1.5.9`，它会同时同步 `package.json` 与 `public/js/config.js` 两处。
> - 如果要另外发布到 Docker Hub，可使用备用工作流 `.github/workflows/docker.yml`（需自行配置 `DOCKER_USERNAME` / `DOCKER_PASSWORD` 密钥并手动触发，默认不参与自动发布）。

## 🔒 访问控制与安全

为了保护你的隐私，Web 播放器支持开启访问密码。

### 开启方式

1. **环境变量配置**（推荐 Docker 用户使用）：
   - `ENABLE_WEBPLAYER_AUTH=true`: 开启认证
   - `WEBPLAYER_PASSWORD=yourpassword`: 设置访问密码
2. **Web 界面配置**：
   登录管理后台（默认端口 9527），进入 **"系统配置"**，勾选 **"启用 Web 播放器访问密码"** 并设置密码。

### 权限与公开源限制矩阵 (当 `user.enablePublicRestriction` 开启时)

| 用户类型             | 查看列表 | 使用/切换(仅个人) | 修改默认音质 | 上传/导入音源 | 删除/修改公开源 |
| :------------------- | :------- | :---------------- | :----------- | :------------ | :-------------- |
| **管理员**     | ✅ 允许  | ✅ 允许           | ✅ 允许      | ✅ 允许       | ✅ 允许         |
| **已登录用户** | ✅ 允许  | ✅ 允许           | ✅ 允许      | ✅ 允许       | ❌ 禁止         |
| **未登录访客** | ❌ 隐藏  | ❌ 禁止           | ❌ 禁止      | ❌ 禁止       | ❌ 禁止         |

> **实际判定规则**（源码 `server.ts` + `customSourceHandlers.ts`）：开启限制后，`/api/custom-source/*` 的写操作要求「管理员密码（`x-frontend-auth`）**或**有效用户登录凭证（`x-user-token`）任一通过」；而删除 / 修改 `_open` 公共源在 `handleDelete` 中另行强制校验管理员密码。未登录访客一律返回 403。

## 📱 移动端适配

Web 播放器针对移动端做了深度优化，手机浏览器访问也能接近原生 App 的体验：

- **自适应布局**：窄屏下侧边栏收起为抽屉，列表、播放栏与弹窗排版自动调整。
- **手势交互**：歌词详情页支持向下滑动收起，底部封面点击直达歌词。
- **车载 / 蓝牙**：补齐 512×512 栅格封面并适配 AVRCP BIP 协议（该协议不支持 SVG），解决车载屏幕封面黑屏或不显示的问题。
- **iOS 提示**：受 iOS WebKit 后台限制，开启底部波形或 EQ 音效会导致锁屏暂停；需要锁屏后台听歌时请关闭这两项。

---

## 🚀 快速启动

本项目基于 **Node.js** 开发，支持多种部署方式。

### 方式一：桌面客户端

可以通过桌面端更方便地运行 LX Music Sync Server，支持 Windows、macOS 和 Linux。

- **📦 下载地址**: [GitHub Releases](https://github.com/zues0077/lxserver/releases)（桌面端产物由 `.github/workflows/release.yml` 在推送 `v*` 标签时自动构建）
- **✨ 桌面端优势**:
  - **单窗口管理**: 服务器管理与 Web 播放器合二为一，界面更统一。
  - **托盘常驻**: 窗口关闭后自动缩回托盘，服务在后台始终运行。
  - **全架构支持**: 提供 Windows (x64/x86/ARM64 Setup 及 Portable)、macOS (Intel/Apple Silicon) 及 Linux (amd64/arm64/armv7l) 全家桶。

### 方式二：使用 Docker

镜像地址（GitHub Packages / GHCR）：

- 跟随最新：`ghcr.io/zues0077/lxserver:latest`
- 固定版本（推荐）：`ghcr.io/zues0077/lxserver:1.5.9`
- 完整标签说明见上方 [Docker 部署](#-docker-部署)

**Docker Run 示例：**

```bash
docker run -d \
  -p 9527:9527 \
  -v $(pwd)/data:/server/data \
  -v $(pwd)/cache:/server/cache \
  -v $(pwd)/music:/server/music \
  -v $(pwd)/cover_cache:/server/cover_cache \
  --name lx-sync-server \
  --restart unless-stopped \
  ghcr.io/zues0077/lxserver:1.5.9
```

> ⚠️ **`--restart` 不要省**：面板里的「重启服务」（`POST /api/restart`）在容器内是通过结束进程实现的，
> 完全依赖容器的重启策略才能重新拉起来。漏写 `--restart`（或写成 `no`）时，点一次「重启服务」服务就彻底停了。
> 推荐 `--restart unless-stopped` 或 `always`。

> **建议同时挂载 `data`、`cache`、`music`、`cover_cache` 四个目录。**
>
> - `/server/data`（必须）：配置（会自动落到 `data/config.js`）、用户数据、日志（`data/logs`）、备份。
> - `/server/cache`（建议）：播放缓存。默认缓存位置为 `root`，缓存实际写在容器内的
>   `/server/cache/<用户名>`。
> - `/server/music`（建议）：下载目录。点「下载」或「移入下载目录」后，文件会从缓存目录移到
>   这里，即容器内的 `/server/music/<用户名>`。
> - `/server/cover_cache`（建议）：歌曲封面缓存。**它恒定写在容器工作目录下，不受面板「缓存位置」开关影响**
>   —— 即使把缓存切成 `data` 模式、只挂 `data`，封面图依然会落进容器可写层。所以要单独挂载它。
>
> 若**不**挂 `cache` / `music`，这两类文件会写进容器的可写层 —— 宿主目录里看不到，容器重建即丢失。
> 另一种做法是在面板把「缓存位置」由 `root` 切换为 `data`，缓存与下载会改为落在
> `/server/data/cache/<用户名>`、`/server/data/music/<用户名>`，此时这两个目录只挂 `data` 即可；
> 代价是这部分数据会纳入数据同步，数据卷体积会明显变大。注意该开关**不影响 `cover_cache`**。
>
> **关于 `./logs`**：镜像默认 `LOG_PATH=/server/data/logs`，日志本来就写在 `data` 卷里，
> 因此单独挂 `./logs:/server/logs` 是一个**空挂载**（上游默认行为也是如此）。
> 想让日志单独落到宿主的 `./logs`，需要同时设置环境变量 `LOG_PATH=/server/logs`。

**Docker Compose 示例：**

新建 `docker-compose.yml` 文件：

```yaml
services:
  lx-sync-server:
    image: ghcr.io/zues0077/lxserver:1.5.9   # 或 :latest
    container_name: lx-sync-server
    restart: unless-stopped          # 不要省：面板「重启服务」靠它拉起进程
    ports:
      - "9527:9527"
      # - "4533:4533"                # 仅当设置了 SUBSONIC_PORT（如 4533）时才需要
    volumes:
      - ./data:/server/data
      # 默认 root 缓存模式下必须一并挂载，否则缓存/下载会留在容器可写层
      - ./cache:/server/cache
      - ./music:/server/music
      # 封面缓存恒定写在容器工作目录，不受「缓存位置」开关影响，需单独挂载
      - ./cover_cache:/server/cover_cache
    environment:
      - NODE_ENV=production
      # - ADMIN_PASSWORD=yourpassword
      # - ENABLE_WEBPLAYER_AUTH=true
      # - WEBPLAYER_PASSWORD=yourpassword
      # - ADMIN_PATH=/admin
      # - PLAYER_PATH=/
      # - LOG_PATH=/server/logs       # 仅当上面额外挂载了 ./logs:/server/logs 时才需要
```

### 方式三：直接运行 (Git Clone)

```bash
# 1. 克隆项目
git clone https://github.com/zues0077/lxserver.git && cd lxserver

# 2. 安装依赖并编译
npm ci && npm run build

# 3. 启动服务
npm start
```

### 方式四：使用 Release 版本

1. 在 GitHub Releases 下载压缩包。
2. 解压后运行 `npm install --omit=dev`。
3. 执行 `npm start` 启动。

---

## 🔌 服务连接与客户端配置

### ① Web 界面访问

- **Web 播放器**: `http://<服务器IP>:9527`（默认根路径，可通过 `PLAYER_PATH` 环境变量或后台配置自定义路径，如 `/music`）
  - 若启用了播放器访问密码认证（`ENABLE_WEBPLAYER_AUTH`），首次访问需输入播放器密码（默认 `123456`）。
- **管理后台**: `http://<服务器IP>:9527/admin`（默认路径为 `/admin`，可通过 `ADMIN_PATH` 自定义，默认管理员密码: `123456`）。

### ② LX Music 客户端同步配置（桌面端 / 移动端）

进入客户端「设置 → 同步设置」，选择自定义连接：

- **模式一：用户路径模式（推荐，默认开启 `USER_ENABLE_PATH=true`）**
  - **连接 URL**: `http://<服务器IP>:9527/<用户名>`（例如：`http://192.168.1.100:9527/user1`）
  - **连接密码**: 对应用户的独立密码
  - **特点**: 通过 URL 中的用户名精确路由到各用户独立存储空间，**允许多个不同用户使用相同密码**。
- **模式二：根路径模式（需配置 `USER_ENABLE_ROOT=true`）**
  - **连接 URL**: `http://<服务器IP>:9527`（例如：`http://192.168.1.100:9527`）
  - **连接密码**: 对应用户的密码
  - **特点**: URL 无需携带用户名，服务端通过鉴权密码自动匹配用户。**注意：此模式下所有用户的密码必须唯一，不允许不同用户使用相同密码**。

### ③ Subsonic 音乐客户端配置（音流 / Feishin / Symfonium 等）

全面兼容 Subsonic API 协议，客户端中填写：

- **服务器地址 (Server URL)**:
  - **默认共享主端口**: `http://<服务器IP>:9527/rest`（子路径由 `SUBSONIC_PATH` 决定，默认 `/rest`）
  - **独立监听端口模式**（若配置了 `SUBSONIC_PORT` > 0，例如 `4533`）: `http://<服务器IP>:4533/rest`
    - ⚠️ **Docker 部署需要额外发布该端口**：仅设置 `SUBSONIC_PORT=4533` 环境变量是不够的，
      还要在 `docker run` 里加 `-p 4533:4533`（或 compose 的 `ports` 里放开 `"4533:4533"`），否则容器外连不上。
- **用户名 & 密码**: 在后台“用户管理”中配置的用户名及其同步密码。
- **在线搜索**: 支持在 Subsonic 客户端中直接全网搜索与播放，可使用 `wy:`、`tx:`、`kw:`、`kg:`、`mg:` 指定平台，或使用 `online:` / `local:` 强制在线/本地搜索。
- **关于服务端转码**：Subsonic 的 `transcode` 相关能力依赖 `ffmpeg`，而 **Docker 镜像默认只装了 `chromaprint`，不含 `ffmpeg`**。
  镜像启动时会自动探测（`probeFfmpeg()`）：检测不到就关闭转码并**优雅降级为 302 直链**（不会报错、也不会导致播放失败），
  只是客户端要求的码率/格式转换不会生效。需要服务端转码时，请自行在镜像中安装 `ffmpeg`，或改用自带 `ffmpeg` 的镜像变体。

---

## 🏗️ 项目架构

本项目基于 Node.js 采用前后端分离架构：

- **Backend (Node.js 原生 http + WebSocket)**：数据同步、用户与权限、自定义源管理、Subsonic 协议、WebDAV 备份。
- **WebPlayer (Vanilla JS)**：音乐播放业务，默认访问路径为根路径 `/`。
- **Console (Vanilla JS)**：位于 `/admin` 路径，负责用户与数据管理。

---

## 🛠️ 配置说明

系统配置文件已默认持久化在数据目录中的 `data/config.js`（Docker 部署下，挂载 `./data` 卷即可让**配置本身**在容器更新、重启后永久保留 —— 注意这里说的只是配置，缓存 / 下载 / 封面缓存还需要各自的挂载，见上文「建议同时挂载」说明；若根目录下存在旧 `config.js` 会自动平滑迁移）。环境变量优先级最高：

| 环境变量                                     | 对应配置项                                   | 说明                                                                                               | 默认值               |
| -------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------- |
| `PORT`                                     | `port`                                     | 服务端口                                                                                           | `9527`             |
| `ADMIN_PATH`                               | `admin.path`                               | 后台管理界面访问路径                                                                               | `/admin`           |
| `PLAYER_PATH`                              | `player.path`                              | Web 播放器访问路径 (默认为根路径 `/`)                                                            | `/`                |
| `ADMIN_PASSWORD`                           | `admin.password`                           | 管理员密码（用于登录控制台和音乐播放器管理员登录）                                                 | `123456`           |
| `SERVER_NAME`                              | `serverName`                               | 同步服务名称（客户端连接展示名称及管理后台标题）                                                   | `LX Sync Server`   |
| `PLAYER_NAME`                              | `player.name`                              | Web 播放器名称（播放器网页标题及登录卡片标题）                                                     | `LX Music Web`     |
| `ENABLE_DEBUG`                             | `debug.enabled`                            | 是否启用 DEBUG 模式 (开启后输出详细调试日志与音源内部日志，默认关闭)                               | `false`            |
| `MAX_SNAPSHOT_NUM`                         | `maxSnapshotNum`                           | 保留的最大快照数量                                                                                 | `10`               |
| `CONFIG_PATH`                              | -                                            | 指定外部配置文件的绝对路径 (默认使用 `data/config.js`)                                           | -                    |
| `DATA_PATH`                                | -                                            | 指定数据存储目录的绝对路径                                                                         | `./data`           |
| `LOG_PATH`                                 | -                                            | 指定日志输出目录的绝对路径                                                                         | `./logs`           |
| `PROXY_HEADER`                             | `proxy.header`                             | 代理转发 IP 头 (如 `x-real-ip`)                                                                  | -                    |
| `USER_ENABLE_ROOT`                         | `user.enableRoot`                          | 启用根路径 (开启后连接URL即为 `ip:port`，不允许不同用户密码相同)                                 | `false`            |
| `USER_ENABLE_PATH`                         | `user.enablePath`                          | 启用用户路径 (开启后连接URL需为 `ip:port/用户名`，允许密码相同)                                  | `true`             |
| `WEBDAV_ENABLE`                            | `webdav.enable`                            | 是否启用 WebDAV 同步与备份                                                                         | `false`            |
| `WEBDAV_URL`                               | `webdav.url`                               | WebDAV 地址                                                                                        | -                    |
| `WEBDAV_USERNAME`                          | `webdav.username`                          | WebDAV 用户名                                                                                      | -                    |
| `WEBDAV_PASSWORD`                          | `webdav.password`                          | WebDAV 密码                                                                                        | -                    |
| `WEBDAV_SYNC_PATH`                         | `webdav.syncPath`                          | WebDAV 增量同步远端路径                                                                            | `/lx-sync`         |
| `WEBDAV_BACKUP_PATH`                       | `webdav.backupPath`                        | WebDAV 全量备份远端路径                                                                            | `/lx-sync-backups` |
| `SYNC_INTERVAL`                            | `sync.interval`                            | WebDAV 增量同步检测间隔(分钟)                                                                      | `60`               |
| `BACKUP_INTERVAL`                          | `sync.backupInterval`                      | WebDAV 全量备份间隔(小时)                                                                          | `24`               |
| `WEBDAV_EXCLUDE_CACHE`                     | `webdav.excludeCache`                      | 排除缓存目录同步 (`data/<用户>/cache`)，开启后不参与增量同步及全量备份（已同步的文件不会被删除） | `false`            |
| `WEBDAV_EXCLUDE_MUSIC`                     | `webdav.excludeMusic`                      | 排除下载目录同步 (`data/<用户>/music`)，开启后不参与增量同步及全量备份（已同步的文件不会被删除） | `false`            |
| `ENABLE_WEBPLAYER_AUTH`                    | `player.enableAuth`                        | 是否启用 Web 播放器访问密码                                                                        | `false`            |
| `WEBPLAYER_PASSWORD`                       | `player.password`                          | Web 播放器访问密码                                                                                 | `123456`           |
| `DISABLE_TELEMETRY`                        | `disableTelemetry`                         | 是否禁用匿名数据统计，系统更新提示以及系统公告提示                                                 | `false`            |
| `ENABLE_PUBLIC_USER_RESTRICTION`           | `user.enablePublicRestriction`             | 是否启用公开用户权限限制 (限制上传、删除公开源、缓存到服务器等)                                    | `true`             |
| `ENABLE_PUBLIC_NON_ADMIN_LOCAL_MUSIC`      | `user.enablePublicNonAdminLocalMusic`      | 是否开启非管理员访问本地音乐 (允许未登录管理员的公开账号访问本地音乐)                              | `false`            |
| `ENABLE_PUBLIC_NON_ADMIN_BROWSER_DOWNLOAD` | `user.enablePublicNonAdminBrowserDownload` | 是否开启非管理员浏览器下载 (允许未登录管理员的公开/普通账号使用浏览器下载歌曲)                     | `true`             |
| `ENABLE_PUBLIC_NON_ADMIN_SERVER_CACHE`     | `user.enablePublicNonAdminServerCache`     | 是否开启非管理员服务器缓存 (允许未登录管理员的公开/普通账号将歌曲缓存到服务器)                     | `false`            |
| `ENABLE_PUBLIC_FAVORITES`                  | `user.enablePublicFavorites`               | 是否开启公开收藏和歌曲 (开启后允许公开/未登录用户查看及播放公开收藏)                               | `false`            |
| `ENABLE_PUBLIC_NON_ADMIN_ACCESS`           | `user.enablePublicNonAdminAccess`          | 是否开启非管理员访问公开收藏和歌曲 (允许未登录管理员的公开账号查看)                                | `false`            |
| `ENABLE_CUSTOM_MUSIC_DIR`                  | `user.enableCustomMusicDir`                | 是否开启自定义歌曲目录总开关                                                                       | `false`            |
| `ENABLE_LOGIN_USER_CACHE_RESTRICTION`      | `user.enableLoginCacheRestriction`         | 是否启用登录用户缓存限制 (开启后限非管理员登录用户的缓存设置)                                      | `false`            |
| `ENABLE_CACHE_SIZE_LIMIT`                  | `user.enableCacheSizeLimit`                | 是否启用缓存空间限制 (开启后超出容量将按 LRU 自动清理)                                             | `false`            |
| `CACHE_SIZE_LIMIT`                         | `user.cacheSizeLimit`                      | 缓存空间限制大小 (单位: MB)                                                                        | `2000`             |
| `CONFIG_BACKUP_ENABLE`                     | `configBackup.enable`                      | 是否启用配置文件自动备份功能 (每天生成一份历史配置副本)                                            | `true`             |
| `CONFIG_BACKUP_RETENTION_DAYS`             | `configBackup.retentionDays`               | 配置文件备份保留天数 (自动清理过期备份)                                                            | `7`                |
| `CONFIG_BACKUP_DIR`                        | `configBackup.dir`                         | 配置文件备份存储目录路径 (支持绝对路径或相对 `./data`)，留空则为 `<data>/backups`                     | `-`                |
| `SNAPSHOT_BACKUP_PATH`                     | `snapshot.backupPath`                      | 歌单快照自定义存储路径 (支持绝对路径或相对 `./data`，各用户独立隔离)                             | -                    |
| `LIST_ADD_MUSIC_LOCATION_TYPE`             | `list.addMusicLocationType`                | 添加歌曲到列表时的位置 (`top` / `bottom`)                                                      | `top`              |
| `PROXY_ALL_ENABLED`                        | `proxy.all.enabled`                        | 是否启用外发请求代理 (针对 Music SDK)                                                              | `false`            |
| `PROXY_ALL_ADDRESS`                        | `proxy.all.address`                        | 代理地址 (支持 http:// 或 socks5://)                                                               | -                    |
| `SINGER_SOURCE_PRIORITY`                   | `singer.sourcePriority`                    | 歌手信息获取来源优先级 (如 `tx,wy` 或 `wy,tx`)                                                 | `tx,wy`            |
| `SUBSONIC_ENABLE`                          | `subsonic.enable`                          | 是否启用 Subsonic 协议支持                                                                         | `true`             |
| `SUBSONIC_PATH`                            | `subsonic.path`                            | Subsonic 接口访问路径 (默认为 `/rest`)                                                           | `/rest`            |
| `SUBSONIC_PORT`                            | `subsonic.port`                            | Subsonic 独立监听端口 (`0` 为关闭独立端口，与主服务共用端口)。**Docker 部署需额外发布该端口**（如 `-p 4533:4533`） | `0`                |

> 📌 **关于 `DATA_PATH` / `LOG_PATH` 的默认值差异**：表中写的 `./data`、`./logs` 是**直接 `npm start` 裸跑**时的默认值。
> Docker 镜像已在 `Dockerfile` 里覆盖为 `DATA_PATH=/server/data`、`LOG_PATH=/server/data/logs`，
> 因此容器内日志默认落在 `data/logs`（对应宿主 `./data/logs`），而不是单独挂的 `./logs` 目录。
| `SUBSONIC_ENABLE_DEBUG`                    | `subsonic.enableDebug`                     | 是否开启 Subsonic 调试日志模式                                                                     | `false`            |
| `SUBSONIC_ONLINE_SEARCH`                   | `subsonic.onlineSearch`                    | 是否开启 Subsonic 在线全网搜索                                                                     | `true`             |
| `SUBSONIC_ONLINE_SEARCH_MODE`              | `subsonic.onlineSearchMode`                | Subsonic 在线搜索模式 (`fallback` / `merge` / `local_only`)                                  | `fallback`         |
| `SUBSONIC_ONLINE_SEARCH_SOURCES`           | `subsonic.onlineSearchSources`             | Subsonic 在线搜索默认音源列表                                                                      | `wy,tx,kw,kg,mg`   |
| `SUBSONIC_PUBLIC_LEADERBOARDS`             | `subsonic.publicLeaderboards`              | 是否开启 Subsonic 公开排行榜 (将在线排行榜映射为只读歌单)                                          | `false`            |
| `SUBSONIC_LEADERBOARD_SOURCE`              | `subsonic.leaderboardSource`               | Subsonic 公开排行榜默认音源平台 (仅支持单选, 如 `tx`, `wy` 等)                                 | `tx`               |
| `SUBSONIC_LYRIC_TRANSLATION`               | `subsonic.lyricTranslation`                | Subsonic 歌词中是否包含翻译                                                                        | `true`             |
| `SUBSONIC_CACHE_ON_PLAY`                   | `subsonic.cacheOnPlay`                     | Subsonic 播放时是否触发服务器自动缓存保存 (落盘到用户目录)                                         | `false`            |
| `SUBSONIC_PLAY_CACHE_FIRST`                | `subsonic.playCacheFirst`                  | Subsonic 播放时是否优先使用服务器已有的本地缓存/下载文件直接传输                                   | `true`             |
| `SUBSONIC_QUALITY_ENABLED`                 | `subsonic.quality.enabled`                 | Subsonic 是否开启音质优选                                                                          | `true`             |
| `SUBSONIC_QUALITY_PRIORITY`                | `subsonic.quality.priority`                | Subsonic 音质优选优先级列表 (如 `flac,320k,128k`)                                                | `flac,320k,128k`   |
| `ARTIST_MAX_FETCH_PAGES`                   | `artist.maxFetchPages`                     | 歌手歌曲最大抓取页数                                                                               | `20`               |
| `CACHE_NAMING_PATTERN`                     | `cache.namingPattern`                      | 缓存文件命名规则 (`simple` / `custom`)                                                         | `simple`           |
| `SYSTEM_ALLOW_UNSAFE_VM`                   | `system.allowUnsafeVM`                     | 是否允许运行 VM 模式自定义源脚本 (需注意安全风险)                                                  | `false`            |
| `LX_USER_<用户名>`                         | `users` 数组                               | 快速添加用户，值为该用户的密码 (如 `LX_USER_test=123`)                                           | -                    |
| `SOURCE_PROBE_ENABLED`                     | `customSource.probe.enabled`               | 是否启用自定义源平台可用性巡检                                                                     | `true`             |
| `SOURCE_PROBE_INTERVAL_MINUTES`            | `customSource.probe.intervalMinutes`       | 平台复检间隔（分钟）                                                                               | `180`              |
| `SOURCE_PROBE_FAIL_THRESHOLD`              | `customSource.probe.failThreshold`         | 连续失败多少次判定平台不可用                                                                       | `2`                |
| `SOURCE_PROBE_AUTO_DISABLE`                | `customSource.probe.autoDisablePlatform`   | 判定不可用后是否自动关闭该平台的解析                                                               | `true`             |
| `SOURCE_PROBE_AUTO_REMOVE`                 | `customSource.probe.autoRemoveSource`      | 某音源全部平台失效时是否自动移除该音源（默认移入 `.trash/` 可恢复）                                | `true`             |

> **高级用户配置说明**：环境变量 `LX_USER_<用户名>` 仅用于快速添加用户及设置密码。若需为特定用户配置独立的高级选项（如开启个人自定义音乐目录、分配操作权限 `allowOperateCustomMusicDir` 或写入权限 `allowWriteCustomMusicDir`、调整快照数量等），请直接在 `config.js` 的 `users` 数组中手动配置对应字段，或者在后台管理界面的“用户管理”面板中通过图形界面修改。

> **布尔类型环境变量说明**：所有布尔类型的环境变量支持灵活的写法（不区分大小写），开启支持 `true` / `1` / `yes` / `y` / `on`；关闭支持 `false` / `0` / `no` / `n` / `off`。

> **提示**：目前服务支持 `启用根路径` (URL配置为 `ip:port`) 和 `启用用户路径` (URL配置为 `ip:port/username`) 两种数据同步连接方式。如果没有启用用户路径，则必须保证每一个同步用户的鉴权密码不重复。

---

## 🛡️ 数据收集与隐私说明

本项目集成了 PostHog 匿名数据统计，主要用于：

1. **Bug 追踪**: 收集版本号、环境类型。
2. **通知推送**: 弹出 **版本更新提醒** 与 **紧急维护公告**。

- **绝对匿名**: 绝不收集 IP、用户名或具体歌单内容。
- **关闭方法**: 环境变量设置 `DISABLE_TELEMETRY=true`。**注意：关闭后将无法收到新版本通知。**

---

## 🤝 贡献与致谢

- 本项目修改自 [xcq0607/lxserver](https://github.com/xcq0607/lxserver)，后者修改自 [lyswhut/lx-music-sync-server](https://github.com/lyswhut/lx-music-sync-server)。
- Web 播放器逻辑参考 [lx-music-desktop](https://github.com/lyswhut/lx-music-desktop)。
- 感谢以上项目的作者与贡献者。

### 👥 贡献者 (Contributors)

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

## 📄 开源协议

本项目基于 Apache License 2.0 许可证发行，以下协议是对于 Apache License 2.0 的补充，如有冲突，以以下协议为准。

Apache License 2.0 copyright (c) 2026 [zues0077](https://github.com/zues0077)（原始版权归 [xcq0607](https://github.com/xcq0607)，遵循 Apache-2.0 保留署名）

**词语约定**：本协议中的“本项目”指 LX Music Web 播放器；“使用者”指签署本协议的使用者；“官方音乐平台”指对本项目内置的包括酷我、酷狗、咪咕等音乐源的官方平台统称；“版权数据”指包括但不限于图像、音频、名字等在内的他人拥有所属版权的数据。

### 一、数据来源

1. **官方平台**: 本项目的各官方平台在线数据来源原理是从其公开服务器中拉取数据，经过对数据简单地筛选与合并后进行展示(与未登录状态在官方APP获取的数据相同)，因此本项目不对数据的合法性、准确性负责。
2. **音频数据**: 本项目本身没有获取某个音频数据的能力，所使用的在线音频数据来源来自设置内“自定义源”所选择的“源”返回的在线链接。本项目无法校验其准确性，使用过程中可能会出现播放异常。
3. **其他数据**: 本项目的非官方平台数据（例如“我的列表”内列表）来自服务器存储数据，本项目不对这些数据的合法性、准确性负责。

### 二、免责声明

1. **版权数据**: 使用本项目的过程中可能会产生版权数据。对于这些版权数据，本项目不拥有它们的所有权。为了避免侵权，使用者务必在 **24 小时内** 清除使用本项目的过程中所产生的版权数据。
2. **责任承担**: 由于使用本项目产生的包括由于本协议或由于使用或无法使用本项目而引起的任何性质的任何直接、间接、特殊、偶然或结果性损害由使用者负责。
3. **法律法规**: 本项目完全免费，且开源发布于 GitHub 面向全世界人用作对技术的学习交流。**禁止**在违反当地法律法规的情况下使用本项目。对于使用者在明知或不知当地法律法规不允许的情况下使用本项目所造成的任何违法违规行为由使用者承担。

### 三、其他

1. **资源使用**: 本项目内使用的部分包括但不限于字体、图片等资源来源于互联网。如果出现侵权可联系本项目移除。
2. **非商业性质**: 本项目仅用于对技术可行性的探索及研究，不接受任何商业（包括但不限于广告等）合作及捐赠。
3. **接受协议**: 若你使用了本项目，即代表你接受本协议。
