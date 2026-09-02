# 开发日志

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
