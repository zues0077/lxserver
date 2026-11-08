
const config: LX.Config = {
  serverName: 'LX Sync Server', // 同步服务名称
  'debug.enabled': false, // 是否启用 DEBUG 模式 (开发人员使用)
  'proxy.enabled': false, // 是否使用代理转发请求到本服务器
  'proxy.header': 'x-real-ip', // 代理转发的请求头 原始IP
  bindIP: '0.0.0.0', // 绑定IP
  port: 9527, // 端口
  'user.enablePath': true, // 是否开启用户路径
  'user.enableRoot': false, // 是否开启根路径
  'user.enablePublicRestriction': true, // 是否启用公开用户权限限制
  'user.enablePublicNonAdminLocalMusic': false, // 是否开启非管理员访问本地音乐
  'user.enablePublicNonAdminBrowserDownload': true, // 是否开启非管理员浏览器下载
  'user.enablePublicNonAdminServerCache': false, // 是否开启非管理员服务器缓存
  'user.enablePublicFavorites': false, // 是否开启公开收藏和歌曲
  'user.enablePublicNonAdminAccess': false, // 是否开启非管理员访问公开收藏和歌曲
  'user.enableCustomMusicDir': false, // 是否启用自定义歌曲目录
  'user.enableLoginCacheRestriction': false, // 是否启用登录用户缓存限制
  'user.enableCacheSizeLimit': false, // 是否启用缓存空间限制
  'user.cacheSizeLimit': 2000, // 缓存空间限制大小 (MB)，只统计缓存目录，不含已下载文件
  'cache.maxAgeDays': 14, // 缓存文件自动保留天数（0 = 永久保留），只作用于缓存目录

  maxSnapshotNum: 10, // 公共最大备份快照数
  'list.addMusicLocationType': 'top', // 公共添加歌曲到我的列表时的位置 top | bottom，参考客户端的「设置 → 列表设置 → 添加歌曲到列表时的位置」
  disableTelemetry: false, // 是否禁用数据收集（仅用于开源项目改进，不含敏感信息）

  users: [
    // 用户配置例子
    // 提示：你也可以通过环境变量 LX_USER_<用户名>={"password":"123","enableCustomMusicDir":true} 的 JSON 格式来配置高级选项
    // {
    //   name: 'user1', // 用户名，必须，不能与其他用户名重复
    //   password: '123.def', // 是连接密码，必须，不能与其他用户密码重复，若在外网，务必增加密码复杂度
    //   maxSnapshotNum: 10, // 可选，最大备份快照数
    //   'list.addMusicLocationType': 'top', // 可选，添加歌曲到我的列表时的位置 top | bottom，参考客户端的「设置 → 列表设置 → 添加歌曲到列表时的位置」
    //   enableCustomMusicDir: false, // 可选，是否启用此用户自定义歌曲目录
    //   customMusicDir: '', // 可选，自定义歌曲目录绝对路径
    //   allowOperateCustomMusicDir: false, // 可选，是否允许操作目录歌曲（如删除、洗版）
    //   allowWriteCustomMusicDir: false, // 可选，是否允许写入歌曲文件（如关联、更新元信息、嵌入歌词）
    //   enableAutoDownload: false, // 可选，是否启用此用户自动下载歌曲功能
    // },
  ],

  'admin.password': '123456',

  // WebDAV 配置
  'webdav.enable': false,
  'webdav.url': '',
  'webdav.username': '',
  'webdav.password': '',
  'webdav.syncPath': '/lx-sync', // 增量同步远程路径
  'webdav.backupPath': '/lx-sync-backups', // 全量备份远程路径
  'sync.interval': 60, // 同步间隔（分钟）默认1小时
  'sync.backupInterval': 24, // 全量备份间隔（小时）默认24小时
  'webdav.excludeCache': false, // 是否排除缓存目录 (data/<user>/cache) 的同步与备份
  'webdav.excludeMusic': false, // 是否排除音乐下载目录 (data/<user>/music) 的同步与备份


  // 本地配置备份（config.js 每日一份本地副本）
  'configBackup.enable': true, // 是否启用本地配置备份
  'configBackup.retentionDays': 7, // 本地备份保留天数
  'configBackup.dir': '', // 备份目录，留空则用 <data>/backups，相对路径基于 data 目录，绝对路径直接使用

  // 歌单快照额外备份路径（留空则存于用户数据目录 list/snapshot，相对路径基于 data 目录，绝对路径直接使用）
  'snapshot.backupPath': '',

  // Web播放器配置
  'player.name': 'LX Music Web',
  'player.enableAuth': false,
  'player.password': '123456',

  // 代理配置
  'proxy.all.enabled': false,
  'proxy.all.address': '',

  // 细分代理：音乐平台 / 自定义音源 / 应用。
  // enabled 为 undefined 表示该类别「沿用上面的统一开关」，显式 true/false 才独立生效。
  'proxy.music.enabled': undefined,
  'proxy.music.address': '',
  'proxy.customSource.enabled': undefined,
  'proxy.customSource.address': '',
  'proxy.app.enabled': undefined,
  'proxy.app.address': '',

  // ===== 平台账号（用自己的会员账号听各平台歌曲）=====
  // 账号 Cookie 不存这里：config.js 会被本地备份与 WebDAV 同步上云，
  // Cookie 是登录凭证，单独加密存在 data/music-accounts.json（见 src/server/musicAccount/store.ts）
  'musicAccount.enabled': false, // 总开关：开启后取链时才会尝试用已配置的平台账号
  'musicAccount.priority': true, // true=首选自己账号，失败再回落自定义音源；false=自定义音源失败后才试账号
  'musicAccount.timeoutMs': 15000, // 单次账号取链的超时上限(ms)，超时即回落自定义音源
  'musicAccount.allowedUsers': [], // 使用权限名单：允许走账号取链的用户名（游客=_open）；空=所有人可用
  'musicAccount.checkHours': 72, // 账号健康巡检的最小间隔（小时，1~168）
  'musicAccount.checkHour': 3, // 巡检落在每天的几点（0-23），放在凌晨避免边播边扫
  'musicAccount.healthCheckEnabled': true, // 自动巡检开关：关掉后启动/定时都不巡检，只靠取链失败复核与手动检查
  'musicAccount.autoSwitch': {}, // 主号失效自动切换：{平台id: true}，默认空=全部关闭（多号漂移代价大）
  // 酷狗概念版 VIP 自动领取：多账号轮流做任务，每个账号每天可领 8 次（每次 3 小时）
  'musicAccount.kglite.autoClaim': true, // 是否开启定时自动领取
  'musicAccount.kglite.startHour': 6, // 每天从几点开始跑（0-23）；之后每 3 小时一轮
  'musicAccount.kglite.rounds': 3, // 每天自动领取跑几轮（每轮都把当日 8 次额度领满，1 轮就够；多留几轮只为防容器重启错过那一轮，范围 1~24）
  // 账号之间的错峰等待：每次在 [最短, 最长] 区间里随机取一个秒数，别用固定值
  // （固定间隔会形成等差时间序列，比人工操作更像脚本）
  'musicAccount.kglite.gapMinSeconds': 60,
  'musicAccount.kglite.gapMaxSeconds': 600,
  'musicAccount.kglite.minRemainHours': 24, // 剩余会员低于这么多小时才补领；够用就跳过（避免把额度攒到几个月后）
  // 登录态静默续期：概念版 App token 约 60 天过期，过期后只能重新扫码/收短信。
  // 每账号在 [最短, 最长] 天里随机续一次，账号之间按账号数自动错开（不是固定星期几）。
  'musicAccount.kglite.tokenRefresh': true,
  'musicAccount.kglite.tokenRefreshMinDays': 6,
  'musicAccount.kglite.tokenRefreshMaxDays': 8,

  // 访问路径配置
  'admin.path': '/admin', // 后台管理路径
  'player.path': '/', // 播放器路径，默认为根路径 /
  'subsonic.enable': true, // 是否启用 Subsonic 服务
  'subsonic.path': '/rest', // Subsonic 访问路径
  'subsonic.port': 0, // Subsonic 独立端口: 0=不启用(走主端口 subsonic.path); >0 时单独监听该端口, 只允许通过 Subsonic 鉴权的用户访问
  'subsonic.enableDebug': false, // 是否开启 Subsonic 调试日志模式
  'subsonic.onlineSearch': true, // 是否开启 Subsonic 在线全网搜索
  'subsonic.onlineSearchMode': 'fallback', // 在线搜索模式: fallback | merge | local_only
  'subsonic.onlineSearchSources': 'wy,tx,kw,kg,mg', // 在线搜索默认平台
  'subsonic.publicLeaderboards': false, // 是否在 Subsonic 中公开在线排行榜(只读虚拟播放列表)
  'subsonic.leaderboardSource': 'tx', // 在线排行榜平台: tx | wy | kg | kw | mg
  'subsonic.sharedListMode': 'leaderboard', // 共享歌单内容模式: leaderboard | playlist | both
  'subsonic.sharedListSort': 'hot', // 共享歌单排序: hot | new
  'subsonic.dislikeRating': 1, // 评分联动 dislike 阈值: 0 < rating <= 该值 视为不喜欢(写回原生 dislike 规则); 设为 0 关闭联动
  'subsonic.linkRatingToDislike': false, // 解耦开关(正向): 评星 -> 不喜欢 是否自动联动; false=不联动(仅记录评分)
  'subsonic.linkDislikeToRating': false, // 解耦开关(反向): 不喜欢 -> 评星 是否自动联动; false=不联动(仅记录不喜欢)
  'subsonic.hideDisliked': true, // 是否在 Subsonic 列表中隐藏 dislike 命中的歌曲(关闭则只评分不剔除)
  'subsonic.dislikeCrossSource': false, // dislike 是否跨平台同名命中(各平台 ID 不互通, 开启会误伤同名歌手/专辑)
  'subsonic.dislikeNoRecommend': true, // 推荐类接口(每日推荐/随机/相似)是否排除 dislike 歌曲(与 hideDisliked 独立)
  'subsonic.dislikeDuetMode': 'any', // 合唱歌曲匹配模式: any=任一歌手命中 / all=全部命中 / primary=仅主唱
  'subsonic.dislikeNormalizeName': true, // 歌名去版本后缀归一化: 「晴天 (Live)」也能命中「晴天」规则
  'subsonic.dislikeRequireSinger': true, // 歌曲/专辑级别都要求歌手同时匹配(关闭则纯歌名规则可单独命中, 会误杀同名)
  'subsonic.recommendPoolSize': 100, // 推荐池容量: 专辑列表可翻页数 ≈ 容量 / size
  'subsonic.lyricTranslation': true, // 是否在 Subsonic 歌词中包含翻译
  'subsonic.cacheOnPlay': false, // 是否在 Subsonic 播放时触发服务器缓存保存（落盘）
  'subsonic.playCacheFirst': true, // 是否在 Subsonic 播放时优先使用服务器已有的本地缓存/下载文件直接传输
  'subsonic.quality.enabled': true, // 音质优选总开关: 按优先级主动选最优可用音质(非失败降级); 关闭则 stream 仅单次解析
  'subsonic.quality.priority': 'flac,320k,128k', // 音质优先级(从高到低, 逗号分隔), 按此顺序主动优选
  'subsonic.quality.clientCapMode': 'soft', // 客户端 maxBitrate 上界模式: hard 仅选≤上限的最高优先级; soft 上限内都取不到再突破上限选更高优先级
  'subsonic.source.priority': 'kw,tx,wy,mg,kg', // 跨平台优选顺序(逗号分隔, 客户端所选源始终优先)
  'subsonic.source.crossPlatform': true, // 是否允许跨平台优选(按歌名+歌手在其它平台搜索替身)
  'subsonic.source.autoSwitchCustom': true, // 同源是否切换其它自定义源脚本(callUserApiGetMusicUrl 内部循环同平台候选脚本)
  'subsonic.transcode.enabled': false, // 服务端转码总开关(需安装 ffmpeg);音源无客户端请求音质时降码率转发以省客户端流量
  'subsonic.transcode.onQualityMiss': true, // 仅音源缺失对应低音质时才转码;关闭则永不转码
  'subsonic.transcode.format': 'mp3', // 转码目标格式: mp3 | opus | aac
  'subsonic.transcode.maxConcurrent': 2, // 转码并发上限,防 CPU 过载
  'singer.sourcePriority': ['tx', 'wy'], // 歌手信息源优先级
  'artist.maxFetchPages': 20, // 歌手歌曲最大抓取页数
  'cache.namingPattern': 'simple', // 缓存命名规则
  'system.allowUnsafeVM': false, // 是否允许运行 VM 模式自定义源脚本

  // ===== 自定义源「平台可用性巡检」 =====
  // 新添加的音源会立即逐个平台探测；之后按 intervalMinutes 定时对「剩余可用平台」复检。
  // 平台连续 failThreshold 次失败 → 自动写入 states.json 的 disabledSources 关闭该平台解析；
  // 某音源全部平台都不可用 → 按 removeMode 自动移除该音源（默认移入 .trash，可恢复）。
  'customSource.probe.enabled': true, // 巡检总开关
  'customSource.probe.intervalMinutes': 360, // 复检间隔（分钟，默认 6 小时；平台多时别调太小，避免持续探测第三方）
  'customSource.probe.failThreshold': 2, // 连续失败多少次判定不可用
  'customSource.probe.demoteThreshold': 1, // 连续失败几次后降权观察（只排队尾）；0 = 关闭降权档
  'customSource.probe.allDownDays': 3, // 全平台失效满几天移除音源；单个平台失效只关平台，0 = 当轮即移除
  'customSource.probe.timeoutMs': 15000, // 单平台单次探测超时（毫秒）
  // 必须与 sourceProbe.ts 里 positiveNumber(..., 6) 的兜底值保持一致：
  // config.js 一旦显式落值就会覆盖运行时默认，两边不同步会让「默认 6」形同虚设。
  'customSource.probe.concurrency': 6, // 探测并发数（实测 37 源 / 97 平台：2 并发约 356s，6 并发约 44s）
  'customSource.probe.verifyLink': true, // 是否对返回链接做可达性校验
  'customSource.probe.autoDisablePlatform': true, // 不可用是否自动关闭该平台
  'customSource.probe.autoRemoveSource': true, // 全平台不可用是否自动移除音源
  'customSource.probe.removeMode': 'trash', // 移除方式：trash 移入回收站 / delete 直接删除
  // 回收站保留天数：只增不减会把 NAS 盘慢慢吃满，而多数人不会回头翻。
  // 0 = 永不自动清理（想长期留档时用）。到期条目被彻底删除，不可恢复。
  'customSource.trash.retentionDays': 3,
  'customSource.probe.probeOnNewSource': true, // 新增音源是否立即巡检
  // 已关闭平台「快速复检」：只探被自动关闭的平台、每平台 1 首，成功即恢复，不做定罪。
  // 全量巡检一轮后，被误关或平台临时故障的源原本要等这么久才能复活；
  // 复检把恢复窗口压到 12 小时，成本只有全量的几十分之一。设 0 关闭。
  // 默认 180（3 小时）而不是 30：慢源（脚本同步块 5~7 秒）恰好也有一堆平台被关着，
  // 30 分钟一轮等于每半小时把主线程卡 6~13 秒（2026-11-04 246 实测）。
  // 也不用 720：246 实测有 62 个平台待复检，720 分钟 × 4 轮 = 单个平台最长要等两天才轮到。
  'customSource.probe.restoreIntervalMinutes': 180,
  'customSource.probe.restoreBatch': 32, // 每轮复检最多探多少个「源×平台」，多的按关闭时间轮转（62 个平台约 2 轮扫完）
  // 同一平台两次探测的最小间隔（毫秒）。全量巡检里单个平台常排 20~30 个源，
  // 并发全开时同一平台会瞬时收到多个请求，最容易被平台判成异常流量。设 0 关闭。
  'customSource.probe.throttleMs': 250,
  // 单轮巡检总时长预算（毫秒）。到点不再领新任务，剩余留到下一轮最前面（按上次探测时间排序，不会饿死）。
  'customSource.probe.maxDurationMs': 480000,
  // 各平台测试曲目覆盖（留空则用缓存/内置搜索）。
  // kg 必须显式配置：它的歌曲主键是 32 位文件 hash，而缓存索引只存 audio_id 且不带 hash，
  // 内置搜索虽然能带出 hash 但要多一次搜索。这里给一首固定曲目当首选，失配时仍会走搜索兜底。
  // songmid 与 hash 都填 hash：两类源脚本（读 songmid / 读 hash）都能拿到可用的主键。
  'customSource.probe.testSongs': {
    kg: { songmid: 'B3A52A7A958BF0AED0EBFBA2E9A818B7', hash: 'B3A52A7A958BF0AED0EBFBA2E9A818B7', name: '晴天', singer: '周杰伦', interval: '04:29' },
  },
  'customSource.probe.systemicFailureRatio': 0.5, // 某平台在超过该比例的音源上同时失败 → 判定为平台侧异常，本轮只记录不自动处置
  // 判定「平台侧异常」还要求该平台成功率低于此值。有音源能播就说明曲目可播、平台没限流，
  // 此时过半失败是音源自己的后端挂了，不能整档赦免（只赦免非硬故障的失败）
  'customSource.probe.suspectMaxOkRatio': 0.05,

  // ===== 自定义源「取链」（用户点播放时的实时解析） =====
  // 与巡检无关：这里控制的是用户实际播放时，逐个音源要链接的行为。
  'customSource.callTimeoutMs': 20000, // 单个音源取链的超时上限（脚本内部可能串行试十几个后端）
  // ===== 自定义源「慢源降速运行」 =====
  // 有些公开音源本身能用，但脚本里的同步逻辑要跑好几秒（实测「非常刀」5.2s、「西瓜聚合源」5.6s）。
  // 直接停用等于拿可用性换稳定；这里改为把它关进单间：慢源之间互斥、同源单飞、巡检排到队尾，
  // 它仍然能取链，但不再与其它慢源叠成十几秒的主线程阻塞。30 分钟无新慢记录自动恢复。
  'customSource.governor.enabled': true,
  'customSource.governor.syncMs': 800, // 单次同步块超过该毫秒数算一次「慢」（正常源通常几十毫秒）
  'customSource.governor.minHits': 2, // 窗口内累计几次才降速：一次偶发不动它
  'customSource.governor.severeSyncMs': 2500, // 单次就超过该值（实测这类源 5~7 秒）→ 首次即降速，不必等第二次
  'customSource.governor.ttlMinutes': 30, // 降速状态有效期，到期自动回到正常
  // ===== 慢源独立线程（进一步根治主线程卡顿）=====
  // 降速运行只解决「多个慢源叠在一起」，挡不住单个脚本自身的 5~13s 同步块
  // （手册 P-1046：vm2 边界的 decontextify 深拷贝是主线程阻塞来源）。
  // 仅把已被判定降速的源移进 worker_threads：脚本、lx.request 网络、响应解析与回调
  // 全部留在 worker，主线程只收最终结果。其余源仍走原来的 vm2 路径。
  'customSource.governor.worker.enabled': true, // 关掉即完全回到「全部源在主线程」
  'customSource.governor.worker.fallbackToMain': true, // worker 启动/调用失败时回退主线程 vm2，保证可用
  // 出站护栏：自定义源脚本发起的请求不允许访问内网/保留地址（127/8、10/8、172.16/12、
  // 192.168/16、169.254/16、IPv6 ::1/fc00::/7/fe80::/10 等）。脚本无需逃逸沙箱就能
  // 把容器当内网跳板探测 NAS 管理页或云 metadata，默认开启。确有源要访问局域网服务再关。
  'customSource.blockPrivateNetwork': true,
  'customSource.verifyPlayable': true, // 拿到链接后再探一次，挡掉「URL 正常但实际 404」的假成功
  // 取链失败过的音源，下次排到队尾（不禁用、不删源、成功即恢复）：
  // 单首歌的单次失败里「无版权/已下架」这类软失败占比很高，凭一次失败禁用会误伤一批，
  // 所以只改尝试顺序，把定罪留给有测试曲目与阈值保护的巡检。
  'customSource.playSink.enabled': true,
  // 按「源 × 平台 × 音质档」短路：某源在某一档连续失败且零成功，就在该档直接跳过一小时
  // （到期自动放行一次探路，成功即恢复）。与上面沉底的区别：沉底只改顺序仍会试，
  // 这里是按档把「必败的源」排到最后兜底：前面有可用源成功就省掉那几段超时，
  // 可用源全败时它还会被试一次（不把跨歌曲的证据当成本首歌的判决）。
  'customSource.qualityLedger.enabled': true,
  // 按历史成绩正向排序：用「源 × 平台 × 档」的成功耗时 EWMA 与成功率打分，
  // 把实测更快的源提到前面。样本不足（<2 次）不动手，从没成功过的垫底。
  'customSource.playRank.enabled': true,
}

export default config
