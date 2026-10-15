import {
  ACCOUNT_BASE_URL,
  DEFAULT_HTTP_TIMEOUT,
  MINA_SID,
  QR_LOGIN_SID,
  QR_MAX_POLL_COUNT,
  QR_POLL_TIMEOUT,
  SERVICE_TOKEN_VALID_HOURS,
  formatUserAgent,
} from './constants'
import { CookieJar } from './cookieJar'
import { generateDeviceId, md5Upper, sha1Base64 } from './crypto'
import {
  HttpTimeoutError,
  appendQuery,
  encodeForm,
  extractBigIntField,
  findSetCookieValue,
  httpRequest,
  parseJson,
  pickString,
} from './http'

/** 登录状态：成功 / 需要图形验证码 / 需要二次验证 / 失败 */
export type LoginState = 'success' | 'need_captcha' | 'need_verify' | 'failed'

/** 登录方式 */
export type LoginMethod = 'password' | 'qrcode' | 'cookie'

/** 保存下来的登录态（可持久化到磁盘，实现免登录） */
export interface TokenInfo {
  userId: string
  deviceId: string
  cUserId: string
  passToken: string
  ssecurity: string
  /** micoapi 服务的 serviceToken */
  serviceToken: string
  /** serviceToken 名义过期时间（毫秒时间戳） */
  expiresAt: number
  /** 本次登录时间 */
  acquiredAt: number
  loginMethod: LoginMethod
  /** 登录使用的账号（仅用于展示，接口返回时会被打码） */
  account?: string
}

export interface LoginResult {
  state: LoginState
  error?: string
  /** need_captcha 时的图片（base64，不含 data: 前缀） */
  captchaImage?: string
  /** need_verify 时的验证地址 */
  verifyUrl?: string
  verifyType?: 'phone' | 'email'
  tokenInfo?: TokenInfo
}

export interface QRCodeInfo {
  /** 可直接 <img> 展示的二维码图片地址 */
  qrcodeUrl: string
  /** 二维码里编码的登录地址（留给前端自行渲染二维码时使用） */
  loginUrl: string
}

export type QRCodeState = 'idle' | 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'failed'

export interface QRPollResult {
  state: QRCodeState
  message: string
  tokenInfo?: TokenInfo
}

/**
 * 小米账号认证器。
 *
 * 三条登录路径：
 *  1. 账号密码（可能进入图形验证码 / 短信邮箱二次验证）
 *  2. 扫码登录（longPolling 长轮询，免密码）
 *  3. 直接用已有的 passToken + userId（从浏览器 Cookie 里抄）
 *
 * 最终都要走 serviceLogin 拿 location + ssecurity + nonce，
 * 再算 clientSign 访问 location，从重定向链的 set-cookie 里取 serviceToken。
 */
export class MinaAuth {
  private jar = new CookieJar()
  private deviceId = generateDeviceId()
  private userAgent = formatUserAgent(this.deviceId)

  // 密码登录过程中的中间态
  private username = ''
  private password = ''
  private loginData: Record<string, unknown> | null = null
  private verifyUrl = ''
  private captchaIck = ''

  // 扫码登录过程中的中间态
  private qrPollUrl = ''
  private qrPollCount = 0
  private qrNonZeroStreak = 0
  private qrState: QRCodeState = 'idle'

  private token: TokenInfo | null = null

  /** 从已保存的登录态恢复 */
  restoreToken(token: TokenInfo | null | undefined) {
    if (!token || !token.userId || !token.serviceToken) return
    this.token = { ...token }
    if (token.deviceId) {
      this.deviceId = token.deviceId
      this.userAgent = formatUserAgent(this.deviceId)
    }
    if (token.cUserId) this.jar.setValue('cUserId', token.cUserId)
  }

  getToken(): TokenInfo | null {
    return this.token
  }

  /** serviceToken 是否仍然可用（留 3 小时余量） */
  isTokenValid(): boolean {
    if (!this.token || !this.token.userId || !this.token.serviceToken) return false
    const expiresAt = Number(this.token.expiresAt) || 0
    if (!expiresAt) return true
    return Date.now() + 3 * 3600 * 1000 < expiresAt
  }

  /** 直接用 passToken + userId 登录（扫码完成后也复用这条路径） */
  async loginByPassToken(passToken: string, userId: string, cUserId = '', account = ''): Promise<LoginResult> {
    const result = await this.exchangeServiceToken(passToken, userId, MINA_SID, cUserId, account)
    return result
  }

  /** 账号密码登录 */
  async loginWithPassword(username: string, password: string): Promise<LoginResult> {
    this.username = username
    this.password = password
    const step1 = await this.loginStep1(MINA_SID)
    if (!step1) return { state: 'failed', error: '获取登录签名失败，请检查网络能否访问 account.xiaomi.com' }
    this.loginData = step1
    return this.loginStep2WithPassword('')
  }

  /** 提交图形验证码继续登录 */
  async loginWithCaptcha(captcha: string): Promise<LoginResult> {
    if (!this.loginData) return { state: 'failed', error: '请先发起账号密码登录' }
    return this.loginStep2WithPassword(captcha)
  }

  /** 提交短信 / 邮箱验证码继续登录 */
  async loginWithVerifyCode(code: string): Promise<LoginResult> {
    if (!this.verifyUrl) return { state: 'failed', error: '当前没有待验证的登录会话' }
    const location = await this.verifyTicket(code)
    if (!location) return { state: 'failed', error: '验证码校验失败' }
    await this.followRedirectsForCookies(location)
    const passToken = this.jar.getValue('passToken')
    const userId = this.jar.getValue('userId')
    if (!passToken || !userId) return { state: 'failed', error: '二次验证后未获取到 passToken' }
    return this.exchangeServiceToken(passToken, userId, MINA_SID, this.jar.getValue('cUserId'), this.username)
  }

  // ===== 扫码登录 =====

  /** 第一步：向米家申请二维码 */
  async getQRCode(): Promise<QRCodeInfo | null> {
    this.resetQrSession()
    const step1 = await this.loginStep1(QR_LOGIN_SID)
    if (!step1) return null
    const sign = pickString(step1, '_sign')
    const qs = pickString(step1, 'qs')
    const callback = pickString(step1, 'callback')
    if (!sign || !qs || !callback) return null

    const params = encodeForm({
      _qrsize: '240',
      qs,
      sid: QR_LOGIN_SID,
      _sign: sign,
      callback,
      _json: 'true',
      _dc: String(Date.now()),
    })
    const qrUrl = `${ACCOUNT_BASE_URL}/longPolling/loginUrl?${params}`

    const res = await httpRequest(qrUrl, {
      method: 'GET',
      headers: { 'User-Agent': this.userAgent, 'Content-Type': 'application/x-www-form-urlencoded' },
      jar: this.jar,
      timeoutMs: DEFAULT_HTTP_TIMEOUT,
    })
    const data = parseJson<Record<string, unknown>>(res.text)
    if (!data || Number(data.code || 0) !== 0) return null

    const lp = pickString(data, 'lp')
    const qrImage = pickString(data, 'qr')
    const loginUrl = pickString(data, 'loginUrl')
    if (!lp) return null

    this.qrPollUrl = lp
    this.qrPollCount = 0
    this.qrNonZeroStreak = 0
    this.qrState = 'waiting'

    return { qrcodeUrl: qrImage || loginUrl, loginUrl }
  }

  /** 第二步：轮询扫码状态（服务端长轮询，阻塞到状态变化或超时） */
  async pollQRCode(): Promise<QRPollResult> {
    if (!this.qrPollUrl) return { state: 'failed', message: '请先获取二维码' }

    this.qrPollCount += 1
    if (this.qrPollCount > QR_MAX_POLL_COUNT) {
      this.qrState = 'expired'
      return { state: 'expired', message: '二维码已过期，请重新获取' }
    }

    let res
    try {
      res = await httpRequest(this.qrPollUrl, {
        method: 'GET',
        headers: { 'User-Agent': this.userAgent, 'Content-Type': 'application/x-www-form-urlencoded' },
        jar: this.jar,
        timeoutMs: QR_POLL_TIMEOUT,
      })
    } catch (error: any) {
      if (error instanceof HttpTimeoutError) {
        // 长轮询超时 = 用户还没扫，属于正常等待
        return { state: 'waiting', message: '等待扫码' }
      }
      this.qrState = 'failed'
      return { state: 'failed', message: `轮询失败: ${error?.message || error}` }
    }

    if (res.status === 403) {
      this.qrState = 'expired'
      return { state: 'expired', message: '二维码已失效，请重新获取' }
    }
    if (res.status >= 400) {
      this.qrState = 'failed'
      return { state: 'failed', message: `轮询失败: HTTP ${res.status}` }
    }

    const data = parseJson<Record<string, unknown>>(res.text)
    if (!data) return { state: 'waiting', message: '等待扫码' }

    if (Number(data.code || 0) !== 0) {
      // 偶发非零码（并发残留/瞬时重连）不该立刻判过期
      this.qrNonZeroStreak += 1
      if (this.qrNonZeroStreak >= 2) {
        this.qrState = 'expired'
        return { state: 'expired', message: `二维码已过期: ${pickString(data, 'desc', 'unknown')}` }
      }
      return { state: 'waiting', message: '等待扫码' }
    }
    this.qrNonZeroStreak = 0

    const passToken = pickString(data, 'passToken')
    const userId = pickString(data, 'userId')
    const cUserId = pickString(data, 'cUserId')
    if (!passToken || !userId) {
      // 已扫码但未确认，接口不会下发 passToken
      this.qrState = 'scanned'
      return { state: 'scanned', message: '已扫码，请在手机上确认登录' }
    }

    const result = await this.exchangeServiceToken(passToken, userId, MINA_SID, cUserId, '扫码登录')
    if (result.state !== 'success' || !result.tokenInfo) {
      this.qrState = 'failed'
      return { state: 'failed', message: result.error || '换取 serviceToken 失败' }
    }
    this.qrState = 'confirmed'
    this.qrPollUrl = ''
    return { state: 'confirmed', message: '登录成功', tokenInfo: result.tokenInfo }
  }

  getQRState(): QRCodeState {
    return this.qrState
  }

  /** 重置扫码会话（重新获取二维码时调用） */
  resetQrSession() {
    this.qrPollUrl = ''
    this.qrPollCount = 0
    this.qrNonZeroStreak = 0
    this.qrState = 'idle'
  }

  // ===== 内部实现 =====

  /** Step1：获取登录签名 */
  private async loginStep1(sid: string): Promise<Record<string, unknown> | null> {
    const url = `${ACCOUNT_BASE_URL}/pass/serviceLogin?sid=${sid}&_json=true`
    const res = await httpRequest(url, {
      method: 'GET',
      headers: {
        'User-Agent': this.userAgent,
        'Cookie': `sdkVersion=3.8.6; deviceId=${this.deviceId}`,
      },
      jar: this.jar,
      timeoutMs: DEFAULT_HTTP_TIMEOUT,
    })
    return parseJson<Record<string, unknown>>(res.text)
  }

  /** Step2：提交账号密码（可带图形验证码） */
  private async loginStep2WithPassword(captcha: string): Promise<LoginResult> {
    const auth = this.loginData || {}
    const url = `${ACCOUNT_BASE_URL}/pass/serviceLoginAuth2?_json=true`

    const form: Record<string, string> = {
      user: this.username,
      hash: md5Upper(this.password),
      callback: pickString(auth, 'callback'),
      sid: pickString(auth, 'sid', MINA_SID),
      qs: pickString(auth, 'qs'),
      _sign: pickString(auth, '_sign'),
    }
    if (captcha) form.captCode = captcha

    const cookieParts = [`sdkVersion=3.8.6`, `deviceId=${this.deviceId}`]
    if (captcha && this.captchaIck) cookieParts.push(`ick=${this.captchaIck}`)

    const res = await httpRequest(url, {
      method: 'POST',
      headers: {
        'User-Agent': this.userAgent,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookieParts.join('; '),
      },
      body: encodeForm(form),
      jar: this.jar,
      timeoutMs: DEFAULT_HTTP_TIMEOUT,
    })

    const data = parseJson<Record<string, unknown>>(res.text)
    if (!data) return { state: 'failed', error: `登录响应解析失败: ${res.text.slice(0, 200)}` }

    // 二次验证（短信/邮箱）
    const notificationUrl = pickString(data, 'notificationUrl')
    if (notificationUrl) {
      const verifyUrl = notificationUrl.startsWith('http') ? notificationUrl : ACCOUNT_BASE_URL + notificationUrl
      this.verifyUrl = verifyUrl
      return {
        state: 'need_verify',
        verifyUrl,
        verifyType: verifyUrl.includes('email') ? 'email' : 'phone',
      }
    }

    // 图形验证码
    const captchaRaw =
      pickString(data, 'captchaUrl') ||
      pickString(data, 'captchaURL') ||
      pickString(data, 'captcha_url') ||
      pickString(data, 'imgUrl')
    if (captchaRaw) {
      const captchaUrl = captchaRaw.startsWith('http') ? captchaRaw : ACCOUNT_BASE_URL + captchaRaw
      try {
        const imageRes = await httpRequest(captchaUrl, {
          method: 'GET',
          headers: { 'User-Agent': this.userAgent },
          jar: this.jar,
          binary: true,
          timeoutMs: DEFAULT_HTTP_TIMEOUT,
        })
        this.captchaIck = this.jar.getValue('ick')
        return {
          state: 'need_captcha',
          captchaImage: imageRes.binary ? imageRes.binary.toString('base64') : '',
        }
      } catch (error: any) {
        return { state: 'need_captcha', captchaImage: '', error: `获取验证码图片失败: ${error?.message || error}` }
      }
    }

    const location = pickString(data, 'location')
    if (!location) {
      return {
        state: 'failed',
        error: `登录失败: code=${pickString(data, 'code', '?')} ${pickString(data, 'desc') || pickString(data, 'description')}`,
      }
    }

    const ssecurity = pickString(data, 'ssecurity')
    const nonce = extractBigIntField(res.text, 'nonce') || pickString(data, 'nonce')
    const userId = pickString(data, 'userId')
    const passToken = pickString(data, 'passToken')
    // 提前记下 passToken / userId，便于后续免密续期
    if (passToken) this.jar.setValue('passToken', passToken)
    if (userId) this.jar.setValue('userId', userId)

    const clientSign = sha1Base64(`nonce=${nonce}&${ssecurity}`)
    const locationWithSign = appendQuery(location, { _userIdNeedEncrypt: 'true', clientSign })
    const error = await this.sts(locationWithSign, MINA_SID, ssecurity, userId, passToken)
    if (error) return { state: 'failed', error: `换取 serviceToken 失败: ${error}` }

    return { state: 'success', tokenInfo: this.token || undefined }
  }

  /** Step3：访问 location，跟随重定向链从 set-cookie 取 serviceToken */
  private async sts(
    location: string,
    sid: string,
    ssecurity: string,
    userId = '',
    passToken = ''
  ): Promise<string | null> {
    const res = await httpRequest(location, {
      method: 'GET',
      headers: { 'User-Agent': this.userAgent, 'Content-Type': 'application/x-www-form-urlencoded' },
      jar: this.jar,
      maxRedirects: 10,
      timeoutMs: DEFAULT_HTTP_TIMEOUT,
    })

    const serviceToken = findSetCookieValue(res.setCookie, 'serviceToken') || this.jar.getValue('serviceToken')
    const finalUserId = userId || this.jar.getValue('userId') || this.token?.userId || ''
    const finalPassToken = passToken || this.jar.getValue('passToken') || ''
    const cUserId = this.jar.getValue('cUserId') || this.token?.cUserId || ''

    if (!serviceToken) {
      return `未获取到 serviceToken (status=${res.status}, body=${res.text.slice(0, 160)})`
    }

    this.token = {
      userId: finalUserId,
      deviceId: this.deviceId,
      cUserId,
      passToken: finalPassToken,
      ssecurity: ssecurity || this.jar.getValue('ssecurity'),
      serviceToken,
      expiresAt: Date.now() + SERVICE_TOKEN_VALID_HOURS * 3600 * 1000,
      acquiredAt: Date.now(),
      loginMethod: this.username ? 'password' : 'cookie',
      account: this.username || this.token?.account || '',
    }
    void sid
    return null
  }

  /** 用 passToken 换取指定服务的 serviceToken */
  private async exchangeServiceToken(
    passToken: string,
    userId: string,
    sid: string,
    cUserId = '',
    account = ''
  ): Promise<LoginResult> {
    const url = `${ACCOUNT_BASE_URL}/pass/serviceLogin?sid=${sid}&_json=true`
    const cookieParts = [`passToken=${passToken}`, `userId=${userId}`, `deviceId=${this.deviceId}`, `sdkVersion=3.8.6`]
    if (cUserId) cookieParts.push(`cUserId=${cUserId}`)

    const res = await httpRequest(url, {
      method: 'GET',
      headers: { 'User-Agent': this.userAgent, 'Cookie': cookieParts.join('; ') },
      jar: this.jar,
      timeoutMs: DEFAULT_HTTP_TIMEOUT,
    })
    const data = parseJson<Record<string, unknown>>(res.text)
    if (!data) return { state: 'failed', error: 'serviceLogin 响应解析失败' }

    const code = Number(data.code || 0)
    if (code !== 0) {
      return { state: 'failed', error: `serviceLogin 失败: code=${code} ${pickString(data, 'desc')}` }
    }

    const location = pickString(data, 'location')
    if (!location) return { state: 'failed', error: 'serviceLogin 未返回 location' }

    const ssecurity = pickString(data, 'ssecurity')
    const nonce = extractBigIntField(res.text, 'nonce') || pickString(data, 'nonce')
    const newUserId = pickString(data, 'userId', userId)
    if (cUserId) this.jar.setValue('cUserId', cUserId)
    this.jar.setValue('passToken', passToken)

    const clientSign = sha1Base64(`nonce=${nonce}&${ssecurity}`)
    const locationWithSign = appendQuery(location, { _userIdNeedEncrypt: 'true', clientSign })
    const error = await this.sts(locationWithSign, sid, ssecurity, newUserId, passToken)
    if (error) return { state: 'failed', error }

    if (this.token) {
      this.token.loginMethod = account === '扫码登录' ? 'qrcode' : this.username ? 'password' : 'cookie'
      this.token.account = account || this.username || ''
    }
    return { state: 'success', tokenInfo: this.token || undefined }
  }

  /** 校验二次验证码 */
  private async verifyTicket(ticket: string): Promise<string | null> {
    const isEmail = this.verifyUrl.includes('email')
    const api = `${ACCOUNT_BASE_URL}${isEmail ? '/identity/auth/verifyEmail' : '/identity/auth/verifyPhone'}?_dc=${Date.now()}`
    const res = await httpRequest(api, {
      method: 'POST',
      headers: { 'User-Agent': this.userAgent, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: encodeForm({ ticket, trust: 'true', _json: 'true', _flag: isEmail ? '8' : '4' }),
      jar: this.jar,
      timeoutMs: DEFAULT_HTTP_TIMEOUT,
    })
    const data = parseJson<Record<string, unknown>>(res.text)
    if (!data || Number(data.code || 0) !== 0) return null
    return pickString(data, 'location') || null
  }

  /** 跟随重定向链收集 Cookie（passToken / userId 在这里拿到） */
  private async followRedirectsForCookies(location: string) {
    try {
      await httpRequest(location, {
        method: 'GET',
        headers: { 'User-Agent': this.userAgent, 'Content-Type': 'application/x-www-form-urlencoded' },
        jar: this.jar,
        maxRedirects: 10,
        timeoutMs: DEFAULT_HTTP_TIMEOUT,
      })
    } catch {
      // passToken 可能已经在 CookieJar 里，忽略
    }
  }
}
