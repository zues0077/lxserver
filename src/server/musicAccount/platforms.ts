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

export interface MusicAccountPlatform {
  /** 平台 id，同时是 LX source id */
  id: string
  /** 展示名 */
  name: string
  /** 短名，用于紧凑展示 */
  short: string
  /** 抓取 Cookie 时要在哪个域名下复制（浏览器 F12 → Application → Cookies） */
  cookieDomain: string
  /** 该平台 Cookie 里用于判断登录态的关键字段（命中任意一个即认为已登录） */
  loginKeys: string[]
  /** 抓取步骤说明，展示在管理界面「如何获取」里 */
  guide: string[]
  /** 登录后能带来的收益说明 */
  benefit: string
  /** 主色，用于界面标识 */
  color: string
}

export const PLATFORMS: MusicAccountPlatform[] = [
  {
    id: 'wy',
    name: '网易云音乐',
    short: '网易',
    cookieDomain: 'music.163.com',
    loginKeys: ['MUSIC_U', '__csrf', 'MUSIC_A'],
    guide: [
      '浏览器打开 https://music.163.com 并登录账号',
      '按 F12 打开开发者工具 → 切到「应用 / Application」面板',
      '左侧找到 Cookie → https://music.163.com',
      '复制整行 Cookie（或至少包含 MUSIC_U 与 __csrf 的片段）',
    ],
    benefit: '会员可解锁 VIP 独占、无损及 Hi-Res 音质',
    color: '#C20C0C',
  },
  {
    id: 'tx',
    name: 'QQ音乐',
    short: 'QQ',
    cookieDomain: 'y.qq.com',
    loginKeys: ['qm_keyst', 'uin', 'wxuin'],
    guide: [
      '浏览器打开 https://y.qq.com 并登录账号',
      '按 F12 → 「应用 / Application」→ Cookie → https://y.qq.com',
      '复制整行 Cookie（关键字段 uin 与 qm_keyst）',
      '注意：仅带 uin 不带 qm_keyst 时通常仍按游客处理',
    ],
    benefit: '会员可解锁 SQ 无损、臻品音质与付费曲目',
    color: '#31C27C',
  },
  {
    id: 'kw',
    name: '酷我音乐',
    short: '酷我',
    cookieDomain: 'kuwo.cn',
    loginKeys: ['kw_token', 'Hm_lvt_', 'user_id'],
    guide: [
      '浏览器打开 http://www.kuwo.cn 并登录账号',
      '按 F12 → 「应用 / Application」→ Cookie → .kuwo.cn',
      '复制整行 Cookie（酷我需要 kw_token 才稳定）',
    ],
    benefit: '会员可解锁 320k、无损与付费曲库',
    color: '#FFA000',
  },
  {
    id: 'kg',
    name: '酷狗音乐',
    short: '酷狗',
    cookieDomain: 'kugou.com',
    loginKeys: ['t', 'KugooID', 'kg_mid'],
    guide: [
      '浏览器打开 https://www.kugou.com 并登录账号',
      '按 F12 → 「应用 / Application」→ Cookie → .kugou.com',
      '复制整行 Cookie（会员高音质需要 t 与 KugooID）',
    ],
    benefit: '会员可解锁高品音质与付费曲目',
    color: '#2E86FF',
  },
  {
    id: 'mg',
    name: '咪咕音乐',
    short: '咪咕',
    cookieDomain: 'music.migu.cn',
    loginKeys: ['migu_music', 'USERTICKET', 'pusk'],
    guide: [
      '浏览器打开 https://music.migu.cn 并登录账号',
      '按 F12 → 「应用 / Application」→ Cookie → .migu.cn',
      '复制整行 Cookie',
      '提示：未登录时咪咕仅能拿到 PQ(128k)，登录后才有 HQ/SQ',
    ],
    benefit: '登录后可解锁 HQ(320k)、SQ 无损音质',
    color: '#FF6A00',
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
