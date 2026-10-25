/**
 * Cognote 云端同步服务端
 * - 零依赖，兼容 Node 16+
 * - Token 鉴权（Authorization: Bearer <token> 或 ?token=）
 * - 数据存于 data/files/，清单 data/manifest.json（版本号递增）
 * API:
 *   GET  /api/ping                 → 连通性/Token 校验
 *   POST /api/sync                 → 双向差异同步（返回需下载/上传/删除的清单，下载内容内联）
 *   GET  /api/file?path=xx         → 下载单个文件（base64）
 *   PUT  /api/file                 → 上传单个文件 {path, content(base64), mtimeMs}
 *   POST /api/file/delete          → 删除文件 {path}
 */
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const defaults = { token: '', port: 8600, host: '127.0.0.1', dataDir: path.join(__dirname, 'data'), maxFileMb: 20, inlineBudgetMb: 24 };
let config = { ...defaults };
try {
  Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
} catch {
  // 首次运行：生成随机 token 并写入配置
  config.token = crypto.randomBytes(24).toString('hex');
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    console.log(`[sync] 已生成配置: ${CONFIG_PATH}`);
  } catch (e) {
    console.error(`[sync] 配置写入失败: ${e.message}`);
  }
}
if (!config.token) {
  console.error('[sync] config.json 缺少 token，无法启动');
  process.exit(1);
}

const FILES_DIR = path.join(config.dataDir, 'files');
const MANIFEST_PATH = path.join(config.dataDir, 'manifest.json');
fs.mkdirSync(FILES_DIR, { recursive: true });

// ---------- manifest ----------
let manifest = { version: 1, files: {}, deleted: {} };
try {
  manifest = Object.assign(manifest, JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')));
} catch { /* 首次运行 */ }

// 串行化 manifest 写盘，避免并发写坏文件
let _writeQueue = Promise.resolve();
function saveManifest() {
  _writeQueue = _writeQueue.then(async () => {
    const tmp = MANIFEST_PATH + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(manifest), 'utf8');
    await fsp.rename(tmp, MANIFEST_PATH);
  }).catch((e) => console.error(`[sync] manifest 写入失败: ${e.message}`));
  return _writeQueue;
}

// 删除记录保留上限（条），超出按时间淘汰
const MAX_DELETED = 5000;
function pruneDeleted() {
  const keys = Object.keys(manifest.deleted);
  if (keys.length <= MAX_DELETED) return;
  keys.sort((a, b) => manifest.deleted[a] - manifest.deleted[b]);
  for (const k of keys.slice(0, keys.length - MAX_DELETED)) delete manifest.deleted[k];
}

// ---------- path 安全校验 ----------
function safeRel(p) {
  const rel = String(p || '').split('\\').join('/');
  if (!rel || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return null;
  const parts = rel.split('/');
  if (parts.some((seg) => !seg || seg === '.' || seg === '..')) return null;
  if (parts[0] === '.cognote-sync') return null; // 同步状态目录不可同步
  return rel;
}
function absOf(rel) {
  const abs = path.join(FILES_DIR, ...rel.split('/'));
  if (abs !== FILES_DIR && !abs.startsWith(FILES_DIR + path.sep)) throw new Error('非法路径');
  return abs;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ---------- helpers ----------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error('请求体过大（上限 ' + Math.round(limitBytes / 1048576) + 'MB）'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('无效的 JSON')); }
    });
    req.on('error', reject);
  });
}

function checkToken(req, url) {
  const auth = req.headers.authorization || '';
  let token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) token = (url.searchParams.get('token') || '').trim();
  const a = Buffer.from(String(token));
  const b = Buffer.from(String(config.token));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- 同步核心 ----------
// 请求: { local: [{path, hash, mtimeMs}], known: {path: 上次同步的hash} }
// 响应: { version, download:[{path,hash,mtimeMs,content,conflict?,conflictCopy?}], upload:[path],
//         deleteLocal:[path], deletedRemote:[path], gone:[path], truncated:bool }
async function handleSync(body) {
  const local = Array.isArray(body.local) ? body.local : [];
  const known = body.known && typeof body.known === 'object' ? body.known : {};
  const localMap = new Map();
  for (const f of local) {
    const rel = safeRel(f.path);
    if (rel) localMap.set(rel, { hash: String(f.hash || ''), mtimeMs: Number(f.mtimeMs) || 0 });
  }

  const download = [];       // 需写入本地（服务端版本胜出或本地缺失）
  const upload = [];         // 需上传（本地新增/修改胜出）
  const deleteLocal = [];    // 服务端已删除 → 客户端删本地
  const deletedRemote = [];  // 本地已删除 → 服务端删远端
  const deleteLocalSet = new Set();

  // 1) 本地已删除的传播：known 有但服务端已没有 → 删本地（并清理状态）
  for (const rel of Object.keys(known)) {
    if (!manifest.files[rel] && localMap.has(rel)) {
      deleteLocal.push(rel);
      deleteLocalSet.add(rel);
    }
  }

  // 2) 遍历服务端文件
  for (const [rel, sf] of Object.entries(manifest.files)) {
    const lf = localMap.get(rel);
    if (!lf) {
      // 本地没有该文件：本地曾同步过且内容未变 → 本地删除了 → 删远端；
      // 若服务端在客户端上次同步后又改过 → 内容更新，恢复到本地而不是删除
      if (Object.prototype.hasOwnProperty.call(known, rel)) {
        if (known[rel] === sf.hash) deletedRemote.push(rel);
        else download.push({ path: rel, hash: sf.hash, mtimeMs: sf.mtimeMs, _sf: sf });
      } else {
        download.push({ path: rel, hash: sf.hash, mtimeMs: sf.mtimeMs, _sf: sf });
      }
      continue;
    }
    if (deleteLocalSet.has(rel)) continue; // 本地已删且服务端也没有，跳过
    if (lf.hash === sf.hash) continue;     // 双方一致

    const knownHash = known[rel];
    const locallyChanged = knownHash !== lf.hash;   // 本地在上次同步后改过
    const serverChanged = knownHash !== sf.hash;    // 服务端在上次同步后改过

    if (locallyChanged && !serverChanged) {
      upload.push(rel);
    } else if (!locallyChanged && serverChanged) {
      download.push({ path: rel, hash: sf.hash, mtimeMs: sf.mtimeMs, _sf: sf });
    } else {
      // 双方都改过（或首次同步两边内容不同）→ 冲突：mtime 新者胜，
      // 败方版本由对端保留为「冲突副本」（本地胜 → 服务端旧内容回传；服务端胜 → 本地另存副本）
      const localWins = lf.mtimeMs > sf.mtimeMs;
      if (localWins) {
        upload.push(rel);
        download.push({ path: rel, hash: sf.hash, mtimeMs: sf.mtimeMs, conflictCopy: true, _sf: sf });
      } else {
        download.push({ path: rel, hash: sf.hash, mtimeMs: sf.mtimeMs, conflict: true, _sf: sf });
      }
    }
  }

  // 3) 遍历本地文件：服务端没有的 → 上传（若服务端曾删除过则视为复活）
  for (const rel of localMap.keys()) {
    if (!manifest.files[rel] && !deleteLocalSet.has(rel)) upload.push(rel);
  }

  // 内联下载内容：受总字节预算限制，超出部分留给下一轮（客户端循环拉取）
  const budget = Math.max(2, config.inlineBudgetMb) * 1048576;
  let used = 0;
  let truncated = false;
  for (const item of download) {
    const sf = item._sf;
    delete item._sf;
    if (used >= budget) { truncated = true; break; }
    try {
      const buf = await fsp.readFile(absOf(item.path));
      if (used + buf.length > budget) { truncated = true; break; }
      used += buf.length;
      item.content = buf.toString('base64');
      // 磁盘内容与 manifest 不一致（人工改动过）时以磁盘为准
      const realHash = sha256(buf);
      if (realHash !== sf.hash) {
        item.hash = realHash;
        manifest.files[item.path] = { ...sf, hash: realHash, size: buf.length };
        await saveManifest();
      }
    } catch {
      // 文件丢失 → 从清单移除
      delete manifest.files[item.path];
      await saveManifest();
    }
  }

  return {
    version: manifest.version,
    // 只回传已成功内联内容的项（截断的留在下一轮，避免客户端写入空文件）
    download: download.filter((d) => d.content != null),
    upload: [...new Set(upload)],
    deleteLocal,
    deletedRemote,
    truncated,
  };
}

async function applyUpload(rel, contentB64, mtimeMs) {
  const buf = Buffer.from(String(contentB64 || ''), 'base64');
  const abs = absOf(rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, buf);
  manifest.files[rel] = {
    hash: sha256(buf),
    mtimeMs: Number(mtimeMs) || Date.now(),
    size: buf.length,
    updatedAt: Date.now(),
  };
  delete manifest.deleted[rel];
  manifest.version++;
  await saveManifest();
  return { ok: true, hash: manifest.files[rel].hash, version: manifest.version };
}

async function applyDelete(rel) {
  const abs = absOf(rel);
  await fsp.unlink(abs).catch(() => {});
  if (manifest.files[rel]) {
    delete manifest.files[rel];
    manifest.deleted[rel] = Date.now();
    pruneDeleted();
    manifest.version++;
    await saveManifest();
  }
  return { ok: true, version: manifest.version };
}

// ---------- http ----------
const LIMIT = (Math.max(2, config.maxFileMb) + 2) * 1048576;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  try {
    if (p === '/api/ping' && req.method === 'GET') {
      if (!checkToken(req, url)) return sendJson(res, 401, { ok: false, error: 'Token 无效' });
      return sendJson(res, 200, { ok: true, serverTime: Date.now(), version: manifest.version, fileCount: Object.keys(manifest.files).length });
    }
    if (!checkToken(req, url)) return sendJson(res, 401, { ok: false, error: 'Token 无效' });

    if (p === '/api/sync' && req.method === 'POST') {
      const body = await readBody(req, LIMIT);
      return sendJson(res, 200, { ok: true, ...(await handleSync(body)) });
    }
    if (p === '/api/file' && req.method === 'GET') {
      const rel = safeRel(url.searchParams.get('path'));
      if (!rel || !manifest.files[rel]) return sendJson(res, 404, { ok: false, error: '文件不存在' });
      const buf = await fsp.readFile(absOf(rel));
      return sendJson(res, 200, { ok: true, path: rel, hash: manifest.files[rel].hash, mtimeMs: manifest.files[rel].mtimeMs, content: buf.toString('base64') });
    }
    if (p === '/api/file' && req.method === 'PUT') {
      const body = await readBody(req, LIMIT);
      const rel = safeRel(body.path);
      if (!rel) return sendJson(res, 400, { ok: false, error: '非法路径' });
      return sendJson(res, 200, await applyUpload(rel, body.content, body.mtimeMs));
    }
    if (p === '/api/file/delete' && req.method === 'POST') {
      const body = await readBody(req, LIMIT);
      const rel = safeRel(body.path);
      if (!rel) return sendJson(res, 400, { ok: false, error: '非法路径' });
      return sendJson(res, 200, await applyDelete(rel));
    }
    return sendJson(res, 404, { ok: false, error: '接口不存在' });
  } catch (err) {
    sendJson(res, err.status || 500, { ok: false, error: err.message || '服务器错误' });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`[sync] Cognote 同步服务已启动: http://${config.host}:${config.port}`);
  console.log(`[sync] 数据目录: ${config.dataDir}`);
  console.log(`[sync] 已同步文件数: ${Object.keys(manifest.files).length}, 版本: ${manifest.version}`);
});
