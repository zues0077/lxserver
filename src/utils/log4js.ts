import path from 'node:path'
import log4js from 'log4js'

// 统一本地时区的时间戳布局：与 src/utils/time.ts 的 localTime() 格式一致，
// 避免日志里出现「UTC + 本地」双层时间（容器默认时区常为 UTC，而代码里又混用本地时刻）。
const FILE_LAYOUT = { type: 'pattern', pattern: '%d{yyyy-MM-dd HH:mm:ss.SSS} [%p] %c - %m' }

const createLogConfig = (logPath: string) => {
  return {
    appenders: {
      access: {
        type: 'file',
        filename: path.join(logPath, 'access.log'),
        maxLogSize: 1024 * 1024 * 10,
        category: 'access',
        // compress: true,
        keepFileExt: true,
        numBackups: 10,
        layout: FILE_LAYOUT,
      },
      app: {
        type: 'file',
        filename: path.join(logPath, 'app.log'),
        maxLogSize: 10485760,
        backups: 10,
        keepFileExt: true,
        layout: FILE_LAYOUT,
      },
      errorFile: {
        type: 'file',
        filename: path.join(logPath, 'errors.log'),
        layout: FILE_LAYOUT,
      },
      errors: {
        type: 'logLevelFilter',
        level: 'ERROR',
        appender: 'errorFile',
      },
      console: {
        type: 'console',
        layout: FILE_LAYOUT,
      },
      login: {
        type: 'file',
        filename: path.join(logPath, 'login.log'),
        maxLogSize: 1024 * 1024 * 10,
        category: 'login',
        keepFileExt: true,
        numBackups: 10,
        layout: FILE_LAYOUT,
      },
      token: {
        type: 'file',
        filename: path.join(logPath, 'token.log'),
        maxLogSize: 1024 * 1024 * 10,
        category: 'token',
        keepFileExt: true,
        numBackups: 10,
        layout: FILE_LAYOUT,
      },
      subsonic: {
        type: 'file',
        filename: path.join(logPath, 'subsonic.log'),
        maxLogSize: 10485760,
        backups: 5,
        keepFileExt: true,
        layout: FILE_LAYOUT,
      },
    },
    categories: {
      default: { appenders: ['app', 'errors', 'console'], level: 'DEBUG' },
      access: { appenders: ['access'], level: 'ALL' },
      login: { appenders: ['login'], level: 'ALL' },
      token: { appenders: ['token'], level: 'ALL' },
      subsonic: { appenders: ['subsonic', 'errors'], level: 'DEBUG' },
    },
  }
}


export const initLogger = () => {
  log4js.configure(createLogConfig(global.lx.logPath))
}


export const startupLog = log4js.getLogger('startup')
export const syncLog = log4js.getLogger('sync')
export const accessLog = log4js.getLogger('access')
export const loginLog = log4js.getLogger('login')
export const tokenLog = log4js.getLogger('token')
export const subsonicLog = log4js.getLogger('subsonic')
