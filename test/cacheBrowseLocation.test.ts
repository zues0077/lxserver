import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getCacheBrowseLocation, withCacheBrowseLocation } from '../src/server/cacheBrowseLocation'

test('非 cache 请求不设置浏览位置', () => {
  withCacheBrowseLocation('/api/music/search?name=x&browseLocation=root', () => {
    assert.equal(getCacheBrowseLocation(), undefined)
  })
})

test('cache 浏览请求带 browseLocation=root', () => {
  withCacheBrowseLocation('/api/music/cache/list?browseLocation=root', () => {
    assert.equal(getCacheBrowseLocation(), 'root')
  })
})

test('cache 浏览请求带 browseLocation=data', () => {
  withCacheBrowseLocation('/api/music/cache/file/admin/a.flac?folder=cache&browseLocation=data', () => {
    assert.equal(getCacheBrowseLocation(), 'data')
  })
})

test('cache 请求不带 browseLocation 时为 undefined（走持久化配置）', () => {
  withCacheBrowseLocation('/api/music/cache/list?user=_open', () => {
    assert.equal(getCacheBrowseLocation(), undefined)
  })
})

test('非法 location 值被忽略', () => {
  withCacheBrowseLocation('/api/music/cache/list?browseLocation=__evil__', () => {
    assert.equal(getCacheBrowseLocation(), undefined)
  })
})

test('写配置接口（config）不能被浏览态覆盖', () => {
  withCacheBrowseLocation('/api/music/cache/config?browseLocation=data', () => {
    assert.equal(getCacheBrowseLocation(), undefined)
  })
})

test('写配置接口（rename）不能被浏览态覆盖', () => {
  withCacheBrowseLocation('/api/music/cache/rename?browseLocation=data', () => {
    assert.equal(getCacheBrowseLocation(), undefined)
  })
})

test('remaster/start 属于浏览态', () => {
  withCacheBrowseLocation('/api/music/remaster/start?browseLocation=data', () => {
    assert.equal(getCacheBrowseLocation(), 'data')
  })
})

test('作用域结束后立即失效（不泄漏到后续请求）', () => {
  withCacheBrowseLocation('/api/music/cache/list?browseLocation=data', () => {
    assert.equal(getCacheBrowseLocation(), 'data')
  })
  assert.equal(getCacheBrowseLocation(), undefined)
})

test('嵌套请求：内层覆盖外层，出栈后恢复外层', () => {
  withCacheBrowseLocation('/api/music/cache/list?browseLocation=root', () => {
    assert.equal(getCacheBrowseLocation(), 'root')
    withCacheBrowseLocation('/api/music/cache/list?browseLocation=data', () => {
      assert.equal(getCacheBrowseLocation(), 'data')
    })
    assert.equal(getCacheBrowseLocation(), 'root')
  })
})

test('异常路径不残留上下文', () => {
  assert.throws(() => {
    withCacheBrowseLocation('/api/music/cache/list?browseLocation=data', () => {
      throw new Error('boom')
    })
  })
  assert.equal(getCacheBrowseLocation(), undefined)
})

test('并发请求互不串味', async () => {
  const seen = await Promise.all([
    withCacheBrowseLocation('/api/music/cache/list?browseLocation=root', async () => {
      await new Promise(r => setTimeout(r, 10))
      return getCacheBrowseLocation()
    }),
    withCacheBrowseLocation('/api/music/cache/list?browseLocation=data', async () => {
      await new Promise(r => setTimeout(r, 5))
      return getCacheBrowseLocation()
    }),
    withCacheBrowseLocation('/api/music/cache/list', async () => {
      await new Promise(r => setTimeout(r, 8))
      return getCacheBrowseLocation()
    }),
  ])
  assert.deepEqual(seen, ['root', 'data', undefined])
})
