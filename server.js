const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { exec } = require('node:child_process');
const { Indexer } = require('./src/indexer');
const { SearchEngine } = require('./src/search');
const { DeepSeekAI, AIError } = require('./src/ai');
const notesApi = require('./src/notes');

const ROOT = __dirname;

// 打包为独立 exe 时(process.pkg)，可写数据放在 exe 旁的 data 目录；开发模式使用项目根 config.json
const IS_PKG = !!process.pkg;
const EXE_DIR = IS_PKG ? path.dirname(process.execPath) : ROOT;
const DATA_DIR = process.env.KB_DATA_DIR || path.join(EXE_DIR, 'data');
const CONFIG_PATH = IS_PKG ? path.join(DATA_DIR, 'config.json') : path.join(ROOT, 'config.json');

const DEFAULT_CONFIG = {
  notesDir: '',
  port: 8570,
  host: '127.0.0.1',
  deepseek: { apiKey: '', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', timeoutMs: 120000 },
  index: { maxFileSizeKb: 2048, ignoreDirs: ['.git', 'node_modules', 'img', 'images', '.obsidian', '.trash', '.vscode'] },
};

function ensureDataDir() {
  if (IS_PKG) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const cfg = JSON.parse(raw);
    cfg.deepseek = { ...DEFAULT_CONFIG.deepseek, ...(cfg.deepseek || {}) };
    cfg.index = { ...DEFAULT_CONFIG.index, ...(cfg.index || {}) };
    return cfg;
  } catch (err) {
    const base = IS_PKG ? DEFAULT_CONFIG : JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    return { ...base, deepseek: { ...DEFAULT_CONFIG.deepseek, ...(base.deepseek || {}) }, index: { ...DEFAULT_CONFIG.index, ...(base.index || {}) } };
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
let ai = new DeepSeekAI(config.deepseek);

function rebuildIndexer() {
  const dir = (config.notesDir || '').trim();
  // 空或无效的笔记目录：用一个空的临时目录扫描，保证服务可启动并提示配置
  let scanDir = dir;
  if (!scanDir || !fs.existsSync(scanDir)) {
    scanDir = path.join(EXE_DIR, '.empty-notes');
    try { fs.mkdirSync(scanDir, { recursive: true }); } catch {}
  }
  indexer = new Indexer(scanDir, { ...config.index, ignoreDirs: config.index.ignoreDirs });
  const info = indexer.scan();
  search = new SearchEngine(indexer);
  return info;
}

function saveConfig(next) {
  initConfig();
  config = { ...config, ...next };
  config.deepseek = { ...(loadConfig().deepseek || config.deepseek), ...(next.deepseek || {}) };
  ensureDataDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  ai = new DeepSeekAI(config.deepseek);
}

function publicConfig() {
  const c = JSON.parse(JSON.stringify(config));
  delete c.deepseek.apiKey;
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

  if (pathname === '/api/config' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.notesDir) {
      if (!fs.existsSync(body.notesDir)) throw new Error(`目录不存在: ${body.notesDir}`);
      config.notesDir = body.notesDir;
    }
    if (body.port) config.port = body.port;
    if (body.host) config.host = body.host;
    if (body.deepseek) config.deepseek = { ...config.deepseek, ...body.deepseek };
    if (body.index) config.index = { ...config.index, ...body.index };
    saveConfig({ notesDir: config.notesDir, port: config.port, host: config.host, deepseek: config.deepseek, index: config.index });
    rebuildIndexer();
    return sendJson(res, 200, publicConfig());
  }

  if (pathname === '/api/stats' && req.method === 'GET') {
    return sendJson(res, 200, { notesDir: config.notesDir, stats: indexer.stats() });
  }

  if (pathname === '/api/rescan' && req.method === 'POST') {
    const info = rebuildIndexer();
    return sendJson(res, 200, { ok: true, info });
  }

  if (pathname === '/api/tree' && req.method === 'GET') {
    const tree = await notesApi.buildTree(config.notesDir, config.index.ignoreDirs);
    return sendJson(res, 200, { tree });
  }

  if (pathname === '/api/search' && req.method === 'GET') {
    const q = url.searchParams.get('q') || '';
    if (!q.trim()) return sendJson(res, 200, { query: q, total: 0, results: [] });
    return sendJson(res, 200, search.query(q));
  }

  if (pathname === '/api/note' && req.method === 'GET') {
    const rel = url.searchParams.get('rel');
    if (!rel) throw new Error('缺少 rel 参数');
    const { content, size, mtimeMs } = await notesApi.readNote(config.notesDir, rel);
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
    await notesApi.writeNote(config.notesDir, body.rel, body.content);
    indexer.add(path.join(config.notesDir, notesApi.fromPosix(body.rel)));
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
    if (!rel) throw new Error('缺少 rel 参数');
    const abs = notesApi.safeResolve(config.notesDir, rel);
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
    }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(abs).pipe(res);
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
    const abs = notesApi.safeResolve(config.notesDir, body.rel);
    if (!fs.existsSync(abs)) throw new Error('路径不存在: ' + body.rel);
    revealInExplorer(abs);
    return sendJson(res, 200, { ok: true });
  }

  // ---------- AI ----------
  if (pathname === '/api/ai/status' && req.method === 'GET') {
    return sendJson(res, 200, { configured: ai.isConfigured(), model: config.deepseek.model });
  }

  if (pathname === '/api/classify' && req.method === 'POST') {
    const body = await readBody(req);
    const doc = ensureDoc(body.rel);
    const result = await ai.classifyNote(doc);
    return sendJson(res, 200, { ok: true, relPath: doc.relPath, ...result });
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

  return null;
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  try {
    if (pathname.startsWith('/api/')) {
      const handled = await handleApi(pathname, req, res, url);
      if (handled === null) return notFound(res);
      return;
    }
    await serveStatic(pathname, res);
  } catch (err) {
    const status = err.status || 500;
    sendJson(res, status, { ok: false, error: err.message || '服务器错误' });
  }
});

// 启动前构建索引
try {
  const info = rebuildIndexer();
  console.log(`[知识库] 扫描完成: ${info.total} 篇笔记${info.errors ? `，${info.errors} 个读取错误` : ''}`);
} catch (err) {
  console.error(`[知识库] 索引构建失败: ${err.message}`);
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
      console.log(`[知识库] 端口 ${port} 被占用，尝试端口 ${port + 1} ...`);
      tryListen(port + 1, attemptsLeft - 1);
    } else {
      console.error(`[知识库] 端口 ${port} 无法监听: ${err.message}`);
      process.exit(1);
    }
  });
  server2.once('listening', () => {
    config.port = server2.address().port;
    const url = `http://${config.host}:${config.port}`;
    console.log(`[知识库] 已启动: ${url}`);
    console.log(`[知识库] 笔记目录: ${config.notesDir || '(未设置)'}`);
    console.log(`[知识库] 配置文件: ${CONFIG_PATH}`);
    console.log(`[知识库] DeepSeek AI: ${ai.isConfigured() ? '已配置' : '未配置 (编辑 config.json 的 deepseek.apiKey)'}`);
    if (IS_PKG) {
      console.log('[知识库] 打包模式：正在打开浏览器...');
      openBrowser(url);
    }
  });
}

tryListen(config.port, 20);

module.exports = server;