# 小爱音箱投播

把 Web 播放器里的歌曲投送到小爱音箱播放（支持多台设备同时播放）。

> 该功能参考了 [songloft-org/songloft-plugin-miot](https://github.com/songloft-org/songloft-plugin-miot)（MIoT 插件）与 gefl24/lxserver 的小爱投播实现，在 lxserver 内用 TypeScript 原生重新实现，**不依赖 Python、无需额外镜像层**。

## 它是怎么工作的

```
浏览器（播放器）
   │ 1. POST /api/music/xiaoai/play  { songInfo, quality, deviceIds }
   ▼
lxserver
   │ 2. 用自定义源把歌解析成真实音频地址
   │ 3. 生成带签名、30 分钟有效的本地中转地址
   ▼
小爱音箱  ◀── 4. 通过 ubus(player_play_url / player_play_music) 下发地址，音箱自己去拉流

浏览器（自动续播守望）
   │ 5. 每 3 秒 GET /api/music/xiaoai/status 读音箱播放进度
   │ 6. 进度过半 → POST /api/music/xiaoai/prefetch 预解析下一首
   │ 7. 接近结尾 → 调播放器的「下一首」，回到第 1 步
   ▼
```

- 音箱只会照 URL 拉流，无法携带登录态，所以「谁能拉流」靠 URL 里的 HMAC 签名控制（`data/xiaoai.secret`）。
- 在线歌曲一律经 `/api/music/xiaoai/stream` 中转，回源时补上浏览器 UA 与 Referer，规避防盗链。
- 账号登录走米家云接口：`account.xiaomi.com` 取 `serviceToken`，`api2.mina.mi.com` 下发设备指令。

## 使用步骤

1. 打开 Web 播放器 → **设置** → **小爱音箱**。
2. 填写**服务地址**：必须是**音箱能访问到**的地址。
   - 局域网：`http://<NAS或服务器的局域网IP>:9527`
   - 反向代理：填对外域名，例如 `https://lx.example.com`
   - 留空则按当前页面地址自动推断（仅在浏览器与音箱同一网段且地址一致时可用）
3. 登录小米账号：推荐「扫码登录」，用米家 App 扫码即可；也可用账号密码或 Cookie。
4. 点「刷新设备」，勾选要播放的音箱（可多选）。
5. 点「投送到小爱」：会把**当前歌曲立即投到音箱**，并把这个页面的播放目标切到小爱；此后点播放/切歌都会投送到音箱。切回本机点「切回本机播放」。
6. 想让**歌单自动连播**，保持「播放完自动下一首」处于开启状态（默认开启）。

## 自动续播（歌单连播）

音箱播完一首不会通知播放器，所以由播放器侧盯住音箱状态，到点自动接下一首。

**判定规则**

| 情况 | 行为 |
| --- | --- |
| 正常播放中 | 什么都不做，界面显示实时进度 |
| 进度超过 60% | 提前向服务端预解析下一首，切歌时直接命中缓存 |
| 进度超过 98%（接近结尾） | **提前切歌**，避开解析耗时，两首歌之间几乎无缝 |
| 设备已停止且进度在末尾（≥97%） | 判定播完，切下一首 |
| 设备不上报进度（老固件） | 仅在「确认停止 6 秒以上」后切歌，门槛更保守 |
| 你点了暂停 | 停止守望，点播放恢复后才继续续播 |
| 音箱被语音/米家 App 停在中途 | **不切歌**，继续等它恢复 |
| 长时间无人播放（4 分钟） | 停止守望，避免一直轮询云端 |
| 状态连续查询失败 | 累计 6 次后停止守望并提示 |

**与播放模式一致**：切歌走播放器自身的「下一首」入口，因此随机播放、单曲循环、顺序播放、列表循环的行为与本地播放完全相同；随机模式下还会把预解析选中的那首「钉住」，确保解析的和播出的是同一首。

**为什么需要它**：投送模式下浏览器里其实没有在播放音频，播放器无法像本地播放那样感知「这首放完了」，必须靠主动查询音箱状态来判断。

**限制**

- **播放器页面必须保持打开**：守望跑在浏览器里（心跳放在 Web Worker，避免切到后台标签后被节流）。关掉页面后，音箱会把当前这首放完，但不会自动接下一首。
- 多台音箱同时播放时，以**勾选的第一台**作为进度来源。

## 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/music/xiaoai/config` | 读取配置与登录状态 |
| POST | `/api/music/xiaoai/config` | 保存 `serverBaseUrl` / `selectedDeviceIds` / `keepLight` / `disabledModels` |
| POST | `/api/music/xiaoai/login/qrcode` | 获取登录二维码（`qrcodeImage` 为 data URL，可直接展示） |
| POST | `/api/music/xiaoai/login/qrcode/poll` | 轮询扫码状态：`waiting` / `scanned` / `confirmed` / `expired` |
| POST | `/api/music/xiaoai/login/password` | 账号密码登录，可能返回 `need_captcha` / `need_verify` |
| POST | `/api/music/xiaoai/login/captcha` | 提交图形验证码 |
| POST | `/api/music/xiaoai/login/verify` | 提交短信 / 邮箱验证码 |
| POST | `/api/music/xiaoai/login/cookie` | 用 `userId` + `passToken` 登录 |
| POST | `/api/music/xiaoai/logout` | 退出登录并清除本地凭据 |
| GET | `/api/music/xiaoai/devices?refresh=1` | 拉取设备列表 |
| POST | `/api/music/xiaoai/play` | 投送歌曲（可带 `deviceIds` 覆盖） |
| POST | `/api/music/xiaoai/prefetch` | 预解析下一首的播放地址（自动续播用，结果缓存 10 分钟） |
| POST | `/api/music/xiaoai/pause` / `resume` / `stop` / `next` / `prev` | 播放控制 |
| POST | `/api/music/xiaoai/volume` | 设置音量（0-100） |
| GET | `/api/music/xiaoai/status?deviceId=` | 查询播放状态（含 `progressRatio` 播放进度比例） |
| GET | `/api/music/xiaoai/stream?token=` | 音频中转地址（由签名 token 授权，无需登录态） |

除 `stream` 外，其余接口需要管理员口令（`x-frontend-auth`）或已通过认证的播放器会话。

## 配置文件

写在数据目录（容器内 `/server/data`）下：

- `xiaoai.config.json`：开关、服务地址、选中设备、设备列表等
- `xiaoai.token.json`：登录态（`passToken` + `serviceToken`），**权限 600，不包含密码**
- `xiaoai.secret`：流地址签名密钥，删除后已下发的播放链接立即失效

登录成功后只持久化 `passToken`，`serviceToken` 过期时会自动静默续期（约 12 小时一次）。

## 常见问题

**音箱提示"播放失败"或没有声音**

1. 检查「服务地址」是否为音箱能访问的地址（最常见问题）。容器内不要填 `127.0.0.1`。
2. 确认音箱与服务器网络互通：在手机浏览器打开 `http://<服务地址>/health` 看是否返回正常。
3. 部分型号（`LX04`/`L05B`/`X08A` 等）必须走 `player_play_music`，服务端已内置型号白名单；若某个型号出现「灯亮但无声」，可在配置里把该型号加入 `disabledModels` 强制改走 `player_play_url`。

**账号密码登录返回"需要二次验证"**

小米对新设备登录有风控。优先使用**扫码登录**；或在浏览器登录小米账号后，从 Cookie 里取 `userId` 与 `passToken` 用 Cookie 方式登录。

**播放完不会自动播下一首**

请确认：
1. 设置里的「播放完自动下一首」是开启状态；
2. 播放器页面保持打开（自动续播由页面驱动）；
3. 从「播放目标」投送后再开始播放歌单，而不是只在本机播。

若界面提示「音箱没有开始播放」或「无法读取音箱状态」，说明音箱状态查询不通，通常是登录态过期或设备离线，重新扫码登录并刷新设备即可。

**多人使用**

小爱配置是服务级（全局）的：登录一个小米账号、共享一份设备列表。切换播放目标后，所有使用该播放器的用户都会投送到同一批音箱。
