const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { tokenCountMap } = require('./tokenize');

const MD_RE = /\.md$/i;
// 支持索引的代码文件类型
const CODE_RE = /\.(js|jsx|ts|tsx|mjs|cjs|py|c|cpp|h|hpp|java|go|rs|sh|bash|zsh|json|yaml|yml|toml|xml|html|htm|css|scss|less|sql|csv|log|env|vue|svelte|rb|php|swift|kt|scala|lua|r|pl|ex|exs|erl|hs|ml|fs|clj|lisp|el|vim|proto|graphql|gql|tf|hcl|ini|cfg|conf|properties|gradle|cmake|makefile|mk)$/i;
const ALL_SUPPORTED_RE = /\.(md|pdf|txt|png|jpe?g|gif|webp|svg|docx?|xlsx?|pptx?|js|jsx|ts|tsx|mjs|cjs|py|c|cpp|h|hpp|java|go|rs|sh|bash|zsh|json|yaml|yml|toml|xml|html|htm|css|scss|less|sql|csv|log|env|gitignore|dockerignore|vue|svelte|rb|php|swift|kt|scala|lua|r|pl|ex|exs|erl|hs|ml|fs|clj|lisp|el|vim|proto|graphql|gql|tf|hcl|ini|cfg|conf|properties|gradle|cmake|makefile|mk)$/i;

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
    // 实际参与索引的根目录（多目录索引开启时为全部目录，否则仅第一个）
    this.scope = Array.isArray(opts.scope) && opts.scope.length
      ? opts.scope.map((d) => path.resolve(d))
      : [this.notesDir];
    // 去掉被其他根目录包含的子目录，避免重复索引
    this.scope = this.scope.filter(
      (d, i, arr) => !arr.some((o, j) => j !== i && d.startsWith(o + path.sep))
    );
    if (!this.scope.length) this.scope = [this.notesDir];
    // 索引 key 是否带目录名前缀（与目录树 relPath 保持一致）
    this.prefixActive = this.scope.length > 1;
    this.ignoreDirs = new Set(opts.ignoreDirs || ['.git', 'node_modules', 'img', 'images', '.obsidian']);
    this.maxSizeBytes = (opts.maxFileSizeKb || 2048) * 1024;
    this.docs = new Map();   // key -> doc
    this.index = new Map();  // token  -> Map(key -> {t,g,h,b})
    this.errors = [];
  }

  // 索引 key <-> 绝对路径；不在索引范围内的文件返回 null（不参与索引）
  keyForAbs(absPath) {
    const norm = path.resolve(absPath);
    for (const dir of this.scope) {
      if (norm !== dir && norm.startsWith(dir + path.sep)) {
        const rel = path.relative(dir, norm).split(path.sep).join('/');
        return this.prefixActive ? path.basename(dir) + '/' + rel : rel;
      }
    }
    return null;
  }

  // (笔记目录, 相对路径) -> 索引 key
  keyFor(noteDir, relPath) {
    const rel = String(relPath || '').split(path.sep).join('/');
    if (!this.prefixActive) return rel;
    const dir = this.scope.find((d) => d === path.resolve(noteDir)) || path.resolve(noteDir);
    return rel ? path.basename(dir) + '/' + rel : path.basename(dir);
  }

  // 索引 key -> 绝对路径
  absFor(key) {
    const k = String(key).split(path.sep).join('/');
    if (this.prefixActive) {
      const i = k.indexOf('/');
      const name = i === -1 ? k : k.slice(0, i);
      const rest = i === -1 ? '' : k.slice(i + 1);
      const dir = this.scope.find((d) => path.basename(d) === name);
      if (dir) return path.join(dir, rest);
    }
    return path.join(this.notesDir, k);
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
    const stack = [...this.scope];
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
        } else if (e.isFile() && ALL_SUPPORTED_RE.test(e.name)) {
          out.push(full);
        } else if (e.isSymbolicLink()) {
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
            if (visited.has(real)) continue;
            visited.add(real);
            stack.push(full);
          } else if (st.isFile() && ALL_SUPPORTED_RE.test(e.name)) {
            out.push(full);
          }
        }
      }
    }
    return out;
  }

  _parse(absPath) {
    const relPath = this.keyForAbs(absPath);
    if (!relPath) return null;
    let content;
    try {
      content = fs.readFileSync(absPath, 'utf8');
    } catch (err) {
      this.errors.push(`${relPath}: ${err.message}`);
      return null;
    }
    const isMd = MD_RE.test(absPath);
    const isCode = CODE_RE.test(absPath);
    let tags = [];
    let body = content;
    let title = '';
    let headings = [];
    let links = [];
    if (isMd) {
      const fm = parseFrontmatter(content);
      tags = fm.tags;
      body = fm.body;
      title = extractTitle(body, relPath);
      headings = buildHeadings(body);
      links = extractInternalLinks(body, relPath);
    } else if (isCode) {
      // 代码文件：从文件名提取标题，从内容中提取注释作为摘要
      title = path.basename(relPath).replace(/\.[^.]+$/, '');
      // 尝试提取文件顶部注释作为摘要
      const commentMatch = content.match(/^(?:\/\/|#|\/\*|\*|--;?|""")\s*(.+)/m);
      if (commentMatch) body = commentMatch[1].trim() + '\n' + content;
    } else {
      title = path.basename(relPath).replace(/\.[^.]+$/, '');
    }
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

  // 从缓存加载的索引不含全文（save 不持久化 body），此处按需回读并缓存
  ensureBody(relPath) {
    const doc = this.docs.get(relPath);
    if (!doc) return null;
    if (doc.body != null) return doc.body;
    try {
      const parsed = this._parse(this.absFor(relPath));
      if (parsed) doc.body = parsed.body;
    } catch (err) {
      this.errors.push(`${relPath}: ${err.message}`);
    }
    if (doc.body == null) doc.body = '';
    return doc.body;
  }

  add(absPath) {
    const relPath = this.keyForAbs(absPath);
    if (!relPath) return { relPath: null, doc: null };
    return { relPath, doc: this._indexFile(absPath) };
  }

  remove(absPath) {
    const relPath = this.keyForAbs(absPath);
    if (relPath) this._removeDoc(relPath);
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
      // 索引的根目录集合：与当前配置不一致时调用方应放弃缓存并全量重建
      scope: this.scope,
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
      return {
        ok: true,
        docs: this.docs.size,
        tokens: this.index.size,
        savedAt: data.savedAt,
        // 缓存建立时索引的根目录集合；旧版本索引没有该字段，视为 [notesDir]
        scope: Array.isArray(data.scope) ? data.scope : null,
      };
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
      const absPath = this.absFor(relPath);
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
      const relPath = this.keyForAbs(absPath);
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
      // 链接是相对笔记自身目录解析的，多目录模式下需补回目录名前缀
      const i = relPath.indexOf('/');
      const prefix = this.prefixActive && i > 0 ? relPath.slice(0, i + 1) : '';
      for (const rawTarget of (doc.links || [])) {
        const target = prefix + rawTarget;
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
