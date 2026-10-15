# 自定义源平台可用性巡检

一个自定义音源脚本通常会同时声明多个平台（`wy` / `tx` / `kw` / `kg` / `mg` / `qsvip` …），
但实际上其中总有几个平台的接口是坏的：官方风控收紧、接口下线、脚本作者没跟上更新。

坏掉的平台会带来很实际的体验问题——播放时服务器仍会先去试它，等它超时或报错，再换下一个音源，
用户侧就是「点了播放要愣好几秒才出声」。

**平台可用性巡检**会主动把这些坏平台找出来并关掉，让播放路径直接跳过它们。

## 工作机制

巡检分三步：

```
① 新添加的音源      上传 / 导入成功后，立即逐个平台探测一次
② 定时复检          按 customSource.probe.intervalMinutes 周期，对「剩余可用平台」再探测
③ 处置
   平台连续失败 ≥ failThreshold 次   →  自动关闭该平台的解析（写 states.json 的 disabledSources）
   某音源全部平台都不可用            →  自动移除该音源（默认移入同级 .trash/，可恢复）
```

判定一次「平台不可用」要同时满足：

1. 音源脚本调用 `musicUrl` 抛错或超时（默认 15 秒）；
2. 或脚本返回了内容但不是合法的 `http(s)` 播放直链（含试听片段标记也算无效）；
3. 开启 `verifyLink` 时（默认开），还会对返回的链接发一次 `Range: bytes=0-1` 的探测请求，
   链接返回 4xx/5xx 同样判定失败——这能识别「脚本还能跑，但拿到的链接早就失效了」的平台。

并且必须**连续失败达到阈值**（默认 2 次）才会真正关闭，单次失败只记状态、不动开关，避免网络抖动误伤。

### 自动关闭 vs 手动关闭

平台开关和面板上的「平台启用/禁用」是**同一份状态**（`states.json` 的 `disabledSources`），
所以巡检关掉的平台在面板上能直接看到，也可以手动再打开。

两者的区别在于：

| 来源 | 会被自动复检 | 会被自动恢复 |
| --- | --- | --- |
| 巡检自动关闭 | 是 | 是（探测成功即自动重新开启） |
| 你手动关闭 | **否** | **否** |

也就是说，巡检只管自己关掉的东西，不会覆盖你的手动选择。

## 配置

全部配置项都可以写在 `config.js` 里（面板/配置文件改动会热重载）：

```js
module.exports = {
  // 总开关
  'customSource.probe.enabled': true,

  // 复检间隔（分钟）
  'customSource.probe.intervalMinutes': 180,

  // 连续失败多少次判定平台不可用
  'customSource.probe.failThreshold': 2,

  // 单个平台单次探测超时（毫秒）
  'customSource.probe.timeoutMs': 15000,

  // 探测并发数
  'customSource.probe.concurrency': 2,

  // 是否对返回链接做可达性校验
  'customSource.probe.verifyLink': true,

  // 平台不可用时自动关闭该平台
  'customSource.probe.autoDisablePlatform': true,

  // 音源全部平台不可用时自动移除该音源
  'customSource.probe.autoRemoveSource': true,

  // 移除方式：trash = 移入同级 .trash/ 目录（可恢复）；delete = 直接删除
  'customSource.probe.removeMode': 'trash',

  // 新添加的音源是否立即巡检
  'customSource.probe.probeOnNewSource': true,

  // 各平台测试曲目覆盖（见下一节）
  'customSource.probe.testSongs': {},
}
```

### 探测用哪首歌？

探测一个平台是否可用，必须给它一首歌去解析。测试曲目按以下优先级选取：

1. **`customSource.probe.testSongs`** —— 你显式指定的曲目：
   ```js
   'customSource.probe.testSongs': {
     wy: { songmid: '1903149553', name: '无名的人', singer: '毛不易' },
     tx: { songmid: '004bd0xxxx', name: '晴天', singer: '周杰伦' },
   }
   ```
2. **服务器缓存索引** —— 用户实际播放成功过的同平台歌曲（零配置，最贴近真实场景）。
3. **内置 SDK 搜索兜底** —— 用内置搜索接口取一首。

如果三者都拿不到测试曲目，该平台会被标记为 `skipped`（跳过），**不判定为不可用**，
也不会因此触发删除音源——证据不足时宁可不动。

## 状态与文件

| 文件 | 位置 | 说明 |
| --- | --- | --- |
| 巡检状态 | `<DATA_PATH>/users/source/<owner>/probe-status.json` | 每个源、每个平台的探测结果与连续失败次数 |
| 平台开关 | `<DATA_PATH>/users/source/<owner>/states.json` | 与面板共用；`disabledSources` 数组 |
| 审计日志 | `<DATA_PATH>/users/source/<owner>/probe-audit.log` | 关闭平台 / 移除音源等动作逐行记录（JSON Lines） |
| 回收站 | `<DATA_PATH>/users/source/<owner>/.trash/` | `removeMode: 'trash'` 时被移除脚本的备份 |

`probe-status.json` 刻意独立于 `sources.json`：
音源目录的文件监控只监听 `*.js` 与 `sources.json`，
把高频变化的状态写进独立文件就不会引发无谓的音源重载。

`_open`（公开空间）的源在关闭平台时，会同时写入 `_open/states.json` 与**每个已注册用户**的
`states.json`——因为登录用户读的是自己空间的那份，只写公开空间会被遮蔽。

### 恢复一个被移除的音源

被移除的脚本在 `.trash/` 里，文件名格式为 `<ISO时间戳>_<原文件名>`。
把它移回上级目录、并在 `sources.json` 中重新加回条目即可（或直接在面板重新导入）。

## 环境变量

| 环境变量 | 对应配置 |
| --- | --- |
| `SOURCE_PROBE_ENABLED` | `customSource.probe.enabled` |
| `SOURCE_PROBE_INTERVAL_MINUTES` | `customSource.probe.intervalMinutes` |
| `SOURCE_PROBE_FAIL_THRESHOLD` | `customSource.probe.failThreshold` |
| `SOURCE_PROBE_AUTO_DISABLE` | `customSource.probe.autoDisablePlatform` |
| `SOURCE_PROBE_AUTO_REMOVE` | `customSource.probe.autoRemoveSource` |

## 状态查询

`GET /health` 的 `sourceProbe` 字段：

```json
{
  "sourceProbe": {
    "enabled": true,
    "running": false,
    "intervalMinutes": 180,
    "failThreshold": 2,
    "autoDisablePlatform": true,
    "autoRemoveSource": true,
    "removeMode": "trash",
    "lastRunAt": 1760538600000,
    "lastRun": {
      "sourcesChecked": 36,
      "platformsChecked": 152,
      "platformsOk": 138,
      "platformsDown": 14,
      "platformsSkipped": 6,
      "newlyDisabled": ["某某音源/tx"],
      "restored": [],
      "removed": [],
      "message": "巡检 36 个音源的 152 个平台：可用 138、不可用 14、跳过 6；新关闭 1 个平台"
    },
    "autoDisabledPlatforms": [
      { "owner": "open", "sourceId": "某某音源.js", "sourceName": "某某音源", "platform": "tx", "since": 1760538600000 }
    ]
  }
}
```

### 逐平台明细（排查用）

默认 `/health` 只返回上面的汇总，不会带上每个平台的明细，避免被 Docker healthcheck 之类的
高频轮询撑大。需要排查「某个平台为什么被判不可用」时，加上 `?probeDetail=1`：

```bash
curl -s 'http://<你的服务地址>/health?probeDetail=1' | jq '.sourceProbe.details'
```

```json
[
  {
    "owner": "open",
    "sourceId": "某某音源.js",
    "sourceName": "某某音源",
    "platform": "tx",
    "status": "down",
    "autoDisabled": true,
    "failCount": 2,
    "lastCheckAt": 1760538600000,
    "lastOkAt": 0,
    "lastError": "链接返回 403"
  }
]
```

明细按「失败优先」排序（`down` → 有失败计数 → 正常 → 跳过），`lastError` 就是判定依据，
可直接看出是音源侧问题还是链接校验不通过。

巡检同时作为后台任务注册到任务调度器，任务 ID 为 `custom_source_health_probe`，
可在面板的任务列表里看到执行记录。

## 与「脚本自检护栏」的分工

| | 脚本自检护栏 | 平台可用性巡检 |
| --- | --- | --- |
| 防的是什么 | **脚本本身作恶**：空死循环、反调试自旋、沙箱逃逸 | **脚本没错，但它依赖的平台挂了** |
| 触发方式 | 空闲 CPU 持续超标 / 静态特征命中 | 定时按平台实际解析一次 |
| 处置 | 内存态隔离（不删文件、不改配置） | 关闭平台解析；全平台失效时移除音源（可恢复） |
| 文档 | [source-guard.md](./source-guard.md) | 本文 |

两者互不干扰：巡检执行期间会向护栏登记「忙碌」，其 CPU 开销不会被误判为异常。

## 注意事项

- 巡检会**真实发起解析请求**，间隔别设太短（默认 3 小时），否则会给音源接口带来不必要的压力和风控风险。
- 关闭自动移除（`customSource.probe.autoRemoveSource: false`）时，全平台失效的音源只会被关闭全部平台，
  不会被删除——只想让它安静下来、不想动文件的场景可以这样配。
- 首次启动（或刚开启功能时）会跑一轮全量探测，`/health` 的 `lastRun` 会显示结果；
  探测过程中日志前缀为 `[音源巡检]`。
