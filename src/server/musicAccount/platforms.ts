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
  /** 抓取步骤说明，展示在管理界面「如何获取」里 */
  guide: string[]
  /** 登录后能带来的收益说明 */
  benefit: string
  /** 主色，用于界面标识 */
  color: string
  /**
   * 支持的扫码登录方式。
   * 有值前端就显示「扫码登录」按钮；没有就只能手工填 Cookie
   * （酷我 / 咪咕官方没有可用的扫码换 token 接口，硬做只会给出假按钮）。
   */
  qrLogins?: MusicAccountQrOption[]
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
    cookieDomain: 'www.kuwo.cn',
    loginKeys: ['kw_token', 'userid', 'user_id', 'websid', 'logintype', 'username'],
    guide: [
      '打开 https://www.kuwo.cn 并登录，登录后播放一首歌（让 Cookie 尽量完整）',
      'F12 →「网络 / Network」，筛选 www.kuwo.cn，点播放相关请求（如 /api/v1/www/music/playUrl）',
      '复制请求标头里的 Cookie 整行',
      '关键字段：kw_token、userid、websid（会员中心 vip1.kuwo.cn 只有 userid / websid / sid，也算登录态）',
    ],
    benefit: '会员可解锁 320k、无损与付费曲库',
    color: '#FFA000',
  },
  {
    id: 'kg',
    name: '酷狗音乐',
    short: '酷狗',
    cookieDomain: 'www.kugou.com',
    loginKeys: ['t', 'KugooID'],
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
    id: 'mg',
    name: '咪咕音乐',
    short: '咪咕',
    cookieDomain: 'music.migu.cn',
    loginKeys: ['*ticket*', '*utoken*', '*pacmtoken*', 'migu_music*', 'mg_auth*', 'pusk', 'userid'],
    guide: [
      '打开 https://music.migu.cn 并登录，登录后播放一首歌',
      'F12 →「网络 / Network」，筛选 music.migu.cn',
      '点 listen-url 这类音频接口，复制请求标头里的 Cookie 整行',
      '关键字段：pacmtoken（新版网页登录后必定有），另外 idmpauth / migu-utoken-sessionid / LTToken 也算',
      '未登录只能拿到 PQ(128k)，带登录 Cookie 才有 HQ(320k) / SQ',
    ],
    benefit: '登录后可解锁 HQ(320k)、SQ 无损音质',
    color: '#FF6A00',
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
    // 登录态 Cookie（sessionid*）下发在 qishui.com 域，接口都在 api.qishui.com
    cookieDomain: 'api.qishui.com',
    loginKeys: ['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard'],
    essentialKey: 'sessionid_ss',
    essentialHint: '缺 sessionid_ss 基本等于未登录；汽水 PC 网页端登录后会同时下发 sessionid / sid_tt / sid_guard',
    guide: [
      '打开 https://www.qishui.com 并登录（或用官方 PC 客户端登录后从客户端取）',
      'F12 →「网络 / Network」，筛选 api.qishui.com，点任意一条 luna 接口',
      '复制「请求标头」里的 Cookie 整行',
      '关键字段：sessionid_ss、sessionid、sid_tt、sid_guard',
      '⚠️ 提醒：汽水的会员曲目取流需要官方客户端签名，配了账号也拿不到整曲，详见下方说明',
    ],
    benefit: '可保存登录态；注意：cover/UGC 类曲目免登录就能播，会员无损与版权受限曲的整曲需要官方客户端签名，账号不解决',
    color: '#06C270',
    qrLogins: [{ driver: 'soda', label: '扫码登录（抖音 App）' }],
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
