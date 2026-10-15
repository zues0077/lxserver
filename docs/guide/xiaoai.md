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
```

- 音箱只会照 URL 拉流，无法携带登录态，所以「谁能拉流」靠 URL 里的 HMAC 签名控制（`data/xiaoai.secret`）。
- 在线歌曲一律经 `/api/music/xiaoai/stream` 中转，回源时补上浏览器 UA 与 Referer，规避防盗链。
- 账号登录走米家云接口：`account.xiaomi.com` 取 `serviceToken`，`api2.mina.mi.com` 下发设备指令。

## 使用步骤

1. 打开 Web 播放器 → **设置** → **小爱音箱**。
2. 打开「启用小爱投播」。
3. 填写**服务地址**：必须是**音箱能访问到**的地址。
   - 局域网：`http://<NAS或服务器的局域网IP>:9527`
   - 反向代理：填对外域名，例如 `https://lx.example.com`
   - 留空则按当前页面地址自动推断（仅在浏览器与音箱同一网段且地址一致时可用）
4. 登录小米账号：推荐「扫码登录」，用米家 App 扫码即可；也可用账号密码或 Cookie。
5. 点「刷新设备」，勾选要播放的音箱（可多选）。
6. 点「投送到小爱」，之后在播放器里播放歌曲即会投送到音箱。

## 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/music/xiaoai/config` | 读取配置与登录状态 |
| POST | `/api/music/xiaoai/config` | 保存 `enabled` / `serverBaseUrl` / `selectedDeviceIds` / `keepLight` / `disabledModels` |
| POST | `/api/music/xiaoai/login/qrcode` | 获取登录二维码（`qrcodeImage` 为 data URL，可直接展示） |
| POST | `/api/music/xiaoai/login/qrcode/poll` | 轮询扫码状态：`waiting` / `scanned` / `confirmed` / `expired` |
| POST | `/api/music/xiaoai/login/password` | 账号密码登录，可能返回 `need_captcha` / `need_verify` |
| POST | `/api/music/xiaoai/login/captcha` | 提交图形验证码 |
| POST | `/api/music/xiaoai/login/verify` | 提交短信 / 邮箱验证码 |
| POST | `/api/music/xiaoai/login/cookie` | 用 `userId` + `passToken` 登录 |
| POST | `/api/music/xiaoai/logout` | 退出登录并清除本地凭据 |
| GET | `/api/music/xiaoai/devices?refresh=1` | 拉取设备列表 |
| POST | `/api/music/xiaoai/play` | 投送歌曲（可带 `deviceIds` 覆盖） |
| POST | `/api/music/xiaoai/pause` / `resume` / `stop` / `next` / `prev` | 播放控制 |
| POST | `/api/music/xiaoai/volume` | 设置音量（0-100） |
| GET | `/api/music/xiaoai/status?deviceId=` | 查询播放状态 |
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

**播放完一首不会自动播下一首**

当前版本由浏览器端驱动队列：播放器页面保持打开时，正常切歌（下一首/上一首）会重新投送。音箱独立续播（关掉页面后自动连播）暂未实现。

**多人使用**

小爱配置是服务级（全局）的：登录一个小米账号、共享一份设备列表。切换播放目标后，所有使用该播放器的用户都会投送到同一批音箱。
