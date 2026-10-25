# 使用教程（Web 播放器 / 客户端同步 / Subsonic / 下载与缓存）

> 从打开第一个页面到播放第一首歌，这份教程带你走完 **全部核心链路**；每个操作都标出“在哪改、存在哪”。

---

## 目录

- [🏠 第一步：访问 Web 播放器](#-第一步访问-web-播放器)
- [👤 第二步：登录与创建用户](#-第二步登录与创建用户)
- [🔍 第三步：搜索与播放](#-第三步搜索与播放)
- [📻 第四步：管理歌单与收藏](#-第四步管理歌单与收藏)
- [📥 第五步：下载与服务器缓存](#-第五步下载与服务器缓存)
- [🎵 第六步：连接 LX Music 桌面/移动端客户端](#-第六步连接-lx-music-桌面移动端客户端)
- [🔌 第七步：接入 Subsonic 客户端（音流/Feishin/Symfonium）](#-第七步接入-subsonic-客户端音流feishinsymfonium)
- [📺 第八步：小爱音箱投播](#-第八步小爱音箱投播)
- [⚙️ 第九步：管理后台（用户/备份/版本/重启）](#-第九步管理后台用户备份版本重启)
- [❓ 常见场景速查](#-常见场景速查)

---

## 🏠 第一步：访问 Web 播放器

默认地址（解压后的根路径）：`http://IP:9527`（Docker 中的 `9527` 需 `-p 9527:9527`，见 [Docker 部署](README.md#docker-部署)）。

- 若未配置 `ENABLE_WEBPLAYER_AUTH=true` → 进页即能播放（游客模式只能访问公开歌单）。
- 需要 `WEBPLAYER_PASSWORD`（默认 `123456`）时才输入；这独立于管理后台密码。

---

## 👤 第二步：登录与创建用户

### 管理员登录

`http://IP:9527/admin` → 默认管理员密码 `123456`（**生产环境请先改**）。

在「用户管理」里 **新增用户**（`users` 条目），支持：
- 改名 / 改密码 / 加权限（`enableCustomMusicDir` 可让他拥有私有音频目录）
- 公开/私密可见性控制（`enablePublicFavorites` 等开关）

### 用户 login

右键播放器右下角的「设置」→ **登录**（或用你建的账号密码在登录页登录），登录后获得个人 `data/<用户名>` 空间。

> 登录是 Web 播放器左上“用户”图标，而 `users.json` 的管理（创建/密码）在 admin 后台。

---

## 🔍 第三步：搜索与播放

Web 播放器搜的多源平台有：`wy`(网易) / `tx`(腾讯) / `kw`(酷我) / `kg`(酷狗) / `mg`(咪咕)—— 在 `subsonic.onlineSearchSources` 里配默认。

### 搜索 → 播放

1. 点搜索栏 → 选平台或全部 → 唱单（选音质: `flac`/`320k`/`128k`，在设置里可改 `preferredQuality`）
2. 若品质解析失败 → **自动降级**（`flac → 320k → 128k`）
3. 不想等解析？点 **服务器缓存**（需 `enableServerCache=true`）→ 前端先缓存，然后再播
4. 点进播放器详情页看歌词、封面、滚动

### 小细节

- 快捷键：`Space`(暂停/播放)、`ArrowRight`(下一曲)、`ArrowLeft`(上一曲)
- 调低音量的轨迹在右下角滑块上。
- **歌词翻译/罗马音**：设置里开关 `showLyricTranslation` / `showLyricRoma`

---

## 📻 第四步：管理歌单与收藏

登录后：
- 你想做的：播放器主页左下角“收藏” — 点收藏 → 加入/新建歌单 → 用 `list.addMusicLocationType`（top/bottom）控制新歌加在哪里
- 拖歌单列：在你到底层列表长按 → 拖拽排序
- 在后台管理 → **快照管理** → 一键备份/恢复（歌单、收藏、enrich）。

还有一功能：展示侧边栏歌手/专辑的右侧工具栏（收藏与清空）：
- **小道提示**：在设置界面去"`switchPlaylistOnSearchPlay`/`switchPlaylistOnSongListPlay`"开关决定搜索/歌单播放后是否**自动切歌单**（建议都开，避免播放完一歌单后找不到下一首歌）

---

## 📥 第五步：下载与服务器缓存

> 这两件事是 **完全不同路径**，直接到 `fileCache.ts` 的文件落点，不要混为一谈。

### 1）服务器缓存（边听边存）

在播放器里点「**缓存到服务器**」→ 后台丢歌到 `cache/<username>`（`root` 模式）或 `data/<username>/cache`（`data` 模式，可同步），**不阻塞播放**。

- `enableServerCache=true` 时，一遍粉色进度条走完 = 这条 **音频文件 + 同样音质的 lrc/封面标签** 都落好了。

### 2）下载（直链落盘）

在右键菜单点「下载到服务器」→ 落 `music/<username>` 下。
- **`enableOnlyDownloadMode=true`（默认）** → 直接写 `music`
- 想写 `cache`？去 **设置 → 仅下载模式** 关掉 → 再点「移动目录」到音乐库下（见下）

### 3）向 cache 与 music 之间移动

在「本地音乐」页面的工具栏里点「**移动目录**」→ 即 `batchSwitchFolder` → 双向移动，`music ← → cache`。
- **注意**：`music` 下带子目录/分类的歌不能迁移到 `cache`（只移动源文件）
- 若下载时已经缓存，**同名同音质会直接复制**（节省硬盘空间）

---

## 🎵 第六步：连接 LX Music 桌面/移动端客户端

进入客户端 **设置 → 同步设置**（见 [服务连接与客户端配置](README.md#服务连接与客户端配置)）：

### 用户路径模式（推荐）

URL = `http://IP:9527/<用户名>`，密码为用户自己的密码。
- **每个用户各自拥有自己的歌单**，支持不同用户相同密码（iOS / Mac / Win 同码也可）。

### 根路径模式

URL = `http://IP:9527`，须 `USER_ENABLE_ROOT=true`（`docker-compose.yml` 里加 `- USER_ENABLE_ROOT=true`）；这个模式下所有用户的密码必须唯一。

> PC 客户端要转发 `ws://...`（WebSocket），在容器里设 `- p 9527:9527` 足够，nuxt 根路径（`PLAYER_PATH`）或 `/socket` 兼容。

---

## 🔌 第七步：接入 Subsonic 客户端（音流/Feishin/Symfonium）

- 地址：`http://IP:9527/rest`（`SUBSONIC_PATH` 默认 `/rest`）
- 用户名/密码：你在后台建的 **用户**。
- 别忘了在 `docker-compose.yml` 里开了 `- p 4533:4533`（如果配了 `SUBSONIC_PORT=4533`）
- 在线搜索：`wy:` / `tx:` / `kw:` / `kg:` / `mg:`，`Subsonic 在线搜索` 的默认音源在 `subsonic.onlineSearchSources` 里。
- 服务端转码要 ffmpeg，Docker 镜像默认没有 ffmpeg；传不过来就 **优雅降级 302 直链**（不会报错）。

---

## 📺 第八步：小爱音箱投播

`http://IP:9527` → 设置中 **小爱音箱投播**：
- 先扫码登录（米家 App 扫）或密码/cookie
- 扬声器列表出来后选目标 → 点播放器底部「投播」即可
- 单曲 `audioID` 匹配失败时会降级到在库里搜 ` Nội dung`
- 支持 **多台同时播**，会自动续播

### 教程：投播常见问题
- 屏幕不显示 `audioID` → 关了 `xiaoai.hybrid` 设置或更新脚本

---

## ⚙️ 第九步：管理后台（用户/备份/版本/重启）

- **用户管理**: 打开关/改名/密码/快照
- **系统配置**（[应用设置与配置规则](./app-settings.md)）
- **版本信息**：`/api/status`（看 `version` 字段）
- **重启**:
  - 改 `/admin` 面板的开关 → `POST /api/admin/reload`（**修改启用即生效**）
  - 改端口/基础环境 → 点 `POST /api/restart`，Docker 靠 `--restart unless-stopped` 重启

### 日志
- 管理后台 → **系统日志**（`/api/logs?type=app`）
- 容器里查看完整日志用 `docker logs`（或者向 `logs/` 卷里看 `/server/data/logs/app.log`）
- 更新/回滚/升级路径见更新日志 `changelog.md`

---

## ❓ 常见场景速查

| 场景 | 解决 |
| :--- | :--- |
| 页面打不开 | 看没开防火墙 9527；Docker 是否 `-p 9527:9527` |
| 搜索不到歌 | 检查 `subsonic.onlineSearchSources` / 各音源是否启用 |
| 缓存歌曲但下载失败 | 检查 `enableCacheSizeLimit` 是否开了 + 容量限制，去设置里看 |
| 歌词不显示 / 翻译缺失 | 设置里 `showLyricTranslation=true`；在 `data/<user>` 里看 lrc 文件是否存在 |
| 用户同密码冲突 | 用户路径模式支持；根路径模式要唯一 |
| 音量不大 | 检查 `audio.volume` 是否被小程序控制；也可能是受 **自动代理**（`enableAutoProxy=true`） 影响 |
| TS 切换不生效 | 设置 → 默认音质 `preferredQuality` |
| 反复同步卡顿 | 看同步时间 `LX_USER` 和服务器端设置的 `sync.interval` |

---

## 扩展阅读

- [快速启动部署指南](./getting-started.md) — 镜像标签、卷挂载等部署细节
- [配置文件及环境变量](./configuration.md) — 逐表全部环境变量
- [Web 播放器指南](./web-player.md) — 播放器详情与架构
- [同步服务器设置](./sync-server.md) — 同步拓扑
- [小爱音箱投播](./xiaoai.md)
- [应用软件设置与配置规则](./app-settings.md) — 全部设置的优先级链与落盘
- [服务端 API 参考](../api/reference.md) — RESTful API
