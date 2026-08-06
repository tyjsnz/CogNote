/* 知识库智能体 前端逻辑 */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const state = {
    config: null,
    tree: null,
    currentRel: null,     // 当前打开的笔记
    currentDir: '',       // 新建笔记时的默认目录
    selectedRels: [],     // 当前笔记 + 所属分类的所有笔记
    editing: false,
    searchMode: false,
    activeTag: '',
    prevRel: null,        // 新建/编辑取消时返回的原笔记
  };

  // ---------- helpers ----------
  function toast(msg, isErr) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast ' + (isErr ? 'err' : '');
    clearTimeout(el._t);
    el._t = setTimeout(() => (el.className = 'toast hidden'), 3000);
  }

  async function api(url, opts) {
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // 用于 HTML 属性选择器 [data-rel="..."] 中的字符串转义（不改变字面量）
  function escAttr(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function highlight(text, terms) {
    let out = esc(text);
    for (const t of terms) {
      if (!t) continue;
      const re = new RegExp('(' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
      out = out.replace(re, '<mark>$1</mark>');
    }
    return out;
  }

  function relDir(rel) {
    const idx = rel.lastIndexOf('/');
    return idx === -1 ? '' : rel.slice(0, idx);
  }

  function dirName(rel) {
    const d = relDir(rel);
    if (!d) return '(根目录)';
    const parts = d.split('/');
    return parts[parts.length - 1];
  }

  function relExists(rel) {
    let found = false;
    (function walk(n) {
      if (!n || found) return;
      if (n.type === 'file' && n.relPath === rel) found = true;
      else if (n.type === 'dir') n.children.forEach(walk);
    })(state.tree);
    return found;
  }

  function uniqueRel(dir, baseName) {
    const mk = (n) => (dir ? dir + '/' : '') + n + '.md';
    if (!relExists(mk(baseName))) return mk(baseName);
    for (let i = 2; i < 99; i++) {
      if (!relExists(mk(baseName + ' (' + i + ')'))) return mk(baseName + ' (' + i + ')');
    }
    return mk(baseName + '-' + Date.now());
  }

  async function fetchConfig() {
    state.config = await api('/api/config');
    const badge = $('#ai-badge');
    if (state.config.aiConfigured) {
      badge.textContent = 'AI 就绪';
      badge.className = 'badge ok';
    } else {
      badge.textContent = 'AI 未配置';
      badge.className = 'badge';
    }
  }

  async function loadStats() {
    const d = await api('/api/stats');
    $('#note-count').textContent = d.stats.total + ' 篇';
  }

  // ---------- tree ----------
  async function loadTree() {
    const d = await api('/api/tree');
    state.tree = d.tree;
    $('#tree').innerHTML = renderTree(state.tree);
  }

  function renderTree(node, depth = 0) {
    if (!node) return '';
    let html = '';
    const children = node.children || [];
    if (node.type === 'dir') {
      const open = depth < 2;
      html +=
        '<div class="tree-node dir" data-rel="' + esc(node.relPath) + '" data-type="dir">' +
        '<span class="arrow">' + (children.length ? (open ? '▾' : '▸') : '') + '</span>' +
        '<span class="icon">📁</span><span>' + esc(node.name) + '</span>' +
        (node.noteCount ? '<span class="count">' + node.noteCount + '</span>' : '') +
        '</div>';
      html +=
        '<div class="tree-children' + (open ? '' : ' collapsed') + '" data-parent="' + esc(node.relPath) + '">' +
        children.map((c) => renderTree(c, depth + 1)).join('') +
        '</div>';
    } else {
      html +=
        '<div class="tree-node file" data-rel="' + esc(node.relPath) + '" data-type="file">' +
        '<span class="arrow"></span><span class="icon">📄</span><span>' + esc(node.name.replace(/\.md$/i, '')) + '</span>' +
        '</div>';
    }
    return html;
  }

  function bindTreeEvents() {
    $('#tree').addEventListener('click', async (e) => {
      const node = e.target.closest('.tree-node');
      if (!node) return;
      if (node.dataset.type === 'dir') {
        const arrow = node.querySelector('.arrow');
        const childrenBox = document.querySelector('.tree-children[data-parent="' + escAttr(node.dataset.rel) + '"]');
        if (!childrenBox) return;
        childrenBox.classList.toggle('collapsed');
        arrow.textContent = childrenBox.classList.contains('collapsed') ? '▸' : '▾';
        if (!childrenBox.classList.contains('collapsed')) {
          state.currentDir = node.dataset.rel;
          $('#tree').querySelectorAll('.tree-node.active').forEach((n) => n.classList.remove('active'));
          node.classList.add('active');
          clearSearch();
          selectDir(node.dataset.rel);
        }
      } else {
        openNote(node.dataset.rel);
      }
    });
  }

  // ---------- 右键菜单 ----------
  function hideCtxMenu() {
    $('#ctx-menu').classList.add('hidden');
  }

  function showCtxMenu(x, y, items) {
    const menu = $('#ctx-menu');
    menu.innerHTML = items
      .map((it) =>
        it.sep
          ? '<div class="ctx-sep"></div>'
          : '<div class="ctx-item' + (it.danger ? ' danger' : '') + '" data-action="' + escAttr(it.action) + '">' + it.label + '</div>'
      )
      .join('');
    menu.classList.remove('hidden');
    const mw = menu.offsetWidth || 190;
    const mh = menu.offsetHeight || 120;
    menu.style.left = Math.max(4, Math.min(x, window.innerWidth - mw - 8)) + 'px';
    menu.style.top = Math.max(4, Math.min(y, window.innerHeight - mh - 8)) + 'px';
    menu.querySelectorAll('.ctx-item').forEach((el) =>
      el.addEventListener('click', () => {
        hideCtxMenu();
        const fn = ctxActions[el.dataset.action];
        if (fn) fn();
      })
    );
  }

  const ctxActions = {
    reveal() {
      const n = window._ctxNode;
      if (!n || n.type === 'root') return;
      api('/api/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rel: n.rel }),
      }).then(() => toast('已在资源管理器中打开: ' + n.rel)).catch((e) => toast(e.message, true));
    },
    async 'new-subfolder'() {
      const n = window._ctxNode || { type: 'root', rel: '' };
      const name = prompt('输入新分类名称：', '新分类');
      if (!name) return;
      const clean = name.replace(/[\\/:*?"<>|]/g, '_').trim();
      if (!clean) return;
      const rel = n.rel ? n.rel + '/' + clean : clean;
      await api('/api/folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rel }),
      });
      toast('已创建分类: ' + rel);
      await reloadTree();
      expandDir(n.rel);
    },
    async 'new-root'() {
      const name = prompt('输入根分类名称：', '');
      if (!name) return;
      const clean = name.replace(/[\\/:*?"<>|]/g, '_').trim();
      if (!clean) return;
      await api('/api/folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rel: clean }),
      });
      toast('已创建根分类: ' + clean);
      await reloadTree();
    },
    'new-note'() {
      const n = window._ctxNode || {};
      state.currentDir = n.type === 'root' ? '' : n.rel;
      if (state.tree) expandNodePath(n.rel);
      newNote();
    },
    edit() {
      const n = window._ctxNode;
      if (!n || n.type !== 'file') return;
      openNote(n.rel);
      openEditor();
    },
    move() {
      const n = window._ctxNode;
      if (!n || n.type !== 'file') return;
      state.currentRel = n.rel;
      openMoveDialog();
    },
    async delete() {
      const n = window._ctxNode;
      if (!n || n.type !== 'file') return;
      if (!confirm('确定删除该笔记？\n' + n.rel)) return;
      await api('/api/note/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rel: n.rel }),
      });
      toast('已删除');
      await reloadTree();
      if (state.currentRel === n.rel) state.currentRel = null;
      selectDir(state.currentDir || '');
    },
  };

  function bindContextMenu() {
    $('#tree').addEventListener('contextmenu', (e) => {
      e.preventDefault();
      hideCtxMenu();
      const node = e.target.closest('.tree-node');
      if (node) {
        const rel = node.dataset.rel;
        const isDir = node.dataset.type === 'dir';
        window._ctxNode = { type: node.dataset.type, rel };
        const items = isDir
          ? [
              { action: 'new-subfolder', label: '📁 新建子分类' },
              { action: 'new-note', label: '📄 新建笔记' },
              { action: 'reveal', label: '🔗 打开本地位置' },
            ]
          : [
              { action: 'edit', label: '✏️ 编辑' },
              { action: 'move', label: '📁 归类 / 移动' },
              { action: 'reveal', label: '🔗 打开本地位置' },
              { sep: true },
              { action: 'delete', label: '🗑️ 删除', danger: true },
            ];
        showCtxMenu(e.clientX, e.clientY, items);
      } else {
        window._ctxNode = { type: 'root', rel: '' };
        showCtxMenu(e.clientX, e.clientY, [{ action: 'new-root', label: '📁 新建根分类' }]);
      }
    });
    document.addEventListener('click', hideCtxMenu);
    document.addEventListener('contextmenu', (e) => {
      // 在目录树内右键由 #tree 处理；仅当右键点击无关区域时收起菜单
      if (!e.target.closest('#tree, #move-tree, #ctx-menu')) hideCtxMenu();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hideCtxMenu();
    });
  }

  function expandNodePath(rel) {
    if (!rel) return;
    const parts = rel.split('/');
    let cur = '';
    for (const p of parts.slice(0, -1)) {
      cur = cur ? cur + '/' + p : p;
      const box = document.querySelector('.tree-children[data-parent="' + escAttr(cur) + '"]');
      if (box && box.classList.contains('collapsed')) {
        box.classList.remove('collapsed');
        const arrow = document.querySelector('.tree-node.dir[data-rel="' + escAttr(cur) + '"] .arrow');
        if (arrow) arrow.textContent = '▾';
      }
    }
  }

  function expandDir(rel) {
    if (!rel) return;
    const box = document.querySelector('.tree-children[data-parent="' + escAttr(rel) + '"]');
    if (box && box.classList.contains('collapsed')) {
      box.classList.remove('collapsed');
      const arrow = document.querySelector('.tree-node.dir[data-rel="' + escAttr(rel) + '"] .arrow');
      if (arrow) arrow.textContent = '▾';
    }
  }

  function reloadTree() {
    return loadTree();
  }

  // ---------- tags ----------
  async function loadTags() {
    const d = await api('/api/stats');
    const box = $('#tags');
    box.innerHTML = '';
    for (const [tag, n] of d.stats.topTags) {
      const el = document.createElement('span');
      el.className = 'tag-chip';
      el.innerHTML = esc(tag) + '<span class="n">' + n + '</span>';
      el.title = '点击搜索该标签';
      el.addEventListener('click', () => searchByTag(tag, el));
      box.appendChild(el);
    }
  }

  function searchByTag(tag, el) {
    $('#tags').querySelectorAll('.tag-chip.active').forEach((c) => c.classList.remove('active'));
    if (el) el.classList.add('active');
    state.activeTag = tag;
    runSearch('#' + tag);
  }

  // ---------- note open/view ----------
  async function openNote(rel) {
    state.currentRel = rel;
    state.editing = false;
    $('#search-results').classList.add('hidden');
    $('#editor').classList.add('hidden');
    $('#viewer').classList.remove('hidden');
    $('#tree').querySelectorAll('.tree-node.active').forEach((n) => n.classList.remove('active'));
    $('#tree').querySelector('.tree-node.file[data-rel="' + escAttr(rel) + '"]')?.classList.add('active');

    const d = await api('/api/note?rel=' + encodeURIComponent(rel));
    state.currentDir = relDir(rel);
    $('#note-path').textContent = d.relPath;
    const tags = d.meta?.tags || [];
    $('#note-tags').innerHTML = tags.length
      ? tags.map((t) => '<span class="tag-chip">' + esc(t) + '</span>').join('')
      : '';
    $('#note-body').innerHTML = renderMarkdown(stripFrontmatter(d.content));
    syncSelection();
  }

  function selectDir(dirRel) {
    state.currentRel = null;
    state.prevRel = null;
    $('#search-results').classList.add('hidden');
    $('#editor').classList.add('hidden');
    $('#viewer').classList.remove('hidden');
    $('#note-tags').innerHTML = '';
    $('#note-path').textContent = dirRel || '(根目录)';
    $('#note-body').innerHTML =
      '<p class="empty">📁 分类：<b>' + esc(dirRel || '(根目录)') + '</b><br>' +
      '从左侧选择一篇笔记，或点击"＋新建"在该分类下创建笔记。</p>';
    syncSelection();
  }

  function syncSelection() {
    // 当前笔记 + 同目录笔记作为 AI 上下文
    if (state.currentRel) {
      const dir = relDir(state.currentRel);
      state.selectedRels = collectRelsInDir(state.tree, dir);
    } else if (state.currentDir !== null) {
      state.selectedRels = collectRelsInDir(state.tree, state.currentDir || '');
    } else {
      state.selectedRels = [];
    }
  }

  function collectRelsInDir(node, dirRel) {
    const out = [];
    if (!node) return out;
    if (node.type === 'file') {
      if ((dirRel === '' && !node.relPath.includes('/')) || (dirRel && node.relPath.startsWith(dirRel + '/'))) out.push(node.relPath);
      return out;
    }
    if (node.type === 'dir') {
      const isRoot = node.relPath === '';
      const isExact = node.relPath === dirRel;
      const isAncestor = dirRel.startsWith(node.relPath + '/');
      if (isRoot || isExact || isAncestor) {
        for (const c of node.children) out.push(...collectRelsInDir(c, dirRel));
      }
      return out;
    }
    return out;
  }

  function stripFrontmatter(content) {
    const m = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
    return m ? content.slice(m[0].length) : content;
  }

  // ---------- editor ----------
  let vditor = null;

  function ensureVditor() {
    if (vditor) return Promise.resolve(vditor);
    return new Promise((resolve, reject) => {
      try {
        vditor = new Vditor('vditor-wrap', {
          height: 'auto',
          minHeight: 460,
          mode: 'ir',
          theme: 'light',
          lang: 'zh_CN',
          cdn: '/vendor/vditor',
          cache: { enable: false },
          toolbar: [
            'undo', 'redo', '|',
            'headings', 'bold', 'italic', 'strike', '|',
            'list', 'ordered-list', 'check', '|',
            'quote', 'line', 'code', 'inline-code', '|',
            'table', 'link', '|',
            'emoji', '|',
            'edit-mode', 'both', 'preview', 'fullscreen', '|',
            'outline', 'export',
          ],
          preview: {
            theme: { current: 'light' },
            hljs: { lineNumber: true, style: 'github', enable: true },
            markdown: { toc: true, mark: true, footnote: true },
            math: { engine: 'KaTeX', inlineDigit: true },
            diagram: true,
          },
          after() {
            resolve(vditor);
          },
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function openEditor() {
    if (!state.currentRel && !state.currentDir) {
      toast('请先选择一篇笔记或分类', true);
      return;
    }
    state.editing = true;
    $('#viewer').classList.add('hidden');
    $('#search-results').classList.add('hidden');
    $('#editor').classList.remove('hidden');

    ensureVditor().then(() => {
      if (state.currentRel) {
        api('/api/note?rel=' + encodeURIComponent(state.currentRel)).then((d) => {
          const fm = parseFrontmatter(d.content);
          $('#edit-title').value = fm.title || '';
          $('#edit-tags').value = (fm.tags || []).join(', ');
          vditor.setValue(fm.body);
        });
      } else {
        $('#edit-title').value = '';
        $('#edit-tags').value = '';
        vditor.setValue('# 新笔记\n\n');
        $('#edit-title').focus();
      }
    });
  }

  function parseFrontmatter(content) {
    const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!m) return { tags: [], body: content };
    const fm = m[1];
    const tm = fm.match(/^tags:\s*\[?([^\]]*?)\]?$/m);
    const tags = tm
      ? tm[1]
          .split(/[,，\s]+/)
          .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
          .filter(Boolean)
      : [];
    return { tags, body: content.slice(m[0].length) };
  }

  async function saveNote() {
    const title = $('#edit-title').value.trim();
    const tags = $('#edit-tags').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    let body = vditor ? vditor.getValue() : '';

    let newRel;
    if (state.currentRel) {
      newRel = state.currentRel;
      state.prevRel = null;
    } else {
      const name = (title || '未命名笔记').replace(/[\\/:*?"<>|]/g, '_');
      newRel = uniqueRel(state.currentDir || '', name);
    }

    let content;
    const header = title && !/^\s*#\s+/.test(body) ? '# ' + title + '\n\n' : '';
    if (tags.length) {
      content = '---\ntags: [' + tags.map((t) => '"' + t.replace(/"/g, '') + '"').join(', ') + ']\n---\n\n' + header + body;
    } else {
      content = header + body;
    }

    await api('/api/note', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rel: newRel, content }),
    });
    toast('已保存: ' + newRel);
    await Promise.all([loadTree(), loadTags(), loadStats()]);
    await openNote(newRel);
  }

  function cancelEdit() {
    state.editing = false;
    $('#editor').classList.add('hidden');
    if (state.currentRel) {
      openNote(state.currentRel);
    } else if (state.prevRel) {
      const p = state.prevRel;
      state.prevRel = null;
      openNote(p);
    } else {
      selectDir(state.currentDir || '');
    }
  }

  // ---------- new / move / delete ----------
  async function newNote() {
    state.prevRel = state.currentRel || state.prevRel; // 记住之前在看的笔记，取消时返回
    state.currentRel = null;                            // 新建模式：保存时创建新文件
    state.editing = true;
    $('#search-results').classList.add('hidden');
    $('#editor').classList.remove('hidden');
    $('#viewer').classList.add('hidden');
    $('#edit-title').value = '';
    $('#edit-tags').value = '';
    ensureVditor().then(() => {
      vditor.setValue('# 新笔记\n\n');
      $('#edit-title').focus();
    });
  }

  async function openMoveDialog() {
    if (!state.currentRel) {
      toast('请先选择一篇笔记', true);
      return;
    }
    const d = await api('/api/tree');
    $('#move-src').textContent = state.currentRel;
    const box = $('#move-tree');
    box.innerHTML = renderMoveTree(d.tree);
    $('#dialog-move').classList.remove('hidden');
    window._moveTarget = '';
    bindMoveTree(box, state.tree);
  }

  function renderMoveTree(node, depth = 0) {
    if (!node) return '';
    let html = '';
    const children = node.children || [];
    if (node.type === 'dir') {
      const open = depth < 2;
      html +=
        '<div class="tree-node dir" data-rel="' + esc(node.relPath) + '" data-type="dir">' +
        '<span class="arrow">' + (children.length ? (open ? '▾' : '▸') : '') + '</span>' +
        '<span class="icon">📁</span><span>' + esc(node.name) + '</span>' +
        '</div>';
      html +=
        '<div class="tree-children' + (open ? '' : ' collapsed') + '" data-parent="' + esc(node.relPath) + '">' +
        children.map((c) => renderMoveTree(c, depth + 1)).join('') +
        '</div>';
    }
    return html;
  }

  function bindMoveTree(container, tree) {
    container.addEventListener('click', (e) => {
      const node = e.target.closest('.tree-node');
      if (!node || node.dataset.type !== 'dir') return;
      const arrow = node.querySelector('.arrow');
      const childrenBox = document.querySelector('#move-tree .tree-children[data-parent="' + escAttr(node.dataset.rel) + '"]');
      if (childrenBox) {
        childrenBox.classList.toggle('collapsed');
        arrow.textContent = childrenBox.classList.contains('collapsed') ? '▸' : '▾';
      }
      container.querySelectorAll('.tree-node.dir.active').forEach((n) => n.classList.remove('active'));
      node.classList.add('active');
      window._moveTarget = node.dataset.rel;
    });
  }

  async function confirmMove() {
    if (!state.currentRel) return;
    const target = window._moveTarget || '';
    const name = state.currentRel.split('/').pop();
    const to = target ? target + '/' + name : name;
    if (to === state.currentRel) {
      toast('位置未变化');
      $('#dialog-move').classList.add('hidden');
      return;
    }
    await api('/api/note/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: state.currentRel, to }),
    });
    toast('已移动 → ' + to);
    $('#dialog-move').classList.add('hidden');
    await Promise.all([loadTree(), loadTags(), loadStats()]);
    await openNote(to);
  }

  async function deleteNote() {
    if (!state.currentRel) return;
    if (!confirm('确定删除该笔记？\n' + state.currentRel)) return;
    await api('/api/note/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rel: state.currentRel }),
    });
    toast('已删除');
    state.currentRel = null;
    await Promise.all([loadTree(), loadTags(), loadStats()]);
    selectDir(state.currentDir || '');
  }

  // ---------- search ----------
  async function runSearch(q) {
    const d = await api('/api/search?q=' + encodeURIComponent(q));
    $('#viewer').classList.add('hidden');
    $('#editor').classList.add('hidden');
    $('#search-results').classList.remove('hidden');
    $('#results-title').textContent = '“' + q + '” 共 ' + d.total + ' 条结果';
    const terms = d.query.trim().split(/\s+/).filter(Boolean);
    $('#results-list').innerHTML = d.results.length
      ? d.results
          .map((r) => {
            const pathHtml = highlight(r.relPath, terms);
            const title = r.title || r.relPath;
            const t = terms.length ? highlight(title, terms) : esc(title);
            const snippet = r.snippet ? highlight(r.snippet, terms) : '';
            return (
              '<div class="result-item" data-rel="' + esc(r.relPath) + '">' +
              '<h4>' + t + '</h4>' +
              '<div class="path">' + pathHtml + '</div>' +
              (snippet ? '<div class="snippet">' + snippet + '</div>' : '') +
              '<div class="meta">' +
              (r.tags.length ? '🏷 ' + r.tags.map(esc).join(', ') + ' · ' : '') +
              '相关度 <span class="hl-score">' + r.score + '</span>' +
              '</div>' +
              '</div>'
            );
          })
          .join('')
      : '<p class="empty">没有匹配的笔记，换几个关键词试试。</p>';
    document.querySelectorAll('.result-item').forEach((el) =>
      el.addEventListener('click', () => {
        state.currentRel = el.dataset.rel;
        openNote(el.dataset.rel);
      })
    );
  }

  function clearSearch() {
    state.searchMode = false;
    $('#search-results').classList.add('hidden');
  }

  // ---------- AI ----------
  function aiLoading(boxId, msg) {
    const box = $(boxId);
    box.className = 'ai-out';
    box.innerHTML = '<div class="loading">⏳ ' + esc(msg) + '...</div>';
    return box;
  }

  function aiError(box, err) {
    box.className = 'ai-out error';
    box.innerHTML = '⚠️ ' + esc(err.message || String(err));
  }

  async function aiClassify() {
    if (!state.currentRel) return toast('请先选择一篇笔记', true);
    const box = aiLoading('#ai-classify-out', 'AI 正在分析归类');
    try {
      const d = await api('/api/classify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rel: state.currentRel }),
      });
      box.className = 'ai-out done';
      box.innerHTML =
        '<b>建议分类：</b>' + esc(d.category || '—') + '<br>' +
        '<b>建议标签：</b>' + (d.tags?.length ? d.tags.map(esc).join(', ') : '—') + '<br>' +
        '<b>摘要：</b>' + esc(d.summary || '—') + '<br>' +
        '<b>关键词：</b>' + (d.keywords?.length ? d.keywords.map(esc).join(', ') : '—');
    } catch (e) {
      aiError(box, e);
    }
  }

  async function aiExpand(mode) {
    if (!state.currentRel) return toast('请先选择一篇笔记', true);
    const prompt = $('#ai-expand-prompt').value.trim();
    const box = aiLoading('#ai-expand-out', 'AI 正在扩展知识（可耗时较久）');
    try {
      const d = await api('/api/expand', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rel: state.currentRel, prompt }),
      });
      const text = d.markdown.replace(/^```(?:markdown)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
      if (mode === 'append') {
        const note = await api('/api/note?rel=' + encodeURIComponent(state.currentRel));
        const newContent = note.content.endsWith('\n') ? note.content + '\n' + text : note.content + '\n\n' + text;
        await api('/api/note', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rel: state.currentRel, content: newContent }),
        });
        box.className = 'ai-out done';
        box.innerHTML = '✅ 已追加到当前笔记。<div class="ai-out-inner">' + renderMarkdown(text) + '</div>';
        await openNote(state.currentRel);
      } else {
        const base = state.currentRel.replace(/\.md$/i, '');
        const newRel = base + '·扩展.md';
        await api('/api/note', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rel: newRel, content: text }),
        });
        box.className = 'ai-out done';
        box.innerHTML = '✅ 已生成新笔记：' + esc(newRel);
        await Promise.all([loadTree(), loadStats()]);
      }
    } catch (e) {
      aiError(box, e);
    }
  }

  async function aiSummary() {
    if (!state.currentRel) return toast('请先选择一篇笔记', true);
    const box = aiLoading('#ai-review-out', 'AI 正在生成复习摘要');
    try {
      const d = await api('/api/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rel: state.currentRel }),
      });
      box.className = 'ai-out done';
      box.innerHTML = renderMarkdown(d.markdown.replace(/^```(?:markdown)?\s*\n?/i, '').replace(/\n?```\s*$/, ''));
    } catch (e) {
      aiError(box, e);
    }
  }

  async function aiQuiz() {
    if (!state.currentRel) return toast('请先选择一篇笔记', true);
    const box = aiLoading('#ai-review-out', 'AI 正在生成自测题');
    try {
      const d = await api('/api/quiz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rels: state.selectedRels.length ? state.selectedRels : [state.currentRel], count: 5 }),
      });
      box.className = 'ai-out done';
      box.innerHTML = renderMarkdown(d.markdown.replace(/^```(?:markdown)?\s*\n?/i, '').replace(/\n?```\s*$/, ''));
    } catch (e) {
      aiError(box, e);
    }
  }

  async function aiAsk() {
    const q = $('#ai-ask-question').value.trim();
    if (!q) return toast('请输入问题', true);
    if (!state.selectedRels.length) return toast('请先选择笔记或分类', true);
    const box = aiLoading('#ai-ask-out', 'AI 正在检索并回答');
    try {
      const d = await api('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rels: state.selectedRels, question: q }),
      });
      box.className = 'ai-out done';
      box.innerHTML = renderMarkdown(d.answer.replace(/^```(?:markdown)?\s*\n?/i, '').replace(/\n?```\s*$/, ''));
    } catch (e) {
      aiError(box, e);
    }
  }

  // ---------- settings ----------
  function openSettings() {
    $('#cfg-notesdir').value = state.config.notesDir;
    $('#cfg-model').value = state.config.deepseek.model;
    $('#cfg-apikey').value = '';
    $('#dialog-settings').classList.remove('hidden');
  }

  async function saveSettings() {
    const body = {
      notesDir: $('#cfg-notesdir').value.trim(),
      deepseek: {
        apiKey: $('#cfg-apikey').value.trim(),
        model: $('#cfg-model').value.trim(),
      },
    };
    if (!body.deepseek.apiKey) delete body.deepseek.apiKey;
    await api('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    toast('设置已保存，索引已重建');
    $('#dialog-settings').classList.add('hidden');
    await fetchConfig();
    await Promise.all([loadTree(), loadTags(), loadStats()]);
  }

  // ---------- bindings ----------
  function bindEvents() {
    $('#search-btn').addEventListener('click', () => {
      const q = $('#search-input').value.trim();
      if (q) runSearch(q);
    });
    $('#search-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const q = $('#search-input').value.trim();
        if (q) runSearch(q);
      }
    });
    $('#btn-clear-search').addEventListener('click', () => {
      $('#search-input').value = '';
      clearSearch();
      if (state.currentRel) openNote(state.currentRel);
      else selectDir(state.currentDir || '');
    });
    $('#btn-rescan').addEventListener('click', async () => {
      toast('正在重新扫描...');
      await api('/api/rescan', { method: 'POST' });
      await Promise.all([loadTree(), loadTags(), loadStats()]);
      toast('重新扫描完成');
    });

    $('#btn-edit').addEventListener('click', openEditor);
    $('#btn-new').addEventListener('click', newNote);
    $('#btn-move').addEventListener('click', openMoveDialog);
    $('#btn-delete').addEventListener('click', deleteNote);

    $('#btn-save').addEventListener('click', saveNote);
    $('#btn-cancel-edit').addEventListener('click', cancelEdit);

    $('#btn-ai-classify').addEventListener('click', aiClassify);
    $('#btn-ai-expand-append').addEventListener('click', () => aiExpand('append'));
    $('#btn-ai-expand-new').addEventListener('click', () => aiExpand('new'));
    $('#btn-ai-summary').addEventListener('click', aiSummary);
    $('#btn-ai-quiz').addEventListener('click', aiQuiz);
    $('#btn-ai-ask').addEventListener('click', aiAsk);

    $('#btn-settings').addEventListener('click', (e) => {
      e.preventDefault();
      openSettings();
    });
    $('#btn-settings-ok').addEventListener('click', saveSettings);
    $('#btn-settings-cancel').addEventListener('click', () => $('#dialog-settings').classList.add('hidden'));

    $('#btn-move-cancel').addEventListener('click', () => $('#dialog-move').classList.add('hidden'));
    $('#btn-move-ok').addEventListener('click', confirmMove);

    document.querySelectorAll('.modal').forEach((m) =>
      m.addEventListener('click', (e) => {
        if (e.target === m) m.classList.add('hidden');
      })
    );
  }

  // ---------- init ----------
  async function init() {
    bindEvents();
    bindTreeEvents();
    bindContextMenu();
    await fetchConfig();
    try {
      await Promise.all([loadTree(), loadTags(), loadStats()]);
    } catch (e) {
      toast('加载失败: ' + e.message, true);
    }
    selectDir('');
  }

  init();
})();