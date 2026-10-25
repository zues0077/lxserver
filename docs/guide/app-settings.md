# 应用设置与配置规则详解

> 读完这份文档，你能弄懂 **lxserver 的所有设置从哪里来时、往哪里去，以及修改后怎样才算真正生效**。

---

## 目录

- [一、配置的来源与生效优先級](#一配置的来源与生效优先級)
- [二、系统级配置 `data/config.js`（管理后台全屏可改项）](#二系统级配置-dataconfigjs管理后台全屏可改项)
- [三、用户级配置（用户的“私人加厚版默认值”）](#三用户级配置用户的私人加厚版默认值)
- [四、Web 播放器客户端设置 `DEFAULT_SETTINGS`（`app.js` 内）](#四web-播放器客户端设置-default_settingsappjs-内)
- [五、音源文件（`data/users/source/<用户>/`）](#五音源文件datauserssource用户)
- [六、文件/缓存规则（`fileCache.ts`）](#六文件缓存规则filecachets)
- [七、环境变量（`environment variables`）](#七环境变量environment-variables)
- [八、优先级拓扑与修改生效方式速查](#八优先级拓扑与修改生效方式速查)
- [九、常见排错](#九常见排错)
- [扩展阅读](#扩展阅读)

---

## 一、配置的来源与生效优先級

系统中每一个可配置的“变量”，最终只取 **五层链** 中的最高权值。权重由高到低：

| 优先級 | 来自哪里 | 修改方式 | 生效方式 |
| :---: | :--- | :--- | :--- |
| **1** | **环境变量**（Docker `environment` / `export`） | compose 或 `docker run -e` | 服务启动时 / 重载配置时 |
| **2** | **WebDAV 云端**（`WEBDAV_URL` 配置的云盘） | WebDAV 远端 `config.js` | 启动时与后台点击“从云端恢复”时，覆盖本地 `config.js` |
| **3** | **`CONFIG_PATH` 指定的外部配置文件** | 编辑该外部文件 | 服务启动时 |
| **4** | **数据目录 `data/config.js`** | 管理后台「系统配置」保存 / 手动编辑 / 环境恢复 `data/config.js` | **自动热重载**（后台改完即写回 `config.js`） |
| **5** | **系统默认常量 `src/defaultConfig.ts`** | 写死在纯代码里，不能从界面改 | 只有改代码 / 升级版本时才变 |

> ⚠️ **关键设计**：显式设为 `false` / `null` 的变量，永远**高过空**的变量。比如 `serverCacheLocation: "root"` 写进了 `config.js`，即使后端的那句默认值是 `"data"`，起效的也是 `"root"`。

### 生效方式速查

- 改 `config.js`（后台/文件）→ **立即生效**（写回引擎会触发半热重载 `POST /api/admin/reload`）
- 改环境变量 → 需 **“重启服务”**（`POST /api/restart`）或重载配置
- 该变量是 **启动时一次性读取**（如 `PORT`、`SINGER_SOURCE_PRIORITY`） → 修改环境变量后必须 `restart`

---

## 二、系统级配置 `data/config.js`（管理后台全屏可改项）

它是 `src/defaultConfig.ts` 的 **JSON 镜像**，才能通过管理后台「系统配置」页修改。结构大致如下（行号基于 v1.5.35 `src/defaultConfig.ts`）：

```json
{
  "port": 9527,
  "admin": { "path": "/admin", "password": "123456" },
  "player": { "path": "/", "name": "LX Music Web", "enableAuth": false, "password": "123456" },
  "serverName": "LX Sync Server",
  "debug": { "enabled": false },
  "maxSnapshotNum": 10,
  "assets": { "path": "./assets", "theme": "./assets/theme" },
  "user": {
    "enableRoot": false,
    "enablePath": true,
    "enablePublicRestriction": true,
    "enablePublicNonAdminLocalMusic": false,
    "enablePublicNonAdminBrowserDownload": true,
    "enablePublicNonAdminServerCache": false,
    "enablePublicFavorites": false,
    "enablePublicNonAdminAccess": false,
    "enableCustomMusicDir": false,
    "enableLoginCacheRestriction": false,
    "enableCacheSizeLimit": false,
    "cacheSizeLimit": 2000,
    "enableCoffee": true
  },
  "webdav": { "enable": false, "url": "", "username": "", "password": "", "syncPath": "/lx-sync", "backupPath": "/lx-sync-backups" },
  "sync": { "interval": 60, "backupInterval": 24, "excludeCache": false, "excludeMusic": false },
  "configBackup": { "enable": true, "retentionDays": 7, "dir": "" },
  "snapshot": { "backupPath": "" },
  "list": { "addMusicLocationType": "top" },
  "proxy": { "all": { "enabled": false, "address": "" } },
  "singer": { "sourcePriority": "tx,wy" },
  "subsonic": {
    "enable": true,
    "path": "/rest",
    "port": 0,
    "enableDebug": false,
    "onlineSearch": true,
    "onlineSearchMode": "fallback",
    "onlineSearchSources": "wy,tx,kw,kg,mg",
    "publicLeaderboards": false,
    "leaderboardSource": "tx",
    "lyricTranslation": true,
    "cacheOnPlay": false,
    "playCacheFirst": true,
    "quality": { "enabled": true, "priority": "flac,320k,128k" }
  },
  "artist": { "maxFetchPages": 20 },
  "cache": { "namingPattern": "simple" },
  "system": { "allowUnsafeVM": false },
  "users": [ ... ],
  "customSource": {
    "probe": { "enabled": true, "intervalMinutes": 180, "failThreshold": 2, "autoDisablePlatform": true, "autoRemoveSource": true },
    "sourceGuard": { "enabled": true, "safeChannel": true, "vmInjections": false, "allocatedDeclarations": ... },
    "delaySince": true,
    "lyric": { "weakTrusted": ["kugou", "qq", "kuwo", "netease", "migu", "open"] }
  },
  "xiaoai": { ... 小爱音箱投播配置 ... }
}
```

### 管理类按钮（管理后台「服务器管理」）

| 按钮名 | 底层操作 | 何时用到 |
| :--- | :--- | :--- |
| **重启网络** | `POST /api/admin/reload` 重新加载全部配置+用户+音源；**只改配置时**用它，**不用 `restart`** | 修改 `config.js` 非端口项后 |
| **重启服务** | `POST /api/restart` 结束进程 | 改环境变量（`PORT` 等）后必须用它 |
| **注销内存** | 清除 Session 与缓存内存 | 注册/出问题时 |

> ⚠️ 在 **Docker 中点了「重启服务」必须靠容器 `--restart unless-stopped` 策略**自动拉起进程，容器策略漏写就彻底停掉。

---

## 三、用户级配置（用户的“私人加厚版默认值”）

在 `data/config.js` 的 `users` 数组（或 `data/users.json`）里：

```json
{ "name": "user1", "password": "pass123", "enableCustomMusicDir": false, "customMusicDir": "", "allowOperateCustomMusicDir": false, "allowWriteCustomMusicDir": false, "enablePublicNonAdminAccess": false, "enablePublicNonAdminLocalMusic": false, "enablePublicNonAdminServerCache": false, "enablePublicFavorites": false, "users": [...] }
```

每个用户还应有一个 **用户设置目录（`data/<用户名>/config.js` 或 `data/<username>/settings.json`）**，记录了用户偏好：

- 喜欢 **音质**、歌词、列表页数、语言偏好、客户端同步地址
- WebDAV 的 **用户独立** `data/<用户名>` 目录实现隔离

### 写入权限

| 用户类型 | 修改入口 | 限制 |
| :--- | :--- | :--- |
| **管理员** | 管理后台「用户管理」/ 系统配置 | 无限制 |
| **登录用户** | Web 播放器右下角「设置」 | 只改自己的播放/显示/缓存偏好 |
| **游客（未登录）** | 无法修改任何系统设置 | 有限的公开信息查看 |

> 推送 `LX_USER_<用户名>=<密码>` 是 **初始化走 env**，注册后 `users.json` 才会持久化。

---

## 四、Web 播放器客户端设置 `DEFAULT_SETTINGS`（`app.js` 内）

`public/music/app.js` 里定义了 **播放器客户端的完整默认值字典**（以 `preferences` 的后端 `plugin.settings` 落盘为最终可修改配置，以下为准）：

| 字段 | 默认 | 说明 |
| :--- | :--- | :--- |
| `itemsPerPage` | `20`（`'all'`=全量） | 列表分页 |
| `defaultEntry` | `favorites` | 进站默认页 |
| `preferredQuality` | `flac` | 默认音质偏好 |
| `enablePublicSources` | `true` | 是否显示公开源 |
| `enableProxyPlayback` / `enableProxyDownload` | `false` | 播放/下载代理 |
| `enableAutoProxy` | `true` | 自动代理（HTTPS 下 HTTP 资源切代理） |
| `enableCustomProxy` / `customProxyUrl` | `false` / `''` | 自定义代理（`${url}` 占位） |
| `enableOnlyDownloadMode` | `true` | 仅下载模式（**下载写 music 目录**） |
| `downloadConcurrency` | `3`（1≈5） | 下载并发 |
| `hotSearchLimit` | `20` | 热搜显示条目 |
| `lyricFontSize` | `1.25` | 歌词字体（rem） |
| `lyricFontFamily` | `''` | 歌词字体 |
| `switchPlaylistOnSearchPlay` | `true` | 搜索时切歌单 |
| `switchPlaylistOnSongListPlay` | `true` | 歌单时切歌单 |
| `autoFilterDislikedSongs` | `true` | 自动剔除不喜欢的歌曲 |
| `autoResume` | `true` | 自动恢复进度 |
| `showSidebarSongInfo` | `false` | 侧边栏显示歌曲信息 |
| `enableCrossfade` | `true` | 淡入淡出 |
| `keepScreenAwake` | `true` | 保持唤醒 |
| `enableKeyboardShortcuts` | `true` | 快捷键 |
| `showLyricTranslation` / `showLyricRoma` / `swapLyricTransRoma` | `true`/`false`/`false` | 歌词翻译/罗马音/互换 |
| `autoCompactPlaybar` | `true` | 自动精简播放条 |
| `enableAutoSwitchSource` / `enableAutoSwitchApiSource` | `true` | 音质失败自动换源 |
| `enableAutoSkipOnError` | `true` | 失败自动下一曲 |
| `enableAutoDegradeQuality` | `true` | 自动降级音质（`flac → 320k → 128k`） |
| `playbackErrorPriority` | `platform,quality,next` | 错误处理优先级 |
| `enablePreloader` / `disablePreloadSkip` | `true`/`false` | 预读 |
| `enableSmtcLyric` | `true` | SMTC 歌词（锁屏/媒体键） |
| `showFooterVisualizer` / `footerVisualizerStyle` | `true`/`bars` | 底部波形 |
| `enableServerCache` / `enableServerLyricCache` / `embedLyricToFile` | `true` | 服务器缓存与歌词/标签 |
| `serverCacheLocation` | `root` | `root`（容器卷）/ `data`（同步到 `data`） |
| `serverCacheNamingPattern` | `simple` | 缓存文件命名 (`simple`/`standard`) |
| `enableRemaster` | `false` | 洗版/降码 |
| `enableLyricCache` / `enableSongUrlCache` | `true` | 本地链接缓存 |
| `enableLyricGlow` | `true` | 歌词荧光 |
| `enablePersistentToken` | `false` | 持久化 Token |
| `playerBackground` | `blur` | 背景效果 |
| `saveAccountSettingsToFile` | `true` | 把播放器设置写文件 |
| `autoUpdateNetworkList` / `networkListAutoCheckInterval` | `false`/`6h` | 网络歌单自动更新 |
| `remoteSyncUrl` / `remoteSyncCode` | `''` | 客户端离线同步地址与密码 |
| `enableClientModeSync` | `false` | 模拟桌面端向远程列通过同步需 |
| `lastRemoteSyncMode` | `merge_remote_local` | 上次同步模式 |
| `deduplicatePlaylistByQuality` | `true` | 同 ID 仅加最高音质 |

> 搜索引擎 **健康模型**：当响起 `error`，自动降级顺序为 `flac → 320k → 192k → 128k`，由 `playbackErrorPriority` 与 `enableAutoSwitchSource` 控制。

前台修改（播放器右下角设置面板）→ 写入 `settings/` 对象的 `localStorage`（WeakRef），对应的客户端配置再经过 `POST /api/user/catalog` 推送给所有设备。

---

## 五、音源文件（`data/users/source/<用户>/`）

第三方音源脚本与状态管理都在这个目录下，**每个用户独立一份**：

| 文件 | 职责 | 备注 |
| :--- | :--- | :--- |
| `<js>/<脚本>.js` | 公开/私有音源脚本本体 | 管理员拖入公开目录 `_open`；登录后上传写 `<用户>` |
| `states.json` | 个人源状态（启用/禁用/屏蔽） | 公开源的开关状态在此 **不是管全局，只改用户个人** |
| `order.json` | 拖拽排序 | 分 **已启用/未启用** 两组；公开源与私有源合并排序 |
| `_open` | 公开源的默认目录，所有人的可见范围 | 管理员添加公开源 |
| `platforms/` | 引入的音源平台设置 | 可包含平台的私有 key |
| `sources.json` | 音源信息本体（`name`, `url`, `content`） | `qualitys` 声明每个平台的音质项 |
| `order` / `platforms` | else | 其他对应设置 |

**隔离等级**：
- 公开全局源 `_open` 上上传的私有同名源 ID → **覆盖公开源（放弃公开，使用私有）**
- 用户自己禁用了 `states.json` 的私有源 → 不向公共源降级
- 公开源被管理员删了 → 本地无感退回公共排序

---

## 六、文件/缓存规则（`fileCache.ts`）

管理后台「设置 → 文件缓存」里修改参数，实际在 `src/server/musicAccount/fileCache.ts` 落地。

**核心参数**：

| 参数 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `serverCacheLocation` | `root` | `root` 挂在 `/server/cache`；`data` 挂在 `/server/data/<用户>/cache` |
| `preferredQuality` | `flac` | 首选音质 |
| `downloadConcurrency` | `3` | 同时下几首歌（1–5） |
| `enableCacheSizeLimit` | `false` | 开关 |
| `cacheSizeLimit` | `2000`MB | 超了按 LRU 删 |
| `cacheNamingPattern` | `simple` | `simple`/`standard`（文件名不同） |
| `worker` | `true` | 是否有 AS 服务线程来跑下载 |

**`ensureDir` 行为**：

```js
ensureDir(username, isOnlyDownload) // 只下载时写到 music， cdn/cache 时写到 cache
```

- 声音 **只写一个目录**：`music/<username>` / `cache/<username>`；打开 `root` 选项后，在 `data` 下 `cache`/`music` 各一份。
- 同名冲突 → 加 `(i)` 后缀
- 如果是同名 `.lrc` + `.mp3` 互相关联，删文件时一起清。
- 重复下载 → 相同噪点质量/文件存在，**直接复制不重下**。

**文件名**：`<歌名> - <歌手> - <音质> - <专辑>`（simple），非法字符替换为 `_`，大于 200 截断。

---

## 七、环境变量（`environment variables`）

它不为 `config.js` 服务，是 **最快最稳的启动参数**（之后也能被面板热重载改回）。

### 显式启用必须写在 `LX_USER` 之类的自定义条目里，比如：

| 变量名 | 说明 | 备注 |
| :--- | :--- | :--- |
| `PORT` | 9527 | 服务端口 |
| `ADMIN_PASSWORD` | 123456 | 初始密码 |
| `ENABLE_WEBPLAYER_AUTH` | boolean | 播放器认证开关 |
| `WEBPLAYER_PASSWORD` | 123456 | 播放器密码 |
| `ENABLE_DEBUG` | boolean | 调试模式 |
| `CONFIG_PATH` | /path/ | 外部配置文件 |
| `DATA_PATH` | /server/data | 数据路径 |
| `LOG_PATH` | /server/data/logs | 漏写 `LOG_PATH` 会存到 `data/logs` |
| `LX_USER_<name>` | password | 自动注册用户 |
| `SUBSONIC_PORT` | 4533 | 需要 `-p 4533:4533`（或 docker compose ports） |
| `ENABLE_PUBLIC_USER_RESTRICTION` | bool | 公共用户限制开关 |
| ... | | 更多见配置指南 |

### 其他环境变量
- `LX_USER_<用户名>` 首字符 **不能是数字**（必须用字母/下划线）
- **默认密码**：`admin.password` / `player.password` = `862080`（`src/defaultConfig.ts`）

### 布尔值等
- Thanks `1`, `true`, `yes`, `on`, `y` 和 `0`, `false`, `no`, `off`, `n` 都支持。

---

## 八、优先级拓扑与修改生效方式速查

```
[ 环 境 变 量 / 云 端 WebDAV ]  → 最高优先級 —— 需要重启
        ↓
[ 自 定 义 config.js ]
        ↓
[ 后 台 面 板 改 配 置 ]  → 即写即生效到 data/config.js （半热重载）
        ↓
[ 系 统 默 认 src/defaultConfig.ts ]  → 最低
```

- **每改一条** → 考虑它的“所属级别”：
  - 面板没写进去的 → 去 `config.js` 配（加），因为面板只列出显式项
  - 面板写了的 → 立即生效
- **改 `PORT`**：必须重启服务（后端监听的，重载没用的）
- **改 `ENABLE_WEBPLAYER_AUTH`**：需要某些强制cookie重新登录

---

## 九、常见排错

- 改了 `config.js` 不生效 → **不重启面板服务**；用“重启网络”或“重启服务”，看控制台；
- 如果 `config.js` 不生效 → 前后端分开推，忘记同步 → 核查环境变量（Docker 里 `-e` 的传入同源）
- **面板改了不生效** → 可能 `config.js` 没被保存，也可能是 `WEBPLAYER_PASSWORD` 写错导致用户重新获取 token（密码没变但hash需要匹配 session）；
- **多用户时最大同步数 > 其实它就一个**：是否启用了 `enablePublicRestriction`？
- 不想让管理员看到公开收藏/列表 → 在“用户管理”-右侧弹窗切 **私密/公开**；
- 音源锁屏/SMTC 不显示 → `enableSmtcLyric`（default true），在 `ls` 里检查；
- `enablePublicFavorites` = 公开收藏夹，如果停了 → 仅在“前台可见”。

---

## 扩展阅读

- [配置文件及环境变量（详细表）](./configuration.md)
- [快速启动部署指南](./getting-started.md)
- [Web 播放器指南](./web-player.md)
- [同步服务器设置](./sync-server.md)
- [音源自检护栏](./source-guard.md) · [平台可用性巡检](./source-probe.md) · [小爱音箱投播](./xiaoai.md)
