#!/usr/bin/env node
/**
 * 一键设置版本号。
 *
 * 版本号原本分散在两处：package.json 的 `version`（镜像 tag 与文档站页脚读取它）
 * 和 public/js/config.js 的 `version`（前端展示、release.yml 读取它）。
 * 这个脚本让它们永远保持一致，避免只改一处导致的版本错乱。
 *
 * 此外还会同步文档里「跟着版本号走」的示例（README 中英 + getting-started 中英）：
 * 镜像 tag、标签对照表、`npm run version:set` 用法示例 —— 这些此前必须手工改，
 * 漏改就会出现「文档写着旧版本、用户照着拉旧镜像」的漂移。changelog.md 属历史记录，不在此列。
 *
 * 用法：
 *   npm run version:set -- 1.5.5
 *   node scripts/set-version.js 1.5.5
 *   node scripts/set-version.js v1.5.5     # 前缀 v 可有可无
 *   node scripts/set-version.js            # 只打印当前版本
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const configPaths = [
  path.join(root, 'public', 'js', 'config.js'),
];

const raw = (process.argv[2] || '').trim();

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

if (!raw) {
  console.log(`当前版本: ${pkg.version}`);
  console.log('用法: npm run version:set -- <版本号>   （例如 1.5.5）');
  process.exit(0);
}

// 允许带 v 前缀，内部统一存不带 v 的语义化版本
const version = raw.replace(/^v/i, '');

// 只接受 x.y.z（可带 -pre / +build 后缀），避免把乱七八糟的东西写进 package.json
if (!/^\d+\.\d+\.\d+([-.+][0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`✗ 版本号格式不合法: ${raw}`);
  console.error('  期望形如 1.5.3 / 1.5.3-beta.1 / 1.5.3+build.7');
  process.exit(1);
}

const oldVersion = pkg.version;
pkg.version = version;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
console.log(`✓ package.json            ${oldVersion} → ${version}`);

for (const file of configPaths) {
  if (!fs.existsSync(file)) continue;
  const src = fs.readFileSync(file, 'utf-8');
  const re = /(\n\s*version:\s*)'[^']*'(\s*,)/;
  if (!re.test(src)) {
    console.warn(`⚠ ${path.relative(root, file)} 里没找到 version 字段，请检查格式`);
    continue;
  }
  const next = src.replace(re, `$1'v${version}'$2`);
  if (next === src) {
    console.log(`✓ ${path.relative(root, file).padEnd(24)} 已是 v${version}，无需修改`);
    continue;
  }
  fs.writeFileSync(file, next, 'utf-8');
  console.log(`✓ ${path.relative(root, file).padEnd(24)} v${oldVersion} → v${version}`);
}

// ---- 同步文档里跟着版本号走的示例（消除「文档写旧版本」漂移）----
// 文档中版本号有三类形态，都随发版漂移，这里一次性替换掉：
//   1) 镜像 tag：        ghcr.io/zues0077/lxserver:1.5.4 / ghcr.nju.edu.cn/...:1.5.4
//   2) 标签对照表：      | `v1.5.4` / `1.5.4` | 当前版本 ... |
//   3) 用法示例：        npm run version:set -- 1.5.4
// 注意：changelog.md 属历史记录，**不**在这里同步。
const docTargets = [
  path.join(root, 'README.md'),
  path.join(root, 'README_EN.md'),
  path.join(root, 'docs', 'guide', 'getting-started.md'),
  path.join(root, 'docs', 'en', 'guide', 'getting-started.md'),
];

const docRules = [
  { name: '镜像 tag', re: /(ghcr\.(?:io|nju\.edu\.cn)\/zues0077\/lxserver:)\d+\.\d+\.\d+/g, to: `$1${version}` },
  { name: '标签对照表', re: /`v\d+\.\d+\.\d+` \/ `\d+\.\d+\.\d+`/g, to: '`v' + version + '` / `' + version + '`' },
  { name: '版本用法示例', re: /(npm run version:set -- )\d+\.\d+\.\d+/g, to: `$1${version}` },
];

let docChanged = 0;
for (const file of docTargets) {
  if (!fs.existsSync(file)) continue;
  const src = fs.readFileSync(file, 'utf-8');
  let next = src;
  let hits = 0;
  const detail = [];
  for (const rule of docRules) {
    const matched = next.match(rule.re);
    if (matched) {
      hits += matched.length;
      detail.push(`${rule.name}×${matched.length}`);
    }
    next = next.replace(rule.re, rule.to);
  }
  if (next === src) {
    console.log(`✓ ${path.relative(root, file).padEnd(32)} 无版本号需同步`);
    continue;
  }
  fs.writeFileSync(file, next, 'utf-8');
  docChanged += hits;
  console.log(`✓ ${path.relative(root, file).padEnd(32)} 同步 ${hits} 处（${detail.join('、')}）→ v${version}`);
}
if (docChanged === 0) {
  console.log('✓ 文档版本号示例           全部已是最新，无需修改');
} else {
  console.log(`✓ 文档版本号示例           共同步 ${docChanged} 处`);
}

// ---- 更新通知一致性检查 ----
// 通知引擎按 `compareVersions(当前版本, target) >= 0` 判断 operator '<' 的条目是否要弹窗。
// 若存在 target 高于新版本的活跃更新通知（典型场景：版本号从 2.x 回退到 1.5.x），
// 新版本客户端会误弹「发现新版本 v2.1.3」。这里自动把它们归档。
function cmpVersion(a, b) {
  const pa = String(a).replace(/^v/i, '').split(/[.+-]/).map(x => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split(/[.+-]/).map(x => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

const noticePath = path.join(root, 'notice', 'notification.json');
if (fs.existsSync(noticePath)) {
  try {
    const notices = JSON.parse(fs.readFileSync(noticePath, 'utf-8'));
    let archived = 0;
    for (const item of Array.isArray(notices) ? notices : []) {
      if (item && item.type === 'version' && item.status === 'active'
          && item.logic && item.logic.target_version
          && cmpVersion(item.logic.target_version, version) > 0) {
        item.status = 'archived';
        archived++;
        console.log(`✓ notice/notification.json  通知 ${item.id}（target ${item.logic.target_version} > ${version}）已自动归档，避免误报升级`);
      }
    }
    if (archived > 0) {
      fs.writeFileSync(noticePath, JSON.stringify(notices, null, 4) + '\n', 'utf-8');
    } else {
      console.log(`✓ notice/notification.json  检查通过：没有 target 高于 v${version} 的活跃更新通知`);
    }
  } catch (e) {
    console.warn(`⚠ notice/notification.json 检查失败: ${e.message}`);
  }
}

console.log('\n接下来：');
console.log('  1) 在 changelog.md 顶部补一条 `## v' + version + '` 记录');
console.log('  2) 提交并推送到 main —— 镜像会自动打上 v' + version + ' / ' + version + ' / latest');
console.log('     （或手动触发 docker-publish 工作流，在 version 输入框里临时指定版本）');
