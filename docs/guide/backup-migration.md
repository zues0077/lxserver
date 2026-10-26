# 数据备份与迁移

> 本页讲清楚 lxserver 到底把数据写在哪、每个文件是干什么的、怎么备份、以及换一台机器（或换盘 / 升级重装）时怎么把数据完整搬过去。
> 与 [部署页](./deployment) 的「四目录挂载」互补：那里讲「怎么挂」，这里讲「挂上去之后里面有什么、怎么保」。
> 设置项从哪来、怎么改，见 [应用设置与配置规则](./app-settings)；fnOS 实操见 [fnOS 部署实战](./deploy-fnOS)。

---

## 目录

- [一、先记住一个核心原则](#一、先记住一个核心原则)
- [二、卷结构总览（容器视角）](#二、卷结构总览-容器视角)
- [三、各文件 / 目录的作用](#三、各文件-目录的作用)
- [四、四种缓存落点（root / data 模式）](#四、四种缓存落点-root-data-模式)
- [五、怎么备份](#五、怎么备份)
- [六、换机迁移步骤](#六、换机迁移步骤)
- [七、常见坑](#七、常见坑)

---

## 一、先记住一个核心原则

> **所有持久数据都应该落在你挂载的卷里，而不是容器可写层。**

容器重建（升级、换镜像、误删容器）会清空可写层。只要下面这些目录都正确挂载了宿主机目录，重建容器只是「换个壳」，数据原封不动。

四个**必挂**卷（`data` / `cache` / `music` / `cover_cache`）缺一不可；`logs` 可选。挂载含义见 [快速开始](./getting-started#容器挂载卷-volume-mappings-) 与 [部署页](./deployment#四生产级-docker-compose)。

---

## 二、卷结构总览（容器视角）

容器内部固定路径如下（`DATA_PATH` 默认 `/server/data`，可用环境变量改）：

```
/server/
├── data/                         ← 必挂 ./data（宿主机）
│   ├── config.js                ← 系统配置（后台全屏可改项，自动每日留备份）
│   ├── config.js.bak / daily/*  ← 本地配置备份副本
│   ├── music-accounts.json      ← 平台账号 Cookie（加密存储）
│   ├── qishui-pending.json      ← 汽水待处理任务
│   ├── logs/                    ← 默认日志位置（LOG_PATH 默认 /server/data/logs）
│   ├── backups/                 ← WebDAV / 本地备份落点
│   └── users/
│       ├── <用户名>/
│       │   ├── users.json       ← 用户档案（昵称、头像、偏好）
│       │   ├── states.json      ← 音源状态（哪些被禁用 disabledSources）
│       │   ├── sources.json     ← 该用户私有自定义音源清单
│       │   ├── settings.json    ← 用户级设置（含 serverCacheLocation）
│       │   ├── radioStations.json ← 自建电台
│       │   └── （data 模式下）cache/ music/   ← 缓存与下载（见第四节）
│       └── source/              ← 自定义音源脚本与共享清单
│           ├── _open/           ← 公开（未登录）用户共享的音源
│           │   ├── sources.json
│           │   ├── states.json
│           │   └── order.json
│           └── <用户名>/
│               ├── <源名>.js    ← 音源实现脚本
│               ├── states.json
│               ├── order.json
│               └── sources.json
├── cache/                       ← 必挂 ./cache（root 模式：播放缓存 /server/cache/<用户>）
├── music/                       ← 必挂 ./music（root 模式：下载目录 /server/music/<用户>）
└── cover_cache/                 ← 必挂 ./cover_cache（封面缓存，恒定写工作目录）
```

> 上面 `data/users/<用户名>/` 与 `data/users/source/<用户名>/` 是**两套不同目录**：
> - 前者是「用户数据」（档案、设置、私有源清单、电台）；
> - 后者是「自定义音源代码 / 共享清单」（音源 `.js` 脚本、order 排序）。
> 备份时两个都要带。

---

## 三、各文件 / 目录的作用

| 文件 / 目录 | 作用 | 丢了会怎样 | 是否必备份 |
| :--- | :--- | :--- | :--- |
| `data/config.js` | 系统级配置：管理员密码、播放器路径、缓存位置、WebDAV、各项开关 | 回到出厂默认（管理员密码变 `123456`，需重设） | ✅ 必备 |
| `data/music-accounts.json` | 平台账号（网易/QQ/微信/酷狗/**汽水**/**B站**）的 Cookie，**加密**存储 | 平台账号需重新扫码 / 填 Cookie 登录 | ✅ 必备份（否则要重新登录） |
| `data/users/<用户>/users.json` | 用户档案 | 用户配置丢失（歌单本身在同步数据里，一般还在） | ✅ 备 |
| `data/users/<用户>/states.json` | 音源开关状态（`disabledSources`）。平台连续失败会自动写这里关解析 | 被禁用过的源重新尝试解析（可能再卡） | ✅ 备 |
| `data/users/<用户>/sources.json` | 该用户私有自定义音源清单 | 私有音源列表丢失（脚本若在 source/ 下还在，可重新挂） | ✅ 备 |
| `data/users/source/**` | 自定义音源 `.js` 脚本 + 公开/私有清单（`_open` 为共享） | 自定义音源全部失效，需重新上传 | ✅ 必备份 |
| `data/users/<用户>/settings.json` | 用户级设置，含 `serverCacheLocation`（root/data） | 缓存落点回退默认 | ⚠️ 建议备 |
| `data/users/<用户>/radioStations.json` | 自建电台 | 电台丢失 | ⚠️ 可选 |
| `data/qishui-pending.json` | 汽水待处理任务 | 进行中的汽水任务丢失 | ⚠️ 可选 |
| `data/logs/` | 运行日志（排错入口） | 历史日志丢失，不影响运行 | ⚠️ 可选 |
| `data/backups/` | 自动 / 手动备份产物 | 失去一份备份副本（源数据还在则无妨） | ⚠️ 可选 |
| `cache/` `music/` | 播放缓存 / 下载的音频文件 | 缓存/已下载歌曲丢失，可重新缓存 | ⚠️ 体积大，按需 |
| `cover_cache/` | 封面缩略图 | 封面需重新抓取，不影响播放 | ⚠️ 可重建，可选 |

> **最小备份集**（丢了会真疼的）：`data/config.js` + `data/music-accounts.json` + `data/users/`（整个目录）。其余都能重建。

---

## 四、四种缓存落点（root / data 模式）

播放缓存与下载目录的**实际位置**由 `serverCacheLocation` 决定（用户级 `settings.json` 可覆盖系统级 `config.js`）：

| 模式 | 缓存 | 下载 | 对应挂载 |
| :--- | :--- | :--- | :--- |
| `root`（默认） | `/server/cache/<用户>` | `/server/music/<用户>` | 挂 `./cache`、`./music` |
| `data` | `/server/data/cache/<用户>` | `/server/data/music/<用户>` | 只挂 `./data` 即可 |

- 索引文件：`cache_index.json`（缓存索引）、`music_index.json`（下载索引），分别在各自的 `cache/` `music/` 目录下。
- **无论哪种模式，`cover_cache` 都恒定写在 `/server/cover_cache`**（容器工作目录），不受开关影响 → 必须单独挂 `./cover_cache`。
- 切换 root↔data 后，旧的缓存/下载不会自动搬，需要手动 rsync 或重新缓存。

---

## 五、怎么备份

### 5.1 内置 WebDAV 增量备份（推荐）

后台「系统设置 → 备份」可配置 WebDAV 目标（坚果云 / 群晖 / 自建等）。特点：

- **增量**：只传变化的文件，省带宽。
- 自动按策略执行，落点在 `data/backups/`（本地）并同步到 WebDAV。
- 恢复时从 WebDAV 拉回并解压，会先确认 `data` 里有 `config.js` 才覆盖，避免把云端空配置砸下来。

> 没配 WebDAV 也行：`data/config.js` 本身有**每日本地副本**（`config.js` 落值时会自动留备份），算一层兜底。

### 5.2 手动冷备（拷 data 卷）

最朴素也最稳：停容器后，把宿主的 `./data` 整个目录打个压缩包。

```bash
# 停容器（避免备份时文件被写）
docker stop lx-sync-server

# 打包 data（cache/music/cover_cache 按需，体积可能很大）
tar -czf lxserver-data-$(date +%F).tar.gz ./data

# 可选：连缓存一起备（体积大，注意磁盘）
# tar -czf lxserver-full-$(date +%F).tar.gz ./data ./cache ./music ./cover_cache

docker start lx-sync-server
```

### 5.3 备份清单：最少要备什么

| 优先级 | 路径 | 说明 |
| :--- | :--- | :--- |
| 🔴 必备 | `./data/config.js` | 系统配置 |
| 🔴 必务 | `./data/music-accounts.json` | 平台账号凭证（否则重新登录） |
| 🔴 必备 | `./data/users/` | 全部用户档案 + 音源脚本 |
| 🟡 建议 | `./data/users/*/settings.json` | 用户缓存位置偏好 |
| 🟡 建议 | `./data/logs/` | 排错历史 |
| 🟢 可选 | `./cache` `./music` `./cover_cache` | 音频/封面，可重建 |

---

## 六、换机迁移步骤

场景：旧机器容器 `lxserver-old` → 新机器 `lxserver-new`（同镜像版本，数据完整搬过去）。

**步骤 1 — 停旧机写入**
```bash
docker stop lxserver-old        # 确保备份时没有被写
```

**步骤 2 — 导出数据**
把旧机的 `./data`（至少）拷出来。最稳是 `tar` 到可移动盘 / 网络共享，或先 `docker cp` 出容器里的 `/server/data` 再拷。
```bash
# 旧机
tar -czf lxserver-data.tar.gz ./data
# 传送到新机（scp / 移动盘 / 共享文件夹 任选）
```

**步骤 3 — 新机建目录结构**
新机准备好四个挂载目录，并把 `data` 解压进去：
```bash
# 新机
mkdir -p /opt/lxserver/{data,cache,music,cover_cache}
tar -xzf lxserver-data.tar.gz -C /opt/lxserver/   # 解压出 data/
```

**步骤 4 — 用相同版本启动**
新机 `docker run` / `docker-compose` 用**同一个镜像版本号**（别用 `latest`，避免新旧代码读旧数据不兼容），挂载同样的四个卷，环境变量（尤其 `ADMIN_PASSWORD`、`TZ`、`PROXY_HEADER`）保持一致。
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

**步骤 5 — 验证**
```
http://<新机IP>:9527/health     # 返回 JSON = OK
```
进后台确认：用户都在、平台账号（读 `music-accounts.json`）仍登录着、自定义音源脚本在 `data/users/source/` 下完好。

**步骤 6 — 换地址后的收尾**
- 如果新机 IP / 域名变了：更新 LX 客户端、Subsonic 客户端的连接 URL；反代规则指向新宿主端口。
- 如果版本也跟着升了：先备好旧 `data`，启动后用 `/health` 确认音源数、巡检正常；异常就改回旧版本标签启动（`data` 卷不受影响，可随时回滚）。

> ⚠️ **不要在「运行中的旧容器」和「新容器」同时挂同一个宿主 `data` 目录**（会双写损坏）。迁移期间旧容器保持 `stop`。

---

## 七、常见坑

| 现象 | 原因 / 解决 |
| :--- | :--- |
| 恢复备份后管理员密码不对 | 云端备份里 `config.js` 是旧的；用备份时的 `ADMIN_PASSWORD` 或重置。恢复逻辑会避免空配置覆盖，但版本跨度大时要核对 |
| 换了机器平台账号要重新登录 | `music-accounts.json` 没一起搬 → 备份清单里它是🔴必务项，务必带上 |
| 缓存/下载在新机器是空的 | 之前是 `root` 模式，数据在 `./cache` `./music`，只搬了 `data` → 把 `cache`/`music` 也一并传过去；或改 `data` 模式重缓存 |
| 封面全丢 | `cover_cache` 没挂/没搬 → 补挂载，封面会重新抓取 |
| 新机器起不来 / 报权限错 | `data` 目录属主不是容器用户 → `chown -R` 到合适 uid，或确认挂载权限为读写 |
| 升级后自定义音源失效 | 跨大版本音源 API 可能变 → 先看 `data/users/source/` 脚本是否完好，必要时按新版本重传 |

> 部署 / 反代相关问题见 [部署页](./deployment)；fnOS 实操见 [fnOS 部署实战](./deploy-fnOS)；设置与配置规则见 [应用设置与配置规则](./app-settings)。
