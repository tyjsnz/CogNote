# 知识库智能体

针对个人 Markdown 知识笔记的**本地 Web 知识库智能体**：自动扫描归类、中文全文检索、AI 知识扩展（DeepSeek）、快速复习自测，并可在 Web 端直接新建/编辑 Markdown 笔记。

## 痛点与解决

| 痛点 | 本工具方案 |
|------|-----------|
| 笔记散落多目录，查询不便 | 自动递归扫描，按目录树 + 标签组织，一键全文检索 |
| 中文搜索难（分词/倒排） | 自建中文 bigram + 英文分词倒排索引，TF-IDF 加权排序 |
| 知识孤立，缺少体系化扩展 | DeepSeek AI 一键扩展笔记、推荐分类、打标签 |
| 复习效率低 | AI 生成"一页纸复习摘要"与自测题 |
| 改笔记要在本地找文件 | 浏览器内 Markdown 编辑（编辑/预览双栏）+ 实时落盘 |

## 技术栈

- **后端零依赖**：仅需 Node.js ≥ 22（内置 `http`、`fetch`、`fs`、`exec`）
- 后端：原生 Node HTTP 服务 + 内存倒排索引；在资源管理器中打开本地目录（`explorer.exe`）
- 前端：原生 HTML/CSS/JS 单页应用 + 自写轻量 Markdown 渲染器（只读预览）
- **编辑器：Vditor 3.10.8**（开源 MIT，本地集成，离线可用）
  - IR / WYSIWYG / SV 三种模式，工具栏
  - KaTeX 数学公式、Mermaid / flowchart / graphviz 图表
  - highlight.js 代码高亮（含行号）、预览分屏、大纲、导出
- AI：DeepSeek API（OpenAI 兼容 Chat Completions 协议）

## 目录结构

```
知识库/
├── config.json          # 配置：笔记目录、DeepSeek Key、模型、端口
├── server.js            # HTTP 服务入口 + API 路由
├── scripts/rescan.js    # 命令行重新扫描
├── src/
│   ├── tokenize.js      # 中文 bigram + 英文分词
│   ├── indexer.js       # 扫描 md、提取标题/标签/目录、构建倒排索引
│   ├── search.js        # 全文检索（TF-IDF、字段加权、摘要高亮）
│   ├── notes.js         # 笔记 CRUD、移动、目录树、路径安全
│   └── ai.js            # DeepSeek 封装：归类/扩展/摘要/自测/问答
└── public/              # 前端单页应用
```

## 快速开始

### 1. 安装

```bash
# 需要 Node.js >= 22（node -v 验证）
```

> Vditor 富文本编辑器已打包在 `public/vendor/`，无需额外安装，离线可用。

### 2. 配置

编辑 `config.json`：

```json
{
  "notesDir": "D:\\prj\\fnos_sync_data\\prj\\开发文档",
  "port": 8570,
  "deepseek": {
    "apiKey": "sk-你的key",          // 填写后 AI 功能生效
    "model": "deepseek-chat"
  }
}
```

也可在 Web 界面右上角 ⚙️ 中填写目录与 API Key（保存后自动重建索引）。

### 3. 启动

```bash
npm start
# 或双击 start.bat
```

浏览器打开 **http://127.0.0.1:8570**

> 未配置 API Key 时，笔记浏览/检索/编辑全部可用；仅 AI 功能提示配置 Key。

## 功能说明

### 笔记浏览与检索
- 左侧**目录树**展示全部分类（对应本地文件夹），点击文件夹筛选、点击笔记打开
- 顶栏**全文搜索**：支持中英文混搜、命令/算法名/路径片段，结果按相关度排序并高亮
- **右键目录**：新建子分类 / 新建笔记 / 打开本地位置；**右键空白**：新建根分类
- **右键文档**：编辑 / 归类移动 / 打开本地位置 / 删除

### Markdown 编辑（Vditor 富文本编辑器）
- 打开笔记 → 「编辑」进入编辑器：**IR 即时渲染 / WYSIWYG 所见即所得 / 分屏预览** 三种模式
- 工具栏支持：标题、加粗斜体、列表、任务列表、引用、代码块、表格、链接、emoji、大纲、导出
- **KaTeX 数学公式**（`$x^2$`）、**Mermaid 图表**（` ```mermaid ` 代码块）、代码高亮
- 标题 / 标签(frontmatter) / 正文分离；保存实时落盘
- 「新建」在所选分类下创建笔记，自动避免重名覆盖

### AI 智能归类（手动触发）
- 选中笔记 → AI 助手 → 「分析当前笔记」
- 返回：建议分类目录、建议标签、一句话摘要、关键词
- 可按建议使用「归类」按钮把笔记移动到新分类

### AI 知识扩展（手动触发，避免浪费额度）
- 选中笔记 → 「知识扩展」
  - **追加到当前**：扩展内容写入原笔记末尾
  - **生成新笔记**：生成 `笔记名·扩展.md` 新文档
- 可输入扩展方向（如"补充飞控指令的异常场景处理"）

### 复习与自测
- 「复习摘要」：为当前笔记生成一页纸重点/命令/易错点/自测题
- 「生成自测题」：基于当前笔记**及其同分类笔记**生成 5 题问答
- 「问答」：就当前笔记/分类内容向 AI 提问，回答标注笔记来源

### 笔记编辑
- 「编辑」：标题 / 标签(frontmatter) / 正文三栏，编辑与预览双模式
- 「新建」：在所选分类下创建新笔记；「归类」移动；「删除」确认后删除

## API 一览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | /api/tree | 笔记目录树 |
| GET  | /api/search?q= | 全文检索 |
| GET  | /api/note?rel= | 读取笔记（含 meta） |
| PUT  | /api/note | 新建/保存笔记 |
| POST | /api/note/move | 移动/归类 |
| POST | /api/note/delete | 删除 |
| POST | /api/folder | 新建分类（文件夹） |
| POST | /api/reveal | 在资源管理器中打开本地位置 |
| POST | /api/classify | AI 归类建议 |
| POST | /api/expand | AI 知识扩展 |
| POST | /api/summarize | AI 复习摘要 |
| POST | /api/quiz | AI 自测题 |
| POST | /api/ask | AI 问答 |
| POST | /api/rescan | 重建索引 |
| GET/POST | /api/config | 读取/保存配置 |

## 开发计划（路线图）

- [x] **v1.0 核心**：扫描索引、中文全文检索、笔记 CRUD、Web 界面、DeepSeek 归类/扩展/复习/问答
- [ ] **v1.1 索引持久化**：索引落盘 + mtime 增量更新，加快大库冷启动
- [ ] **v1.2 批量归类**：一键对全库分析归类、生成分类调整建议报告
- [ ] **v1.3 双链与图**：笔记引用关系 / 主题聚类视图
- [ ] **v1.4 复习计划**：按遗忘曲线生成每日复习清单

## 常见问题

- **端口被占用**：修改 config.json 的 `port`。
- **笔记不显示**：检查 `notesDir` 是否正确；`.git`/`node_modules`/`img` 等目录默认忽略。
- **AI 报 401/超时**：确认 `deepseek.apiKey` 已填写；国内网络访问 api.deepseek.com 一般正常。
