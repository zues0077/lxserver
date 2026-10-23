#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""GHCR 多架构镜像安全清理（仅标准库，可直接跑在 GitHub Actions 上）。

为什么不用 actions/delete-package-versions 的 delete-only-untagged-versions：
  多架构镜像 = 1 个带 tag 的 index + 每平台一个 index + image manifest + attestation，
  后三类全是 **无 tag 版本**。无脑删掉所有 untagged 会让带 tag 的索引悬空，
  docker pull 立刻失败。本脚本先用 OCI 接口解析父子关系，只删「确定没人引用」的。

保留策略：
  - `latest` 永远保留
  - 最近 N 个正式版 tag（形如 X.Y.Z / vX.Y.Z）保留，其余删除
  - dev/test 类 tag（`test-*`、`<版本>-<sha>`、纯 sha）超过 N 天删除
  - 孤儿（无任何保留索引引用的 untagged）超过 N 天删除
  - 删除顺序：按依赖深度升序（先 image/attestation，后平台 index，最后顶层 index）

用法：
  python scripts/ghcr-cleanup.py --token "$TOKEN" --owner zues0077 --package lxserver \
      --keep-release 10 --dev-max-age-days 14 --orphan-max-age-days 7
  # 默认 dry-run，加 --apply 才真删
"""
import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request

API = 'https://api.github.com'
ACC = (
    'application/vnd.oci.image.index.v1+json,'
    'application/vnd.docker.distribution.manifest.list.v2+json,'
    'application/vnd.oci.image.manifest.v1+json,'
    'application/vnd.docker.distribution.manifest.v2+json'
)
RELEASE_RE = re.compile(r'^v?\d+\.\d+\.\d+$')


def build_opener():
    # GitHub Actions 里环境可能带代理，api.github.com / ghcr.io 走直连更稳
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


class Cleaner:
    def __init__(self, token, owner, package):
        self.token = token
        self.owner = owner
        self.package = package
        self.op = build_opener()

    # ---------- HTTP ----------
    def api(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        for attempt in range(4):
            req = urllib.request.Request(
                API + path, data=data, method=method,
                headers={'Authorization': f'Bearer {self.token}',
                         'Accept': 'application/vnd.github+json',
                         'Content-Type': 'application/json',
                         'User-Agent': 'ghcr-cleanup'})
            try:
                with self.op.open(req, timeout=60) as r:
                    txt = r.read().decode()
                    return r.status, (json.loads(txt) if txt.strip() else None)
            except urllib.error.HTTPError as e:
                txt = e.read().decode()
                if e.code == 403 and 'secondary rate' in txt.lower():
                    time.sleep(30)
                    continue
                try:
                    return e.code, json.loads(txt)
                except Exception:
                    return e.code, {'message': txt[:300]}
            except Exception as e:
                if attempt == 3:
                    return 0, {'message': f'{type(e).__name__}: {e}'}
                time.sleep(3 + attempt * 5)
        return 0, {'message': 'exhausted'}

    def registry_token(self):
        """公开包可匿名换 token；私有包退回 Basic 认证。"""
        url = (f'https://ghcr.io/token?scope=repository:{self.owner}/{self.package}'
               f':pull&service=ghcr.io')
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'ghcr-cleanup'})
            return json.loads(self.op.open(req, timeout=60).read().decode())['token']
        except Exception:
            import base64
            basic = base64.b64encode(f'{self.owner}:{self.token}'.encode()).decode()
            req = urllib.request.Request(
                url, headers={'Authorization': f'Basic {basic}', 'User-Agent': 'ghcr-cleanup'})
            return json.loads(self.op.open(req, timeout=60).read().decode())['token']

    def manifest(self, digest, retries=3):
        """ghcr.io 偶发连接超时，必须重试；404 直接返回 None（已删/不可达）。"""
        for attempt in range(retries):
            req = urllib.request.Request(
                f'https://ghcr.io/v2/{self.owner}/{self.package}/manifests/{digest}',
                headers={'Authorization': f'Bearer {self.rt}', 'Accept': ACC,
                         'User-Agent': 'ghcr-cleanup'})
            try:
                with self.op.open(req, timeout=90) as r:
                    return json.loads(r.read().decode())
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    return None
                if attempt == retries - 1:
                    return None
            except Exception:
                if attempt == retries - 1:
                    return None
            time.sleep(2 + attempt * 3)
        return None

    # ---------- 数据 ----------
    def versions(self):
        out, page = [], 1
        while True:
            st, d = self.api('GET', f'/users/{self.owner}/packages/container/'
                                    f'{self.package}/versions?per_page=100&page={page}')
            if st != 200 or not d:
                break
            out.extend(d)
            page += 1
            if page > 20:
                break
        return out

    # ---------- 主流程 ----------
    def plan(self, keep_release, dev_max_age_days, orphan_max_age_days):
        vers = self.versions()
        self.rt = self.registry_token()
        by_dig = {v['name']: v for v in vers}

        mfs = {}
        for v in vers:
            m = self.manifest(v['name'])
            if m:
                mfs[v['name']] = m
        children = {d: [c['digest'] for c in m['manifests']]
                    for d, m in mfs.items() if isinstance(m.get('manifests'), list)}

        def descendants(roots):
            seen = set(roots)
            stack = list(roots)
            while stack:
                for c in children.get(stack.pop(), []):
                    if c not in seen:
                        seen.add(c)
                        stack.append(c)
            return seen

        now = time.time()

        def age_days(v):
            t = time.mktime(time.strptime(v['created_at'], '%Y-%m-%dT%H:%M:%SZ'))
            return (now - t) / 86400.0

        tagged = [v for v in vers if v['metadata']['container']['tags']]
        releases = [v for v in tagged if any(RELEASE_RE.match(t) for t in v['metadata']['container']['tags'])]

        # 最近 keep_release 个正式版 + latest
        releases.sort(key=lambda v: v['created_at'], reverse=True)
        keep_roots = set(v['name'] for v in releases[:keep_release])
        keep_roots |= set(v['name'] for v in tagged
                          if 'latest' in v['metadata']['container']['tags'])

        # dev/test：超过阈值就删
        dev_drop = set()
        for v in tagged:
            if v['name'] in keep_roots:
                continue
            if age_days(v) >= dev_max_age_days:
                dev_drop.add(v['name'])

        # 超出保留数的正式版：也删
        for v in releases[keep_release:]:
            dev_drop.add(v['name'])

        keep = descendants(keep_roots)
        drop = descendants(dev_drop) - keep

        # 孤儿：既不在保留树里，也不属于任何待删树，且超过阈值
        orphans = set()
        for v in vers:
            if v['name'] in keep or v['name'] in drop:
                continue
            if not v['metadata']['container']['tags'] and age_days(v) >= orphan_max_age_days:
                orphans.add(v['name'])

        todo = (drop | orphans) - keep
        todo = {d for d in todo if d in by_dig}

        # 深度升序：image/attestation(0) → 平台 index(1) → 顶层 index(2)
        depth = {}

        def dep(d, seen=None):
            if d in depth:
                return depth[d]
            seen = seen or set()
            if d in seen:
                return 0
            seen.add(d)
            kids = children.get(d, [])
            depth[d] = 0 if not kids else 1 + max(dep(k, seen) for k in kids)
            return depth[d]

        for d in todo:
            dep(d)
        ordered = sorted(todo, key=lambda d: (depth[d], by_dig[d]['created_at']))
        return vers, by_dig, ordered, keep

    def run(self, keep_release, dev_max_age_days, orphan_max_age_days, apply_changes):
        vers, by_dig, ordered, keep = self.plan(keep_release, dev_max_age_days, orphan_max_age_days)
        print(f'版本总数 {len(vers)}；保留 {len(keep)}；待删 {len(ordered)}')
        for d in ordered[:20]:
            v = by_dig[d]
            print(f"  - {v['id']} {v['created_at']} {v['metadata']['container']['tags']}")
        if len(ordered) > 20:
            print(f'  ... 其余 {len(ordered) - 20} 条')

        if not apply_changes:
            print('\n[dry-run] 未删除。加 --apply 才会真正删除。')
            return 0

        ok = gone = skip = fail = 0
        for d in ordered:
            vid = by_dig[d]['id']
            st, resp = self.api('DELETE', f'/users/{self.owner}/packages/container/'
                                          f'{self.package}/versions/{vid}')
            if st in (200, 204):
                ok += 1
            elif st == 404:
                gone += 1
            elif st == 400 and 'download' in json.dumps(resp).lower():
                skip += 1
                print(f'  SKIP {vid} 下载量超限（>5000，需联系 GitHub 支持）')
            else:
                fail += 1
                print(f'  FAIL {vid} -> {st} {str(resp)[:150]}')
            time.sleep(0.1)
        print(f'\n完成：删除 {ok}，此前已删 {gone}，跳过 {skip}，失败 {fail}')

        left = self.versions()
        print('清理后剩余版本数:', len(left))
        return 1 if fail else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--token', required=True)
    ap.add_argument('--owner', default='zues0077')
    ap.add_argument('--package', default='lxserver')
    ap.add_argument('--keep-release', type=int, default=10,
                    help='保留最近多少个正式版 tag（X.Y.Z / vX.Y.Z）')
    ap.add_argument('--dev-max-age-days', type=int, default=14,
                    help='dev/test 类 tag 保留天数')
    ap.add_argument('--orphan-max-age-days', type=int, default=7,
                    help='孤儿 untagged 版本保留天数')
    ap.add_argument('--apply', action='store_true', help='真正执行删除')
    a = ap.parse_args()
    c = Cleaner(a.token, a.owner, a.package)
    return c.run(a.keep_release, a.dev_max_age_days, a.orphan_max_age_days, a.apply)


if __name__ == '__main__':
    sys.exit(main())
