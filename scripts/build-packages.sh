#!/bin/bash
# Cognote 发行包构建：绿色便携包（内置官方 Node 运行时）
# 产物: dist/release/Cognote-v<版本>-<平台>.zip + Cognote-Sync-Server-v<版本>.zip + SHA256SUMS.txt
# 运行时从 npmmirror 下载（国内高速），可重复执行（已下载的会跳过）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
NODE_VER="22.22.3"
MIRROR="https://registry.npmmirror.com/-/binary/node/v${NODE_VER}"
OUT="$ROOT/dist/release"
CACHE="$ROOT/dist/runtime"
STAGE="$OUT/.stage"
NAME="Cognote-v${VERSION}"

mkdir -p "$OUT" "$CACHE"
rm -rf "$STAGE"
mkdir -p "$STAGE"

fetch() { # <url> <dest>
  if [ -s "$2" ]; then return 0; fi
  echo "  下载 $(basename "$2") ..."
  curl -fsSL --retry 3 --retry-delay 2 -o "$2.part" "$1"
  mv "$2.part" "$2"
}

# ---------- 应用文件（各平台共用） ----------
stage_app() { # <目标目录>
  local d="$1"
  mkdir -p "$d/scripts"
  cp "$ROOT/server.js" "$ROOT/package.json" "$ROOT/config.example.json" "$ROOT/LICENSE" "$ROOT/README.md" "$d/"
  cp -R "$ROOT/src" "$ROOT/public" "$d/"
  cp "$ROOT/scripts/self-update.js" "$d/scripts/"
  find "$d" -name '.DS_Store' -delete
}

launcher_windows() { # <目标目录>
  cat > "$1/启动 Cognote.bat" <<'BAT'
@echo off
chcp 65001 >nul
title Cognote
cd /d "%~dp0"
echo ==========================================
echo   Cognote 启动中...
echo   浏览器访问: http://127.0.0.1:8570
echo   关闭本窗口即停止服务
echo ==========================================
"%~dp0node.exe" "%~dp0server.js"
pause
BAT
}

launcher_unix() { # <目标目录> <启动文件名>
  local d="$1" f="$2"
  cat > "$d/$f" <<SH
#!/bin/bash
cd "\$(dirname "\$0")"
echo "=========================================="
echo "  Cognote 启动中..."
echo "  浏览器访问: http://127.0.0.1:8570"
echo "  按 Ctrl+C 停止服务"
echo "=========================================="
exec ./node server.js
SH
  chmod +x "$d/$f"
}

readme_txt() { # <目标目录>
  cat > "$1/使用说明.txt" <<'TXT'
Cognote 便携版使用说明
================================

一、启动
  Windows : 双击「启动 Cognote.bat」
  macOS   : 双击「启动 Cognote.command」
            （若提示"无法打开"，在终端执行  xattr -cr .  后重试，或右键 → 打开）
  Linux   : 终端执行  ./start.sh

  启动后用浏览器访问: http://127.0.0.1:8570
  关闭窗口（或 Ctrl+C）即停止服务。

二、首次配置
  1. 打开 http://127.0.0.1:8570
  2. 进入「设置」→ 笔记目录，填写存放 Markdown 笔记的目录（可填多个），保存
  3. 目录树会自动扫描并建立中文全文索引

三、数据位置（均在本程序目录内）
  config.json   配置文件（首次启动自动生成）
  .index.json   全文索引缓存
  云端同步/     启用云端同步后出现的本地同步目录

四、云端同步（可选，需自建同步服务）
  Cognote 不提供官方云端，也不上传任何数据。
  如需多设备同步，请自行部署同步服务端（下载页的
  Cognote-Sync-Server 包，内含完整部署文档），
  然后在 Cognote「设置 → 云端同步」填写服务器地址与 Token。
  详细图文教程见官网「自建云同步」页面。

五、注意事项
  - 请把本目录放在可写位置（桌面 / 文档等），不要放进系统保护目录
  - 笔记始终以你的本地文件为准；卸载 = 删除本目录（先备份 config.json）
TXT
}

# ---------- 各平台包 ----------
build_platform() { # <平台标识> <npmmirror 文件名> <运行时解压后路径> <运行时目标名>
  local plat="$1" tarfile="$2" inner="$3" rtname="$4"
  local pkg="$STAGE/${NAME}-${plat}"
  echo "== 构建 ${NAME}-${plat}"
  fetch "$MIRROR/$tarfile" "$CACHE/$tarfile"

  local tmp="$STAGE/.rt-$plat"
  rm -rf "$tmp"; mkdir -p "$tmp"
  case "$tarfile" in
    *.zip)    (cd "$tmp" && unzip -q "$CACHE/$tarfile") ;;
    *.tar.xz) tar -xJf "$CACHE/$tarfile" -C "$tmp" ;;
    *.tar.gz) tar -xzf "$CACHE/$tarfile" -C "$tmp" ;;
  esac
  cp "$tmp/$inner" "$tmp/$rtname"

  stage_app "$pkg"
  mv "$tmp/$rtname" "$pkg/$rtname"
  rm -rf "$tmp"
  chmod +x "$pkg/$rtname"

  case "$plat" in
    windows-*) launcher_windows "$pkg" ;;
    linux-*)   launcher_unix "$pkg" "start.sh" ;;
    macos-*)   launcher_unix "$pkg" "启动 Cognote.command" ;;
  esac
  readme_txt "$pkg"

  (cd "$STAGE" && zip -X -qry "$OUT/${NAME}-${plat}.zip" "${NAME}-${plat}")
  rm -rf "$pkg"
  echo "  完成: ${NAME}-${plat}.zip ($(du -h "$OUT/${NAME}-${plat}.zip" | cut -f1))"
}

# ---------- 同步服务端包 ----------
build_sync() {
  local pkg="$STAGE/Cognote-Sync-Server-v${VERSION}"
  echo "== 构建 Cognote-Sync-Server-v${VERSION}"
  mkdir -p "$pkg"
  cp "$ROOT/sync-server/server.js" "$ROOT/sync-server/share-viewer.html" \
     "$ROOT/sync-server/package.json" "$ROOT/sync-server/README.md" "$pkg/"
  cat > "$pkg/config.example.json" <<'JSON'
{
  "token": "",
  "port": 8600,
  "host": "127.0.0.1",
  "maxFileMb": 20,
  "inlineBudgetMb": 24
}
JSON
  find "$pkg" -name '.DS_Store' -delete
  (cd "$STAGE" && zip -X -qry "$OUT/Cognote-Sync-Server-v${VERSION}.zip" "Cognote-Sync-Server-v${VERSION}")
  rm -rf "$pkg"
  echo "  完成: Cognote-Sync-Server-v${VERSION}.zip"
}

# ---------- 应用更新包（自动更新专用：仅应用文件，跨平台共用） ----------
build_app_update() {
  local pkg="$STAGE/Cognote-AppUpdate-v${VERSION}"
  echo "== 构建 Cognote-AppUpdate-v${VERSION}"
  stage_app "$pkg"
  (cd "$STAGE" && zip -X -qry "$OUT/Cognote-AppUpdate-v${VERSION}.zip" "Cognote-AppUpdate-v${VERSION}")
  rm -rf "$pkg"
  echo "  完成: Cognote-AppUpdate-v${VERSION}.zip ($(du -h "$OUT/Cognote-AppUpdate-v${VERSION}.zip" | cut -f1))"
}

# ---------- 更新源清单 latest.json（供客户端 /api/update/check 拉取） ----------
write_manifest() {
  echo "== 生成 latest.json"
  UPDATE_BASE_URL="${UPDATE_BASE_URL:-https://cognote.flacn.net/downloads}" node - "$OUT" "$VERSION" "$ROOT" <<'JS'
const fs = require('fs');
const path = require('path');
let args = process.argv.slice(1);
if (args[0] === '-') args = process.argv.slice(2); // `node -` 时 '-' 也占 argv
const [out, version, root] = args;
const base = process.env.UPDATE_BASE_URL || 'https://cognote.flacn.net/downloads';

// SHA256SUMS → { 文件名: 哈希 }
const sums = {};
for (const line of fs.readFileSync(path.join(out, 'SHA256SUMS.txt'), 'utf8').trim().split('\n')) {
  const m = line.trim().match(/^([0-9a-f]{64})\s+\*?\.\s*\/(.+)$/) || line.trim().match(/^([0-9a-f]{64})\s+\.\s*\/(.+)$/);
  if (m) sums[m[2]] = m[1];
}
const info = (file) => ({
  file,
  url: base + '/' + file,
  size: fs.statSync(path.join(out, file)).size,
  sha256: sums[file] || '',
});

// 更新说明：优先 RELEASE_NOTES 环境变量，否则自动摘取 CHANGELOG 最新小节
let notes = process.env.RELEASE_NOTES || '';
if (!notes) {
  try {
    const md = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    const lines = md.split('\n');
    let start = -1;
    for (let i = 0; i < lines.length; i++) { if (/^### /.test(lines[i])) { start = i; break; } }
    if (start >= 0) {
      const buf = [];
      for (let i = start + 1; i < lines.length; i++) {
        if (/^#{2,3} /.test(lines[i])) break;
        buf.push(lines[i]);
      }
      notes = buf.join('\n').replace(/^\s*-\s+/gm, '· ').replace(/\n{2,}/g, '\n').trim();
    }
  } catch { /* 无 CHANGELOG 则留空 */ }
}

const plats = ['windows-x64', 'macos-arm64', 'macos-x64', 'linux-x64'].map((p) => ({
  platform: p, ...info(`Cognote-v${version}-${p}.zip`),
}));
const manifest = {
  name: 'Cognote',
  version,
  publishedAt: new Date().toISOString(),
  notes: notes.length > 1000 ? notes.slice(0, 1000) + '…（完整说明见官网 CHANGELOG）' : notes,
  appUpdate: info(`Cognote-AppUpdate-v${version}.zip`),
  packages: plats,
  syncServer: info(`Cognote-Sync-Server-v${version}.zip`),
};
fs.writeFileSync(path.join(out, 'latest.json'), JSON.stringify(manifest, null, 2));
console.log('  完成: latest.json (version=' + version + ', notes=' + notes.length + ' 字)');
JS
}

build_platform "windows-x64" "node-v${NODE_VER}-win-x64.zip"    "node-v${NODE_VER}-win-x64/node.exe" "node.exe"
build_platform "macos-arm64" "node-v${NODE_VER}-darwin-arm64.tar.xz" "node-v${NODE_VER}-darwin-arm64/bin/node" "node"
build_platform "macos-x64"   "node-v${NODE_VER}-darwin-x64.tar.xz"   "node-v${NODE_VER}-darwin-x64/bin/node"   "node"
build_platform "linux-x64"   "node-v${NODE_VER}-linux-x64.tar.xz"    "node-v${NODE_VER}-linux-x64/bin/node"    "node"
build_sync
build_app_update

rm -rf "$STAGE"
(cd "$OUT" && shasum -a 256 ./*.zip > SHA256SUMS.txt)
write_manifest
echo "== 全部完成 =="
ls -la "$OUT"
cat "$OUT/SHA256SUMS.txt"
