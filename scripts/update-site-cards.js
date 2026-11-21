#!/usr/bin/env node
/**
 * 发版辅助：把 dist 产物的大小/SHA256 写进 site/index.html 的下载卡片。
 * 用法：node scripts/update-site-cards.js <artifactsDir...>
 * 产物文件名 → 卡片文件名映射见 MAP。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const V = pkg.version;

const dirs = process.argv.slice(2);
if (!dirs.length) {
  console.error('用法: node scripts/update-site-cards.js <dir...>');
  process.exit(1);
}

// 固定产物：卡片文件名 → 源文件（在 dirs 中按 basename 查找）
const MAP = {
  [`Cognote-v${V}-windows-x64.zip`]: `Cognote-v${V}-windows-x64.zip`,
  [`Cognote-v${V}-macos-arm64.zip`]: `Cognote-v${V}-macos-arm64.zip`,
  [`Cognote-v${V}-macos-x64.zip`]: `Cognote-v${V}-macos-x64.zip`,
  [`Cognote-v${V}-linux-x64.zip`]: `Cognote-v${V}-linux-x64.zip`,
  [`Cognote-Sync-Server-v${V}.zip`]: `Cognote-Sync-Server-v${V}.zip`,
  [`Cognote-${V}-setup.exe`]: `Cognote Setup ${V}.exe`,
  [`Cognote-${V}-macos-arm64.dmg`]: `Cognote-${V}-arm64.dmg`,
  [`Cognote-${V}-macos-x64.dmg`]: `Cognote-${V}.dmg`,
};

const files = new Map();
for (const d of dirs) {
  for (const f of fs.readdirSync(d)) files.set(f, path.join(d, f));
}

let html = fs.readFileSync(path.join(root, 'site/index.html'), 'utf8');
let okCount = 0;
for (const [cardName, srcName] of Object.entries(MAP)) {
  const src = files.get(srcName);
  if (!src) {
    console.log(`  ⚠️  未找到产物 ${srcName}（跳过 ${cardName}）`);
    continue;
  }
  const buf = fs.readFileSync(src);
  const mbNum = buf.length / 1024 / 1024;
  const mb = mbNum >= 0.1 ? `${mbNum.toFixed(1)} MB` : `${Math.round(buf.length / 1024)} KB`;
  const sha = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8);
  const re = new RegExp(
    `(<div class="file">${cardName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</div>\\s*<div class="meta"><span>)[^<]*(</span><span>SHA256 )[0-9a-fA-F]*…`
  );
  if (!re.test(html)) {
    console.log(`  ⚠️  卡片未匹配 ${cardName}`);
    continue;
  }
  html = html.replace(re, `$1${mb}$2${sha}…`);
  okCount++;
  console.log(`  ✅ ${cardName}: ${mb} · ${sha}…`);
}

fs.writeFileSync(path.join(root, 'site/index.html'), html);
console.log(`\n更新 ${okCount}/${Object.keys(MAP).length} 张卡片（版本 ${V}）`);
