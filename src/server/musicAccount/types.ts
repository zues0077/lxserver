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
  /**
   * 实际命中的账号平台名（如「酷狗概念版」）。
   * 同一个 source 可能挂多个账号通道（kg 就有概念版与标准版），
   * 用 source 反查平台名会显示成「酷狗音乐账号」，与实际通道不符。
   */
  accountName?: string
  /** 链接的音频扩展名 */
  ext?: string
  /** 汽水版权曲 CENC 加密流的解密密钥（32 位十六进制），仅汽水通道有，用于下载时就地解密 */
  key?: string
  /** 失败原因（会展示给管理员，不要包含 Cookie） */
  error?: string
  /**
   * 取链过程中换到了新的短期凭证（咪咕 pacmtoken）。
   * 与 AccountInfo.refreshedCookie 同理：编排层要写回存储，下次请求才用得上新票。
   */
  refreshedCookie?: string
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
  /**
   * 校验过程中平台顺带下发了新的短期凭证（目前只有咪咕的 pacmtoken 有这机制）。
   * 编排层拿到后要**立刻写回存储**，否则下次请求还在用旧票 —— 咪咕就是
   * 「浏览器每发一次请求都续一次、我们存快照不续」才导致固定 3 小时失效的。
   */
  refreshedCookie?: string
  /**
   * 平台侧的**稳定用户 id**（账号维度唯一），用于识别「这是哪个号」。
   *
   * 只有「Cookie 里没带稳定 uid、但平台接口能问出来」的平台才会给：
   * 咪咕网页 Cookie 只有 idmpauth / pacmtoken 这类会话字段，没有 userid，
   * 但 queryUserInfo 会返回 userId —— 没有它，一键同步就认不出号，只能覆盖主账号。
   */
  uid?: string
}

/** 各平台解析器需要实现的接口 */
export interface PlatformResolver {
  /** 取播放链接 */
  resolve(songInfo: any, quality: string, cookie: string): Promise<AccountResolveResult>
  /** 探测账号登录态与会员状态 */
  getAccountInfo(cookie: string): Promise<AccountInfo>
  /**
   * 远程问一次「这份 Cookie 是哪个号」，返回平台侧稳定 user id（取不到返回空串）。
   *
   * 给保存链路用：Cookie 里没有稳定 uid 时（咪咕浏览器 Cookie 就是），
   * 靠它认出已有条目，避免「一键同步推一个新号就把主账号覆盖掉」。
   * 实现各自控制超时，调用方还会再套一层总预算。
   */
  resolveUid?(cookie: string): Promise<string>
}
