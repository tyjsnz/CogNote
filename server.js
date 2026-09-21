const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { exec } = require('node:child_process');
const { Indexer } = require('./src/indexer');
const { SearchEngine } = require('./src/search');
const { DeepSeekAI, AIError } = require('./src/ai');
const notesApi = require('./src/notes');
const { ReviewManager } = require('./src/review');

const ROOT = __dirname;

// 打包为独立 exe 时(process.pkg)，可写数据放在 exe 旁的 data 目录；开发模式使用项目根 config.json
const IS_PKG = !!process.pkg;
const EXE_DIR = IS_PKG ? path.dirname(process.execPath) : ROOT;
const DATA_DIR = process.env.KB_DATA_DIR || path.join(EXE_DIR, 'data');
const CONFIG_PATH = IS_PKG ? path.join(DATA_DIR, 'config.json') : path.join(ROOT, 'config.json');
// v1.1: 索引持久化路径
const INDEX_PATH = IS_PKG ? path.join(DATA_DIR, 'index.json') : path.join(ROOT, '.index.json');
// v1.4: 复习数据目录
const REVIEW_DIR = IS_PKG ? DATA_DIR : ROOT;

const DEFAULT_CONFIG = {
  notesDir: '',
  notesDirs: [],
  reviewDirs: [],
  port: 8570,
  host: '127.0.0.1',
  deepseek: { apiKey: '', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', timeoutMs: 120000 },
  ai: { provider: 'deepseek', apiKey: '', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', timeoutMs: 120000 },
  index: { maxFileSizeKb: 2048, ignoreDirs: ['.git', 'node_modules', 'img', 'images', '.obsidian', '.trash', '.vscode', '_attachments'] },
};

// AI 服务商默认配置
const AI_PROVIDER_DEFAULTS = {
  deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  openai: { baseUrl: 'https://api.openai.com', model: 'gpt-4o' },
  claude: { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-20250514' },
  moonshot: { baseUrl: 'https://api.moonshot.cn', model: 'moonshot-v1-8k' },
  zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  ollama: { baseUrl: 'http://localhost:11434', model: 'llama3' },
  custom: { baseUrl: '', model: '' },
};

function ensureDataDir() {
  if (IS_PKG) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const cfg = JSON.parse(raw);
    cfg.deepseek = { ...DEFAULT_CONFIG.deepseek, ...(cfg.deepseek || {}) };
    cfg.ai = { ...DEFAULT_CONFIG.ai, ...(cfg.ai || {}) };
    cfg.index = { ...DEFAULT_CONFIG.index, ...(cfg.index || {}) };
    if (!cfg.index.ignoreDirs.includes('_attachments')) cfg.index.ignoreDirs.push('_attachments');
    // 兼容旧 notesDir → notesDirs
    if (!cfg.notesDirs || !cfg.notesDirs.length) {
      cfg.notesDirs = cfg.notesDir ? [cfg.notesDir] : [];
    }
    // 确保 reviewDirs 存在
    if (!cfg.reviewDirs) cfg.reviewDirs = [];
    return cfg;
  } catch (err) {
    const base = IS_PKG ? DEFAULT_CONFIG : JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    const cfg = { ...base, deepseek: { ...DEFAULT_CONFIG.deepseek, ...(base.deepseek || {}) }, ai: { ...DEFAULT_CONFIG.ai, ...(base.ai || {}) }, index: { ...DEFAULT_CONFIG.index, ...(base.index || {}) } };
    if (!cfg.index.ignoreDirs.includes('_attachments')) cfg.index.ignoreDirs.push('_attachments');
    if (!cfg.notesDirs || !cfg.notesDirs.length) {
      cfg.notesDirs = cfg.notesDir ? [cfg.notesDir] : [];
    }
    // 确保 reviewDirs 存在
    if (!cfg.reviewDirs) cfg.reviewDirs = [];
    return cfg;
  }
}

function initConfig() {
  // 打包模式首次运行：若 data/config.json 不存在，写入默认配置
  if (IS_PKG) {
    ensureDataDir();
    if (!fs.existsSync(CONFIG_PATH)) {
      const base = DEFAULT_CONFIG;
      let notesDir = '';
      try { notesDir = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).notesDir || ''; } catch {}
      fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...base, notesDir }, null, 2), 'utf8');
    }
  } else if (!fs.existsSync(CONFIG_PATH)) {
    ensureDataDir();
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
  }
}

initConfig();
let config = loadConfig();
let indexer = null;
let search = null;
const aiCfg = config.ai || config.deepseek;
let ai = new DeepSeekAI(aiCfg);
let review = null;

function rebuildIndexer(incremental = false) {
  // 支持多目录：优先使用 notesDirs 数组，兼容旧 notesDir
  let dirs = (config.notesDirs || []).filter((d) => d && fs.existsSync(d));
  if (!dirs.length && config.notesDir && fs.existsSync(config.notesDir)) {
    dirs = [config.notesDir];
  }
  if (!dirs.length) {
    // 没有有效目录：用临时空目录保证服务可启动
    const scanDir = path.join(EXE_DIR, '.empty-notes');
    try { fs.mkdirSync(scanDir, { recursive: true }); } catch {}
    dirs = [scanDir];
  }
  // 向后兼容：notesDir 设为第一个目录
  config.notesDir = dirs[0];
  indexer = new Indexer(dirs[0], { ...config.index, ignoreDirs: config.index.ignoreDirs });
  // v1.1: 尝试加载已保存的索引
  if (incremental && fs.existsSync(INDEX_PATH)) {
    const loadResult = indexer.load(INDEX_PATH);
    if (loadResult.ok) {
      console.log(`[Cognote] 已加载缓存索引: ${loadResult.docs} 篇笔记, ${loadResult.tokens} 个词元`);
      const info = indexer.incrementalScan();
      search = new SearchEngine(indexer);
      review = new ReviewManager(REVIEW_DIR);
      // 增量更新后保存
      indexer.save(INDEX_PATH);
      return info;
    }
  }
  // 全量扫描
  const info = indexer.scan();
  search = new SearchEngine(indexer);
  review = new ReviewManager(REVIEW_DIR);
  // 扫描后保存索引
  try { indexer.save(INDEX_PATH); } catch {}
  return info;
}

function saveConfig(next) {
  initConfig();
  config = { ...config, ...next };
  if (next.deepseek) config.deepseek = { ...(loadConfig().deepseek || config.deepseek), ...(next.deepseek || {}) };
  if (next.ai) config.ai = { ...(loadConfig().ai || config.ai), ...(next.ai || {}) };
  if (next.index) config.index = { ...(loadConfig().index || config.index), ...(next.index || {}) };
  // _attachments 始终过滤
  if (config.index?.ignoreDirs && !config.index.ignoreDirs.includes('_attachments')) {
    config.index.ignoreDirs.push('_attachments');
  }
  ensureDataDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  // 根据 AI 服务商配置初始化 AI
  const aiCfg = config.ai || config.deepseek;
  ai = new DeepSeekAI(aiCfg);
}

function publicConfig() {
  const c = JSON.parse(JSON.stringify(config));
  if (c.deepseek) delete c.deepseek.apiKey;
  if (c.ai) delete c.ai.apiKey;
  // 确保 notesDirs 存在
  if (!c.notesDirs) c.notesDirs = c.notesDir ? [c.notesDir] : [];
  // 确保 reviewDirs 存在
  if (!c.reviewDirs) c.reviewDirs = [];
  return { ...c, aiConfigured: ai.isConfigured() };
}

// ---------- static ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.otf': 'font/otf',
  '.map': 'application/json',
};

function serveStatic(reqUrl, res) {
  let p = decodeURIComponent(reqUrl.split('?')[0]);
  if (p === '/') p = '/index.html';
  const abs = path.join(ROOT, 'public', p);
  if (!abs.startsWith(path.join(ROOT, 'public'))) return notFound(res);
  let data;
  try {
    // pkg 快照内必须使用同步读取
    data = fs.readFileSync(abs);
  } catch {
    return notFound(res);
  }
  const ext = path.extname(abs).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(data);
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function revealInExplorer(absPath) {
  const isDir = fs.statSync(absPath).isDirectory();
  let cmd;
  if (process.platform === 'win32') {
    cmd = isDir ? `explorer.exe "${absPath}"` : `explorer.exe /select,"${absPath}"`;
  } else if (process.platform === 'darwin') {
    cmd = `open ${isDir ? '' : '-R '}"${absPath}"`;
  } else {
    cmd = `xdg-open "${isDir ? absPath : path.dirname(absPath)}"`;
  }
  exec(cmd, { windowsHide: true }, () => {});
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 20 * 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(buf ? JSON.parse(buf) : {});
      } catch {
        reject(new Error('无效的 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function ensureDoc(rel) {
  const doc = indexer.get(notesApi.toPosix(rel));
  if (!doc) {
    const e = new Error(`笔记不存在: ${rel}`);
    e.status = 404;
    throw e;
  }
  return doc;
}

// ---------- routes ----------
async function handleApi(pathname, req, res, url) {
  if (pathname === '/api/config' && req.method === 'GET') {
    return sendJson(res, 200, publicConfig());
  }

  // 获取 AI 服务商可用模型列表
  if (pathname === '/api/ai/models' && req.method === 'GET') {
    const provider = (url.searchParams.get('provider') || config.ai?.provider || 'deepseek').trim();
    const baseUrl = url.searchParams.get('baseUrl') || config.ai?.baseUrl || AI_PROVIDER_DEFAULTS[provider]?.baseUrl || '';
    const apiKey = url.searchParams.get('apiKey') || config.ai?.apiKey || '';
    if (!baseUrl) return sendJson(res, 200, { models: [] });
    try {
      let models = [];
      if (provider === 'ollama') {
        // Ollama: GET /api/tags
        const ollamaUrl = baseUrl.replace(/\/+$/, '') + '/api/tags';
        const resp = await fetch(ollamaUrl, { signal: AbortSignal.timeout(8000) });
        if (resp.ok) {
          const data = await resp.json();
          models = (data.models || []).map((m) => ({ id: m.name, name: m.name }));
        }
      } else {
        // OpenAI 兼容: GET /v1/models
        const headers = {};
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
        const modelsUrl = baseUrl.replace(/\/+$/, '') + '/v1/models';
        const resp = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(8000) });
        if (resp.ok) {
          const data = await resp.json();
          models = (data.data || []).map((m) => ({ id: m.id, name: m.id }));
        }
      }
      return sendJson(res, 200, { models });
    } catch (err) {
      return sendJson(res, 200, { models: [], error: err.message });
    }
  }

  if (pathname === '/api/config' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.notesDirs && Array.isArray(body.notesDirs)) {
      // 验证所有目录存在
      for (const d of body.notesDirs) {
        if (d && !fs.existsSync(d)) throw new Error(`目录不存在: ${d}`);
      }
      config.notesDirs = body.notesDirs.filter(Boolean);
      config.notesDir = config.notesDirs[0] || '';
    } else if (body.notesDir) {
      if (!fs.existsSync(body.notesDir)) throw new Error(`目录不存在: ${body.notesDir}`);
      config.notesDir = body.notesDir;
      if (!config.notesDirs || !config.notesDirs.length) {
        config.notesDirs = [body.notesDir];
      } else {
        config.notesDirs[0] = body.notesDir;
      }
    }
    if (body.reviewDirs && Array.isArray(body.reviewDirs)) {
      // 验证所有目录存在
      for (const d of body.reviewDirs) {
        if (d && !fs.existsSync(d)) throw new Error(`目录不存在: ${d}`);
      }
      config.reviewDirs = body.reviewDirs.filter(Boolean);
    }
    if (body.port) config.port = body.port;
    if (body.host) config.host = body.host;
    if (body.deepseek) config.deepseek = { ...config.deepseek, ...body.deepseek };
    if (body.ai) config.ai = { ...config.ai, ...body.ai };
    if (body.index) {
      config.index = { ...config.index, ...body.index };
      if (config.index.ignoreDirs && !config.index.ignoreDirs.includes('_attachments')) {
        config.index.ignoreDirs.push('_attachments');
      }
    }
    saveConfig({ notesDir: config.notesDir, notesDirs: config.notesDirs, reviewDirs: config.reviewDirs, port: config.port, host: config.host, deepseek: config.deepseek, ai: config.ai, index: config.index });
    rebuildIndexer();
    return sendJson(res, 200, publicConfig());
  }

  if (pathname === '/api/stats' && req.method === 'GET') {
    return sendJson(res, 200, { notesDir: config.notesDir, stats: indexer.stats() });
  }

  // v1.3: 获取笔记引用关系图
  if (pathname === '/api/links' && req.method === 'GET') {
    return sendJson(res, 200, indexer.getLinkGraph());
  }

  if (pathname === '/api/rescan' && req.method === 'POST') {
    const info = rebuildIndexer();
    return sendJson(res, 200, { ok: true, info });
  }

  if (pathname === '/api/tree' && req.method === 'GET') {
    // 支持多目录：为每个目录构建子树，合并为根节点
    const dirs = (config.notesDirs || []).filter((d) => d && fs.existsSync(d));
    if (!dirs.length) {
      return sendJson(res, 200, { tree: { name: 'Cognote', relPath: '', type: 'dir', children: [], noteCount: 0 } });
    }
    if (dirs.length === 1) {
      const tree = await notesApi.buildTree(dirs[0], config.index.ignoreDirs);
      return sendJson(res, 200, { tree });
    }
    // 多目录：每个目录作为根节点的子节点，用 _prefix 标记来源
    const root = { name: 'Cognote', relPath: '', type: 'dir', children: [], noteCount: 0 };
    for (const dir of dirs) {
      const subtree = await notesApi.buildTree(dir, config.index.ignoreDirs);
      const dirName = path.basename(dir);
      subtree.name = dirName;
      subtree._sourceDir = dir;
      // 用目录名作为唯一 relPath 前缀，所有子节点加上此前缀
      subtree._prefix = dirName;
      subtree.relPath = dirName;
      // 递归为所有子节点加上前缀
      const prefixChildren = (node, prefix) => {
        for (const c of node.children || []) {
          c.relPath = prefix ? prefix + '/' + c.relPath : c.relPath;
          if (c.children) prefixChildren(c, prefix);
        }
      };
      prefixChildren(subtree, dirName);
      root.children.push(subtree);
      root.noteCount += subtree.noteCount;
    }
    return sendJson(res, 200, { tree: root });
  }

  if (pathname === '/api/search' && req.method === 'GET') {
    const q = url.searchParams.get('q') || '';
    if (!q.trim()) return sendJson(res, 200, { query: q, total: 0, results: [] });
    return sendJson(res, 200, search.query(q));
  }

  if (pathname === '/api/note' && req.method === 'GET') {
    const rel = url.searchParams.get('rel');
    const dir = url.searchParams.get('dir'); // 可选：指定笔记目录
    if (!rel) throw new Error('缺少 rel 参数');
    // 多目录模式：用指定目录，否则用 notesDir
    const noteDir = dir && fs.existsSync(dir) ? dir : config.notesDir;
    const { content, size, mtimeMs } = await notesApi.readNote(noteDir, rel);
    const doc = indexer.get(notesApi.toPosix(rel));
    return sendJson(res, 200, {
      relPath: notesApi.toPosix(rel),
      content,
      size,
      mtimeMs,
      meta: doc ? { title: doc.title, tags: doc.tags, headings: doc.headings } : null,
    });
  }

if (pathname === '/api/note' && (req.method === 'PUT' || req.method === 'POST')) {
    const body = await readBody(req);
    if (!body.rel) throw new Error('缺少 rel');
    if (typeof body.content !== 'string') throw new Error('缺少 content');
    const noteDir = body.dir && fs.existsSync(body.dir) ? body.dir : config.notesDir;
    await notesApi.writeNote(noteDir, body.rel, body.content);
    indexer.add(path.join(noteDir, notesApi.fromPosix(body.rel)));
    return sendJson(res, 200, { ok: true, relPath: notesApi.toPosix(body.rel) });
  }

  if (pathname === '/api/note/move' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.from || !body.to) throw new Error('缺少 from/to');
    // 移动前记录旧的子笔记相对路径，用于移动后重建索引
    const fromBase = String(body.from).replace(/\.[mM][dD]$/, '');
    const toBase = String(body.to).replace(/\.[mM][dD]$/, '');
    const hadSub = fs.existsSync(path.join(config.notesDir, notesApi.fromPosix(fromBase)));
    const oldSubRels = hadSub ? await notesApi.walkMdRel(config.notesDir, fromBase) : [];
    const r = await notesApi.moveNote(config.notesDir, body.from, body.to);
    if (hadSub) {
      indexer.remove(path.join(config.notesDir, notesApi.fromPosix(r.from)));
      for (const rel of oldSubRels) indexer.remove(path.join(config.notesDir, notesApi.fromPosix(fromBase + '/' + rel)));
      indexer.add(path.join(config.notesDir, notesApi.fromPosix(r.to)));
      const newSubRels = await notesApi.walkMdRel(config.notesDir, toBase);
      for (const rel of newSubRels) indexer.add(path.join(config.notesDir, notesApi.fromPosix(toBase + '/' + rel)));
    } else {
      indexer.rename(notesApi.toPosix(body.from), path.join(config.notesDir, notesApi.fromPosix(body.to)));
    }
    try { indexer.save(INDEX_PATH); } catch {}
    return sendJson(res, 200, { ok: true, ...r });
  }

  if (pathname === '/api/note/delete' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.rel) throw new Error('缺少 rel');
    const rel = notesApi.toPosix(body.rel);
    const base = rel.replace(/\.[mM][dD]$/, '');
    const hadSub = fs.existsSync(path.join(config.notesDir, notesApi.fromPosix(base)));
    const oldSubRels = hadSub ? await notesApi.walkMdRel(config.notesDir, base) : [];
    await notesApi.deleteNote(config.notesDir, body.rel);
    indexer.remove(path.join(config.notesDir, notesApi.fromPosix(rel)));
    if (hadSub) {
      for (const r of oldSubRels) indexer.remove(path.join(config.notesDir, notesApi.fromPosix(base + '/' + r)));
    }
    try { indexer.save(INDEX_PATH); } catch {}
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/folder' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.rel) throw new Error('缺少路径');
    const abs = notesApi.safeResolve(config.notesDir, body.rel);
    await fsp.mkdir(abs, { recursive: true });
    return sendJson(res, 200, { ok: true, rel: notesApi.toPosix(body.rel) });
  }

  if (pathname === '/api/folder' && req.method === 'DELETE') {
    const body = await readBody(req);
    if (!body.rel) throw new Error('缺少路径');
    const abs = notesApi.safeResolve(config.notesDir, body.rel);
    if (abs === path.resolve(config.notesDir)) throw new Error('不能删除根目录');
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error('目录不存在: ' + body.rel);
    // 拒绝删除「子笔记目录」（同目录下存在同名 .md）
    if (fs.existsSync(path.join(path.dirname(abs), path.basename(abs) + '.md'))) {
      throw new Error('该目录是子笔记目录，请删除对应笔记');
    }
    const entries = await fsp.readdir(abs);
    if (entries.length) throw new Error('目录非空（' + entries.length + ' 项），仅允许删除空目录');
    await fsp.rmdir(abs);
    return sendJson(res, 200, { ok: true, rel: notesApi.toPosix(body.rel) });
  }

  if (pathname === '/api/file' && req.method === 'GET') {
    const rel = url.searchParams.get('rel');
    const dir = url.searchParams.get('dir');
    if (!rel) throw new Error('缺少 rel 参数');
    const fileDir = dir && fs.existsSync(dir) ? dir : config.notesDir;
    const abs = notesApi.safeResolve(fileDir, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error('文件不存在: ' + rel);
    const ext = path.extname(abs).toLowerCase();
    const mime = {
      '.pdf': 'application/pdf',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.txt': 'text/plain',
      '.md': 'text/markdown',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.ppt': 'application/vnd.ms-powerpoint',
      '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    const stream = fs.createReadStream(abs);
    stream.on('error', (err) => {
      console.error(`[Cognote] 文件读取失败: ${abs} - ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('文件读取失败: ' + err.message);
      } else {
        stream.destroy();
      }
    });
    stream.pipe(res);
    return;
  }

  if (pathname === '/api/upload' && req.method === 'POST') {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      throw new Error('Content-Type 必须是 multipart/form-data');
    }
    const boundary = contentType.split('boundary=')[1];
    if (!boundary) throw new Error('缺少 boundary');

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    // 用 boundary 切割 parts
    const boundaryBuf = Buffer.from('--' + boundary, 'utf-8');
    const parts = [];
    let start = 0;
    while (true) {
      const idx = buffer.indexOf(boundaryBuf, start);
      if (idx === -1) break;
      if (start > 0) {
        // 去掉前导 \r\n
        const partStart = start + 2;
        const partEnd = idx - 2; // 去掉尾部 \r\n
        if (partEnd > partStart) {
          parts.push(buffer.slice(partStart, partEnd));
        }
      }
      start = idx + boundaryBuf.length;
    }

    for (const partBuf of parts) {
      // 找 header 和 body 的分隔
      const headerEnd = partBuf.indexOf('\r\n\r\n');
      if (headerEnd === -1) continue;
      const headerStr = partBuf.slice(0, headerEnd).toString('utf-8');
      const body = partBuf.slice(headerEnd + 4);

      const filenameMatch = headerStr.match(/filename="([^"]*)"/);
      if (!filenameMatch || !filenameMatch[1]) continue;

      // 解码原始文件名（RFC 5987 编码）
      let originalName = filenameMatch[1];
      const rfc5987Match = headerStr.match(/filename\*=UTF-8''(.+?)(?=\s*;|$)/i);
      if (rfc5987Match) {
        originalName = decodeURIComponent(rfc5987Match[1]);
      }

      const ext = path.extname(originalName).toLowerCase();
      const allowedExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf', '.txt', '.md', '.zip', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'];
      if (!allowedExts.includes(ext)) {
        throw new Error('不支持的文件类型: ' + ext);
      }

      const timestamp = Date.now();
      const safeName = path.basename(originalName, ext).replace(/[\\/:*?"<>|]/g, '_').slice(0, 50);
      const filename = safeName + '_' + timestamp + ext;
      const relPath = '_attachments/' + filename;
      const abs = notesApi.safeResolve(config.notesDir, relPath);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, body);

      return sendJson(res, 200, {
        ok: true,
        url: '/api/file?rel=' + encodeURIComponent(relPath),
        filename: originalName,
      });
    }
    throw new Error('未找到有效文件');
  }

  if (pathname === '/api/reveal' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.rel) throw new Error('缺少路径');
    const fileDir = body.dir && fs.existsSync(body.dir) ? body.dir : config.notesDir;
    const abs = notesApi.safeResolve(fileDir, body.rel);
    if (!fs.existsSync(abs)) throw new Error('路径不存在: ' + body.rel);
    revealInExplorer(abs);
    return sendJson(res, 200, { ok: true });
  }

  // ---------- AI ----------
  if (pathname === '/api/ai/status' && req.method === 'GET') {
    const provider = config.ai?.provider || 'deepseek';
    return sendJson(res, 200, { configured: ai.isConfigured(), provider, model: config.ai?.model || config.deepseek.model });
  }

  if (pathname === '/api/classify' && req.method === 'POST') {
    const body = await readBody(req);
    const doc = ensureDoc(body.rel);
    const result = await ai.classifyNote(doc);
    return sendJson(res, 200, { ok: true, relPath: doc.relPath, ...result });
  }

  // v1.2: 批量归类分析
  if (pathname === '/api/batch-classify' && req.method === 'POST') {
    const docs = [...indexer.docs.values()];
    if (!docs.length) throw new Error('Cognote 中没有笔记');
    const maxNotes = Math.min(docs.length, body.maxNotes || 100);
    const results = await ai.batchClassify(docs.slice(0, maxNotes));
    // 生成 Markdown 报告
    let report = '# 批量归类建议报告\n\n';
    report += `分析了 ${results.length} 篇笔记的分类建议。\n\n`;
    report += '| 原路径 | 建议分类 | 建议标签 | 理由 |\n|--------|----------|----------|------|\n';
    for (const r of results) {
      report += `| ${r.relPath || ''} | ${r.suggestedCategory || ''} | ${(r.suggestedTags || []).join(', ')} | ${r.reason || ''} |\n`;
    }
    return sendJson(res, 200, { ok: true, count: results.length, results, report });
  }

  if (pathname === '/api/expand' && req.method === 'POST') {
    const body = await readBody(req);
    const doc = ensureDoc(body.rel);
    const markdown = await ai.expandNote(doc, body.prompt);
    return sendJson(res, 200, { ok: true, relPath: doc.relPath, markdown });
  }

  if (pathname === '/api/summarize' && req.method === 'POST') {
    const body = await readBody(req);
    const doc = ensureDoc(body.rel);
    const markdown = await ai.summarize(doc);
    return sendJson(res, 200, { ok: true, relPath: doc.relPath, markdown });
  }

  if (pathname === '/api/quiz' && req.method === 'POST') {
    const body = await readBody(req);
    const rels = body.rels || [];
    const docs = rels.map((r) => indexer.get(notesApi.toPosix(r))).filter(Boolean);
    if (!docs.length) throw new Error('请先选择包含笔记的分类');
    const markdown = await ai.quiz(docs, { count: body.count || 5 });
    return sendJson(res, 200, { ok: true, markdown });
  }

  if (pathname === '/api/ask' && req.method === 'POST') {
    const body = await readBody(req);
    const rels = body.rels || [];
    const docs = rels.map((r) => indexer.get(notesApi.toPosix(r))).filter(Boolean);
    if (!docs.length) throw new Error('没有可参考的笔记');
    if (!body.question?.trim()) throw new Error('问题不能为空');
    const answer = await ai.quickChat(docs, body.question);
    return sendJson(res, 200, { ok: true, answer });
  }

  // v1.4: 复习计划
  if (pathname === '/api/review/due' && req.method === 'GET') {
    const allRels = [...indexer.docs.keys()];
    // 根据 reviewDirs 配置过滤笔记
    const reviewDirs = config.reviewDirs || [];
    let filteredRels = allRels;
    if (reviewDirs.length > 0) {
      // 如果配置了 reviewDirs，只包含这些目录下的笔记
      filteredRels = allRels.filter(rel => {
        return reviewDirs.some(dir => rel.startsWith(dir + '/') || rel === dir);
      });
    }
    const due = review.getDueNotes(filteredRels);
    const stats = review.getStats(filteredRels);
    const items = due.map((d) => {
      const doc = indexer.get(d.relPath);
      return { relPath: d.relPath, title: doc?.title || d.relPath, tags: doc?.tags || [], isNew: d.isNew, isDue: d.isDue, nextReview: d.state.nextReview, interval: d.state.interval };
    });
    return sendJson(res, 200, { ok: true, stats, items });
  }

  if (pathname === '/api/review/mark' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.rel) throw new Error('缺少 rel');
    const quality = Math.max(0, Math.min(5, parseInt(body.quality) || 3));
    const state = review.markReviewed(notesApi.toPosix(body.rel), quality);
    return sendJson(res, 200, { ok: true, state });
  }

  // v1.4: 加入复习计划
  if (pathname === '/api/review/enroll' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.rel) throw new Error('缺少 rel');
    const rel = notesApi.toPosix(body.rel);
    const state = review.enrollNote(rel);
    return sendJson(res, 200, { ok: true, state });
  }

  // v1.4: 移出复习计划
  if (pathname === '/api/review/unenroll' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.rel) throw new Error('缺少 rel');
    const rel = notesApi.toPosix(body.rel);
    const state = review.unenrollNote(rel);
    return sendJson(res, 200, { ok: true, state });
  }

  // v1.4: 检查笔记是否在复习计划中
  if (pathname === '/api/review/status' && req.method === 'GET') {
    const rel = url.searchParams.get('rel');
    if (!rel) throw new Error('缺少 rel 参数');
    const enrolled = review.isEnrolled(notesApi.toPosix(rel));
    return sendJson(res, 200, { ok: true, enrolled });
  }

  // v1.4: 获取复习目录配置
  if (pathname === '/api/review/config' && req.method === 'GET') {
    const reviewDirs = config.reviewDirs || [];
    return sendJson(res, 200, { ok: true, reviewDirs });
  }

  // v1.4: 保存复习目录配置
  if (pathname === '/api/review/config' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.reviewDirs && Array.isArray(body.reviewDirs)) {
      // 验证所有目录存在
      for (const d of body.reviewDirs) {
        if (d && !fs.existsSync(d)) throw new Error(`目录不存在: ${d}`);
      }
      config.reviewDirs = body.reviewDirs.filter(Boolean);
      saveConfig({ reviewDirs: config.reviewDirs });
    }
    return sendJson(res, 200, { ok: true, reviewDirs: config.reviewDirs });
  }

  return null;
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  try {
    if (pathname.startsWith('/api/')) {
      const handled = await handleApi(pathname, req, res, url);
      if (handled === null) return sendJson(res, 404, { ok: false, error: '接口不存在: ' + pathname });
      return;
    }
    await serveStatic(pathname, res);
  } catch (err) {
    const status = err.status || 500;
    sendJson(res, status, { ok: false, error: err.message || '服务器错误' });
  }
});

// 启动前构建索引（增量模式：加载缓存 + 只更新变更文件）
try {
  const info = rebuildIndexer(true);
  console.log(`[Cognote] 扫描完成: ${info.total} 篇笔记${info.added ? `, 新增 ${info.added}` : ''}${info.updated ? `, 更新 ${info.updated}` : ''}${info.removed ? `, 删除 ${info.removed}` : ''}${info.errors ? `, ${info.errors} 个读取错误` : ''}`);
} catch (err) {
  console.error(`[Cognote] 索引构建失败: ${err.message}`);
  process.exit(1);
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, { windowsHide: true }, () => {});
}

function tryListen(port, attemptsLeft) {
  const server2 = server.listen(port, config.host);
  server2.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.log(`[Cognote] 端口 ${port} 被占用，尝试端口 ${port + 1} ...`);
      tryListen(port + 1, attemptsLeft - 1);
    } else {
      console.error(`[Cognote] 端口 ${port} 无法监听: ${err.message}`);
      process.exit(1);
    }
  });
  server2.once('listening', () => {
    config.port = server2.address().port;
    const url = `http://${config.host}:${config.port}`;
    console.log(`[Cognote] 已启动: ${url}`);
    console.log(`[Cognote] 笔记目录: ${config.notesDir || '(未设置)'}`);
    console.log(`[Cognote] 配置文件: ${CONFIG_PATH}`);
    console.log(`[Cognote] DeepSeek AI: ${ai.isConfigured() ? '已配置' : '未配置 (编辑 config.json 的 deepseek.apiKey)'}`);
    if (IS_PKG) {
      console.log('[Cognote] 打包模式：正在打开浏览器...');
      openBrowser(url);
    }
  });
}

tryListen(config.port, 20);

module.exports = server;