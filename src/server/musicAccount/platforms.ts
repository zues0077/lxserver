/**
 * 平台账号（Cookie）支持的音源定义
 *
 * 设计要点：
 * 1. 这里的 id 与 LX 的 source id 保持一致（wy / tx / kw / kg / mg），
 *    这样取链时可以用 `source` 直接命中解析器，无需二次映射。
 * 2. 平台是「数据驱动」的：后期要加新平台，只需在 PLATFORMS 里追加一项，
 *    并在 resolvers/index.ts 注册对应解析器即可，UI 与接口无需改动。
 * 3. 本模块不依赖内置 musicSdk，避免上游更新时冲突。
 */

export interface MusicAccountQrOption {
  /** 扫码驱动 id，对应 qrLogin/index.ts 里的 DRIVERS */
  driver: string
  /** 按钮文案 */
  label: string
}

export interface MusicAccountSmsOption {
  /** 按钮文案 */
  label: string
  /** 是否要用户先答一道图形验证码（咪咕通行证要） */
  captcha: boolean
}

export interface MusicAccountPlatform {
  /** 平台 id，同时是 LX source id */
  id: string
  /** 展示名 */
  name: string
  /** 短名，用于紧凑展示 */
  short: string
  /**
   * 实际发请求的接口域名。
   * 抓 Cookie 要在「网络 / Network」面板按这个域名筛请求 ——
   * 不能按父域（.kuwo.cn / .migu.cn）去 Application 面板里抄，
   * 鉴权 Cookie 只在具体子域的接口请求里才齐全。
   */
  cookieDomain: string
  /** 该平台 Cookie 里用于判断登录态的关键字段（命中任意一个即认为已登录） */
  loginKeys: string[]
  /**
   * 决定「能不能拿到高音质」的那个字段（可选）。
   * 缺了它虽然仍算登录，但套餐权益基本吃不到，保存时要单独提醒 ——
   * 典型是酷我：只在会员中心页面停留过就没有 kw_token，音质锁死在 128k。
   */
  essentialKey?: string
  /** 缺 essentialKey 时给出的补救说明 */
  essentialHint?: string
  /**
   * Cookie 里能**稳定标识「这是哪个号」**的字段（按优先级，取第一个有值的）。
   *
   * 只用来做「扫码登录时同一个号就更新、不同号才新增」的判断，
   * 不参与登录态判定。所以这里**只放不会变的字段**：
   *   - 酷狗 KugooID / 酷我 userid / 咪咕 userid / B站 DedeUserID / QQ uin：用户维度唯一且稳定，放。
   *   - 网易 MUSIC_U、汽水 sessionid：每次登录都会换新值，放进来会导致「重登一次多一个冷备号」，
   *     所以不填 —— 这两个平台退回「覆盖主账号」的老语义。
   */
  uidKeys?: string[]
  /** 抓取步骤说明，展示在管理界面「如何获取」里 */
  guide: string[]
  /** 登录后能带来的收益说明 */
  benefit: string
  /** 主色，用于界面标识 */
  color: string
  /**
   * 支持的扫码登录方式。
   * 有值前端就显示「扫码登录」按钮；没有就只能手工填 Cookie。
   * 酷我官方没有可用的扫码换 token 接口，硬做只会给出假按钮；
   * 咪咕的通行证能出码，但 App 扫一扫只认 TV 端码（实测报「TV扫码登录失败」），同样不给按钮。
   */
  qrLogins?: MusicAccountQrOption[]
  /**
   * 手机号 + 短信验证码登录。
   * 有值前端就显示「手机号登录」按钮 —— 适合官方有短信登录接口、但没有可用扫码的平台。
   */
  smsLogin?: MusicAccountSmsOption
}

export const PLATFORMS: MusicAccountPlatform[] = [
  {
    id: 'wy',
    name: '网易云音乐',
    short: '网易',
    cookieDomain: 'music.163.com',
    loginKeys: ['MUSIC_U', '__csrf', 'MUSIC_A'],
    essentialKey: 'MUSIC_U',
    essentialHint: '没有 MUSIC_U 就是游客身份，VIP / 无损都拿不到，请在 music.163.com 重新登录后播一首歌再取',
    guide: [
      '打开 https://music.163.com 并登录，登录后随便播一首歌（让 Cookie 下发完整）',
      'F12 打开开发者工具 → 切到「网络 / Network」',
      '筛选框输入 music.163.com，点任意一条请求',
      '右侧「标头 / Headers」→ 请求标头里找到 Cookie，整行复制',
      '关键字段：MUSIC_U（登录态）、__csrf',
    ],
    benefit: '会员可解锁 VIP 独占、无损及 Hi-Res 音质',
    color: '#C20C0C',
    qrLogins: [{ driver: 'wy', label: '扫码登录' }],
  },
  {
    id: 'tx',
    name: 'QQ音乐',
    short: 'QQ',
    cookieDomain: 'y.qq.com',
    loginKeys: ['qm_keyst', 'uin', 'wxuin'],
    essentialKey: 'qm_keyst',
    essentialHint: '只有 uin 没有 qm_keyst 会被当游客，SQ / 臻品音质拿不到，请重新登录 QQ 音乐后再取',
    uidKeys: ['uin', 'wxuin'],
    guide: [
      '打开 https://y.qq.com 并登录',
      'F12 →「网络 / Network」，筛选 y.qq.com，点任意一条接口请求',
      '右侧「标头 / Headers」→ 请求标头里的 Cookie，整行复制',
      '关键字段：uin（可能带 o 前缀，如 o0123456789）、qm_keyst',
      '只有 uin 没有 qm_keyst 会按游客处理，起不到会员作用',
    ],
    benefit: '会员可解锁 SQ 无损、臻品音质与付费曲目',
    color: '#31C27C',
    qrLogins: [
      { driver: 'tx', label: 'QQ 扫码' },
      { driver: 'txwx', label: '微信扫码' },
    ],
  },
  {
    id: 'kw',
    name: '酷我音乐',
    short: '酷我',
    cookieDomain: 'vip1.kuwo.cn',
    loginKeys: ['kw_token', 'userid', 'user_id', 'websid', 'logintype', 'username'],
    uidKeys: ['userid', 'user_id'],
    guide: [
      '推荐：打开 https://vip1.kuwo.cn（酷我会员中心）登录，F12 → 网络 → 任选一条 vip1.kuwo.cn 请求，复制 Cookie 整行',
      '或打开 https://www.kuwo.cn 登录并播放一首歌后再复制（www 站多一个 kw_token）',
      '关键字段：userid / websid / sid（会员中心下发的就是这三个），缺了会被当成游客',
      '会员判定走 vip1.kuwo.cn/vip/v2/user/vip?op=ui；Cookie 失效时它回 code=200 但 data 为空，此时会退回结构校验',
    ],
    benefit: '会员可解锁 320k、无损与付费曲库',
    color: '#FFA000',
    // 酷我网页没有「扫酷我 App」的二维码（那只在桌面客户端里），但网页有手机号+图形码+短信码登录，
    // 端点全部在 wapi.kuwo.cn，无需抓包。复用短信登录基础设施（含图形验证码一步）。
    smsLogin: { label: '手机号登录', captcha: true },
  },
  {
    id: 'kg',
    name: '酷狗音乐',
    short: '酷狗',
    cookieDomain: 'www.kugou.com',
    loginKeys: ['t', 'KugooID'],
    uidKeys: ['KugooID', 'userid'],
    guide: [
      '打开 https://www.kugou.com 并登录',
      'F12 →「网络 / Network」，筛选 kugou.com，点任意一条接口请求',
      '复制请求标头里的 Cookie 整行',
      '关键字段：t、KugooID（会员高音质靠这两个）',
    ],
    benefit: '会员可解锁高品音质与付费曲目',
    color: '#2E86FF',
    qrLogins: [{ driver: 'kg', label: '扫码登录' }],
  },
  {
    id: 'kglite',
    name: '酷狗概念版',
    short: '酷狗概念',
    // 取链全走 gateway.kugou.com，抓包/排查都在这个域下
    cookieDomain: 'gateway.kugou.com',
    // 概念版登录态是 App token，与网页 Cookie（t / KugooID）是两套东西
    loginKeys: ['token', 'userid'],
    essentialKey: 'mid',
    essentialHint: '缺少 mid（设备标识）会导致请求签名失败，取链必然报错，请用扫码或短信登录重新获取',
    uidKeys: ['userid'],
    guide: [
      '推荐直接用下面的「扫码登录」或「手机号登录」——概念版登录态必须由 App 侧签发，网页 Cookie 用不了',
      '扫码：打开酷狗概念版 App → 我的 → 扫一扫',
      '手动填也行：登录后保存的 Cookie 只需 token / userid / mid / dfid 四个字段',
      '⚠️ 必须用概念版 App 登录：酷狗音乐的网页 Cookie 打概念版接口会返回 35005 token invalid',
    ],
    benefit: '可看广告免费领 VIP（每天 8 次、每次 3 小时）；VIP 生效后能取 320k OGG 与 16bit / 24bit 无损',
    color: '#00C3FF',
    qrLogins: [{ driver: 'kglite', label: '扫码登录' }],
    // 概念版不需要图形码，一步发码一步登录
    smsLogin: { label: '手机号登录', captcha: false },
  },
  {
    id: 'mg',
    name: '咪咕音乐',
    short: '咪咕',
    cookieDomain: 'music.migu.cn',
    loginKeys: ['*ticket*', '*utoken*', '*pacmtoken*', 'migu_music*', 'mg_auth*', 'pusk', 'userid'],
    uidKeys: ['userid'],
    guide: [
      '打开 https://music.migu.cn 并登录，登录后播放一首歌',
      'F12 →「网络 / Network」，筛选 music.migu.cn',
      '点 listen-url 这类音频接口，复制请求标头里的 Cookie 整行',
      '关键字段：pacmtoken（新版网页登录后必定有），另外 idmpauth / migu-utoken-sessionid / LTToken 也算',
      '未登录只能拿到 PQ(128k)，带登录 Cookie 才有 HQ(320k) / SQ',
    ],
    benefit: '登录后可解锁 HQ(320k)、SQ 无损音质',
    color: '#FF6A00',
    // 不做扫码入口：咪咕音乐 App 的扫一扫只认 TV 端码，扫通行证的网页码必然提示
    // 「TV扫码登录失败」，服务端也收不到任何扫码上报（2026-10-29 实测，三个渠道 sourceid 都一样）。
    // 改走通行证的手机验证码登录：能直接换到 pacmtoken，代价是每次要答一道算术图形题。
    smsLogin: { label: '手机号登录', captcha: true },
  },
  {
    id: 'bili',
    name: 'Bilibili',
    short: 'B站',
    // 取链/校验都打 api.bilibili.com，抓 Cookie 也在这里筛最准
    cookieDomain: 'www.bilibili.com',
    loginKeys: ['SESSDATA', 'bili_jct', 'DedeUserID'],
    essentialKey: 'SESSDATA',
    essentialHint: '没有 SESSDATA 等于游客身份，取流最高只有 192k；大会员的 Hi-Res / 杜比必须 SESSDATA 生效',
    uidKeys: ['DedeUserID'],
    guide: [
      '打开 https://www.bilibili.com 并登录（大会员账号才解锁 Hi-Res / 杜比）',
      'F12 →「网络 / Network」，筛选 api.bilibili.com，任点一条请求',
      '复制「请求标头」里的 Cookie 整行',
      '关键字段：SESSDATA（登录态）、bili_jct、DedeUserID',
      'SESSDATA 默认有效期约 180 天，过期后会显示未登录，重新扫码即可',
    ],
    benefit: '大会员可解锁 Hi-Res FLAC 与杜比全景声；非会员最高 192k',
    color: '#FB7299',
    qrLogins: [{ driver: 'bili', label: '扫码登录' }],
  },
  {
    id: 'soda',
    name: '汽水音乐',
    short: '汽水',
    // 登录态 Cookie（sessionid*）只有官方 PC 客户端登录后才会下发；接口都在 api.qishui.com
    // ⚠️ www.qishui.com 是纯下载落地页、没有账号入口，浏览器访客态只有 ttwid / odin_tt / n_mh，本文件不认这些字段
    cookieDomain: 'api.qishui.com',
    loginKeys: ['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard'],
    essentialKey: 'sessionid_ss',
    essentialHint: '缺 sessionid_ss 基本等于未登录；这四个字段只在汽水 PC 客户端登录后才有，浏览器里的 qishui.com 游客 Cookie 无效',
    guide: [
      '汽水没有网页端登录（www.qishui.com 只是下载页），必须先装官方 PC 客户端并在客户端里登录',
      '登录后关闭客户端，读 %APPDATA%\\SodaMusic\\Network\\Cookies（Chromium 库，value 列是明文，无需解密）',
      '把其中 sessionid / sessionid_ss / sid_tt / sid_guard 拼成一行 Cookie 格式填入下面的输入框',
      '也可以用配套脚本自动完成：读库 → 拼 Cookie → 调 /luna/pc/me 校验 → 结果写进剪贴板',
      '⚠️ 提醒：汽水的会员曲目取流需要官方客户端签名，配了账号也拿不到整曲，详见下方说明',
    ],
    benefit: '可保存登录态；注意：cover/UGC 类曲目免登录就能播，会员无损与版权受限曲的整曲需要官方客户端签名，账号不解决',
    color: '#06C270',
    // 汽水不提供扫码登录：官方二维码要用抖音 App 扫，且新设备几乎必触发短信二次验证，
    // 走通概率低、体验差，不如直接提示「从客户端/网页复制 Cookie」。驱动代码保留在 qrLogin/soda.ts 以备后需。
  },
]

const PLATFORM_MAP = new Map(PLATFORMS.map(p => [p.id, p]))

/** 按 id 取平台定义；未支持返回 undefined */
export function getPlatform(id: string): MusicAccountPlatform | undefined {
  return PLATFORM_MAP.get(id)
}

/** 所有受支持的 source id，供取链快速判断 */
export function supportedSourceIds(): string[] {
  return PLATFORMS.map(p => p.id)
}

/** 该 source 是否纳入账号体系 */
export function isSupportedSource(source: string): boolean {
  return PLATFORM_MAP.has(source)
}
