/** 账号取链的统一结果结构 */
export interface AccountResolveResult {
  ok: boolean
  /** 成功时的播放链接 */
  url?: string
  /** 实际拿到的音质（可能与请求音质不同，平台会降级） */
  quality?: string
  /** 是否走了会员通道 */
  isVip?: boolean
  /** 命中的通道名，用于日志与界面排查 */
  via?: string
  /** 链接的音频扩展名 */
  ext?: string
  /** 失败原因（会展示给管理员，不要包含 Cookie） */
  error?: string
}

/** 账号信息探测结果 */
export interface AccountInfo {
  ok: boolean
  isVip?: boolean
  nickname?: string
  message?: string
  /**
   * 校验强度，如实告知，避免把「看着像有效」当成「已验证」：
   *   online     = 调了需要登录态的接口，返回明确给出了登录结果
   *   structural = 只核对了 Cookie 里是否含该平台登录字段，未在线确认真实性
   * 未返回时由编排层按 online 处理（有明确判定依据的平台才不写这个字段）。
   */
  verified?: 'online' | 'structural'
}

/** 各平台解析器需要实现的接口 */
export interface PlatformResolver {
  /** 取播放链接 */
  resolve(songInfo: any, quality: string, cookie: string): Promise<AccountResolveResult>
  /** 探测账号登录态与会员状态 */
  getAccountInfo(cookie: string): Promise<AccountInfo>
}
