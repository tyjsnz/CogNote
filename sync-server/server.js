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
 * 加密分享（E2EE）：客户端把分享范围明文用「查看口令」加密成 blob 上传（data/share-blobs/<id>.bin），
 * 查看者输口令、服务端现场 scrypt 派生解密渲染——服务端不存口令，磁盘上只有密文。
 * 注意：e2ee 内联实现须与客户端 src/e2ee.js 保持一致。
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

// 分享查看页（静态 HTML，加载一次）
let SHARE_VIEWER_HTML = '<!DOCTYPE html><html><body>分享页未找到</body></html>';
try { SHARE_VIEWER_HTML = fs.readFileSync(path.join(__dirname, 'share-viewer.html'), 'utf8'); } catch { /* 忽略 */ }

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

// ---------- 端到端加密（与客户端 src/e2ee.js 完全一致，独立部署需内联维护） ----------
// 加密分享的 blob 用「查看口令」加密；服务端不存口令，仅在 open/file 请求现场解密渲染。
const E2EE_MAGIC = Buffer.from('CNTE2E1', 'ascii');
const E2EE_SALT_DEFAULT = 'cognote-e2ee-v1';
const E2EE_SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const E2EE_NONCE_LEN = 12;
const E2EE_TAG_LEN = 16;
const E2EE_HEADER_LEN = E2EE_MAGIC.length + E2EE_NONCE_LEN + E2EE_TAG_LEN;

function e2eeDeriveKey(passphrase, salt) {
  if (!passphrase) throw new Error('缺少加密口令');
  return crypto.scryptSync(String(passphrase), salt || E2EE_SALT_DEFAULT, 32, E2EE_SCRYPT);
}

function e2eeEncrypt(key, plain, aad) {
  const aadBuf = aad == null ? null : Buffer.from(String(aad), 'utf8');
  const nonce = crypto.createHmac('sha256', key)
    .update(Buffer.concat([aadBuf || Buffer.alloc(0), Buffer.from([0]), plain]))
    .digest()
    .subarray(0, E2EE_NONCE_LEN);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  if (aadBuf) c.setAAD(aadBuf);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([E2EE_MAGIC, nonce, c.getAuthTag(), ct]);
}

function e2eeDecrypt(key, buf, aad) {
  if (!Buffer.isBuffer(buf) || buf.length < E2EE_HEADER_LEN || !buf.subarray(0, E2EE_MAGIC.length).equals(E2EE_MAGIC)) {
    throw new Error('无效的加密数据');
  }
  const aadBuf = aad == null ? null : Buffer.from(String(aad), 'utf8');
  const nonce = buf.subarray(E2EE_MAGIC.length, E2EE_MAGIC.length + E2EE_NONCE_LEN);
  const tag = buf.subarray(E2EE_MAGIC.length + E2EE_NONCE_LEN, E2EE_HEADER_LEN);
  const ct = buf.subarray(E2EE_HEADER_LEN);
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  if (aadBuf) d.setAAD(aadBuf);
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(ct), d.final()]);
  } catch {
    throw new Error('解密失败：查看密码不正确或数据已损坏');
  }
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

// ---------- 分享 ----------
// 分享记录：id → { title, paths:[相对files的路径], salt, hash, createdAt, expiresAt(0=长期) }
const SHARES_PATH = path.join(config.dataDir, 'shares.json');
let shares = { version: 1, items: {} };
try { shares = Object.assign(shares, JSON.parse(fs.readFileSync(SHARES_PATH, 'utf8'))); } catch { /* 首次运行 */ }

let _shareQueue = Promise.resolve();
function saveShares() {
  _shareQueue = _shareQueue.then(async () => {
    const tmp = SHARES_PATH + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(shares), 'utf8');
    await fsp.rename(tmp, SHARES_PATH);
  }).catch((e) => console.error(`[sync] shares 写入失败: ${e.message}`));
  return _shareQueue;
}

function passwordHash(salt, password) {
  return sha256(Buffer.from(String(salt) + '\u0000' + String(password || ''), 'utf8'));
}

function shareExpired(s) {
  return s.expiresAt > 0 && Date.now() > s.expiresAt;
}

// ---------- 加密分享 blob（data/share-blobs/<id>.bin，查看口令加密的分享内容快照） ----------
const SHARE_BLOBS_DIR = path.join(config.dataDir, 'share-blobs');
fs.mkdirSync(SHARE_BLOBS_DIR, { recursive: true });

function shareBlobPath(id) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(id || ''))) throw new Error('非法分享 id');
  return path.join(SHARE_BLOBS_DIR, id + '.bin');
}

// 解密后的 payload 缓存（id → { at, payload }）：避免每个文件请求都跑一遍 scrypt
const SHARE_PAYLOAD_TTL = 10 * 60000;
const SHARE_PAYLOAD_MAX = 30;
const sharePayloadCache = new Map();
function clearSharePayload(id) {
  sharePayloadCache.delete(id);
}
async function loadSharePayload(id, password) {
  const hit = sharePayloadCache.get(id);
  const now = Date.now();
  if (hit && now - hit.at < SHARE_PAYLOAD_TTL) return hit.payload;
  const raw = await fsp.readFile(shareBlobPath(id));
  const key = e2eeDeriveKey(password, shares.items[id] && shares.items[id].salt);
  const payload = JSON.parse(e2eeDecrypt(key, raw, 'share').toString('utf8'));
  if (payload.v !== 1 || !payload.files || typeof payload.files !== 'object') throw new Error('分享数据格式无效');
  if (sharePayloadCache.size >= SHARE_PAYLOAD_MAX) {
    // 淘汰最旧的一条
    const oldest = [...sharePayloadCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) sharePayloadCache.delete(oldest[0]);
  }
  sharePayloadCache.set(id, { at: now, payload });
  return payload;
}

function b64ByteLen(b64) {
  const s = String(b64 || '');
  const pad = s.endsWith('==') ? 2 : (s.endsWith('=') ? 1 : 0);
  return Math.floor(s.length * 3 / 4) - pad;
}

function sharePathAllowed(s, p) {
  return s.paths.some((base) => {
    const b = base.replace(/\/+$/, '');
    return p === b || p.startsWith(b + '/');
  });
}

// 密码尝试限流：id|ip → { fails, until }
const shareFails = new Map();
function shareLocked(id, ip) {
  const rec = shareFails.get(id + '|' + ip);
  return !!(rec && rec.until > Date.now());
}
function recordShareFail(id, ip) {
  const key = id + '|' + ip;
  const rec = shareFails.get(key) || { fails: 0, until: 0 };
  rec.fails++;
  if (rec.fails >= 10) { rec.until = Date.now() + 10 * 60000; rec.fails = 0; }
  shareFails.set(key, rec);
}
function clearShareFails(id, ip) { shareFails.delete(id + '|' + ip); }

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

function guessMime(p) {
  const ext = path.extname(p).toLowerCase();
  return {
    '.md': 'text/markdown; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.json': 'application/json; charset=utf-8',
  }[ext] || 'application/octet-stream';
}

// 公开分享校验：返回 { share } 或 { error, status }
function authShare(req, id, password) {
  const s = shares.items[id];
  if (!s) return { error: '分享不存在或已被删除', status: 404 };
  if (s.disabled) return { error: '分享已被停用', status: 410 };
  const ip = clientIp(req);
  if (shareLocked(id, ip)) return { error: '尝试次数过多，请 10 分钟后再试', status: 429 };
  const h = passwordHash(s.salt, password);
  const a = Buffer.from(h);
  const b = Buffer.from(String(s.hash));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    recordShareFail(id, ip);
    return { error: '查看密码错误', status: 403 };
  }
  clearShareFails(id, ip);
  if (shareExpired(s)) return { error: '分享已过期', status: 410 };
  return { share: s };
}

// 记录一次分享浏览（open 成功时）：总数 + 按天计数
function recordShareView(s) {
  const now = Date.now();
  s.views = (s.views || 0) + 1;
  s.lastViewAt = now;
  const day = new Date(now).toISOString().slice(0, 10);
  s.viewDays = s.viewDays || {};
  s.viewDays[day] = (s.viewDays[day] || 0) + 1;
}

// 记录一次笔记阅读（file 成功且为 md 时）：per-path 计数
function recordFileView(s, rel) {
  if (!/\.md$/i.test(rel)) return;
  s.fileViews = s.fileViews || {};
  s.fileViews[rel] = (s.fileViews[rel] || 0) + 1;
}

// ---------- http ----------
const LIMIT = (Math.max(2, config.maxFileMb) + 2) * 1048576;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  try {
    if (p === '/api/ping' && req.method === 'GET') {
      if (!checkToken(req, url)) return sendJson(res, 401, { ok: false, error: 'Token 无效' });
      return sendJson(res, 200, { ok: true, serverTime: Date.now(), version: manifest.version, fileCount: Object.keys(manifest.files).length, features: { e2eeShare: true } });
    }

    // ---------- 公开分享接口（无需同步 Token，靠分享密码保护） ----------
    if (p === '/api/public/share/open' && req.method === 'POST') {
      const body = await readBody(req, 65536);
      const id = String(body.id || '').trim();
      const r = authShare(req, id, body.password);
      if (r.error) return sendJson(res, r.status, { ok: false, error: r.error });
      const s = r.share;
      const enc = !!s.enc;
      let files = [];
      if (enc) {
        // 加密分享：文件清单来自解密后的 payload（服务端磁盘上只有密文快照，无 paths 明文结构）
        let payload;
        try {
          payload = await loadSharePayload(id, String(body.password || ''));
        } catch (e) {
          return sendJson(res, 500, { ok: false, error: '分享数据解密失败: ' + e.message });
        }
        files = Object.keys(payload.files).map((rel) => ({
          path: rel,
          size: b64ByteLen(payload.files[rel]),
          mtimeMs: (payload.mtimes && payload.mtimes[rel]) || s.createdAt,
        }));
      } else {
        for (const [rel, sf] of Object.entries(manifest.files)) {
          if (sharePathAllowed(s, rel)) files.push({ path: rel, size: sf.size, mtimeMs: sf.mtimeMs });
        }
      }
      files.sort((a, b2) => a.path.localeCompare(b2.path));
      recordShareView(s);
      await saveShares();
      return sendJson(res, 200, {
        ok: true,
        title: s.title || '分享笔记',
        paths: s.paths,
        expiresAt: s.expiresAt,
        files,
        enc,
      });
    }
    if (p === '/api/public/share/file' && req.method === 'GET') {
      const id = (url.searchParams.get('id') || '').trim();
      const rel = safeRel(url.searchParams.get('path'));
      const password = url.searchParams.get('password');
      const r = authShare(req, id, password);
      if (r.error) return sendJson(res, r.status, { ok: false, error: r.error });
      if (!rel) return sendJson(res, 400, { ok: false, error: '非法路径' });
      if (!sharePathAllowed(r.share, rel)) return sendJson(res, 403, { ok: false, error: '该文件不在分享范围内' });
      let contentB64;
      if (r.share.enc) {
        // 加密分享：从口令解密的 payload 快照取文件，不落明文
        let payload;
        try {
          payload = await loadSharePayload(id, String(password || ''));
        } catch (e) {
          return sendJson(res, 500, { ok: false, error: '分享数据解密失败: ' + e.message });
        }
        contentB64 = payload.files[rel];
        if (contentB64 == null) return sendJson(res, 404, { ok: false, error: '文件不存在' });
      } else {
        if (!manifest.files[rel]) return sendJson(res, 404, { ok: false, error: '文件不存在' });
        let buf;
        try { buf = await fsp.readFile(absOf(rel)); } catch { return sendJson(res, 404, { ok: false, error: '文件不存在' }); }
        contentB64 = buf.toString('base64');
      }
      // 阅读统计：每次成功读取 md 笔记 +1（图片等资源不计）
      recordFileView(r.share, rel);
      await saveShares();
      return sendJson(res, 200, { ok: true, path: rel, content: contentB64, mime: guessMime(rel) });
    }
    if (p === '/s/viewer' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(SHARE_VIEWER_HTML);
    }

    if (!checkToken(req, url)) return sendJson(res, 401, { ok: false, error: 'Token 无效' });

    // ---------- 分享管理（同步 Token 鉴权） ----------
    if (p === '/api/shares' && req.method === 'GET') {
      const list = Object.entries(shares.items).map(([id, s]) => ({
        id,
        title: s.title || '',
        paths: s.paths,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        expired: shareExpired(s),
        disabled: !!s.disabled,
        views: s.views || 0,
        lastViewAt: s.lastViewAt || 0,
        viewDays: s.viewDays || {},
        fileViews: s.fileViews || {},
        enc: !!s.enc,
      }));
      list.sort((a, b2) => b2.createdAt - a.createdAt);
      return sendJson(res, 200, { ok: true, shares: list });
    }
    if (p === '/api/shares/create' && req.method === 'POST') {
      const body = await readBody(req, LIMIT); // 加密分享 blob（明文打包+口令加密）可达数十 MB
      const rawPaths = Array.isArray(body.paths) ? body.paths : [];
      const paths = [...new Set(rawPaths.map((x) => safeRel(x)).filter(Boolean))];
      if (!paths.length) return sendJson(res, 400, { ok: false, error: '缺少分享路径' });
      const password = String(body.password || '').trim();
      if (password.length < 4) return sendJson(res, 400, { ok: false, error: '查看密码至少 4 位' });
      const days = Number(body.expireDays) || 0; // 0=长期, 1/7/30
      if (![0, 1, 7, 30].includes(days)) return sendJson(res, 400, { ok: false, error: '有效期仅支持 1/7/30 天或长期' });
      const id = crypto.randomBytes(9).toString('base64url');
      // 加密分享：客户端把分享范围的明文打包用查看口令加密后上传（salt 由客户端生成，
      // 与口令校验共用同一 salt，open/file 时现场派生解密，服务端不存口令）
      const enc = !!(body.salt && body.blob);
      const salt = enc ? String(body.salt) : crypto.randomBytes(8).toString('hex');
      if (enc) {
        const blob = Buffer.from(String(body.blob), 'base64');
        if (!blob.length) return sendJson(res, 400, { ok: false, error: '加密分享数据为空' });
        await fsp.writeFile(shareBlobPath(id), blob);
      }
      shares.items[id] = {
        title: String(body.title || '').slice(0, 100),
        paths,
        salt,
        hash: passwordHash(salt, password),
        enc,
        createdAt: Date.now(),
        expiresAt: days > 0 ? Date.now() + days * 86400000 : 0,
        disabled: false,
        views: 0,
        lastViewAt: 0,
        viewDays: {},
        fileViews: {},
      };
      await saveShares();
      const s = shares.items[id];
      return sendJson(res, 200, { ok: true, share: { id, title: s.title, paths: s.paths, createdAt: s.createdAt, expiresAt: s.expiresAt, enc } });
    }
    if (p === '/api/shares/delete' && req.method === 'POST') {
      const body = await readBody(req, 65536);
      const id = String(body.id || '').trim();
      if (!shares.items[id]) return sendJson(res, 404, { ok: false, error: '分享不存在' });
      delete shares.items[id];
      clearSharePayload(id);
      await fsp.unlink(shareBlobPath(id)).catch(() => {}); // 加密 blob 一并清理
      await saveShares();
      return sendJson(res, 200, { ok: true });
    }
    // 停用 / 启用（停用后链接立即无法打开，数据与统计保留，可随时恢复）
    if (p === '/api/shares/toggle' && req.method === 'POST') {
      const body = await readBody(req, 65536);
      const id = String(body.id || '').trim();
      const s = shares.items[id];
      if (!s) return sendJson(res, 404, { ok: false, error: '分享不存在' });
      if (typeof body.disabled !== 'boolean') return sendJson(res, 400, { ok: false, error: '缺少 disabled 参数' });
      s.disabled = body.disabled;
      await saveShares();
      return sendJson(res, 200, { ok: true, disabled: s.disabled });
    }
    if (p === '/api/shares/password' && req.method === 'POST') {
      const body = await readBody(req, LIMIT); // 同 create：可能携带新口令加密的 blob
      const id = String(body.id || '').trim();
      const s = shares.items[id];
      if (!s) return sendJson(res, 404, { ok: false, error: '分享不存在' });
      const password = String(body.password || '').trim();
      if (password.length < 4) return sendJson(res, 400, { ok: false, error: '查看密码至少 4 位' });
      const newSalt = crypto.randomBytes(8).toString('hex');
      const enc = !!s.enc;
      if (enc && !(body.salt && body.blob)) {
        return sendJson(res, 400, { ok: false, error: '加密分享修改密码必须携带新的加密数据' });
      }
      s.salt = enc ? String(body.salt) : newSalt;
      s.hash = passwordHash(s.salt, password);
      if (enc) {
        const blob = Buffer.from(String(body.blob), 'base64');
        if (!blob.length) return sendJson(res, 400, { ok: false, error: '加密分享数据为空' });
        await fsp.writeFile(shareBlobPath(id), blob);
      }
      clearSharePayload(id); // 口令/密文已变，作废解密缓存
      await saveShares();
      return sendJson(res, 200, { ok: true, enc });
    }

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
