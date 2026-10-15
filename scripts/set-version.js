#!/usr/bin/env node
/**
 * 一键设置版本号。
 *
 * 版本号原本分散在两处：package.json 的 `version`（镜像 tag 与文档站页脚读取它）
 * 和 public/js/config.js 的 `version`（前端展示、release.yml 读取它）。
 * 这个脚本让它们永远保持一致，避免只改一处导致的版本错乱。
 *
 * 用法：
 *   npm run version:set -- 1.5.3
 *   node scripts/set-version.js 1.5.3
 *   node scripts/set-version.js v1.5.3     # 前缀 v 可有可无
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
  console.log('用法: npm run version:set -- <版本号>   （例如 1.5.3）');
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
  const next = src.replace(/(\n\s*version:\s*)'[^']*'(\s*,)/, `$1'v${version}'$2`);
  if (next === src) {
    console.warn(`⚠ ${path.relative(root, file)} 里没找到 version 字段，请检查格式`);
    continue;
  }
  fs.writeFileSync(file, next, 'utf-8');
  console.log(`✓ ${path.relative(root, file).padEnd(24)} v${oldVersion} → v${version}`);
}

console.log('\n接下来：');
console.log('  1) 在 changelog.md 顶部补一条 `## v' + version + '` 记录');
console.log('  2) 提交并推送到 main —— 镜像会自动打上 v' + version + ' / ' + version + ' / latest');
console.log('     （或手动触发 docker-publish 工作流，在 version 输入框里临时指定版本）');
