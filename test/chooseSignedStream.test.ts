import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chooseSignedStream } from '../src/server/extraSources/soda'

/** 构造候选档：rank 越大音质越高；keyed 标记该档是否带钥 */
const tier = (label: string, rank: number, keyed: boolean) => ({
  v: { main_url: keyed ? `https://cdn/${label}-keyed` : `https://cdn/${label}` },
  meta: { label, rank },
  _keyed: keyed,
})

const keyOf = (x: any) => Boolean(x._keyed)

describe('chooseSignedStream（R76 带钥档优先）', () => {
  it('选中档带钥 → 维持原选（预算内最高档）不降档', () => {
    const ranked = [tier('flac24bit', 6, true), tier('flac', 5, false), tier('320k', 3, false)]
    const r = chooseSignedStream(ranked, 6, keyOf, false)
    assert.equal(r.item.meta.label, 'flac24bit')
    assert.equal(r.downgraded, false)
  })

  it('选中档无钥、预算内低档带钥 → 降级到预算内带钥最高档', () => {
    const ranked = [tier('flac24bit', 6, false), tier('flac', 5, false), tier('320k', 3, true), tier('128k', 2, false)]
    const r = chooseSignedStream(ranked, 6, keyOf, false)
    assert.equal(r.item.meta.label, '320k')
    assert.equal(r.downgraded, false, '预算内带钥选择不算降档')
  })

  it('预算内全无钥但有 track 级钥匙兜底 → 维持原选', () => {
    const ranked = [tier('flac24bit', 6, false), tier('320k', 3, false)]
    const r = chooseSignedStream(ranked, 6, keyOf, true)
    assert.equal(r.item.meta.label, 'flac24bit')
    assert.equal(r.downgraded, false)
  })

  it('预算内全无钥、预算外有钥 → 降档到带钥档并标记 downgraded', () => {
    const ranked = [tier('flac24bit', 6, false), tier('flac', 5, true), tier('320k', 3, false)]
    const r = chooseSignedStream(ranked, 3, keyOf, false)
    assert.equal(r.item.meta.label, 'flac')
    assert.equal(r.downgraded, true, '超出预算的带钥选择要标记降档')
  })

  it('所有档都无钥 → 维持原选（交由门禁/换源兜底）', () => {
    const ranked = [tier('flac24bit', 6, false), tier('320k', 3, false)]
    const r = chooseSignedStream(ranked, 6, keyOf, false)
    assert.equal(r.item.meta.label, 'flac24bit')
    assert.equal(r.downgraded, false)
  })

  it('请求音质预算内无档时：优先选带钥档（宁升档可播，不选无钥加密流）', () => {
    const ranked = [tier('flac24bit', 6, true), tier('flac', 5, false)]
    const r = chooseSignedStream(ranked, 2, keyOf, false)
    assert.equal(r.item.meta.label, 'flac24bit', '预算内无档 → 兜底时也优先带钥档')
    assert.equal(r.downgraded, true)
  })

  it('预算内多档带钥 → 选其中最高档', () => {
    const ranked = [tier('flac24bit', 6, false), tier('flac', 5, true), tier('320k', 3, true)]
    const r = chooseSignedStream(ranked, 6, keyOf, false)
    assert.equal(r.item.meta.label, 'flac')
    assert.equal(r.downgraded, false)
  })
})
