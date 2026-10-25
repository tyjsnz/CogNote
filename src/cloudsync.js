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
            out.push({ path: rel, hash: sha256(buf), mtimeMs: Math.round(st.mtimeMs), _buf: buf });
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
            const cRel = this.conflictName(rel, Date.now());
            const cAbs = path.join(dir, ...cRel.split('/'));
            await fsp.mkdir(path.dirname(cAbs), { recursive: true });
            await fsp.writeFile(cAbs, buf);
            state.files[cRel] = { hash: sha256(buf) };
            summary.conflicts++;
            touched.add(cRel);
            changed = true;
            continue;
          }

          if (item.conflict) {
            // 双方都改过且服务端更新 → 本地版本存冲突副本，写入服务端版本
            const lf = localByPath.get(rel);
            if (lf && lf._buf) {
              const cRel = this.conflictName(rel, Date.now());
              const cAbs = path.join(dir, ...cRel.split('/'));
              await fsp.mkdir(path.dirname(cAbs), { recursive: true });
              await fsp.writeFile(cAbs, lf._buf);
              state.files[cRel] = { hash: sha256(lf._buf) };
              summary.conflicts++;
            }
          }

          await fsp.mkdir(path.dirname(abs), { recursive: true });
          await fsp.writeFile(abs, buf);
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
