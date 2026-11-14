# Cognote 桌面版打包与发布指南

> 适用于 Electron 桌面版（macOS / Windows / Linux）。Web 便携包的构建见
> `scripts/build-packages.sh`，两者互不影响。

## 1. 环境要求

| 项目 | 要求 |
|---|---|
| Node.js | ≥ 22（建议 22 LTS） |
| 系统 | 在对应系统上打包：macOS 打 mac 包、Windows 打 win 包、Linux 打 Linux 包 |
| 网络 | 首次需下载 Electron 运行时（约 120 MB）与打包工具 |
| 磁盘 | 约 1 GB 空闲（产物 ~500 MB） |

国内网络建议设置 Electron 镜像（否则下载很慢）：

```bash
# macOS / Linux
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/

# Windows（cmd）
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
# Windows（PowerShell）
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
```

## 2. 一次性准备

```bash
git clone https://github.com/tyjsnz/CogNote.git
cd CogNote
npm ci          # 或 npm install（会安装 electron / electron-builder / electron-updater）
```

修改版本号（打包与自动更新都以它为准，**必须递增**）：

```bash
# 例如 1.0.4 → 1.0.5
npm version patch --no-git-tag-version
```

## 3. Windows 打包（在 Windows 电脑上）

```bat
npm ci
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm run desktop:pack:win
```

产物在 `dist\desktop\`：

| 文件 | 用途 |
|---|---|
| `Cognote-<版本>-setup.exe` | NSIS 安装版（**支持自动更新**，推荐分发） |
| `Cognote-<版本>-win.zip` | 便携版（解压即用，**不支持自动更新**） |
| `latest.yml` | 自动更新清单（**必须上传**） |
| `*.exe.blockmap` / `*.zip.blockmap` | 增量更新块索引（建议上传） |

> 可选：代码签名可减少 SmartScreen 提示。在 `package.json` 的 `build.win` 增加
> `certificateFile` / `certificatePassword`（或使用环境变量
> `CSC_LINK` / `CSC_KEY_PASSWORD`）。不签名也能打包与自动更新。

## 4. Linux 打包

```bash
npm ci
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm run desktop:pack:linux
```

产物：`Cognote-<版本>.AppImage`（支持自动更新）、`Cognote-<版本>-linux.zip`、
`latest-linux.yml`、`*.blockmap`。

## 5. macOS 打包（可选，本机已完成过一次）

```bash
export CSC_IDENTITY_AUTO_DISCOVERY=false   # 不签名
npm run desktop:pack:mac                   # 当前架构 → dmg + zip + latest-mac.yml
npx electron-builder --mac --x64           # Intel
```

产物：`Cognote-<版本>-arm64.dmg` / `-arm64-mac.zip`、`Cognote-<版本>.dmg` /
`-mac.zip`、`latest-mac.yml`。

> **自动更新要求**：macOS 的 electron-updater 要求应用**已签名**（Developer ID），
> 否则会提示「当前版本未签名，无法自动更新」，请手动下载新包。需要自动更新时：
> 1. 准备 Apple Developer ID Application 证书；
> 2. `export CSC_LINK=/path/to/cert.p12 CSC_KEY_PASSWORD=...` 后重新打包；
> 3. 分发前建议公证：`xcrun notarytool submit ...` 并 `xcrun stapler staple`。

## 6. 发布到更新服务器（关键）

自动更新源在 `package.json` 中配置为：

```json
"publish": [{ "provider": "generic", "url": "https://cognote.flacn.net/downloads/desktop/" }]
```

即：把生成物上传到服务器 `/www/wwwroot/cognote/downloads/desktop/`。

```bash
# 在打包机器上（示例，按实际产物名调整）
scp dist/desktop/latest.yml root@8.138.140.186:/www/wwwroot/cognote/downloads/desktop/
scp dist/desktop/*.exe dist/desktop/*.blockmap root@8.138.140.186:/www/wwwroot/cognote/downloads/desktop/
```

或使用 rsync：

```bash
rsync -av dist/desktop/latest*.yml dist/desktop/*.exe dist/desktop/*.AppImage \
      dist/desktop/*.blockmap root@8.138.140.186:/www/wwwroot/cognote/downloads/desktop/
```

注意事项：

- `latest.yml`（Windows）、`latest-linux.yml`（Linux）、`latest-mac.yml`（macOS）
  **必须与安装包一起上传**，否则客户端检查不到更新；
- 同名文件直接覆盖即可，electron-updater 会按版本号判断是否需要更新；
- 一次构建多个架构时（尤其 macOS arm64 + x64），务必让 `latest-mac.yml`
  与两个架构的包保持一致（同一次 `electron-builder --mac --arm64 --x64` 构建，
  或参考下方 CI 方案）；
- 上传后可用浏览器访问验证：
  `https://cognote.flacn.net/downloads/desktop/latest.yml`；
- **重要**：桌面更新包存放在 `downloads/desktop/`，而 Web 官网发布使用
  `rsync -a --delete site/ …`，会删除服务器上本地 `site/` 不存在的文件。发布官网时
  务必加上保护参数：

  ```bash
  rsync -a --delete --exclude 'downloads/desktop/' site/ root@8.138.140.186:/www/wwwroot/cognote/
  ```

## 7. 客户端更新行为

- 应用启动 3 秒后**静默检查**更新（`electron-updater` + generic 源）；
- 发现新版本 → 弹窗「发现新版本 vX.Y.Z」→ 下载 → 「更新已就绪」→ 立即重启安装；
- 菜单（macOS：应用菜单；Windows/Linux：帮助菜单）提供「检查更新…」手动入口；
- macOS 未签名时会弹窗提示并引导到官网下载页；
- Web 便携包与源码安装仍走原有 `/api/update/check` 逻辑，桌面版不使用该通道。

## 8. 可选：GitHub Actions 统一出三平台包

在仓库新增 `.github/workflows/desktop.yml`，用 `runs-on: macos-latest / windows-latest /
ubuntu-latest` 矩阵执行：

```yaml
- uses: actions/checkout@v4
- uses: actions/setup-node@v4
  with: { node-version: 22 }
- run: npm ci
- run: npx electron-builder --publish never
- uses: actions/upload-artifact@v4
  with:
    name: desktop-${{ matrix.os }}
    path: dist/desktop/**
```

产物下载后按第 6 节上传到更新源即可。macOS 自动更新仍需配置签名证书。

## 9. 常见问题

| 问题 | 处理 |
|---|---|
| 打包卡在下载 Electron | 设置 `ELECTRON_MIRROR` 镜像，或配置 `https_proxy` |
| Windows 打包报 NSIS 下载失败 | 配置代理重试；或改用 `zip` 目标先出便携包 |
| 客户端检查不到更新 | 确认 `latest*.yml` 已上传且版本号大于客户端版本 |
| macOS 提示未签名 | 正常现象；签名/公证后才能自动更新，否则手动下载 |
| 安装版被 SmartScreen 拦截 | 属于未签名安装包提示；可代码签名或让用户选择「仍要运行」 |
