# Cognote

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A5%2022-brightgreen.svg)](https://nodejs.org)

针对个人 Markdown 知识笔记的**本地 Web 智能笔记系统**：自动扫描归类、中文全文检索、AI 知识扩展、快速复习自测，并可在 Web 端直接新建/编辑 Markdown 笔记和代码文件。

## 痛点与解决

| 痛点 | 本工具方案 |
|------|-----------|
| 笔记散落多目录，查询不便 | 自动递归扫描，按目录树 + 标签组织，一键全文检索 |
| 中文搜索难（分词/倒排） | 自建中文 bigram + 英文分词倒排索引，TF-IDF 加权排序 |
| 知识孤立，缺少体系化扩展 | AI 一键扩展笔记、推荐分类、打标签 |
| 复习效率低 | AI 生成"一页纸复习摘要"与自测题 |
| 改笔记要在本地找文件 | 浏览器内 Markdown 编辑（编辑/预览双栏）+ 实时落盘 |

## 技术栈

- **后端零依赖**：仅需 Node.js ≥ 22（内置 `http`、`fetch`、`fs`、`exec`）
- 后端：原生 Node HTTP 服务 + 内存倒排索引
- 前端：原生 HTML/CSS/JS 单页应用 + 自写轻量 Markdown 渲染器
- **编辑器：Tiptap**（基于 ProseMirror，WYSIWYG 所见即所得）
- **代码编辑器：Monaco Editor**（VS Code 内核，用于代码文件编辑）
- **数学公式：KaTeX**（自定义 Tiptap 节点扩展，实时渲染 LaTeX）
- AI：DeepSeek / OpenAI / Claude / Moonshot / 智谱 / 通义千问 / Ollama（本地）/ 自定义（OpenAI 兼容协议）

## 目录结构

```
cognote/
├── config.example.json  # 配置模板（复制为 config.json 后填写）
├── server.js            # HTTP 服务入口 + API 路由
├── scripts/rescan.js    # 命令行重新扫描
├── src/
│   ├── tokenize.js      # 中文 bigram + 英文分词
│   ├── indexer.js       # 扫描 md、提取标题/标签/目录、构建倒排索引
│   ├── search.js        # 全文检索（TF-IDF、字段加权、摘要高亮）
│   ├── notes.js         # 笔记 CRUD、移动、目录树、路径安全
│   └── ai.js            # AI 封装：归类/扩展/摘要/自测/问答
└── public/              # 前端单页应用
```

## 快速开始

### 1. 安装

```bash
git clone https://github.com/your-username/cognote.git
cd cognote
npm install  # 无需额外依赖，此步可跳过
```

需要 **Node.js >= 22**（`node -v` 验证）。

### 2. 配置

```bash
cp config.example.json config.json
```

编辑 `config.json`，填写你的笔记目录和 AI API Key：

```json
{
  "notesDirs": ["/path/to/your/notes"],
  "port": 8570,
  "ai": {
    "provider": "deepseek",
    "apiKey": "sk-你的key",
    "baseUrl": "https://api.deepseek.com",
    "model": "deepseek-chat"
  }
}
```

支持的 AI 服务商：DeepSeek、OpenAI (GPT)、Anthropic (Claude)、Moonshot (Kimi)、智谱 (GLM)、通义千问 (Qwen)、自定义 (OpenAI 兼容)。

也可在 Web 界面右上角 ⚙️ 中在线配置。

### 3. 启动

```bash
npm start
# macOS 用户可双击 start.command
# Windows 用户可双击 start.bat
```

浏览器打开 **http://127.0.0.1:8570**

> 未配置 API Key 时，笔记浏览/检索/编辑全部可用；仅 AI 功能提示配置 Key。

## 功能说明

### 笔记浏览与检索
- 左侧**目录树**展示全部分类，点击文件夹筛选、点击笔记打开
- 顶栏**全文搜索**：支持中英文混搜，结果按相关度排序并高亮
- **右键菜单**：新建/编辑/归类/删除/打开本地位置
- **三主题界面**：浅色 / 深色 / 暖纸色，可跟随系统，顶栏 🎨 菜单或设置面板切换

### Markdown 编辑（Tiptap）
- **WYSIWYG 所见即所得**编辑，格式工具栏：加粗、斜体、删除线、代码、标题、列表、任务列表、引用、代码块、链接、图片
- **KaTeX 数学公式**：行内 `$...$` 和块级 `$$...$$` 实时渲染，点击编辑，符号面板快捷输入
- **图片管理**：粘贴/拖拽/按钮上传，自动存储到 `_attachments/`，保存时清理已删除图片
- 标题 / 标签(frontmatter) / 正文分离；保存实时落盘
- **选区 AI**：选中文字右键即可「AI 解释与扩展 / 改写润色」，结果一键**替换选中**或**插入到下方**
- **源码模式**切换保持可用（textarea 直接编辑 Markdown）

### 代码文件支持
- 扫描索引 80+ 种代码文件类型（JS/TS/Python/Go/Rust/Java/C/C++/Shell/Ruby/PHP 等）
- **Monaco Editor** 代码编辑器（VS Code 内核）：语法高亮、自动补全、代码折叠、括号匹配
- **highlight.js** 语法高亮显示：行号、语言标识、高亮样式随界面主题切换
- 代码文件保存保留原始格式，不处理 Markdown frontmatter

### AI 智能归类
- 分析当前笔记，返回建议分类、标签、摘要、关键词
- 可一键应用到笔记

### AI 知识扩展
- **追加到当前**：扩展内容写入原笔记末尾
- **生成新笔记**：生成独立的扩展文档

### 复习与自测
- 「复习摘要」：一页纸重点/命令/易错点/自测题
- 「生成自测题」：基于当前笔记及同分类笔记生成问答
- 「问答」：就笔记内容向 AI 提问，回答标注来源

## API 一览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | /api/tree | 笔记目录树 |
| GET  | /api/search?q= | 全文检索 |
| GET  | /api/note?rel= | 读取笔记 |
| PUT  | /api/note | 新建/保存笔记 |
| POST | /api/note/move | 移动/归类 |
| POST | /api/note/delete | 删除 |
| POST | /api/classify | AI 归类建议 |
| POST | /api/expand | AI 知识扩展 |
| POST | /api/summarize | AI 复习摘要 |
| POST | /api/quiz | AI 自测题 |
| POST | /api/ask | AI 问答 |
| POST | /api/ai/assist | 选区 AI（explain/rewrite） |
| POST | /api/rescan | 重建索引 |
| GET/POST | /api/config | 读取/保存配置 |
| GET  | /api/links | 笔记引用关系图 |
| POST | /api/upload | 上传附件（图片等） |
| DELETE | /api/attachment | 删除附件 |
| GET  | /api/ai/models | 获取 AI 模型列表 |

## 路线图

- [x] **v1.0** 核心：扫描索引、全文检索、笔记 CRUD、AI 归类/扩展/复习/问答
- [x] **v1.1** 索引持久化：增量更新，加快大库冷启动
- [x] **v1.2** 批量归类：全库分析生成调整建议报告
- [x] **v1.3** 双链与图：笔记引用关系视图
- [x] **v1.4** 复习计划：遗忘曲线每日复习清单
- [x] **v1.5** 代码文件：80+ 语言扫描/高亮/编辑（Monaco Editor）
- [x] **v1.6** 编辑器升级：Tiptap WYSIWYG + 格式工具栏 + 图片管理 + KaTeX 公式
- [x] **v1.7** 界面重设计：Apple 风格 + 浅色/深色/暖纸三主题（可跟随系统）
- [x] **v1.8** 选区 AI：右键解释/改写 → 透明弹出层 → 替换选中或插入下方

## 常见问题

- **端口被占用**：修改 `config.json` 的 `port`。
- **笔记不显示**：检查 `notesDirs` 是否正确。
- **AI 报错**：确认 `apiKey` 已填写且有效。
- **NAS/云盘超时**：确保网络存储已挂载，或增加 `timeoutMs` 配置。

## License

[MIT](LICENSE)
