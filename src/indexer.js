const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { tokenCountMap } = require('./tokenize');

const MD_RE = /\.md$/i;

function parseFrontmatter(content) {
  const tags = [];
  let body = content;
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (m) {
    const fm = m[1];
    const tagsMatch = fm.match(/^tags:\s*\[?([^\]]*?)\]?$/m);
    if (tagsMatch) {
      tagsMatch[1]
        .split(/[,，\s]+/)
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean)
        .forEach((t) => tags.push(t));
    }
    body = content.slice(m[0].length);
  }
  return { tags, body };
}

function extractTitle(body, relPath) {
  const m = body.match(/^\s*#{1,6}\s+(.+)$/m);
  if (m) return m[1].trim().replace(/[#*_`]/g, '').trim();
  const base = path.basename(relPath, '.md');
  return base;
}

function buildHeadings(body) {
  const headings = [];
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^\s*(#{1,6})\s+(.+)$/);
    if (m) headings.push({ level: m[1].length, text: m[2].replace(/[#*_`]/g, '').trim() });
  }
  return headings;
}

// v1.3: 提取笔记中的内部链接（指向其他 .md 文件的链接）
function extractInternalLinks(body, currentRelPath) {
  const links = [];
  // 匹配 [text](path.md) 和 [text](path)
  const re = /\[([^\]]*)\]\(([^)]+\.md)\)/gi;
  let m;
  while ((m = re.exec(body)) !== null) {
    const target = m[2];
    // 解析相对路径
    const currentDir = currentRelPath.includes('/') ? currentRelPath.replace(/\/[^/]*$/, '') : '';
    const resolved = currentDir ? currentDir + '/' + target : target;
    // 规范化路径（处理 ../）
    const parts = resolved.split('/');
    const stack = [];
    for (const p of parts) {
      if (p === '..') stack.pop();
      else if (p && p !== '.') stack.push(p);
    }
    const normalized = stack.join('/');
    if (normalized && normalized !== currentRelPath) {
      links.push(normalized);
    }
  }
  return [...new Set(links)];
}

class Indexer {
  constructor(notesDir, opts = {}) {
    this.notesDir = path.resolve(notesDir);
    this.ignoreDirs = new Set(opts.ignoreDirs || ['.git', 'node_modules', 'img', 'images', '.obsidian']);
    this.maxSizeBytes = (opts.maxFileSizeKb || 2048) * 1024;
    this.docs = new Map();   // relPath -> doc
    this.index = new Map();  // token  -> Map(relPath -> {t,g,h,b})
    this.errors = [];
  }

  isIgnoredDir(dirName) {
    return this.ignoreDirs.has(dirName);
  }

  scan() {
    const files = this._walk();
    for (const absPath of files) {
      this._indexFile(absPath);
    }
    return {
      total: this.docs.size,
      errors: this.errors.length,
      ignoredDirs: this.ignoreDirs.size,
    };
  }

  _walk() {
    const out = [];
    const stack = [this.notesDir];
    const visited = new Set();
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (this.isIgnoredDir(e.name)) continue;
          stack.push(full);
        } else if (e.isFile() && MD_RE.test(e.name)) {
          out.push(full);
        } else if (e.isSymbolicLink()) {
          // 同步盘（fnos_sync_data 等）中的文件可能是 reparse point / 符号链接
          let st;
          try {
            st = fs.statSync(full);
          } catch {
            continue;
          }
          if (st.isDirectory()) {
            if (this.isIgnoredDir(e.name)) continue;
            let real;
            try {
              real = fs.realpathSync(full);
            } catch {
              real = full;
            }
            if (visited.has(real)) continue; // 防止符号链接目录形成环
            visited.add(real);
            stack.push(full);
          } else if (st.isFile() && MD_RE.test(e.name)) {
            out.push(full);
          }
        }
      }
    }
    return out;
  }

  _parse(absPath) {
    const relPath = path.relative(this.notesDir, absPath).split(path.sep).join('/');
    let content;
    try {
      content = fs.readFileSync(absPath, 'utf8');
    } catch (err) {
      this.errors.push(`${relPath}: ${err.message}`);
      return null;
    }
    const { tags, body } = parseFrontmatter(content);
    const title = extractTitle(body, relPath);
    const headings = buildHeadings(body);
    const links = extractInternalLinks(body, relPath);
    const st = fs.statSync(absPath);
    return {
      relPath,
      absPath,
      title,
      tags,
      size: st.size,
      mtimeMs: st.mtimeMs,
      content,
      body,
      headings,
      links,
      titleT: tokenCountMap(title),
      tagT: tokenCountMap(tags.join(' ')),
      headT: tokenCountMap(headings.map((h) => h.text).join(' ')),
      bodyT: tokenCountMap(body),
    };
  }

  _indexFile(absPath) {
    const doc = this._parse(absPath);
    if (!doc) return null;
    this._removeDoc(doc.relPath);
    this.docs.set(doc.relPath, doc);
    for (const [tok, cnt] of doc.titleT) this._addPosting(tok, doc.relPath, { t: cnt });
    for (const [tok, cnt] of doc.tagT) this._addPosting(tok, doc.relPath, { g: cnt });
    for (const [tok, cnt] of doc.headT) this._addPosting(tok, doc.relPath, { h: cnt });
    for (const [tok, cnt] of doc.bodyT) this._addPosting(tok, doc.relPath, { b: cnt });
    return doc;
  }

  _addPosting(tok, relPath, fields) {
    let map = this.index.get(tok);
    if (!map) {
      map = new Map();
      this.index.set(tok, map);
    }
    const entry = map.get(relPath) || { t: 0, g: 0, h: 0, b: 0 };
    entry.t += fields.t || 0;
    entry.g += fields.g || 0;
    entry.h += fields.h || 0;
    entry.b += fields.b || 0;
    map.set(relPath, entry);
  }

  _removeDoc(relPath) {
    const doc = this.docs.get(relPath);
    if (doc) {
      for (const tok of new Set([...doc.titleT.keys(), ...doc.tagT.keys(), ...doc.headT.keys(), ...doc.bodyT.keys()])) {
        const map = this.index.get(tok);
        if (map) {
          map.delete(relPath);
          if (map.size === 0) this.index.delete(tok);
        }
      }
      this.docs.delete(relPath);
    }
  }

  get(relPath) {
    return this.docs.get(relPath);
  }

  add(absPath) {
    const relPath = path.relative(this.notesDir, absPath).split(path.sep).join('/');
    return { relPath, doc: this._indexFile(absPath) };
  }

  remove(absPath) {
    const relPath = path.relative(this.notesDir, absPath).split(path.sep).join('/');
    this._removeDoc(relPath);
  }

  rename(fromRel, toAbs) {
    this._removeDoc(String(fromRel).split(path.sep).join('/'));
    const { relPath, doc } = this.add(toAbs);
    return { relPath, doc };
  }

  stats() {
    const tagCount = new Map();
    for (const doc of this.docs.values()) {
      for (const t of doc.tags) tagCount.set(t, (tagCount.get(t) || 0) + 1);
    }
    return {
      total: this.docs.size,
      errors: this.errors.length,
      topTags: [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30),
    };
  }

  // v1.1: 保存索引到磁盘
  save(indexPath) {
    const data = {
      version: 1,
      savedAt: Date.now(),
      docs: {},
      index: {},
    };
    // 保存文档元数据（不保存 content/body 全文，只保存元信息）
    for (const [relPath, doc] of this.docs) {
      data.docs[relPath] = {
        relPath: doc.relPath,
        title: doc.title,
        tags: doc.tags,
        size: doc.size,
        mtimeMs: doc.mtimeMs,
        headings: doc.headings,
        links: doc.links || [],
        titleT: [...doc.titleT.entries()],
        tagT: [...doc.tagT.entries()],
        headT: [...doc.headT.entries()],
        bodyT: [...doc.bodyT.entries()],
      };
    }
    // 保存倒排索引
    for (const [token, map] of this.index) {
      data.index[token] = [...map.entries()];
    }
    try {
      fs.writeFileSync(indexPath, JSON.stringify(data), 'utf8');
      return { ok: true, docs: this.docs.size, tokens: this.index.size };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // v1.1: 从磁盘加载索引
  load(indexPath) {
    try {
      const raw = fs.readFileSync(indexPath, 'utf8');
      const data = JSON.parse(raw);
      if (!data.docs || !data.index) return { ok: false, error: '索引格式无效' };
      this.docs.clear();
      this.index.clear();
      for (const [relPath, d] of Object.entries(data.docs)) {
        this.docs.set(relPath, {
          relPath: d.relPath,
          title: d.title,
          tags: d.tags,
          size: d.size,
          mtimeMs: d.mtimeMs,
          headings: d.headings,
          links: d.links || [],
          titleT: new Map(d.titleT),
          tagT: new Map(d.tagT),
          headT: new Map(d.headT),
          bodyT: new Map(d.bodyT),
        });
      }
      for (const [token, entries] of Object.entries(data.index)) {
        this.index.set(token, new Map(entries));
      }
      return { ok: true, docs: this.docs.size, tokens: this.index.size, savedAt: data.savedAt };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // v1.1: 增量更新——只重新索引已变更的文件
  incrementalScan() {
    const files = this._walk();
    const currentPaths = new Set();
    let added = 0, updated = 0, removed = 0;
    // 检查已有文件是否变更或被删除
    for (const [relPath, doc] of this.docs) {
      const absPath = path.join(this.notesDir, relPath.split('/').join(path.sep));
      if (!fs.existsSync(absPath)) {
        this._removeDoc(relPath);
        removed++;
        continue;
      }
      try {
        const st = fs.statSync(absPath);
        if (Math.abs(st.mtimeMs - doc.mtimeMs) > 100) {
          this._indexFile(absPath);
          updated++;
        }
      } catch {}
    }
    // 索引新增文件
    for (const absPath of files) {
      const relPath = path.relative(this.notesDir, absPath).split(path.sep).join('/');
      currentPaths.add(relPath);
      if (!this.docs.has(relPath)) {
        this._indexFile(absPath);
        added++;
      }
    }
    return { total: this.docs.size, added, updated, removed, errors: this.errors.length };
  }
// v1.3: 获取笔记引用关系图
  getLinkGraph() {
    const nodes = [];
    const edges = [];
    const nodeSet = new Set();
    for (const [relPath, doc] of this.docs) {
      if (!nodeSet.has(relPath)) {
        nodeSet.add(relPath);
        nodes.push({ id: relPath, title: doc.title, tags: doc.tags });
      }
      for (const target of (doc.links || [])) {
        if (!nodeSet.has(target)) {
          nodeSet.add(target);
          const targetDoc = this.docs.get(target);
          nodes.push({ id: target, title: targetDoc?.title || target, tags: targetDoc?.tags || [] });
        }
        edges.push({ source: relPath, target });
      }
    }
    return { nodes, edges };
  }
}

module.exports = { Indexer, parseFrontmatter, extractTitle };
