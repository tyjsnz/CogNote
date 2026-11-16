/**
 * Cognote 云端同步引擎（客户端）
 * - 与 sync-server 通过 Token 鉴权的 HTTP API 双向同步
 * - 差异同步：只传输变更文件；冲突按 mtime 新者胜，败方保留为「冲突副本」
 * - 状态持久化于云端目录下 .cognote-sync/state.json（记录每个文件上次同步的 hash）
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const e2ee = require('./e2ee');

const SYNC_STATE_DIR = '.cognote-sync';
const STATE_FILE = 'state.json';
const SUPPORTED_RE = /\.(md|pdf|txt|png|jpe?g|gif|webp|svg|docx?|xlsx?|pptx?|zip|js|jsx|ts|tsx|mjs|cjs|py|c|cpp|h|hpp|java|go|rs|sh|bash|json|yaml|yml|toml|xml|html|htm|css|scss|less|sql|csv|log|vue|svelte|rb|php|swift|kt|scala|lua|r|ini|cfg|conf|properties)$/i;
const MAX_SYNC_ROUNDS = 30;   // 内容内联受预算限制时的分轮拉取上限
const TIMEOUT_MS = 60000;

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function toPosix(p) {
  return String(p).split(path.sep).join('/');
}

class CloudSync {
  /**
   * @param {object} opts
   *  - getCloudDir: () => string  云端目录绝对路径
   *  - getConfig:   () => {enabled,url,token,intervalSec}
   *  - onApplied:   (summary) => void  同步落地（写入/删除文件）后的回调，用于刷新索引
   */
  constructor(opts) {
    this.getCloudDir = opts.getCloudDir;
    this.getConfig = opts.getConfig;
    this.onApplied = opts.onApplied || (() => {});
    this.syncing = false;
    this.timer = null;
    this.debounce = null;
    this.lastSyncAt = 0;
    this.lastError = '';
    this.lastSummary = null;
    this.lastChangeAt = 0; // 有文件被写入/删除的时间戳（前端轮询用于刷新树）
    this.lastRev = 0;      // 服务端版本号（无变化时可跳过）
  }

  status() {
    const cfg = this.getConfig() || {};
    return {
      enabled: !!cfg.enabled,
      configured: !!(cfg.enabled && cfg.url && cfg.token),
      encrypt: !!cfg.encrypt,
      url: cfg.url || '',
      dir: this.getCloudDir() || '',
      intervalSec: cfg.intervalSec || 60,
      syncing: this.syncing,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
      lastSummary: this.lastSummary,
      lastChangeAt: this.lastChangeAt,
    };
  }

  // ---------- 端到端加密（cloud.encrypt + cloud.passphrase） ----------
  // 密钥按口令派生并缓存；未启用加密返回 null（明文模式，行为与旧版完全一致）
  encKey() {
    const cfg = this.getConfig() || {};
    if (!cfg.encrypt) return null;
    if (!cfg.passphrase) throw new Error('已启用云端加密，但尚未设置加密口令（设置 → 云端同步）');
    if (this._keyCache && this._keyCache.pass === cfg.passphrase) return this._keyCache.key;
    const key = e2ee.deriveKey(cfg.passphrase);
    this._keyCache = { pass: cfg.passphrase, key };
    return key;
  }

  // 明文 → 待上传字节（加密开启时为密文；AAD 绑定路径）
  encryptFor(plain, rel) {
    const key = this.encKey();
    return key ? e2ee.encrypt(key, plain, rel) : plain;
  }

  // 解密用密钥：加密开启走 encKey（无口令抛错）；加密关闭但本地仍留有口令时也能派生，
  // 用于「关闭加密」迁移期解密服务端残留的旧密文（关闭加密 ≠ 读不懂旧数据）
  decKey() {
    const cfg = this.getConfig() || {};
    if (!cfg.passphrase) return null;
    if (this._decKeyCache && this._decKeyCache.pass === cfg.passphrase) return this._decKeyCache.key;
    const key = e2ee.deriveKey(cfg.passphrase);
    this._decKeyCache = { pass: cfg.passphrase, key };
    return key;
  }

  // 服务端字节 → 明文；无魔数返回原样（明文模式/迁移期），口令错返回 plain:null
  decBuf(buf, rel) {
    if (!e2ee.isEncrypted(buf)) return { plain: buf };
    const key = this.encKey() || this.decKey(); // 加密开启但没口令 → encKey 已抛明确错误
    if (!key) return { plain: null, error: new Error('云端为加密数据，但尚未设置加密口令') };
    try {
      return { plain: e2ee.decrypt(key, buf, rel) };
    } catch (e) {
      return { plain: null, error: e };
    }
  }

  // 本地明文在同步状态里的 hash 口径（加密开启 = 密文 hash，与服务端 manifest 一致）
  hashOf(plain, rel) {
    return sha256(this.encryptFor(plain, rel));
  }

  // ---------- 定时 / 延迟触发 ----------
  startTimer() {
    this.stopTimer();
    const cfg = this.getConfig() || {};
    if (!cfg.enabled || !cfg.url || !cfg.token) return;
    const sec = Math.max(15, Number(cfg.intervalSec) || 60);
    this.timer = setInterval(() => {
      this.syncNow().catch(() => {});
    }, sec * 1000);
    if (this.timer.unref) this.timer.unref();
  }

  stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // 本地变更后的防抖触发（3 秒合并多次保存）
  scheduleSoon(ms = 3000) {
    const cfg = this.getConfig() || {};
    if (!cfg.enabled || !cfg.url || !cfg.token) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.syncNow().catch((e) => console.error(`[cloud] 自动同步失败: ${e.message}`));
    }, ms);
  }

  // ---------- 文件扫描 ----------
  statePath() {
    return path.join(this.getCloudDir(), SYNC_STATE_DIR, STATE_FILE);
  }

  async loadState() {
    try {
      const raw = await fsp.readFile(this.statePath(), 'utf8');
      const o = JSON.parse(raw);
      return { files: (o && typeof o.files === 'object' && o.files) || {} };
    } catch {
      return { files: {} };
    }
  }

  async saveState(state) {
    const p = this.statePath();
    await fsp.mkdir(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(state), 'utf8');
    await fsp.rename(tmp, p);
  }

  // 扫描云端目录（跳过同步状态目录与不支持的文件类型）
  async scanLocal() {
    const root = this.getCloudDir();
    const out = [];
    const self = this; // rec 是普通函数，显式持有实例
    async function rec(dirAbs, dirRel) {
      let entries;
      try {
        entries = await fsp.readdir(dirAbs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name === SYNC_STATE_DIR) continue;
        const abs = path.join(dirAbs, e.name);
        const rel = dirRel ? dirRel + '/' + e.name : e.name;
        if (e.isDirectory()) {
          await rec(abs, rel);
        } else if (e.isFile() && SUPPORTED_RE.test(e.name)) {
          try {
            const buf = await fsp.readFile(abs);
            const st = await fsp.stat(abs);
            // 加密开启：上传字节为密文（hash 按密文口径），冲突副本写盘需用明文
            const enc = self.encryptFor(buf, rel);
            const item = { path: rel, hash: sha256(enc), mtimeMs: Math.round(st.mtimeMs), _buf: enc };
            if (enc !== buf) item._plain = buf;
            out.push(item);
          } catch { /* 忽略读取失败的文件 */ }
        }
      }
    }
    await rec(root, '');
    return out;
  }

  // ---------- HTTP ----------
  async _request(method, apiPath, body) {
    const cfg = this.getConfig();
    const url = String(cfg.url || '').replace(/\/+$/, '') + apiPath;
    const opts = {
      method,
      headers: { Authorization: 'Bearer ' + cfg.token },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    return data;
  }

  // 冲突副本文件名：笔记.md → 笔记 (冲突 20260101-120000).md
  conflictName(rel, ts) {
    const d = new Date(ts || Date.now());
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const i = rel.lastIndexOf('/');
    const dir = i === -1 ? '' : rel.slice(0, i + 1);
    const base = i === -1 ? rel : rel.slice(i + 1);
    const m = base.match(/^(.*?)(\.[^.]+)?$/);
    const stem = m[1] || base;
    const ext = m[2] || '';
    return `${dir}${stem} (冲突 ${stamp})${ext}`;
  }

  // ---------- 主流程 ----------
  async syncNow() {
    if (this.syncing) return { skipped: true, reason: 'syncing' };
    const cfg = this.getConfig() || {};
    if (!cfg.enabled) return { skipped: true, reason: 'disabled' };
    if (!cfg.url || !cfg.token) return { skipped: true, reason: 'not-configured' };
    const dir = this.getCloudDir();
    if (!dir) return { skipped: true, reason: 'no-dir' };
    this.encKey(); // 加密已启用但未设口令 → 在此抛出明确错误，避免半途失败

    this.syncing = true;
    const summary = { pushed: 0, pulled: 0, deleted: 0, remoteDeleted: 0, conflicts: 0, error: '', changedPaths: [], removedPaths: [] };
    const touched = new Set();
    const removed = new Set();
    try {
      await fsp.mkdir(dir, { recursive: true });
      let state = await this.loadState();
      let local = await this.scanLocal();

      for (let round = 0; round < MAX_SYNC_ROUNDS; round++) {
        const known = {};
        for (const [rel, meta] of Object.entries(state.files)) known[rel] = meta.hash;
        const resp = await this._request('POST', '/api/sync', {
          local: local.map((f) => ({ path: f.path, hash: f.hash, mtimeMs: f.mtimeMs })),
          known,
        });

        const localByPath = new Map(local.map((f) => [f.path, f]));
        let changed = false;

        // 1) 下载（含冲突副本落地）
        for (const item of resp.download || []) {
          const rel = item.path;
          const buf = Buffer.from(item.content || '', 'base64');
          const abs = path.join(dir, ...rel.split('/'));

          if (item.conflictCopy) {
            // 服务端旧版本被本地新版本覆盖 → 服务端旧内容存为本地冲突副本（下轮自动上传）
            const dec = this.decBuf(buf, rel);
            if (!dec.plain) {
              // 旧密文口令不一致 → 无法解密，本地版本已胜出，直接丢弃该副本
              console.warn(`[cloud] 冲突副本无法解密，已丢弃: ${rel}`);
              continue;
            }
            const cRel = this.conflictName(rel, Date.now());
            const cAbs = path.join(dir, ...cRel.split('/'));
            await fsp.mkdir(path.dirname(cAbs), { recursive: true });
            await fsp.writeFile(cAbs, dec.plain);
            state.files[cRel] = { hash: this.hashOf(dec.plain, cRel) };
            summary.conflicts++;
            touched.add(cRel);
            changed = true;
            continue;
          }

          if (item.conflict) {
            // 双方都改过且服务端更新 → 本地版本存冲突副本，写入服务端版本
            const lf = localByPath.get(rel);
            if (lf && (lf._plain || lf._buf)) {
              const localPlain = lf._plain || lf._buf;
              const cRel = this.conflictName(rel, Date.now());
              const cAbs = path.join(dir, ...cRel.split('/'));
              await fsp.mkdir(path.dirname(cAbs), { recursive: true });
              await fsp.writeFile(cAbs, localPlain);
              state.files[cRel] = { hash: this.hashOf(localPlain, cRel) };
              summary.conflicts++;
            }
          }

          const dec = this.decBuf(buf, rel);
          if (!dec.plain) {
            // 服务端版本无法解密（口令不一致）：
            // - 本地已有该文件 → 记为「已知版本」，下一轮本地版本判定为变更并上传覆盖，自动收敛
            // - 本地没有该文件 → 绝不能记已知版本（known 有、本地无 会被服务端判定为
            //   「本地已删除 → 删远端」，误删其它设备的数据）；只跳过，等口令修正后再拉取
            if (localByPath.has(rel)) {
              console.warn(`[cloud] 云端文件解密失败（加密口令不一致？），跳过并上传本地版本: ${rel}`);
              state.files[rel] = { hash: item.hash || sha256(buf) };
              changed = true;
            } else {
              console.warn(`[cloud] 云端文件解密失败（加密口令不一致？），本地无该文件已跳过: ${rel}`);
            }
            continue;
          }

          await fsp.mkdir(path.dirname(abs), { recursive: true });
          await fsp.writeFile(abs, dec.plain);
          try { await fsp.utimes(abs, new Date(item.mtimeMs || Date.now()), new Date(item.mtimeMs || Date.now())); } catch {}
          state.files[rel] = { hash: item.hash || sha256(buf) };
          summary.pulled++;
          touched.add(rel);
          changed = true;
        }

        // 2) 删除本地（服务端已删）
        for (const rel of resp.deleteLocal || []) {
          const abs = path.join(dir, ...rel.split('/'));
          await fsp.unlink(abs).catch(() => {});
          delete state.files[rel];
          summary.deleted++;
          removed.add(rel);
          changed = true;
        }

        // 3) 上传
        for (const rel of resp.upload || []) {
          const lf = localByPath.get(rel);
          if (!lf) continue;
          const r = await this._request('PUT', '/api/file', {
            path: rel,
            content: lf._buf.toString('base64'),
            mtimeMs: lf.mtimeMs,
          });
          state.files[rel] = { hash: r.hash || lf.hash };
          summary.pushed++;
          changed = true;
        }

        // 4) 删除远端（本地已删）
        for (const rel of resp.deletedRemote || []) {
          await this._request('POST', '/api/file/delete', { path: rel });
          delete state.files[rel];
          summary.remoteDeleted++;
          changed = true;
        }

        if (changed) {
          await this.saveState(state);
          this.lastChangeAt = Date.now();
        }
        this.lastRev = resp.version || 0;

        // 内容内联受预算截断 → 重新扫描并进入下一轮拉取
        if (!resp.truncated) break;
        local = await this.scanLocal();
        state = await this.loadState();
      }

      this.lastSyncAt = Date.now();
      this.lastError = '';
      summary.changedPaths = [...touched];
      summary.removedPaths = [...removed];
      this.lastSummary = { ...summary, changedPaths: undefined, removedPaths: undefined };
      this.onApplied(summary);
      return { ...summary, at: this.lastSyncAt };
    } catch (err) {
      this.lastError = err.message || String(err);
      this.lastSummary = { ...summary, error: this.lastError };
      throw err;
    } finally {
      this.syncing = false;
    }
  }

  // 测试服务器连通性与 Token（配置保存前调用）
  async ping() {
    return this._request('GET', '/api/ping');
  }
}

module.exports = { CloudSync, SYNC_STATE_DIR };
