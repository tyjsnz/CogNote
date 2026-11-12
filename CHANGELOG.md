# 开发日志

## 2026-11-13

### 修复：双链图引用目标错误（多目录前缀重复）无法打开

- 多目录索引（如「云端同步」+ 本地目录）下，链接解析时已带上目录前缀，双链图又
  补了一次前缀，导致所有边指向 `云端同步/云端同步/…` 这类不存在的路径，点击报
  「无法读取 / 文件不存在」
- 修复：`getLinkGraph()` 直接使用解析后的完整路径，不再二次补前缀
- 顺带增强链接解析：支持 `x.md#锚点`、`<x.md>`、URL 编码路径（`%20`），并排除
  `http(s):` 外链；跨目录 `../` 引用正常
- **测试**：双链图专项 8 项（加载/无重复前缀/标题可读/点击打开/无读取失败/无JS错误）
  + final-regress 30 + cherry-e2e 27 全绿

## 2026-11-12

### 变更：移除编辑器「📝 源码」模式按钮

- 编辑笔记右上角的「源码/预览」切换按钮移除：Cherry 本身就是 Markdown 源码 +
  实时预览分栏，独立源码模式已无必要，减少一处模式歧义
- 同步清理：`#md-source` textarea、`editorMode` 状态、`switchEditorMode()`、
  文件上传的 source 分支及对应 CSS；保存/上传/AI 选区助手链路不变
- **测试**：cherry-e2e 27（新增「源码按钮/textarea 已移除」断言）+ drawio 23 +
  final-regress 30 + toolbar-shot 12 = **92 项全绿**

### 新增：draw.io 画图集成（工具栏画图直接插入文档）

- 工具栏一级直出 **draw.io** 按钮（表格/图片/超链接之后）：点击弹出本地 draw.io
  编辑器，画完点「确定」直接把图以 `![名称](data:image/png;base64,…){data-type=drawio
  data-xml=…}` 插入文档；预览区点击图片可再次打开 draw.io 继续编辑
- **自托管离线可用**：官方桥接页 `drawio_demo.html` + `drawio_lib`/`mxgraph` 静态资源
  入库 `public/vendor/drawio/`（7.1 MB / 350 文件，零外网依赖），走 Cherry 自定义
  postMessage 协议（ready? / ready / setData / getData / getData:success）
- **修复（关键）**：Cherry 对大体积 base64 先替换为 `bigDataBegin…bigDataEnd` 占位符
  再调 `urlProcessor`，此前会被误当相对路径改写成 `/api/file?rel=…`（drawio 图片、
  工具栏图片均受益）
- 查看模式 `markdown.js`、分享页 `share-viewer.html` 兼容 drawio 语法：剥离 `{…}`
  属性块、`data:` 内联图直接渲染（分享页同时修正非 `http(s)://` 绝对图被误拼路径）
- 服务端静态 MIME 补 `.txt`/`.xml`/`.eot`；桥接脚本对空图 `setData` 跳过导入
  （消除 mxCodec allowlist 告警）；补 `mxgraph/css/common.css` 占位消除 404
- **测试**：drawio 专项 23 项（按钮/弹层/iframe 初始化/画布插入/确定插入/预览/
  重新编辑/保存落盘/查看模式渲染/无错误）+ 既有回归 72 项（cherry-e2e 30 +
  toolbar-shot 12 + final-regress 30）**全绿共 95 项**

### 发布：v1.0.2（draw.io 画图发行包 + 官网部署）

- 版本 1.0.1 → **1.0.2**，重建 4 平台应用包 + Sync 服务端包 + AppUpdate 包 +
  `latest.json`（`notes` 自动摘取上方 draw.io 小节 913 字）
- `site/index.html` 5 处更新：文件名 v1.0.1→v1.0.2、体积（windows 35.1→36.8 MB /
  arm64 38.8→40.5 / x64 39.9→41.6 / linux 45.4→47.1，drawio 资源 +7.1 MB 所致）、
  哈希前缀（windows c29b95af / arm64 efad4b40 / x64 8f520331 / linux d2de8f14 /
  sync 85e66cfa）；AppUpdate 包 5.2 MB
- 部署 `rsync site/ → /www/wwwroot/cognote`，线上实测：页面前缀 = 服务器
  `sha256sum` = `latest.json` 记录**三方一致**；6 包 + latest.json + SHA256SUMS
  HEAD 200、Range 206；**AppUpdate 包全量下载后本机 sha256 `764f899e…` 与服务器
  完全一致**；真机 Chrome 打开首页无 4xx、无 JS 错误
- 当前线上版本 **v1.0.2**

### 发布：v1.0.1（编辑器迁移发行包 + 官网部署）

- 版本 1.0.0 → **1.0.1**，重建 4 平台应用包 + Sync 服务端包 + AppUpdate 包 +
  `latest.json`（`notes` 自动摘取上方「编辑器迁移」小节 1020 字）
- `site/index.html` 5 处更新：文件名 v1.0.0→v1.0.1、体积（windows 37.6→35.1 MB /
  arm64 41.3→38.8 / x64 42.4→39.9 / linux 47.9→45.4，Cherry 精简 vendor 生效）、
  哈希前缀（windows d2524c3d / arm64 8f8757b0 / x64 b8058979 / linux f3b693a5 /
  sync 066a0667）
- 部署 `rsync site/ → /www/wwwroot/cognote`，线上实测：页面前缀 = 服务器
  `sha256sum` = `latest.json` 记录**三方一致**；6 包 + latest.json + SHA256SUMS
  HEAD 200、Range 206；**AppUpdate 包全量下载后本机 sha256 `a0387511…` 与服务器
  完全一致**；真机 Chrome 打开首页无 4xx、无 JS 错误
- 当前线上版本 **v1.0.1**（后续发版只需跑 `build-packages.sh` 并 rsync）

### 变更：编辑器从 TipTap 迁移至 Cherry Markdown（解决表格/粘贴/交互痛点）

- **选型背景**：原 TipTap 分页编辑器在表格操作、工具栏快捷键、粘贴图片、
  整体顺滑度上不如同类编辑器；Marktext 引擎 Muya 未达生产可用被排除，
  最终选定 **Cherry Markdown 0.11.13**（Tencent，分栏实时预览，官网 demo 认可）
- **编辑体验**：左源码右实时预览双栏；工具栏**一级直出**表格/公式/图片/链接/
  代码块/分隔线/目录（表格点击弹行列选择网格，公式弹分类符号库，选中即插入）；
  输入即渲染：标题/表格/任务列表/KaTeX 公式（块级+行内）实时可见
- **图片链路**：粘贴、拖拽、工具栏上传统一走 `fileUpload → /api/upload`；
  相对路径图片经 `urlProcessor` 统一改写为 `/api/file?rel=`（编辑器与查看
  视图一致，笔记目录无关）
- **保留能力**：`#md-source` 源码模式切换、右键选区 AI 解释/改写（适配
  CodeMirror 6 视图：选区快照防漂移、替换/插入回写）、保存/frontmatter/
  标签、五主题（Cherry `theme__dark` 随应用暗色联动）
- **依赖本地化**：KaTeX 0.16.21 入库 `vendor/katex`（公式渲染脱离 esm.sh CDN，
  离线可用）；Cherry UMD 自行压缩 13.4MB→6.9MB，vendor 仅留 min 产物 7.2MB；
  移除 importmap / TipTap / ProseMirror 依赖，删除自定义公式弹窗与格式栏
  （Cherry 工具栏原生覆盖）
- **顺手优化**：查看视图任务列表补齐复选框渲染（markdown.js，与编辑器一致）；
  预览标题锚点 `§` 改为 hover 显示（对标 Typora）；vditor 23MB 仅保留
  highlight.js 独立为 `vendor/highlightjs`（发行包净瘦身）
- **测试**：Cherry 原型 15 项 + 系统 e2e 30 项（加载/输入渲染/保存回读/源码
  切换/粘贴上传/AI 右键/暗色主题/无 JS 错误）+ 工具栏 12 项 + 综合回归 30 项
  （复杂存量笔记双侧渲染/五主题循环/保存往返）**共 87 项全绿**

## 2026-11-08

### 发布：自动更新功能上线（发行包 + 官网更新源部署）

- 重建 4 平台应用包 + 同步服务端包 + **新增 `Cognote-AppUpdate-v1.0.0.zip`**
  （应用更新包 5.9 MB）与 **`latest.json` 更新源清单**（版本/更新说明自动摘取
  CHANGELOG 最新小节，超 1000 字自动截断附完整说明指引）
- `site/index.html` 5 处哈希前缀更新（windows 115e1077 / macos-arm64 060f8599 /
  macos-x64 e350c231 / linux 436f3b66 / sync 8409e9a4，linux 体积 47.8→47.9 MB）
- 部署 `rsync site/ → /www/wwwroot/cognote`，线上实测：页面前缀 = 服务器
  `sha256sum` = `latest.json` 记录**三方一致**；`latest.json` / `SHA256SUMS.txt` /
  AppUpdate 包 HEAD 200、Range 206；**AppUpdate 包全量下载后本机 sha256
  `800da616…` 与服务器完全一致**；真机 Chrome 打开首页无 4xx、无 JS 错误
- 至此客户端「启动检查更新 → 顶栏徽章 → 一键更新」链路的更新源已就位，
  当前线上版本 v1.0.0（后续发版只需跑 `build-packages.sh` 并 rsync）

### 新增：自动更新（检测提示 + 一键更新，仅应用文件）

- **更新机制**：启动时静默检查更新源 `config.update.url`（默认官网
  `https://cognote.flacn.net/downloads/latest.json`，8 秒超时不可达则静默不打扰）；
  发现新版顶栏显示呼吸动画徽章「⬆ vX.Y.Z」→ 点击弹窗（当前版本 / 最新版 /
  更新说明）→「立即更新」一键完成：下载应用更新包 → SHA256 校验 → 解压 →
  服务退出 → 覆盖应用文件 → 重启 → 前端轮询结果后自动刷新页面（实测 5.6 秒）
- **仅更新应用文件**（几百 KB~6 MB）：只覆盖 server.js / src / public / scripts
  等清单内文件，保留内置 Node 运行时、config.json、索引与笔记数据；
  按 `.update-files.json` 清单清理新版已废弃的旧文件，数据文件永不涉及
- **安全兜底**（`scripts/self-update.js`，detached 执行）：更新前把将被覆盖的文件
  备份到 `.update-backup/v<旧版>/`；新版本服务 30 秒内起不来**自动回滚旧版本并重启**；
  过程记录写 `update.log`，结果写 `.update-result.json` 供前端轮询；
  SHA256 不匹配 / 包内容异常 / 版本不一致一律在重启前中止（服务不受影响）
- **新增零依赖 zip 解压** `src/zipextract.js`（store/deflate，防 zip slip 路径穿越），
  跨平台不依赖系统 unzip/tar；更新包带顶层目录时自动探测真实根
- **安装形态区分**：便携包走在线覆盖；git 源码安装提示 `git pull`、
  pkg 单文件提示到官网下载（均不在线覆盖，避免破坏安装）
- **发行配套**（`scripts/build-packages.sh`）：新增 `build_app_update()`
  产出 `Cognote-AppUpdate-vX.Y.Z.zip`（应用更新包，跨平台共用）+
  `write_manifest()` 产出 `latest.json`（版本/更新说明自动摘取 CHANGELOG 最新小节/
  各平台包与更新包的 url、size、sha256）
- **前端**：顶栏 `#btn-update` 徽章、设置内「当前版本 + 检查更新」入口、
  `#dialog-update` 更新弹窗；`.update-badge` 呼吸动画
- **验证**：新增 zip 解压单测 **11 项**（store/deflate/中文路径/二进制/
  非法文件/zip slip 拦截）+ 更新端到端 e2e **24 项全绿**
  （徽章出现→弹窗→一键更新→版本变 1.1.0、config/索引/笔记保留、备份与清单就位、
  临时目录清理、SHA 篡改被拦截不重启、手动检查提示已是最新、无 JS 错误）；
  既有回归全绿（settings 22 / latex-full 49 / image-sync 29 / typora-theme 32 /
  viewer-latex 24 / editor-load 8 / bare-latex 3）

### 发布：发行包重建 + 官网/下载文件同步更新到服务端

- 本轮前端改动（设置保存三态提示、目录右键加入复习/过滤目录）已打进发行包：
  重建 4 平台应用包 + 同步服务端包（包内 `public/app.js` 已抽查含新功能代码），
  `SHA256SUMS.txt` 更新，`site/index.html` 5 处哈希前缀同步（体积显示无变化）
- 部署：`rsync site/ → /www/wwwroot/cognote`（www:www / 644），线上实测：
  页面前缀 2b3f8056 / e740d075 / 0b590f95 / 7fe80e25 / bfb90347 与服务器端
  `sha256sum` 逐一一致，`SHA256SUMS.txt` 吻合；5 个下载 HEAD 200、
  windows 包**全量下载后本机 sha256 与校验和完全一致**、Range 断点请求 206 正常
- 真机 Chrome 访问首页/部署页无 4xx、无 JS 错误

### 修复 + 新增：设置保存三态提示；目录右键一键加入复习/过滤目录

- **设置保存提示**（`public/app.js` `saveSettings`）：
  - 保存全程三态提示：进行中「正在保存设置并重建索引…」（转圈常驻）→ 成功
    「✅ 设置已保存，索引已重建」/ 失败「❌ 设置保存失败：原因」（5 秒）
  - 原先 `/api/config` 抛错（如目录不存在）会静默失败、对话框卡住无任何提示，现已捕获；
    云端同步参数改为**保存前**本地校验，避免写到一半失败
  - 保存期间禁用「保存」按钮防重复提交；失败保持对话框打开可直接修正重试
- **目录树右键新增**（目录节点，菜单分隔线后两项）：
  - 「📚 加入复习目录」→ 写入该目录**磁盘绝对路径**到 `reviewDirs`
    （走 `/api/review/config`，不动索引）；已在列表时菜单变为「📤 移出复习目录」
  - 「🚫 加入扫描过滤目录」→ 把目录名追加进 `index.ignoreDirs` 并重建索引，
    目录随即从树中隐藏（过滤按**目录名**匹配，同名目录一并过滤，提示中已注明）
  - 路径解析 `ctxAbsDir`：兼容多目录前缀、云端同步目录、Windows 盘符分隔符；
    文件节点 / 根节点不出现这两项，原有菜单项不变
- **验证**：新增 Playwright e2e（隔离实例 :8599）**22 项全绿、连跑两遍可重复**
  （保存成功/失败/校验、加入与移除复习目录、写入绝对路径、过滤后目录从树中消失、
  菜单回归）；既有 145 项回归（latex/image/theme/viewer/editor）全绿

### 变更：官网接入 GitHub 开源地址（tyjsnz/CogNote）

- **入口**（首页 6 处 + 部署页 4 处）：导航栏 GitHub 图标链接、首屏可点击徽章与
  「⭐ GitHub 源码」按钮、下载区「从源码运行」引导、两页页脚；`og:url`/`canonical`
  指向 https://cognote.flacn.net
- **README**：新增 GitHub 徽章与官网/源码链接，`git clone` 改为真实地址；
  **package.json** 补 `repository` / `homepage` / `bugs` 元信息
- **发行包重建**：包内 README/package.json 已含真实地址，4 平台包 + 同步包重打包，
  `SHA256SUMS.txt` 与页面哈希前缀同步更新（验证：页面前缀与线上文件实际哈希一致）
- 验证：Playwright 链接/图标/无 4xx/无 JS 错误，目测导航与首屏布局正常

### 生产部署：域名绑定 cognote.flacn.net + SSL 自动续签

- **DNS**：`cognote.flacn.net` → `8.138.140.186`（已解析）
- **nginx**（`knowledge-sync.conf` 拆为三块）：
  ① 域名 HTTP → 301 HTTPS（`/.well-known/acme-challenge/` 例外，保证 HTTP-01 续签可达）；
  ② IP HTTP 保持原官网 + `/knowledge-sync/` 反代（既有 `http://IP/knowledge-sync` 客户端不受影响）；
  ③ 域名 HTTPS（TLS1.2/1.3 + HTTP/2，官网静态 + 同步反代）
- **证书**：acme.sh 签发 Let's Encrypt（ECDSA P-256，2026-11-08 ~ 2027-02-06），
  安装至 `/www/server/panel/vhost/cert/cognote.flacn.net/`，reloadcmd 自动 reload nginx
- **自动续签**：复用面板既有 `acme.sh --cron`（每日 4 次）+ ARI 计划续期时间 2027-01-07，
  续签后自动拷贝证书并 reload；挑战路径与安装路径均已实测验证
- **验证**：HTTPS 首页/部署/下载 HEAD 全 200（HTTP/2）、HTTP→HTTPS 301、
  `https://cognote.flacn.net/knowledge-sync/api/ping` ok:true、IP HTTP 兼容不变、
  真机 Chrome 无 4xx / JS 错误

### 新增：官网页面 + 三平台绿色便携包发行

- **官网 `site/`**：`index.html`（Hero / 12 项功能特性 / 真机截图 / 三平台下载区含 SHA256 /
  快速开始 / 云同步自建提示 / FAQ）+ `deploy.html`（自建云同步完整部署教程：架构图、
  安装配置、systemd、nginx 反代、客户端配置、验证、分享、安全建议、常见问题）；
  响应式布局 + 移动端菜单 + 代码一键复制 + 文档页 TOC 滚动高亮，零外部依赖（不依赖 CDN）
- **发行包**：新增 `scripts/build-packages.sh`，从 npmmirror 拉取官方 Node.js 22.22.3 运行时，
  组装 `Cognote-v1.0.0-{windows-x64,macos-arm64,macos-x64,linux-x64}.zip` 绿色便携包
  （内置运行时 + 启动脚本 + 使用说明，解压即用，免安装）与 `Cognote-Sync-Server-v1.0.0.zip`
  （同步服务端，供用户自建部署），生成 `SHA256SUMS.txt`；`site/downloads/` 存放下载文件（不入库）
- **页面重点声明**：云同步为可选能力、**必须自建同步服务**，不提供官方云端；首页与部署页
  均醒目标注并链接到完整部署教程
- **验证**：macOS 便携包真机冒烟（解压→启动→HTTP 200→首启自动生成配置→执行权限保留）；
  Playwright 校验两页面无 4xx/5xx、无 JS 错误、无横向溢出，桌面 + 移动端截图核对

## 2026-11-07

### 修复：云端同步/分享笔记中的相对路径图片不显示

**根因**：笔记里 `figures/xxx.png` 这类相对图片被原样渲染为 `<img src="figures/xxx.png">`，
浏览器按站点根请求 `/figures/xxx.png` → 404。`/api/file` 本身能按笔记目录解析文件，
但渲染时没有任何环节把相对路径改写为 `/api/file?rel=...`。分享链路另有收集/前缀两组问题。

- **应用预览（`public/app.js`）**：新增 `resolveRelImgSrc()`（相对路径按笔记目录解析，
  归一 `./` `../`、解码 URL、剥离查询串；外链/data URI/`/api/file` 不改写）与
  `fixNoteImages()`（DOM 层改写 `img src`）；笔记查看与「导出 PDF」窗口均接入
- **编辑器（TipTap）**：扩展 `Image.renderHTML` 做显示层改写——节点 `attrs.src` 保持原始
  相对路径，保存/源码模式仍写回 `figures/...`（真机验证序列化未被 `/api/file` 污染）
- **分享收集（`server.js collectSharePaths`）**：此前只收 `.md` + `_attachments` 引用，
  `figures/` 图片漏收导致分享页 403。现补收笔记引用的相对文件（图片/PDF/Office 等），
  含 `../` 越界防护、不存在文件与外链自动跳过；单文件分享也会带上其引用的图片
- **分享查看页（`sync-server/share-viewer.html`，已部署生产）**：`/api/file?rel=` 解码出的
  云端根相对路径以 `/` 标记，避免被错误拼上笔记目录（此前 `_attachments` 图片在分享页也 404）；
  新增 `resolveShareImgPath()` 统一归一 `./` `../`
- **验证**：新增 image-sync-test 29 项 + 全量回归 145 项全绿；Playwright 真机端到端：
  预览与编辑器图片真实加载（naturalWidth=1300）、源码模式保留 `figures/fig04_navigation.png`；
  本地 sync-server 上传图片+笔记→创建分享→查看页以 data URL 成功加载（120×80）

### 新增：Typora 风格主题（白底 GitHub 风，第 5 个主题选项）

- **主题入口**：顶栏 🎨 菜单与设置色板新增「Typora」（`data-theme="typora"`），
  与 跟随系统/浅色/深色/暖纸 并列，localStorage 持久化；FOUC 引导数组、
  `VALID_THEMES`、hljs/monaco 映射同步接入（非 dark → github 浅色高亮 + vs 编辑器主题）
- **色板**（`public/style.css`）：纯白画布、GitHub 经典灰边框（#e1e4e8 / #d1d5db）、
  #4183c4 经典蓝 accent、#f8f8f8 代码底、#6a737d 次级文字；
  文档宽度 860px（Typora `#write` 默认宽）
- **预览排版**（`.markdown-body`，仅 typora 生效）：去卡片扁平化（透明无边框，整窗即文档）、
  16px/1.75 正文、GitHub 式 h1/h2 带下划线（2em/1.5em/600）、段落 16px 节奏、
  行内代码小胶囊带边框、#f8f8f8 代码块、灰色 4px 引用条（区别于其它主题的 accent 蓝条）、
  全边框表格 + 斑马纹、0.25em 粗横线 hr
- **编辑排版**（TipTap 编辑器）：同一套排版同步到编辑态（编辑即所见），
  编辑器宽度对齐 `--measure`，透明无边框融入画布
- **设置色板网格**：`repeat(4, 1fr)` → `auto-fit minmax(74px, 1fr)`，5 项一行自适应不挤压
- **验证**：新增 typora-theme-test 32 项（色板变量与 :root 对齐、菜单/VALID_THEMES/色板
  三处双向一致、CSS 括号平衡、编辑态规则）+ 全量回归 116 项全绿；
  Playwright + Chrome 实测：`data-theme=typora`、预览 h1 32px 下边框 #e1e4e8、
  hr 4px 灰条 100% 贯穿、正文/侧栏/顶栏纯白、编辑器 16px/28px 透明无边框
  （计算样式断言 + PIL 像素采样双重确认）

## 2026-11-04

### 修复：裸公式 / 残缺定界符不被解析（用户报告案例）

外部/AI 生成文档中公式常缺定界符或定界符残缺，导致整段显示为乱文本。已修复三类形态并防误伤：

- **无定界符裸公式**（如 `Alt(u) = Alt\_{low} + ... \in \[0,1\]`，夹击文档 line43）
  - `public/app.js` 新增 `detectBareEquation()`：无 `$`/反引号、无中文/全角、含 `=` 且命中 LaTeX 强命令（`\frac`/`\cdot` 等）或 `_{`/`^{` 上下标，且非标题/列表/引用等 markdown 结构行——整段识别为块级公式
  - `splitMathParts` 开头先做裸公式判断（否则内部 `\[0,1\]` 会被定界符正则拆成独立小公式）；`convertMathTextNodes` acceptNode 同步放宽，编辑器加载裸公式段落可转公式节点
  - `public/markdown.js` 预览段落改 `paraLines()` 逐行处理：裸公式行独立成块级公式，其余行合并为普通段落
- **残缺 `$$`**（只有结尾 `$$`，如动态拦截文档 line57-58 双转义两行公式）
  - 预览/分享页新增 `oddDollarLine()`/`oddLine()`：行首非 `$`、`$$` 计数为奇数、命中 LaTeX 特征的行，剥掉 `$$` 后作块级公式；行首 `$` 开头的错配交由 caseC 处理
- **单开双闭错配 `$..$$`**（夹击文档 line21）
  - 三处（app.js splitMathParts / markdown.js inline / share-viewer md()）在常规 `$..$` 提取**之前**加 caseC 预处理 `\$([^$\n]+?)\$\$(?=\s|$)`（带货币保护），无残留 `$`
- **`normalizeLatex()` 三处同步增强**（真 KaTeX 0.16.21 验证过的问题）：`\[`→`[`、`\]`→`]`（保留 `\\[0.5em]` 行尾间距参数）、`\_`→`_`（转义下标还原，否则显示为字面量 `\_`）、行尾孤立 `\` 剥离（KaTeX 报错）
- **分享页 `sync-server/share-viewer.html`（需部署生产）**：`md()` 整行提取置于全局公式配对**之前**（防残缺 `$$` 跨行误吞），带 `inBlock` 状态机（`$$` / `\]`）保护多行 `$$..$$` 与 `\[..\]` 块内部行不被拆出
- **防误伤**：普通赋值行（无 LaTeX 特征）、Windows 路径、中文行文、标题/列表/引用行均不转公式
- **验证**：84 项自动化测试全绿（latex-full 49 + 分享页 24 + 编辑器加载 8 + 裸公式复现 3），四个用户案例经真 KaTeX `throwOnError:true` 渲染全部成功，两篇真实文档整篇渲染无 `$$`/`\_`/`\[` 残留

### 修复：LaTeX 公式全链路转义支持（粘贴 / 编辑 / 保存 / 预览 / 复制 / 分享页）

外部复制文档的公式常带多种转义形态，逐条排查后修复以下缺陷：

- **粘贴/编辑器加载（`public/app.js`）**
  - `splitMathParts` 支持多反斜杠定界符：`\\(..\\)`、`\\[..\\]`、`\$..\$`（原先只认单反斜杠，双转义公式被拆成乱文本）
  - 新增 `normalizeLatex()`：公式内容双转义规范化（`\\frac`→`\frac`、`\\\\`→`\\`），保留 aligned 环境内合法 `\\` 换行
  - `convertMathTextNodes` 触发条件从「文本含 `$`」放宽为「含 `$` 或 `\(` 或 `\[`」——纯 `\(x\)`/`\[x\]` 段落在编辑器加载时现可正确转为公式节点
- **预览渲染（`public/markdown.js`）**
  - `inline()` 提取顺序重排：行内代码 → 公式 → 转义/格式规则 → **最后**恢复占位符。修复：`^`→`<sup>` 规则把 `$E=mc^2$` 的指数截断成 `E=mc<sup>2`；行内代码 `` `$x$` `` 被当公式提取；`\\`→`\` 全局折叠破坏代码与双转义公式
  - 公式正则与 splitMathParts 对齐（多反斜杠定界符 + 货币保护 + normalizeLatex）：修复预览把 `$5 和 $10` 当公式、`$$\\frac{a}{b}$$` 双转义不渲染
  - 段落中行内 `\[..\]` 现可渲染（原先只处理 `\(..\)`）；块级分支内容过 `normalizeLatex`
- **分享查看页（`sync-server/share-viewer.html`，已部署生产）**
  - 内置 `md()` 同步修复：代码块/行内代码先于公式提取、新增 `\(..\)`/`\[.. \]`/双转义/货币保护/normalizeLatex、公式只做一次 HTML 转义（原先 esc 两次）
- **验证**：65 项自动化测试全绿（A 粘贴 13 + B 预览 16 + C 节点 round-trip 2 + D 触发条件 2 + E 保存闭环 6 + V 分享页 18 + G 编辑器加载 mock 8），覆盖 `$..$`、`$$..$$`、`\(..\)`、`\[.. \]`、双转义、`\$..\$`、aligned、货币、Windows 路径、行内/块内代码等场景

## 2026-11-02

### 新增：分享管理（停用/启用/删除）与浏览统计

- **停用/启用**：分享记录新增 `disabled` 状态；停用后链接立即返回 410「分享已被停用」
  （open 与 file 接口同时拦截），数据与统计保留，可随时恢复；新增
  `POST /api/shares/toggle {id, disabled}`，客户端代理 `/api/share/toggle`
- **浏览统计**（保存在 `shares.json`，随分享记录持久化）：
  - `views` / `lastViewAt` / `viewDays{日期:次数}`：每次密码验证通过的 open +1（一次访问）
  - `fileViews{笔记路径:次数}`：每次成功读取 md 笔记 +1（图片等资源不计），可看每篇笔记被看几次
  - 列表接口 `/api/shares` 返回全部统计字段；停用期间不计数
- **分享管理 UI**（设置 → 云端同步 → 📋 分享管理）：每行显示状态（生效中/已停用/已过期）、
  👁 浏览次数；操作含复制链接、⏸ 停用/▶️ 启用（停用前确认）、删除（提示统计将永久删除）；
  「📊 统计」展开显示总浏览/今日/最近浏览时间 + 各笔记阅读次数排行

## 2026-11-01

### 新增：云端笔记分享（链接 + 查看密码）

- **服务端** `sync-server/`：新增分享存储 `data/shares.json`（原子写盘，id 随机 base64url，
  salt + sha256 密码哈希，`timingSafeEqual` 恒时比对）；密码尝试限流（同 id+IP 失败 10 次锁 10 分钟）
- **公开 API**（无需同步 Token，靠查看密码保护）：
  - `POST /api/public/share/open`：校验密码后返回分享内文件清单（密码错 403 / 过期 410 / 限流 429）
  - `GET  /api/public/share/file`：按分享路径白名单读取单文件（base64）
  - `GET  /s/viewer`：分享查看页（自包含 HTML，CDN KaTeX + 内置轻量 markdown 渲染器）
- **管理 API**（同步 Token 鉴权）：`GET /api/shares`、`POST /api/shares/create`
  （paths / password≥4 位 / expireDays∈{0,1,7,30}）、`/api/shares/delete`、`/api/shares/password`
- **客户端代理** `server.js`：`POST /api/share/create`（校验云端路径 + 本地扫描收集
  `_attachments/` 附件引用，附件在云端根目录、不在笔记前缀下，需单独加入分享范围）、
  `GET /api/cloud/shares`、`/api/share/delete`、`/api/share/password`，均带 Bearer Token 转发
- **前端**：云端目录/笔记右键菜单新增「🔗 分享」（仅云端节点显示）；分享对话框
  自动生成 8 位密码、有效期 1/7/30 天或长期，创建后展示链接 + 密码一键复制；
  设置 → 云端同步新增「📋 分享管理」（列表 / 复制链接 / 删除）
- **分享查看页**：密码门 → 侧栏笔记列表 → 正文渲染；笔记内 `/api/file?rel=_attachments%2F…`
  图片引用自动改写为公开文件接口加载；`sessionStorage` 记住密码避免重复输入

### 修复：从外部复制公式粘贴进编辑器解析不出来

- 根因：`handlePaste` 公式分支先做字符串替换再走 tiptap-markdown 的 markdown 解析，
  混合文本 + 多公式 / 块级行内混排时解析结果不确定，常把 `$$..$$` 当普通文本留下
- `splitMathParts` 扩展：支持 `$$..$$`、`\[..\\]`（块级）与 `\(..\)`、`$..$`（行内）四种定界符；
  货币误伤保护（内侧以空白开头/结尾或纯数字金额不视为公式），被拒时从开 `$` 后一位重扫，
  保证 `$100 和 $x^2$` 里的真公式不被漏掉
- 新增 `mathPartsToContent`：直接构建 ProseMirror 节点 JSON（段落 + hardBreak +
  inlineMath/blockMath），绕过 markdown 字符串解析的不确定路径后 `insertContent` 直插
- 预览区复制公式：渲染公式时写入 `data-latex`；document 级 `copy` 监听，选区起止在同一
  公式元素内时把 `$..$` / `$$..$$` 源码写入剪贴板，粘贴回编辑器直接成为公式节点

## 2026-10-25

### 新增：云端同步（多设备）

- **服务端** `sync-server/`：零依赖 Node 同步服务（兼容 Node 16），Token 鉴权、差异同步、
  删除 tombstone、冲突副本、原子写盘；nginx 反代 `/knowledge-sync/`，systemd 守护
- **客户端** `src/cloudsync.js`：以文件 hash 做差异同步；本地变更 3 秒防抖上传 +
  定时拉取 + 手动同步；冲突时 mtime 新者胜，败方保存为 `xxx (冲突 时间).md`
- **目录树**：启用后自动出现「☁️ 云端同步」根分类，其下分类/笔记/图片自动上传；
  云端目录始终参与索引，搜索 / AI / 双链可用
- **设置**：新增云端同步区块（地址、Token、本地目录、间隔、测试连接、立即同步），
  顶栏 ☁️ 状态徽标；同步落地的远端变更会自动刷新目录树
- **附件**：云端笔记插入的图片/附件存入云端目录并随笔记同步，读取时自动回退查找
- **修复**：索引范围变化时已加载的缓存文档未清除（会残留旧 key），改为重建 Indexer


## 2026-09-29

### 修复：公式保存后预览显示原始 HTML（`<span data-inline-math ...>`）
- 根因：`tiptap-markdown` 对无 markdown 序列化规格的节点回落到 HTML 序列化，行内/块级公式节点被存成 `<span data-inline-math latex="...">`，预览渲染器不识别
- `InlineMath` / `BlockMath` 增加 `storage.markdown.serialize`：保存时还原为 `$...$` 与独立 `$$...$$` 块（行内公式换行折叠为空格）
- 增加 `parse.updateDOM`：加载 markdown 时把文本中的 `$..$` / `$$..$$` 转为公式节点（跳过 code/pre），编辑器内可直接渲染存量 `$..$` 公式；粘贴 `$..$` 文本、AI 插入内容同路生效
- 预览渲染器兼容旧版公式 HTML 节点（在 `\\` 转义处理前提取，保留 latex 原样），**存量被污染的笔记无需手工修改即可正常预览**；在编辑器中打开并保存一次会自动还原为 `$...$`
- e2e：混合公式预览/编辑/保存 round-trip、旧版 span 预览兼容、文件内容断言 5/5 通过

### 修复：重启后全文搜索 500（`Cannot read properties of undefined (reading 'replace')`）
- 根因：索引缓存不持久化 `body` 全文，重启加载后文档缺 `body`，搜索生成摘要时对 `undefined` 调 `.replace`
- `Indexer.ensureBody(relPath)`：正文缺失时按需回读（复用 `_parse` 保持 frontmatter 剥离一致），失败降级 `''` 并缓存
- 搜索 top 结果生成摘要前回读正文；`_snippet` 对 `body`/`headings` 加兜底
- AI 端点（归类/扩展/摘要/批量归类/quiz/ask）调用前同样回读，避免重启后 AI 拿到空正文静默降级

## 2026-09-26

### 新增：选区 AI 助手（编辑器）
- 编辑器内选中文字右键 → 「✨ AI 解释与扩展」/「✨ AI 改写润色」（类语雀交互）
- 透明玻璃弹出层展示 AI 结果，锚定选区下方并跟随滚动；上下放不下时贴视口底部，内容区独立滚动
- 四个操作：**替换选中** / **插入到下方** / **复制结果** / **重新生成**；Esc 或关闭按钮收起，切换/关闭笔记时自动收起
- 选区防漂移：执行替换/插入前校验原文未变化，变化则提示重新选择
- 新增 `assistSelection()`（src/ai.js，explain/rewrite 双任务提示词）与 `POST /api/ai/assist`（text ≤ 6000 字）
- 结果经 `renderMarkdown` 渲染展示，插入编辑器时由 Tiptap 解析为标题/列表/代码等结构化节点（无裸 Markdown 标记）

### 修复
- 弹出层定位在选区从文档起始（`from=0`）时被 `!assist.from` 误判为无选区而提前返回，弹层停在页面左上角
- 弹层过高时简单翻转会盖住顶栏，改为「选区下方 → 选区上方 → 贴视口底」三级钳制策略

### 新增：目录树拖拽移动
- 左侧目录树支持鼠标拖动：笔记/分类可拖入目标分类；拖到某篇笔记上 = 放入该笔记的子笔记目录
- 拖到分类子项的空白处视为该分类，拖到树底部空白处视为顶层；根目录不可拖动
- 合法目标行 accent 高亮描边，非法目标（自身/子目录/位置未变化/跨笔记目录）显示禁止放置光标
- 移动后自动展开目标路径、同步打开中笔记的路径（编辑态只更新路径不打断编辑）、刷新标签/统计/中栏列表
- 服务端 `moveNote` 防呆：拒绝移动到自身或其子目录下（含笔记拖入自己子笔记目录的场景）
- 右键「归类 / 移动」弹窗方式保留，两种操作并存

### 新增：移动 / 重命名进行中提示
- 拖拽移动、右键「归类 / 移动」、文件重命名、分类重命名在请求期间显示常驻 spinner 提示（`busyToast`），完成后替换为结果提示，失败显示错误
- 移动进行中禁止发起新的拖拽（`_treeMoving` 守卫），避免并发移动导致路径错乱

### 新增：分类（目录）重命名
- 分类右键菜单新增「✏️ 重命名」（根目录除外），输入新名称后走 `POST /api/note/move` 完成目录改名
- 改名后自动同步：打开中笔记的路径、当前选中分类、展开状态、标签/统计/中栏列表
- 客户端防呆：新名称与现有笔记同名（如 `b.md`）会阻断并提示——目录会意外挂到该笔记下变为其子笔记目录，确需嵌套请拖拽到该笔记上
- 服务端防呆：`moveNote` 拒绝目标位置存在同名笔记（`to.md` 与 `to` 目录并存）的移动，覆盖拖拽/右键/重命名全部入口

## 2026-09-25

### 全新 UI：Apple 风格重设计 + 三主题系统
- style.css 全面重写：设计令牌体系（字体/圆角/阴影/缓动/玻璃模糊），统一组件样式
- 三套主题：浅色、深色、暖纸色，支持跟随系统（prefers-color-scheme）与手动切换
- 主题切换入口：顶栏 🎨 菜单 + 设置面板「外观主题」色板；localStorage 持久化，首帧内联脚本防止刷新闪烁
- 主题联动：highlight.js 代码高亮主题（github / github-dark）、Monaco 编辑器主题、color-scheme
- 顶栏 / 侧栏 / AI 面板 / 工具栏玻璃拟态（backdrop-filter blur）
- 内容优先：阅读宽度收敛 760px 居中，正文宽表格横向滚动兜底
- 弹窗与菜单过渡动画，支持 prefers-reduced-motion 降低动效

### 修复
- 修复正文被挤成多列竖条的布局 bug（`#note-body` 即 `.markdown-body`，误加 `display:flex` 导致所有子元素成为横向 flex item）
- 修复云同步文件未下载（ETIMEDOUT）时的报错体验：自动重试一次，仍失败提示「文件内容未下载到本地（云同步未就绪）…」（`readNote` 与 `/api/file` 流错误统一映射）
- 修复前端 txt/代码文件读取失败时把错误当正文渲染的问题（补 `r.ok` 检查）
- 修复不存在的 CSS 变量引用（`--primary` → `--accent`，`--error` → `--danger`）

## 2026-09-23

### 新增：图片上传与管理
- 编辑器支持三种图片插入方式：工具栏按钮选择文件、Ctrl+V 粘贴剪贴板图片、拖拽图片文件到编辑器
- 图片统一存储到 `_attachments/` 目录，文件名带时间戳防冲突
- 保存笔记时自动清理已删除的图片文件（对比新旧内容中的图片 URL）
- 新增 `DELETE /api/attachment` 端点，安全校验路径必须以 `_attachments/` 开头
- 图片在编辑器内联显示，悬停有蓝色高亮边框

### 新增：数学公式支持（KaTeX）
- 新增自定义 Tiptap 节点扩展 `InlineMath` 和 `BlockMath`（替代需要 Tiptap v3 的 @tiptap/extension-mathematics）
- 行内公式 `$...$` 和块级公式 `$$...$$` 在编辑器内实时 KaTeX 渲染
- 点击已有公式弹出编辑弹窗，支持修改 LaTeX 并原地更新
- KaTeX 从 CDN 加载（CSS + JS），编辑器和查看器均支持数学公式
- PDF 导出也使用 CDN KaTeX 渲染公式

### 新增：公式输入弹窗
- 替换浏览器 `prompt()` 为自定义模态弹窗，textarea 支持多行 LaTeX 输入
- 实时预览：输入 LaTeX 即时渲染公式效果
- 符号面板：希腊字母（α β γ δ...）、运算（分数 √ 积分 ∑ ∏ 极限）、关系（≤ ≥ ≠ ≈）、箭头（→ ← ⇒）、结构（上下标 向量 帽子）
- 快捷键：Ctrl+Enter 确认，Esc 取消
- 新增 ❓ 公式帮助面板：LaTeX 速查表（基础、希腊字母、大型运算符、关系运算符、矩阵、修饰）

### 新增：粘贴自动解析数学公式
- 粘贴 `$E = mc^2$` 自动转为行内公式节点
- 粘贴 `$$\int...$$` 自动转为块级公式节点
- 混合文本和公式时作为 Markdown 插入

### 新增：Link 扩展
- 添加 `@tiptap/extension-link`，工具栏链接按钮可用
- 配置 `openOnClick: false, autolink: true`

### 修复
- 修复 `setLink is not a function` 错误（StarterKit 不包含 Link 扩展）
- 修复 `insertBlockMath is not a function` 错误（改用 ProseMirror 底层 API 创建节点）
- 修复 `Cannot set properties of null (setting '_editor')` 错误（vditor 赋值时序问题）
- 修复数学符号按钮插入双反斜杠问题（HTML `data-math` 属性从 `\\` 改为 `\`）
- 修复块级公式正则不支持多行（`[\s\S]+?` 替代 `.+?`）
- 修复公式弹窗背景透明问题

## 2026-09-21

### 新增：代码文件扫描与显示支持
- 支持 50+ 种代码文件类型的扫描、索引和显示
- 代码文件类型：JavaScript/TypeScript、Python、C/C++、Java、Go、Rust、Shell、Ruby、PHP、Swift、Kotlin、Scala、Lua、R、Perl、Haskell、Clojure、Elixir 等
- 配置文件类型：JSON、YAML/TOML、XML、INI/CFG、.env、Docker、Terraform 等
- 前端文件类型：HTML、CSS/SCSS/Less、Vue、Svelte、GraphQL 等
- 代码文件显示：行号、语法高亮（基于 highlight.js）、文件名和语言标识
- 代码文件标题自动从文件名提取（去除扩展名）
- 代码文件内容可被全文检索索引

### 新增：Monaco Editor 代码编辑器
- 代码文件编辑改用 Monaco Editor（VS Code 的编辑器内核）
- 支持语法高亮、自动补全、代码折叠、括号匹配、minimap
- 支持智能缩进、自动格式化、平滑滚动
- 代码文件保存时保留原始格式，不处理 Markdown frontmatter

### 替换：Markdown 编辑器 Vditor → Milkdown
- 全面替换 Vditor 为 Milkdown（基于 ProseMirror 的现代 Markdown 编辑器）
- 支持 WYSIWYG 所见即所得编辑，体验更接近 Typora
- 内置工具栏：标题、加粗、斜体、删除线、列表、引用、代码块、表格、链接、Emoji
- 支持 KaTeX 数学公式、Mermaid 图表、代码语法高亮、目录、脚注
- Nord 主题，简洁美观
- 源码模式切换保持可用（通过 textarea 直接编辑 Markdown）

### 优化：代码显示样式
- 增强语法高亮：注释斜体灰色、关键字加粗红色、字符串深蓝色、函数紫色
- 改进行号样式：等宽数字、右侧对齐
- 优化代码头部：渐变背景、圆角语言标签

### 新增：Ollama 本地模型支持
- AI 服务商新增「Ollama (本地)」选项，支持连接本地 Ollama 服务
- 选择 Ollama 时自动隐藏 API Key 输入框（本地模型无需认证）
- 默认 Base URL 为 `http://localhost:11434`

### 新增：AI 模型自动加载
- 设置页面模型选择由文本输入改为下拉选择框
- 切换 AI 服务商时自动从服务端获取可用模型列表
- Ollama 通过 `/api/tags` 获取本地已安装模型
- 其他服务商通过 `/v1/models` 接口获取模型列表
- 新增 🔄 刷新按钮，支持手动刷新模型列表
- 新增后端 API：`GET /api/ai/models?provider=&baseUrl=&apiKey=`

### 重构：AI 服务商统一配置
- `DeepSeekAI` 类新增 `provider` 字段，统一处理各服务商差异
- Ollama 不需要 API Key，聊天时不发送 Authorization 头
- 各服务商默认 Base URL 和模型集中管理（`AI_PROVIDER_DEFAULTS`）

### 项目开源准备
- 新增 MIT LICENSE
- 新增 `config.example.json` 配置模板
- 修正 `.gitignore`：移除 `/public`，添加 `public/vendor/`、`dist/`
- 重写 `README.md`：添加安装说明、badge
- 从版本控制移除 `config.json`（含 API Key）
- 移除 `dist/` 构建产物
- 项目更名：知识库智能体 → Cognote

## 2026-09-06

### 新增：目录树显示常见文件类型（图片/Office/文本）
- 目录树扫描新增支持 `.png` `.jpg` `.jpeg` `.gif` `.webp` `.svg` `.txt` `.doc` `.docx` `.xls` `.xlsx` `.ppt` `.pptx` 文件类型
- 点击图片文件直接内嵌显示预览
- 点击 `.txt` 文件直接显示文本内容
- 点击 Office 文档等提供下载/在新标签页打开按钮
- 定义 `COMMON_FILES_RE` 统一管理文件类型过滤规则

### 修复：文件读取超时与错误处理
- `readNote` 添加 15 秒超时（AbortController），NAS/云盘不可用时返回友好错误而非挂起
- 前端 `openNote` markdown 路径增加 try-catch，读取失败时显示错误提示
- `/api/file` 补充 `.doc` `.docx` `.xls` `.xlsx` `.ppt` `.pptx` MIME 类型

## 2026-09-03

### 修复：Markdown 预览渲染错误（数学公式 & 排版）
- 修复 `escapeHtml()` 在数学公式提取前调用，导致 `$>12$` 中 `<>` 被转义破坏 KaTeX 渲染的问题
- 新增 Vditor 转义序列支持：`\$` → `$`、`\\` → `\`，使 `\$\\rightarrow\$` 等数学公式正确渲染
- 移除 `para()` 函数中危险的 `text.replace(/^#{1,6}\s+/, '')`，避免段落开头的 `#` 被错误剥离

### 修复：右键归类/移动时 `state.currentRel.split is not a function`
- 修复 `move()` 函数中 `stripDirPrefix(n.rel)` 返回 `{ rel, dir }` 对象却直接赋值给 `state.currentRel` 的问题
- 修复 `delete()` 函数中 `stripDirPrefix(n.rel)` 未解构就直接作为 API 参数的问题
- 修复 `delete()` 函数中 `state.currentRel === stripDirPrefix(n.rel)` 对象与字符串比较永远为 false 的问题

### 修复：上传附件时 `Unexpected token 'N', "Not Found" is not valid JSON`
- 修复客户端上传处理中 `res.json()` 在 `res.ok` 前调用，服务端返回非 JSON 响应时解析失败的问题
- 上传前先检查 `Content-Type` 是否为 `application/json`，非 JSON 时用 `res.text()` 读取错误信息
- 修复服务端 API 路由未匹配时返回纯文本 `Not Found`，改为返回 JSON 格式错误信息，便于客户端解析

### 新增：多笔记目录支持
- 配置新增 `notesDirs` 数组，支持同时加载多个笔记目录
- 设置面板改为 textarea 多行输入，每行一个目录路径
- 侧边栏目录树自动合并多个来源目录
- 向后兼容旧 `notesDir` 单目录配置

### 修复：文件大小与修改时间显示
- `buildTree` 现在为每个文件节点获取 `size` 和 `mtimeMs`
- 目录文件列表中大小和修改时间正确显示

---

## 2026-09-02

### 新增：多 AI 服务商支持
- 设置面板新增 AI 服务商下拉选择：DeepSeek / OpenAI / Claude / Moonshot / 智谱 / 通义千问 / 自定义
- 切换服务商时自动填充默认 Base URL 和模型名
- API Key / Base URL / 模型均可自定义
- 顶部 AI 徽章显示当前服务商名称

### 新增：可配置扫描过滤目录
- 设置面板新增「扫描过滤目录」输入框（逗号分隔）
- `_attachments` 附件目录固定过滤，不可移除
- 保存后自动重建索引

### 修复与优化
- config.json 新增 `ai` 字段（兼容旧 `deepseek` 字段）
- `publicConfig()` 隐藏所有服务商的 API Key
- AI 状态接口返回当前 provider

---

## 2026-09-02（续）

### v1.4 复习计划（新增）
- 新增 `src/review.js` 模块，实现 SM-2 间隔重复算法
- 新增 `GET /api/review/due` 获取今日待复习笔记列表
- 新增 `POST /api/review/mark` 标记笔记复习掌握程度（0-5分）
- 前端 AI 助手面板新增「📅 复习计划」区域，显示待复习/新笔记/已掌握统计
- 复习数据持久化到 `review.json`

### v1.3 双链与图（新增）
- `indexer.js` 新增 `extractInternalLinks()` 提取 Markdown 内部链接 `[text](path.md)`
- `Indexer` 新增 `getLinkGraph()` 方法构建笔记引用关系图（节点 + 边）
- 新增 `GET /api/links` 返回引用关系图数据
- 新增「🔗 双链图」按钮，弹窗展示引用关系：核心笔记（被引用≥2次）、完整引用列表
- 点击链接可直接跳转打开笔记
- 索引持久化现已包含 `links` 字段

### v1.2 批量归类（新增）
- `ai.js` 新增 `batchClassify()` 方法，分批分析全库笔记，返回分类建议
- 新增 `POST /api/batch-classify` 端点，支持 `maxNotes` 参数限制分析数量
- 前端 AI 助手面板新增「📊 批量归类」区域，一键分析全库
- 生成 Markdown 表格报告，支持下载 `.md` 文件

### v1.1 索引持久化（新增）
- `Indexer` 新增 `save(path)` / `load(path)` 方法，索引数据序列化为 JSON 落盘
- 新增 `incrementalScan()` 增量更新：仅重新索引 mtime 变更的文件
- 服务启动时自动加载缓存索引 + 增量更新，大幅加快大库冷启动速度
- 笔记保存/移动/删除后自动保存索引
- `.index.json` 已加入 `.gitignore`

### 修复与优化
- 修复 `server.js` 中 `INDEX_PATH` 定义顺序错误（`IS_PKG` 未初始化）
- 修复 `config.json` 中笔记目录路径错误
- 修复 `ai.js` 中 `_safeJson` 方法丢失问题

---

## 2026-09-01 之前

### v1.0 核心功能
- **扫描索引**：递归扫描笔记目录，构建倒排索引（中文 bigram + 英文分词）
- **全文检索**：TF-IDF 加权排序，支持中英文混搜，结果高亮摘要
- **笔记 CRUD**：新建/编辑/移动/删除笔记，支持 frontmatter 标签
- **Web 界面**：目录树 + 标签云 + 搜索 + 编辑器
- **Vditor 编辑器**：IR/WYSIWYG/分屏预览三种模式，工具栏完整
- **AI 功能**：DeepSeek 归类建议、知识扩展、复习摘要、自测题、问答
- **子笔记目录**：支持 `笔记名.md` + `笔记名/` 目录结构
- **文件上传**：编辑器内上传附件，插入 Markdown 链接
- **PDF 预览**：PDF 文件在笔记查看器中 iframe 展示
- **响应式布局**：移动端适配，sticky 工具栏
- **导出 PDF**：右键笔记导出为 PDF（浏览器打印）
- **空分类删除**：右键删除空目录
- **移动对话框**：子目录可选择为目标，支持新建子分类
- **符号链接支持**：兼容 fnos_sync_data 等同步盘的 reparse point
