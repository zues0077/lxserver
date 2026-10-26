# fnOS 部署实战（分步教程）

> 本页是 [部署、反代与 HTTPS 实战](./deployment) 的** fnOS 专版**：把「NAS 实战」那一节拆成一步一步能照着点出来的图文流程。
> 适用对象：把 lxserver 装在 fnOS（飞牛私有云）上的用户。其他 NAS（群晖 / 威联通）思路一致，只是 UI 措辞不同。
> 通用背景（反代、HTTPS、安全加固、生产级 Compose、排错）仍见上方主部署页，本页只讲「在 fnOS 上怎么落地」。

---

## 目录

- [〇、先确认这几件事](#〇、先确认这几件事)
- [一、镜像从哪拉：用 `ghcr.nju.edu.cn` 镜像源](#一、镜像从哪拉-用-ghcr-nju-edu-cn-镜像源)
- [二、打开 fnOS 的 Docker 应用](#二、打开-fnos-的-docker-应用)
- [三、拉取镜像（图文步骤）](#三、拉取镜像-图文步骤)
- [四、创建容器（核心，六步）](#四、创建容器-核心-六步)
- [五、启动并验证](#五、启动并验证)
- [六、用 fnOS 内置反代做 HTTPS](#六、用-fnos-内置反代做-https)
- [七、客户端 / 播放器连接](#七、客户端-播放器连接)
- [附录 A：用 trim-cli 命令行部署（作者实战路径）](#附录-a-用-trim-cli-命令行部署-作者实战路径)
- [附录 B：fnOS 常见 errno 速查](#附录-b-fnos-常见-errno-速查)
- [排错](#排错)

---

## 〇、先确认这几件事

| 检查项 | 说明 |
| :--- | :--- |
| fnOS 已安装「Docker」应用 | 应用中心里装好，能打开「镜像 / 容器 / .compose」等页签 |
| 你能访问 fnOS 后台 | 默认 `http://<NAS IP>:5670`（HTTP 明文）。本教程示例 IP 用 `192.168.1.246` |
| 已规划好一个共享文件夹 | 例如 `/vol1/1000/docker/lxserver/`，后面四个挂载都建在它下面 |
| 镜像源能拉 GHCR | fnOS 一般支持填镜像加速器。本文统一用 `ghcr.nju.edu.cn`（见下一节） |
| 端口不冲突 | 容器内部固定 `9527`；宿主端口随便选（本文用 `17950`），反代 / 客户端填宿主端口 |

> 提示：fnOS 上的 Docker 没有 `docker logs` 子命令，验证只能走 `http://<NAS IP>:<宿主端口>/health`（返回 JSON 即正常）。这点很关键，排错全靠它。

---

## 一、镜像从哪拉：用 `ghcr.nju.edu.cn` 镜像源

官方镜像在 GitHub Packages（`ghcr.io/zues0077/lxserver`）。但在国内 fnOS 上直接拉 `ghcr.io` 经常超时。

**推荐用 edu 镜像源**：`ghcr.nju.edu.cn/zues0077/lxserver`。

| 用途 | 镜像地址 |
| :--- | :--- |
| 国内 fnOS / NAS | `ghcr.nju.edu.cn/zues0077/lxserver:1.5.35` |
| 直连 GitHub | `ghcr.io/zues0077/lxserver:1.5.35` |

> 版本号固定写具体数字（如 `1.5.35`），**别用 `latest`**：升级前备份 `./data`，出问题改标签即可回滚。当前版本以 `package.json` 的 `version` 为准（GitHub Releases 也能查到最新 tag）。

---

## 二、打开 fnOS 的 Docker 应用

1. 登录 fnOS 后台（`http://192.168.1.246:5670`）。
2. 在「应用中心」或桌面找到 **Docker** 应用，点开。
3. 你会看到几个页签：**镜像**、**容器**、**Compose**（不同版本名字可能略有差异，但功能一致）。

本教程走「镜像 → 容器」的可视化路径（最稳，不依赖命令行）。

---

## 三、拉取镜像（图文步骤）

**步骤 3.1** — 切到「**镜像**」页签，点「**拉取 / 下载 / 添加镜像**」按钮（右上角，常是一个 `+` 或「拉取镜像」）。

**步骤 3.2** — 在弹出的输入框里填：

```
镜像仓库（Registry）：ghcr.nju.edu.cn
命名空间 / 仓库：zues0077/lxserver
标签（Tag）：1.5.35
```

> 有的 fnOS 把这三段合成一个完整地址框，直接贴：`ghcr.nju.edu.cn/zues0077/lxserver:1.5.35`。

**步骤 3.3** — 如果拉取慢或失败，先去 fnOS 的「**镜像加速器 / 仓库设置**」里把 `ghcr.nju.edu.cn` 加进加速列表，再重试。

**步骤 3.4** — 拉取完成后，镜像列表里会出现 `zues0077/lxserver`，标签 `1.5.35`，点它右边的「**创建容器**」。

---

## 四、创建容器（核心，六步）

点击「创建容器」后会进入一个**分步向导**（有的版本是一个长表单，分「基础设置 / 端口 / 存储空间 / 环境 / 网络 / 确认」几块）。下面每一步都给「界面上填什么」。

### 4.1 基础设置

| 字段 | 填什么 |
| :--- | :--- |
| 容器名称 | `lx-sync-server`（或 `lxserver-verify`，随你） |
| 镜像 | 已自动带出 `ghcr.nju.edu.cn/zues0077/lxserver:1.5.35` |
| 重启策略 | **「总是重启 / Always」** —— ⚠️ 必须选这个！面板「重启服务」靠它把进程拉起来，漏选则点一次重启就再也起不来 |
| 命令 / 参数 | 留空（镜像已写好启动命令） |

### 4.2 端口映射

| 容器端口 | 宿主端口 | 协议 | 说明 |
| :--- | :--- | :--- | :--- |
| `9527` | `17950` | TCP | 容器内部永远是 `9527`；宿主端口随意，反代 / 客户端填 `17950` |

> 如需 Subsonic 独立端口（设了 `SUBSONIC_PORT=4533`），再映射 `4533 → 4533`。

### 4.3 存储空间（四个挂载一个都不能少）

在「**存储空间 / 挂载 / 文件夹**」页，把下面四行**逐条添加**（左侧「容器路径」固定，右侧「宿主路径」是你 NAS 上的真实目录）：

| 宿主路径（示例） | 容器路径 | 权限 | 作用 |
| :--- | :--- | :--- | :--- |
| `/vol1/1000/docker/lxserver/data` | `/server/data` | 读写 | **必须**：配置、用户、日志、备份 |
| `/vol1/1000/docker/lxserver/cache` | `/server/cache` | 读写 | 播放缓存 |
| `/vol1/1000/docker/lxserver/music` | `/server/music` | 读写 | 下载目录 |
| `/vol1/1000/docker/lxserver/cover_cache` | `/server/cover_cache` | 读写 | 封面缓存 |

> ⚠️ **`cover_cache` 最容易被漏**：它恒定写在容器工作目录，**不受后台「缓存位置」开关影响**。漏挂的话封面缓存会写进容器可写层，重建即丢。
>
> 如果你在后台把「缓存位置」从 `root` 改成 `data`，缓存 / 下载会落到 `/server/data/cache`、`/server/data/music`，此时只挂 `data` 也行；但 `cover_cache` 仍然要单独挂。
>
> 日志默认在 `data/logs`；想让日志落到独立宿主目录，再挂 `./logs:/server/logs` 并设环境变量 `LOG_PATH=/server/logs`（本教程不强制）。

### 4.4 环境变量

在「**环境 / 环境变量**」页添加（按需，最少改管理员密码）：

| 变量 | 示例值 | 说明 |
| :--- | :--- | :--- |
| `ADMIN_PASSWORD` | `改成你的强密码` | **必改**：出厂默认 `123456` |
| `ENABLE_WEBPLAYER_AUTH` | `true` | 公网建议开启播放器密码 |
| `WEBPLAYER_PASSWORD` | `播放器密码` | 配合上一项 |
| `TZ` | `Asia/Shanghai` | 让日志时间正确 |
| `EVENT_LOOP_WATCHDOG_TIMEOUT_MS` | `120000` | 主线程卡死自动重启 |
| `PROXY_HEADER` | `x-real-ip` | 走了反代后取真实 IP（见第六节） |
| `LOG_PATH` | `/server/logs` | 仅当额外挂了 `./logs` 才设 |

### 4.5 网络 / 重启策略

- 网络：默认「bridge」即可，无需改。
- 重启策略：再确认一次是 **Always（总是）**（4.1 已设，这里复核）。

### 4.6 确认创建

- 拉到最下方点「**确认 / 创建**」。
- 容器列表里会出现 `lx-sync-server`，状态很快变「运行中 / healthy」。

---

## 五、启动并验证

fnOS 没有 `docker logs`，所以**用 `/health` 验证**：

```
http://192.168.1.246:17950/health
```

- 返回一段 JSON（含音源数、巡检、护栏状态），说明服务正常。
- 也可以直接打开播放器：`http://192.168.1.246:17950/`，后台：`http://192.168.1.246:17950/admin`（密码用你设的 `ADMIN_PASSWORD`）。

> 进后台第一步：到「系统设置」把管理员密码、播放器鉴权再核一遍，并确认「重启策略」生效。

---

## 六、用 fnOS 内置反代做 HTTPS

不强制，但**公网暴露强烈建议**加一层反代（隐藏端口 + HTTPS + 拿真实 IP）。fnOS 自带「反向代理」功能：

1. 打开 fnOS 的「**反向代理 / 反向代理管理**」（有的版本在 Docker 应用或系统设置里）。
2. 新建一条规则：
   - **名称**：lxserver
   - **源（对外）**：`https://music.example.com`（你的域名，需先做好 DNS 解析到 NAS）
   - **上游服务器**：`127.0.0.1`（或容器 IP），端口填**宿主端口** `17950`
   - **协议**：HTTP
   - **开启 WebSocket / 长连接支持**（关键！fnOS 里可能叫「启用 WebSocket」或要手动加 `Upgrade`/`Connection` 头）
3. 证书：在 fnOS 的「证书管理」里申请 Let's Encrypt 或上传自有证书，绑到这条规则。
4. 如果用 fnOS 反代，记得在容器环境变量加 `PROXY_HEADER=x-real-ip`，并确认反代发了 `X-Real-IP` 头，这样服务端日志 / 登录 IP 才是真实来源。

> 更细的 Nginx / Caddy 反代配置、混合内容报错、真实 IP 失真的排错，见主部署页 [二、反向代理与 HTTPS](./deployment#二反向代理与-https重点)。

---

## 七、客户端 / 播放器连接

- **Web 播放器**：`http://192.168.1.246:17950/`（或反代域名 `https://music.example.com/`）。
- **LX Music 客户端**：设置 → 同步设置 → 自定义服务器，URL 填 `http://192.168.1.246:17950/<用户名>`（用户路径模式），密码填用户密码。
- **Subsonic 客户端**（音流 / Feishin）：服务器地址 `http://192.168.1.246:17950/rest`，用后台建的用户登录。

> 走了反代就用反代域名；端口、路径规则与主部署页 [服务访问与客户端连接](./getting-started#服务访问与客户端连接指引) 一致。

---

## 附录 A：用 trim-cli 命令行部署（作者实战路径）

如果你习惯命令行，作者在 246 上实际是用 **trim-cli**（fnOS 的 CLI）完成的，不走 GUI。要点：

1. **登录**：`%TEMP%\fnos-login\driver6.py`（246 专用驱动），回调拿到 token 后 trim-cli 才能操作。
2. **会话绑定**：trim-cli 有会话防护——当前 session 指向 A 机就打不了 B 机（会报 `saved proxy session targets ...`）。246 对应 profile `nas246`，120 对应 `home`，别混。
3. **拉镜像**（写操作都要 `--yes`）：
   ```bash
   # 在 Git Bash 下，/vol1 路径必须加 MSYS_NO_PATHCONV=1，否则路径被改写报 Unsupported path
   MSYS_NO_PATHCONV=1 docker image pull ghcr.nju.edu.cn/zues0077/lxserver:1.5.35 --yes
   ```
4. **同名 tag 指向不同摘要时**会报 `errno 52428822`（镜像已存在）。先 `docker image rm --force <镜像>` 或换 tag 再拉。镜像正在下载中会报 `52428818`，稍等即可。
5. **没有 `docker logs` / `docker exec` / `docker cp`**：验证只走 `/health`；要救容器内数据，可去可写层 `upperdir` 直接拷（先 `inspect` 拿 `UpperDir`）。
6. **`file upload` 不覆盖同名**（存成 `_1`），先 `file mv`/`rm`；`file mv` 目标只能是目录路径。

> 这条路径是作者 246 实战，适合已经熟悉 trim-cli 的用户。新手直接用上面 GUI 六步更稳。

---

## 附录 B：fnOS 常见 errno 速查

| errno | 含义 / 处理 |
| :--- | :--- |
| `52428816` / `52429058` | `composeBuild` / `imageUpgrade` 在本固件走不通 → 改用 `docker container` / `docker image pull` 手动流程 |
| `52428818` | 镜像正在下载中 → 等一会儿再查状态 |
| `52428822` | 镜像已存在（同名 tag 指向不同摘要）→ 先 `docker image rm --force` 或换 tag |

---

## 排错

| 现象 | 原因 / 解决 |
| :--- | :--- |
| 创建容器后状态一直「正在启动」或反复重启 | 看 `/health`；多半是 `data` 卷没挂或权限不可写。确认 4.3 四挂载齐全、目录 fnOS 账号可读写 |
| 封面全丢 / 缓存不在 | `cover_cache` 没挂 → 补 4.3 第四行挂载并重启（旧数据已丢，需重新缓存） |
| 点后台「重启服务」后起不来 | 漏了「重启策略 = Always」→ 删容器重建时勾 Always，或改后重跑 |
| 反代后所有 IP 都是 127.0.0.1 | 没设 `PROXY_HEADER` → 按 4.4 / 第六节配 `PROXY_HEADER=x-real-ip` |
| 浏览器报「混合内容」拦截音频 | 播放器页是 https 但资源走 http → 统一走反代（本页第六节）后同源解决 |
| 拉镜像超时 | 换 `ghcr.nju.edu.cn` 镜像源，或在 fnOS 加速器里加上它 |

> 更全的部署排错表见主部署页 [七、部署排错](./deployment#七部署排错)。数据 / 备份相关排错见 [数据备份与迁移](./backup-migration)。
