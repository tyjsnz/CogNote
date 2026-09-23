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
    reviewMode: false,    // 复习模式：打开笔记后显示评分面板
  };

  // ---------- 界面状态持久化（折叠/当前笔记/目录开关）----------
  function loadUI() {
    const base = { expanded: new Set(), view: null, coverOn: true, aiCollapsed: true };
    try {
      const raw = localStorage.getItem('kb.ui');
      if (raw) {
        const o = JSON.parse(raw);
        return {
          expanded: new Set(Array.isArray(o.expanded) ? o.expanded : []),
          view: o.view || null,
          coverOn: o.coverOn !== false,
          aiCollapsed: o.aiCollapsed !== false,
        };
      }
    } catch (e) { /* ignore */ }
    return base;
  }

  let ui = loadUI();

  function saveUI() {
    try {
      localStorage.setItem('kb.ui', JSON.stringify({
        expanded: [...ui.expanded],
        view: ui.view,
        coverOn: ui.coverOn,
        aiCollapsed: ui.aiCollapsed,
      }));
    } catch (e) { /* ignore */ }
  }

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

  // 统计节点（含递归子节点）下的笔记文件数量
  function countFiles(node) {
    if (!node) return 0;
    if (node.type === 'file') return 1 + (node.children || []).reduce((a, c) => a + countFiles(c), 0);
    return (node.children || []).reduce((a, c) => a + countFiles(c), 0);
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
    const provider = (state.config.ai?.provider || 'deepseek').toUpperCase();
    if (state.config.aiConfigured) {
      badge.textContent = 'AI: ' + provider;
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
  function seedExpanded(node, depth = 0) {
    if (!node || node.type !== 'dir') return;
    if (depth < 2) ui.expanded.add(node.relPath);
    (node.children || []).forEach((c) => seedExpanded(c, depth + 1));
  }

  function pruneExpanded(node) {
    // 仅保留树中仍然存在的可展开节点（目录或带子笔记的笔记）
    const valid = new Set();
    (function walk(n) {
      if (!n) return;
      if ((n.children || []).length) valid.add(n.relPath);
      (n.children || []).forEach(walk);
    })(node);
    for (const rel of [...ui.expanded]) {
      if (rel && !valid.has(rel)) ui.expanded.delete(rel);
    }
  }

  async function loadTree() {
    const d = await api('/api/tree');
    state.tree = d.tree;
    if (!ui.expanded.size) seedExpanded(d.tree);
    pruneExpanded(d.tree);
    $('#tree').innerHTML = renderTree(state.tree);
  }

  function renderTree(node, depth = 0) {
    if (!node) return '';
    let html = '';
    const children = node.children || [];
    const isDir = node.type === 'dir';
    const rel = node.relPath;
    const branch = children.length > 0;
    const open = branch && (isDir ? (ui.expanded.size ? ui.expanded.has(rel) : depth < 2) : ui.expanded.has(rel));
    html +=
      '<div class="tree-node ' + (isDir ? 'dir' : 'file') + '" data-rel="' + esc(rel) + '" data-type="' + (isDir ? 'dir' : 'file') + '">' +
      '<span class="arrow">' + (branch ? (open ? '▾' : '▸') : '') + '</span>' +
      '<span class="icon">' + (isDir ? '📁' : '📄') + '</span>' +
      '<span>' + esc(isDir ? node.name : node.name.replace(/\.md$/i, '')) + '</span>' +
      (isDir && node.noteCount ? '<span class="count">' + node.noteCount + '</span>' : '') +
      '</div>';
    if (branch) {
      html +=
        '<div class="tree-children' + (open ? '' : ' collapsed') + '" data-parent="' + esc(rel) + '">' +
        children.map((c) => renderTree(c, depth + 1)).join('') +
        '</div>';
    }
    return html;
  }

  function bindTreeEvents() {
    $('#tree').addEventListener('click', async (e) => {
      const node = e.target.closest('.tree-node');
      if (!node) return;
      const rel = node.dataset.rel;
      const type = node.dataset.type;
      const childrenBox = document.querySelector('.tree-children[data-parent="' + escAttr(rel) + '"]');
      if (type === 'dir' && !childrenBox) {
        state.currentDir = rel;
        $('#tree').querySelectorAll('.tree-node.active').forEach((n) => n.classList.remove('active'));
        node.classList.add('active');
        clearSearch();
        selectDir(rel);
        return;
      }
      if (childrenBox) {
        if (type === 'file' && !e.target.closest('.arrow')) {
          openNote(rel);
          return;
        }
        const isCollapsed = childrenBox.classList.toggle('collapsed');
        const arrow = node.querySelector('.arrow');
        arrow.textContent = isCollapsed ? '▸' : '▾';
        if (isCollapsed) ui.expanded.delete(rel);
        else ui.expanded.add(rel);
        saveUI();
        if (type === 'dir' && !isCollapsed) {
          state.currentDir = rel;
          $('#tree').querySelectorAll('.tree-node.active').forEach((n) => n.classList.remove('active'));
          node.classList.add('active');
          clearSearch();
          selectDir(rel);
        }
        return;
      }
      if (type === 'dir') {
        state.currentDir = rel;
        $('#tree').querySelectorAll('.tree-node.active').forEach((n) => n.classList.remove('active'));
        node.classList.add('active');
        clearSearch();
        selectDir(rel);
      } else {
        openNote(rel);
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
      const { rel, dir } = stripDirPrefix(n.rel);
      api('/api/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rel, dir }),
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
    async 'delete-folder'() {
      const n = window._ctxNode;
      if (!n || n.type !== 'dir') return;
      if (!confirm('确定删除空分类？\n' + n.rel)) return;
      try {
        await api('/api/folder', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rel: n.rel }),
        });
        toast('已删除分类: ' + n.rel);
        if (state.currentDir === n.rel) state.currentDir = relDir(n.rel);
        await reloadTree();
        selectDir(state.currentDir || '');
      } catch (e) {
        toast(e.message, true);
      }
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
    async 'new-sub-note'() {
      const n = window._ctxNode;
      if (!n || n.type !== 'file') return;
      const base = n.rel.replace(/\.md$/i, '');
      const name = prompt('输入子笔记名称：', '子笔记');
      if (name === null) return;
      const clean = name.replace(/[\\/:*?"<>|]/g, '_').trim();
      if (!clean) return;
      const rel = base + '/' + clean + '.md';
      await api('/api/note', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rel, content: '# ' + clean + '\n\n' }),
      });
      toast('已创建子笔记: ' + rel);
      await reloadTree();
      expandNodePath(rel);
      state.currentRel = rel;
      await openNote(rel);
      openEditor();
    },
    move() {
      const n = window._ctxNode;
      if (!n || n.type !== 'file') return;
      const { rel } = stripDirPrefix(n.rel);
      state.currentRel = rel;
      openMoveDialog();
    },
    async 'export-pdf'() {
      const n = window._ctxNode;
      if (!n || n.type !== 'file') return;
      const win = window.open('', '_blank');
      if (!win) {
        toast('浏览器拦截了弹出窗口，请允许弹窗后重试', true);
        return;
      }
      const base = location.href.slice(0, location.href.lastIndexOf('/') + 1);
      const printCss = [
        '@page { margin: 18mm 14mm }',
        '* { box-sizing: border-box }',
        'html,body { margin: 0; padding: 0 }',
        'body { font-family: "Microsoft YaHei","PingFang SC","HarmonyOS Sans SC","Noto Sans CJK SC",sans-serif; color: #1f2328; line-height: 1.75; font-size: 15px; }',
        '.toolbar { position: fixed; top: 12px; right: 16px; z-index: 99; display: flex; gap: 8px; align-items: center; }',
        '.toolbar button { font: 14px/1.6 "Microsoft YaHei",sans-serif; padding: 6px 14px; border: 1px solid #ccc; border-radius: 6px; background: #fff; cursor: pointer; }',
        '.toolbar button:hover { background: #f0f0f0 }',
        '.page { max-width: 840px; margin: 0 auto; padding: 48px 32px 64px; }',
        '.note-title { font-size: 26px; font-weight: 700; line-height: 1.4; margin: 0 0 6px; }',
        '.note-path { color: #8a9199; font-size: 13px; margin-bottom: 22px; }',
        'h1,h2,h3,h4,h5,h6 { line-height: 1.4; margin: 1.4em 0 0.6em; font-weight: 600; }',
        'h1 { font-size: 22px } h2 { font-size: 19px; border-bottom: 1px solid #ececec; padding-bottom: 6px }',
        'h3 { font-size: 17px } h4 { font-size: 16px }',
        'p { margin: 0.6em 0 }',
        'a { color: #0366d6; text-decoration: none }',
        'img { max-width: 100%; height: auto }',
        'pre { background: #f6f8fa; border: 1px solid #e4e6ea; border-radius: 6px; padding: 12px 14px; overflow-x: auto; }',
        'pre code { font-family: Consolas,"Courier New",monospace; font-size: 13px; line-height: 1.6; }',
        'code { font-family: Consolas,"Courier New",monospace; background: #f3f4f6; padding: 1px 5px; border-radius: 4px; font-size: 13px; }',
        'pre code { background: none; padding: 0 }',
        'blockquote { margin: 0.8em 0; padding: 6px 16px; border-left: 4px solid #dfe2e5; color: #57606a; background: #fafbfc; }',
        'blockquote p { margin: 0.4em 0 }',
        'table { border-collapse: collapse; margin: 0.8em 0; width: 100%; }',
        'th,td { border: 1px solid #d0d7de; padding: 6px 10px; font-size: 14px; text-align: left; }',
        'th { background: #f6f8fa; font-weight: 600 }',
        'ul,ol { padding-left: 1.6em; margin: 0.5em 0 }',
        'li { margin: 0.25em 0 }',
        'del { color: #8a9199 }',
        'sup { font-size: 0.75em }',
        '.math-block { margin: 0.8em 0; overflow-x: auto; }',
        '@media print { body { font-size: 12pt } .toolbar { display: none } .page { max-width: none; padding: 0 } .note-path { display: block } h2 { page-break-after: avoid } pre,blockquote,table,img { page-break-inside: avoid } }'
      ].join('\n');
      win.document.open();
      win.document.write(
        '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
        '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/katex.min.css">' +
        '<title>导出 PDF…</title><style>' + printCss + '</style></head><body>' +
        '<div class="toolbar"><button onclick="window.focus();window.print();">⬇ 导出 PDF</button></div>' +
        '<div class="page"><div id="pdf-body">加载中…</div></div></body></html>'
      );
      win.document.close();
      let d;
      const nRel = stripDirPrefix(n.rel);
      try {
        d = await api('/api/note?rel=' + encodeURIComponent(nRel.rel) + (nRel.dir ? '&dir=' + encodeURIComponent(nRel.dir) : ''));
      } catch (e) {
        const b = win.document.getElementById('pdf-body');
        if (b) b.textContent = '导出失败：' + e.message;
        toast(e.message, true);
        return;
      }
      const title = (d.meta && d.meta.title) || String(n.rel).split('/').pop().replace(/\.md$/i, '');
      win.document.title = title;
      const body = win.document.getElementById('pdf-body');
      if (!body) { win.close(); return; }
      body.innerHTML =
        '<div class="note-title">' + esc(title) + '</div>' +
        '<div class="note-path">' + esc(n.rel) + '</div>' +
        renderMarkdown(stripFrontmatter(d.content));
      try { win.print(); } catch (e) { /* 部分浏览器需手动点击导出按钮 */ }
    },
    async rename() {
      const n = window._ctxNode;
      if (!n || n.type !== 'file') return;
      const oldName = n.rel.split('/').pop();
      const dir = n.rel.includes('/') ? n.rel.slice(0, n.rel.lastIndexOf('/')) : '';
      const base = oldName.replace(/\.md$/i, '');
      const name = prompt('重命名文件：', base);
      if (name === null) return;
      const clean = name.replace(/[\\/:*?"<>|]/g, '_').trim();
      if (!clean) return;
      const newName = /\.md$/i.test(clean) ? clean : clean + '.md';
      const to = dir ? dir + '/' + newName : newName;
      if (to === n.rel) {
        toast('文件名未变化');
        return;
      }
      try {
        await api('/api/note/move', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: n.rel, to }),
        });
        toast('已重命名 → ' + to);
        await Promise.all([loadTree(), loadTags(), loadStats()]);
        if (state.currentRel === n.rel) await openNote(to);
      } catch (e) {
        toast(e.message, true);
      }
    },
    async delete() {
      const n = window._ctxNode;
      if (!n || n.type !== 'file') return;
      const subNum = countFiles(n) - 1;
      const msg = subNum > 0
        ? '确定删除该笔记？\n' + n.rel + '\n\n其下还有 ' + subNum + ' 个子笔记，将连同其子笔记目录一并删除！'
        : '确定删除该笔记？\n' + n.rel;
      if (!confirm(msg)) return;
      const { rel: delRel } = stripDirPrefix(n.rel);
      await api('/api/note/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rel: delRel }),
      });
      toast(subNum > 0 ? '已删除（含子笔记）' : '已删除');
      await reloadTree();
      if (state.currentRel === delRel) state.currentRel = null;
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
              { action: 'new-sub-note', label: '📚 新建子笔记' },
              { action: 'rename', label: '✏️ 重命名' },
              { action: 'move', label: '📁 归类 / 移动' },
              { action: 'export-pdf', label: '📄 导出 PDF' },
              { action: 'reveal', label: '🔗 打开本地位置' },
              { sep: true },
              { action: 'delete', label: '🗑️ 删除', danger: true },
            ];
        if (isDir) {
          const box = document.querySelector('.tree-children[data-parent="' + escAttr(rel) + '"]');
          const isEmpty = !box || box.children.length === 0;
          if (isEmpty) items.push({ sep: true }, { action: 'delete-folder', label: '🗑️ 删除分类（空目录）', danger: true });
        }
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
        const arrow = document.querySelector('.tree-node[data-rel="' + escAttr(cur) + '"] .arrow');
        if (arrow) arrow.textContent = '▾';
        ui.expanded.add(cur);
        saveUI();
      }
    }
  }

  function expandDir(rel) {
    if (!rel) return;
    const box = document.querySelector('.tree-children[data-parent="' + escAttr(rel) + '"]');
    if (box && box.classList.contains('collapsed')) {
      box.classList.remove('collapsed');
      const arrow = document.querySelector('.tree-node[data-rel="' + escAttr(rel) + '"] .arrow');
      if (arrow) arrow.textContent = '▾';
      ui.expanded.add(rel);
      saveUI();
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
  // ---------- 多目录前缀处理 ----------
  function stripDirPrefix(treeRel) {
    if (!treeRel || !state.config?.notesDirs?.length) return { rel: treeRel, dir: '' };
    const dirs = state.config.notesDirs || [];
    for (const dir of dirs) {
      const dirName = dir.replace(/^.*[/\\]/, '');
      if (treeRel === dirName) return { rel: '', dir };
      if (treeRel.startsWith(dirName + '/')) return { rel: treeRel.slice(dirName.length + 1), dir };
    }
    return { rel: treeRel, dir: '' };
  }

  function noteApiUrl(base, rel) {
    const d = state.currentNoteDir || '';
    return base + '?rel=' + encodeURIComponent(rel || state.currentRel) + (d ? '&dir=' + encodeURIComponent(d) : '');
  }

  // ---------- 复习计划管理 ----------
  async function checkReviewEnrollStatus(rel) {
    try {
      const d = await api('/api/review/status?rel=' + encodeURIComponent(rel));
      return d.enrolled;
    } catch {
      return false;
    }
  }

  async function updateReviewEnrollButton(rel) {
    const btn = $('#btn-review-enroll');
    if (!btn || !rel) return;
    const enrolled = await checkReviewEnrollStatus(rel);
    btn.textContent = enrolled ? '📚 移出复习' : '📚 加入复习';
    btn.title = enrolled ? '从复习计划中移除' : '加入复习计划';
    btn.dataset.enrolled = enrolled ? 'true' : 'false';
  }

  async function toggleReviewEnroll(rel) {
    if (!rel) return;
    try {
      const enrolled = await checkReviewEnrollStatus(rel);
      if (enrolled) {
        await api('/api/review/unenroll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rel }),
        });
        toast('已从复习计划中移除');
      } else {
        await api('/api/review/enroll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rel }),
        });
        toast('已加入复习计划');
      }
      await updateReviewEnrollButton(rel);
    } catch (e) {
      toast('操作失败: ' + e.message, true);
    }
  }

  async function openNote(treeRel) {
    const { rel, dir } = stripDirPrefix(treeRel);
    state.currentRel = rel;
    state.currentNoteDir = dir;
    state.editing = false;
    $('#search-results').classList.add('hidden');
    $('#editor').classList.add('hidden');
    $('#viewer').classList.remove('hidden');
    $('#tree').querySelectorAll('.tree-node.active').forEach((n) => n.classList.remove('active'));
    $('#tree').querySelector('.tree-node.file[data-rel="' + escAttr(treeRel) + '"]')?.classList.add('active');
    const fileUrl = '/api/file?rel=' + encodeURIComponent(rel) + (dir ? '&dir=' + encodeURIComponent(dir) : '');
    state.currentDir = relDir(treeRel);
    $('#note-path').textContent = treeRel;
    $('#note-tags').innerHTML = '';
    // PDF
    if (/\.pdf$/i.test(treeRel)) {
      $('#note-body').innerHTML =
        '<div class="pdf-viewer">' +
        '<iframe src="' + fileUrl + '" title="' + esc(treeRel) + '" allow="fullscreen"></iframe>' +
        '</div>';
      ui.view = { type: 'note', rel: treeRel };
      saveUI();
      renderCover();
      syncSelection();
      return;
    }
    // 图片
    if (/\.(png|jpe?g|gif|webp|svg)$/i.test(treeRel)) {
      $('#note-body').innerHTML = '<div style="padding:16px;text-align:center"><img src="' + fileUrl + '" alt="' + esc(treeRel) + '" style="max-width:100%;height:auto;border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,.1)"></div>';
      ui.view = { type: 'note', rel: treeRel };
      saveUI();
      renderCover();
      syncSelection();
      return;
    }
    // 文本文件
    if (/\.txt$/i.test(treeRel)) {
      try {
        const r = await fetch(fileUrl);
        const text = await r.text();
        $('#note-body').innerHTML = '<pre style="background:var(--code-bg);padding:16px;border-radius:8px;overflow-x:auto;line-height:1.6;font-size:14px;white-space:pre-wrap;word-break:break-word">' + esc(text) + '</pre>';
      } catch (e) {
        $('#note-body').innerHTML = '<p class="empty" style="color:var(--danger)">读取失败：' + esc(e.message) + '</p>';
      }
      ui.view = { type: 'note', rel: treeRel };
      saveUI();
      renderCover();
      syncSelection();
      return;
    }
    // 代码文件
    if (/\.(js|jsx|ts|tsx|mjs|cjs|py|c|cpp|h|hpp|java|go|rs|sh|bash|zsh|json|yaml|yml|toml|xml|html|htm|css|scss|less|sql|csv|log|env|vue|svelte|rb|php|swift|kt|scala|lua|r|pl|ex|exs|erl|hs|ml|fs|clj|lisp|el|vim|proto|graphql|gql|tf|hcl|ini|cfg|conf|properties|gradle|cmake|makefile|mk)$/i.test(treeRel)) {
      try {
        const r = await fetch(fileUrl);
        const text = await r.text();
        const ext = treeRel.split('.').pop().toLowerCase();
        const langMap = { js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', sh: 'bash', bash: 'bash', zsh: 'bash', yml: 'yaml', h: 'c', hpp: 'cpp', rb: 'ruby', ex: 'elixir', exs: 'elixir', hs: 'haskell', clj: 'clojure', gql: 'graphql', tf: 'hcl', hcl: 'hcl', makefile: 'makefile', mk: 'makefile' };
        const lang = langMap[ext] || ext;
        let highlighted = esc(text);
        if (typeof hljs !== 'undefined') {
          try {
            if (hljs.getLanguage(lang)) {
              highlighted = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
            } else {
              highlighted = hljs.highlightAuto(text).value;
            }
          } catch {}
        }
        const lines = highlighted.split('\n');
        const lineNumbers = lines.map((_, i) => '<span class="code-line-num">' + (i + 1) + '</span>').join('\n');
        const codeContent = lines.join('\n');
        $('#note-body').innerHTML =
          '<div class="code-viewer">' +
          '<div class="code-header">' +
          '<span class="code-filename">' + esc(treeRel.split('/').pop()) + '</span>' +
          '<span class="code-lang">' + lang.toUpperCase() + '</span>' +
          '</div>' +
          '<div class="code-body">' +
          '<pre class="code-lines"><code>' + lineNumbers + '</code></pre>' +
          '<pre class="code-content"><code class="hljs language-' + lang + '">' + codeContent + '</code></pre>' +
          '</div></div>';
      } catch (e) {
        $('#note-body').innerHTML = '<p class="empty" style="color:var(--danger)">读取失败：' + esc(e.message) + '</p>';
      }
      ui.view = { type: 'note', rel: treeRel };
      saveUI();
      renderCover();
      syncSelection();
      return;
    }
    // Office 文档等其它文件：提供下载链接
    if (!/\.md$/i.test(treeRel)) {
      $('#note-body').innerHTML =
        '<div style="padding:40px;text-align:center;color:var(--muted)">' +
        '<div style="font-size:48px;margin-bottom:16px">📄</div>' +
        '<div style="font-size:16px;margin-bottom:8px;font-weight:600">' + esc(treeRel) + '</div>' +
        '<a href="' + fileUrl + '" target="_blank" style="display:inline-block;padding:10px 24px;background:var(--accent);color:#fff;border-radius:8px;text-decoration:none;font-size:15px">⬇ 下载 / 在新标签页中打开</a>' +
        '</div>';
      ui.view = { type: 'note', rel: treeRel };
      saveUI();
      renderCover();
      syncSelection();
      return;
    }
    // Markdown 笔记
    try {
      const d = await api('/api/note?rel=' + encodeURIComponent(rel) + (dir ? '&dir=' + encodeURIComponent(dir) : ''));
      const tags = d.meta?.tags || [];
      $('#note-tags').innerHTML = tags.length
        ? tags.map((t) => '<span class="tag-chip">' + esc(t) + '</span>').join('')
        : '';
      $('#note-body').innerHTML = renderMarkdown(stripFrontmatter(d.content));
      ui.view = { type: 'note', rel: treeRel };
      saveUI();
      renderCover();
      syncSelection();
      showReviewPanel(state.reviewMode);
      state.reviewMode = false;
      updateReviewEnrollButton(rel);
    } catch (e) {
      $('#note-body').innerHTML = '<p class="empty" style="color:var(--danger)">读取失败：' + esc(e.message) + '</p>';
      ui.view = { type: 'note', rel: treeRel };
      saveUI();
    }
  }

  function selectDir(dirRel) {
    state.currentRel = null;
    state.prevRel = null;
    $('#search-results').classList.add('hidden');
    $('#editor').classList.add('hidden');
    $('#viewer').classList.remove('hidden');
    $('#note-tags').innerHTML = '';
    $('#note-path').textContent = dirRel || '(根目录)';

    // 显示加载中
    $('#note-body').innerHTML = '<p class="empty">加载中…</p>';

    // 获取目录树并渲染文件列表
    api('/api/tree').then((d) => {
      const node = findNode(d.tree, dirRel);
      if (!node) {
        $('#note-body').innerHTML =
          '<p class="empty">📁 分类：<b>' + esc(dirRel || '(根目录)') + '</b><br>' +
          '目录不存在</p>';
        return;
      }
      const files = collectFiles(node);
      if (files.length === 0) {
        $('#note-body').innerHTML =
          '<p class="empty">📁 分类：<b>' + esc(dirRel || '(根目录)') + '</b><br>' +
          '该目录下暂无文档</p>';
        return;
      }
      let html = '<div class="file-list"><table><thead><tr><th>文档名称</th><th>大小</th><th>修改时间</th></tr></thead><tbody>';
      for (const f of files) {
        const size = formatSize(f.size);
        const time = formatTime(f.mtimeMs);
        html += '<tr data-rel="' + escAttr(f.relPath) + '" style="cursor:pointer">' +
          '<td>' + esc(f.name) + '</td>' +
          '<td style="text-align:right;white-space:nowrap">' + size + '</td>' +
          '<td style="white-space:nowrap">' + time + '</td>' +
          '</tr>';
      }
      html += '</tbody></table></div>';
      $('#note-body').innerHTML = html;

      // 点击行打开文档
      $('#note-body').querySelectorAll('.file-list tbody tr').forEach((tr) => {
        tr.addEventListener('click', () => openNote(tr.dataset.rel));
      });
    }).catch((e) => {
      $('#note-body').innerHTML = '<p class="empty" style="color:var(--danger)">加载失败：' + esc(e.message) + '</p>';
    });

    ui.view = { type: 'dir', rel: dirRel || '' };
    saveUI();
    renderCover();
    syncSelection();
  }

  function findNode(node, targetRel) {
    if (!node) return null;
    if (node.relPath === targetRel) return node;
    for (const c of node.children || []) {
      const found = findNode(c, targetRel);
      if (found) return found;
    }
    return null;
  }

  function collectFiles(node) {
    const out = [];
    for (const c of node.children || []) {
      if (c.type === 'file') {
        out.push({ name: c.name, relPath: c.relPath, size: c.size || 0, mtimeMs: c.mtimeMs || 0 });
      } else if (c.type === 'dir') {
        out.push(...collectFiles(c));
      }
    }
    return out;
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function formatTime(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') +
      ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  // ---------- 复习评分浮动面板 ----------
  function showReviewPanel(show) {
    const panel = $('#review-score-panel');
    if (!panel) return;
    if (show && state.currentRel) {
      panel.classList.remove('hidden');
    } else {
      panel.classList.add('hidden');
    }
  }

  async function markReview(quality) {
    if (!state.currentRel) return;
    try {
      await api('/api/review/mark', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rel: state.currentRel, quality }),
      });
      const labels = ['完全不记得', '几乎忘了', '勉强记得', '基本记得', '很熟悉', '完美掌握'];
      toast('已标记：' + labels[quality] + '（' + quality + '/5）');
    } catch (e) {
      toast('标记失败: ' + e.message, true);
    }
    $('#review-score-panel').classList.add('hidden');
  }

  // ---------- 标题目录（封面）----------
  function renderCover() {
    const box = $('#viewer-cover');
    const body = $('#note-body');
    if (!box || !body) return;
    const heads = body.querySelectorAll('h1,h2,h3,h4,h5,h6');
    if (!heads.length) {
      box.innerHTML = '';
      box.classList.add('hidden');
      return;
    }
    box.innerHTML =
      '<div class="cover-title">📑 目录</div>' +
      Array.prototype.map.call(heads, (h) => {
        const lv = parseInt(h.tagName.charAt(1), 10);
        return '<a class="cover-item lv' + lv + '" href="#' + escAttr(h.id) + '" data-target="' + escAttr(h.id) + '">' + esc(h.textContent) + '</a>';
      }).join('');
    box.classList.toggle('hidden', !ui.coverOn);
  }

  function applyCover() {
    $('#btn-cover').classList.toggle('active', ui.coverOn);
    renderCover();
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
      const inDir = dirRel === '' || node.relPath.startsWith(dirRel + '/');
      if (inDir) out.push(node.relPath);
      // 子笔记属于其所在目录，递归收集
      (node.children || []).forEach((c) => out.push(...collectRelsInDir(c, dirRel)));
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
  let editorMode = 'wysiwyg'; // 'wysiwyg' | 'source'

  let monacoEditor = null;
  let monacoReady = false;
  const CODE_FILE_RE = /\.(js|jsx|ts|tsx|mjs|cjs|py|c|cpp|h|hpp|java|go|rs|sh|bash|zsh|json|yaml|yml|toml|xml|html|htm|css|scss|less|sql|csv|log|env|vue|svelte|rb|php|swift|kt|scala|lua|r|pl|ex|exs|erl|hs|ml|fs|clj|lisp|el|vim|proto|graphql|gql|tf|hcl|ini|cfg|conf|properties|gradle|cmake|makefile|mk)$/i;

  function isCodeFile(rel) {
    return CODE_FILE_RE.test(rel);
  }

  function getLangFromExt(rel) {
    const ext = rel.split('.').pop().toLowerCase();
    const map = { js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', java: 'java', go: 'go', rs: 'rust', sh: 'shell', bash: 'shell', zsh: 'shell', json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini', xml: 'xml', html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less', sql: 'sql', rb: 'ruby', php: 'php', swift: 'swift', kt: 'kotlin', scala: 'scala', lua: 'lua', r: 'r', pl: 'perl', ex: 'elixir', exs: 'elixir', hs: 'haskell', clj: 'clojure', vue: 'html', svelte: 'html', proto: 'protobuf', graphql: 'graphql', gql: 'graphql', tf: 'hcl', hcl: 'hcl', ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'properties', makefile: 'makefile', mk: 'makefile' };
    return map[ext] || ext;
  }

  function extractImageUrls(text) {
    const urls = new Set();
    const re = /!\[.*?\]\((\/api\/file\?rel=_attachments[^)]+)\)/g;
    let m;
    while ((m = re.exec(text))) urls.add(m[1]);
    return urls;
  }

  async function cleanupRemovedImages(oldContent, newContent) {
    const oldUrls = extractImageUrls(oldContent);
    const newUrls = extractImageUrls(newContent);
    for (const url of oldUrls) {
      if (!newUrls.has(url)) {
        const rel = decodeURIComponent(url.split('rel=')[1]);
        try {
          await fetch('/api/attachment', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rel }),
          });
        } catch {}
      }
    }
  }

  // ---------- Math Modal ----------
  let mathModalResolve = null;
  let mathModalMode = 'inline'; // 'inline' or 'block'

  function showMathModal(defaultLatex, mode, editor, editPos) {
    mathModalMode = mode || 'inline';
    return new Promise((resolve) => {
      mathModalResolve = resolve;
      const modal = $('#math-modal');
      const input = $('#math-input');
      const title = $('#math-modal-title');
      title.textContent = mode === 'block' ? '插入块级公式' : '插入行内公式';
      input.value = defaultLatex || '';
      $('#math-preview').innerHTML = '<span class="math-placeholder">公式预览</span>';
      modal.classList.remove('hidden');
      input.focus();
      updateMathPreview();
      modal._mathEditor = editor || null;
      modal._mathEditPos = editPos != null ? editPos : null;
    });
  }

  function updateMathPreview() {
    const input = $('#math-input');
    const preview = $('#math-preview');
    const latex = input.value.trim();
    if (!latex) { preview.innerHTML = '<span class="math-placeholder">公式预览</span>'; return; }
    try {
      if (window.katex) {
        preview.innerHTML = window.katex.renderToString(latex, { displayMode: mathModalMode === 'block', throwOnError: false, strict: false });
      } else {
        preview.textContent = latex;
      }
    } catch { preview.textContent = latex; }
  }

  function initMathModal() {
    const modal = $('#math-modal');
    const input = $('#math-input');
    if (!modal || !input) return;

    input.addEventListener('input', updateMathPreview);

    $('#math-modal-close').addEventListener('click', () => {
      modal.classList.add('hidden');
      if (mathModalResolve) { mathModalResolve(null); mathModalResolve = null; }
    });
    modal.querySelector('.modal-overlay').addEventListener('click', () => {
      modal.classList.add('hidden');
      if (mathModalResolve) { mathModalResolve(null); mathModalResolve = null; }
    });
    $('#math-modal-cancel').addEventListener('click', () => {
      modal.classList.add('hidden');
      if (mathModalResolve) { mathModalResolve(null); mathModalResolve = null; }
    });
    $('#math-modal-ok').addEventListener('click', () => {
      const latex = input.value.trim();
      const ed = modal._mathEditor;
      const editPos = modal._mathEditPos;
      modal.classList.add('hidden');
      if (ed && latex) {
        const isBlock = mathModalMode === 'block';
        const nodeName = isBlock ? 'blockMath' : 'inlineMath';
        const nodeType = ed.state.schema.nodes[nodeName];
        if (!nodeType) { toast('数学公式扩展未加载', true); return; }

        if (editPos != null) {
          // Editing existing — replace node at position
          const node = nodeType.create({ latex });
          const tr = ed.state.tr.setNodeMarkup(editPos, undefined, { latex });
          ed.view.dispatch(tr);
          ed.commands.focus();
        } else {
          // Inserting new
          const node = nodeType.create({ latex });
          const { from } = ed.state.selection;
          const tr = ed.state.tr.insert(from, node);
          ed.view.dispatch(tr);
          ed.commands.focus();
        }
      }
      if (mathModalResolve) { mathModalResolve(latex || null); mathModalResolve = null; }
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        $('#math-modal-ok').click();
      }
      if (e.key === 'Escape') {
        modal.classList.add('hidden');
        if (mathModalResolve) { mathModalResolve(null); mathModalResolve = null; }
      }
    });

    // Symbol buttons insert at cursor
    modal.querySelectorAll('[data-math]').forEach(btn => {
      btn.addEventListener('click', () => {
        const sym = btn.dataset.math;
        const start = input.selectionStart;
        const end = input.selectionEnd;
        input.value = input.value.slice(0, start) + sym + input.value.slice(end);
        input.selectionStart = input.selectionEnd = start + sym.length;
        input.focus();
        updateMathPreview();
      });
    });

    // Help button
    $('#math-help-btn').addEventListener('click', () => {
      $('#math-help-modal').classList.remove('hidden');
    });
    $('#math-help-close').addEventListener('click', () => {
      $('#math-help-modal').classList.add('hidden');
    });
    $('#math-help-modal').querySelector('.modal-overlay').addEventListener('click', () => {
      $('#math-help-modal').classList.add('hidden');
    });
  }

  function ensureMonaco() {
    if (monacoReady && monacoEditor) return Promise.resolve(monacoEditor);
    return new Promise((resolve, reject) => {
      function loadMonacoLoader(cb) {
        if (typeof window.require !== 'undefined' && window.require.config) { cb(); return; }
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs/loader.js';
        s.onload = cb;
        s.onerror = () => reject(new Error('Monaco loader 加载失败'));
        document.head.appendChild(s);
      }
      loadMonacoLoader(() => {
        window.require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs' } });
        window.require(['vs/editor/editor.main'], () => {
          monacoReady = true;
          resolve();
        }, reject);
      });
    });
  }

  async function openCodeEditor() {
    if (!state.currentRel) return toast('请先选择一篇笔记', true);
    state.editing = true;
    $('#viewer').classList.add('hidden');
    $('#search-results').classList.add('hidden');
    $('#editor').classList.add('hidden');
    $('#code-editor-section').classList.remove('hidden');

    const lang = getLangFromExt(state.currentRel);
    $('#code-editor-lang').textContent = lang.toUpperCase();

    try {
      await ensureMonaco();
      const d = await api(noteApiUrl('/api/note'));
      const container = document.getElementById('monaco-editor-container');
      if (monacoEditor) {
        monacoEditor.dispose();
        monacoEditor = null;
      }
      monacoEditor = monaco.editor.create(container, {
        value: d.content,
        language: lang,
        theme: 'vs',
        fontSize: 14,
        fontFamily: 'Consolas, "SF Mono", "Fira Code", "Courier New", monospace',
        minimap: { enabled: true },
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        lineNumbers: 'on',
        renderLineHighlight: 'all',
        automaticLayout: true,
        tabSize: 2,
        insertSpaces: true,
        folding: true,
        bracketPairColorization: { enabled: true },
        smoothScrolling: true,
        cursorBlinking: 'smooth',
        cursorSmoothCaretAnimation: 'on',
      });
      monacoEditor.focus();
    } catch (e) {
      toast('编辑器加载失败: ' + e.message, true);
      cancelCodeEdit();
    }
  }

  async function saveCodeFile() {
    if (!state.currentRel || !monacoEditor) return;
    try {
      const content = monacoEditor.getValue();
      await api('/api/note', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rel: state.currentRel, content }),
      });
      toast('已保存: ' + state.currentRel);
      await openNote(state.currentRel);
    } catch (e) {
      toast('保存失败: ' + e.message, true);
    }
  }

  function cancelCodeEdit() {
    state.editing = false;
    $('#code-editor-section').classList.add('hidden');
    if (monacoEditor) {
      monacoEditor.dispose();
      monacoEditor = null;
    }
    if (state.currentRel) openNote(state.currentRel);
  }

  function ensureVditor() {
    if (vditor) return Promise.resolve(vditor);
    return new Promise(async (resolve, reject) => {
      try {
        const tiptapCore = await import('@tiptap/core');
        const tiptapKit = await import('@tiptap/starter-kit');
        const tiptapMd = await import('tiptap-markdown');
        const tiptapTaskList = await import('@tiptap/extension-task-list');
        const tiptapTaskItem = await import('@tiptap/extension-task-item');
        const tiptapImage = await import('@tiptap/extension-image');
        const tiptapMath = await import('@tiptap/extension-mathematics');
        const katex = await import('katex');

        const Editor = tiptapCore.Editor;
        const StarterKit = tiptapKit.StarterKit || tiptapKit.default;
        const Markdown = tiptapMd.Markdown || tiptapMd.default;
        const TaskList = tiptapTaskList.TaskList || tiptapTaskList.default;
        const TaskItem = tiptapTaskItem.TaskItem || tiptapTaskItem.default;
        const Image = tiptapImage.Image || tiptapImage.default;
        const Mathematics = tiptapMath.Mathematics || tiptapMath.default;

        if (!Editor) { reject(new Error('Editor 未加载: ' + Object.keys(tiptapCore).join(','))); return; }
        if (!StarterKit) { reject(new Error('StarterKit 未加载: ' + Object.keys(tiptapKit).join(','))); return; }
        if (!Markdown) { reject(new Error('Markdown 未加载: ' + Object.keys(tiptapMd).join(','))); return; }
        if (!Mathematics) { reject(new Error('Mathematics 未加载: ' + Object.keys(tiptapMath).join(','))); return; }

        const editorRef = { current: null };

        async function createEditor(markdown) {
          const el = document.getElementById('vditor-wrap');
          el.innerHTML = '';
          const editor = new Editor({
            element: el,
            extensions: [
              StarterKit.configure({
                heading: { levels: [1, 2, 3, 4, 5, 6] },
              }),
              Markdown.configure({
                html: true,
                linkify: true,
                transformPastedText: true,
                transformCopiedText: true,
              }),
              TaskList,
              TaskItem.configure({ nested: true }),
              Image.configure({
                inline: true,
                allowBase64: true,
              }),
              Mathematics.configure({
                inlineOptions: {
                  onClick: (node, pos) => {
                    showMathModal(node.attrs.latex, 'inline', editor, pos);
                  },
                },
                blockOptions: {
                  onClick: (node, pos) => {
                    showMathModal(node.attrs.latex, 'block', editor, pos);
                  },
                },
                katexOptions: {
                  throwOnError: false,
                  macros: {
                    '\\R': '\\mathbb{R}',
                    '\\N': '\\mathbb{N}',
                    '\\Z': '\\mathbb{Z}',
                    '\\Q': '\\mathbb{Q}',
                    '\\C': '\\mathbb{C}',
                  },
                },
              }),
            ],
            content: markdown || '',
            editorProps: {
              attributes: {
                class: 'tiptap-editor',
              },
              handlePaste: (view, event) => {
                const items = event.clipboardData?.items;
                if (items) {
                  for (const item of items) {
                    if (item.type.startsWith('image/')) {
                      event.preventDefault();
                      const file = item.getAsFile();
                      if (file) uploadAndInsertImage(file);
                      return true;
                    }
                  }
                }
                // Auto-parse $...$ and $$...$$ from pasted text
                const text = event.clipboardData?.getData('text/plain');
                if (text && (/\$[^$]+\$/s.test(text) || /\$\$[\s\S]+\$\$/.test(text))) {
                  event.preventDefault();
                  const ed = editorRef.current;
                  if (!ed) return false;
                  // Check for block math $$...$$
                  const blockRe = /\$\$([\s\S]+?)\$\$/g;
                  let hasBlock = false;
                  let result = text.replace(blockRe, (_, latex) => { hasBlock = true; return latex; });
                  if (hasBlock) {
                    ed.chain().focus().insertContent('$$\n' + result.trim() + '\n$$').run();
                  } else {
                    // Inline math $...$
                    const inlineRe = /\$([^$]+?)\$/g;
                    const matches = [...text.matchAll(inlineRe)];
                    if (matches.length === 1 && matches[0][0] === text.trim()) {
                      // Entire paste is one math expression — insert as math node
                      ed.chain().focus().insertContent('$' + matches[0][1] + '$').run();
                    } else {
                      // Mixed text and math — insert as markdown
                      ed.chain().focus().insertContent(text).run();
                    }
                  }
                  return true;
                }
                return false;
              },
              handleDrop: (view, event) => {
                const files = event.dataTransfer?.files;
                if (!files) return false;
                for (const file of files) {
                  if (file.type.startsWith('image/')) {
                    event.preventDefault();
                    uploadAndInsertImage(file);
                    return true;
                  }
                }
                return false;
              },
            },
          });
          editorRef.current = editor;
          return editor;
        }

        async function uploadAndInsertImage(file) {
          const ed = editorRef.current;
          if (!ed) return;
          const formData = new FormData();
          formData.append('file', file);
          try {
            toast('正在上传图片...');
            const res = await fetch('/api/upload', { method: 'POST', body: formData });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || '上传失败');
            ed.chain().focus().setImage({ src: data.url, alt: file.name || '' }).run();
            toast('图片已上传');
          } catch (err) {
            toast('图片上传失败: ' + err.message, true);
          }
        }

        await createEditor('');

        function wireToolbar() {
          const bar = document.getElementById('editor-format-bar');
          if (!bar || bar._wired) return;
          bar._wired = true;
          bar.addEventListener('click', (e) => {
            const btn = e.target.closest('button');
            if (!btn) return;
            const ed = editorRef.current;
            if (!ed) return;
            const cmd = btn.dataset.cmd;
            const level = parseInt(btn.dataset.level);
            const chain = ed.chain().focus();
            switch (cmd) {
              case 'toggleBold': chain.toggleBold().run(); break;
              case 'toggleItalic': chain.toggleItalic().run(); break;
              case 'toggleStrike': chain.toggleStrike().run(); break;
              case 'toggleCode': chain.toggleCode().run(); break;
              case 'setHeading': chain.toggleHeading({ level }).run(); break;
              case 'setParagraph': chain.setParagraph().run(); break;
              case 'toggleBulletList': chain.toggleBulletList().run(); break;
              case 'toggleOrderedList': chain.toggleOrderedList().run(); break;
              case 'toggleTaskList': chain.toggleTaskList().run(); break;
              case 'toggleBlockquote': chain.toggleBlockquote().run(); break;
              case 'setCodeBlock': chain.toggleCodeBlock().run(); break;
              case 'setHorizontalRule': chain.setHorizontalRule().run(); break;
              case 'setLink': {
                const url = prompt('输入链接地址：', 'https://');
                if (url) chain.setLink({ href: url }).run();
                break;
              }
              case 'setImage': {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = 'image/*';
                input.onchange = () => {
                  const file = input.files[0];
                  if (file) uploadAndInsertImage(file);
                };
                input.click();
                break;
              }
              case 'insertInlineMath': {
                showMathModal('E = mc^2', 'inline', editorRef.current);
                break;
              }
              case 'insertBlockMath': {
                showMathModal('\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}', 'block', editorRef.current);
                break;
              }
              case 'undo': chain.undo().run(); break;
              case 'redo': chain.redo().run(); break;
            }
          });
          function updateActiveStates() {
            const ed = editorRef.current;
            if (!ed) return;
            bar.querySelectorAll('button[data-cmd]').forEach(btn => {
              const cmd = btn.dataset.cmd;
              let isActive = false;
              switch (cmd) {
                case 'toggleBold': isActive = ed.isActive('bold'); break;
                case 'toggleItalic': isActive = ed.isActive('italic'); break;
                case 'toggleStrike': isActive = ed.isActive('strike'); break;
                case 'toggleCode': isActive = ed.isActive('code'); break;
                case 'setHeading': isActive = ed.isActive('heading', { level: parseInt(btn.dataset.level) }); break;
                case 'setParagraph': isActive = ed.isActive('paragraph'); break;
                case 'toggleBulletList': isActive = ed.isActive('bulletList'); break;
                case 'toggleOrderedList': isActive = ed.isActive('orderedList'); break;
                case 'toggleTaskList': isActive = ed.isActive('taskList'); break;
                case 'toggleBlockquote': isActive = ed.isActive('blockquote'); break;
                case 'setCodeBlock': isActive = ed.isActive('codeBlock'); break;
              }
              btn.classList.toggle('active', isActive);
            });
          }
          const ed2 = editorRef.current;
          if (!ed2) return;
          ed2.on('selectionUpdate', updateActiveStates);
          ed2.on('transaction', updateActiveStates);
        }
        wireToolbar();
        initMathModal();

        vditor = {
          _editor: editorRef.current,
          getValue() {
            const ed = editorRef.current;
            if (!ed) return '';
            try {
              return ed.storage.markdown.getMarkdown();
            } catch {
              return ed.getText();
            }
          },
          setValue(markdown) {
            createEditor(markdown);
          },
          insertValue(markdown) {
            const ed = editorRef.current;
            if (!ed) return;
            ed.chain().focus().insertContent(markdown).run();
          },
        };
        resolve(vditor);
      } catch (e) {
        reject(e);
      }
    });
  }

  function switchEditorMode(mode) {
    editorMode = mode;
    const vditorWrap = $('#vditor-wrap');
    const mdSource = $('#md-source');
    const btn = $('#btn-toggle-md');
    if (mode === 'source') {
      // 切换到源码模式：获取 vditor 内容放入 textarea
      const content = vditor ? vditor.getValue() : '';
      mdSource.value = content;
      vditorWrap.classList.add('hidden');
      mdSource.classList.remove('hidden');
      btn.textContent = '👁 预览';
      btn.title = '切换到可视化编辑模式';
      mdSource.focus();
    } else {
      // 切换到可视化模式：获取 textarea 内容放入 vditor
      const content = mdSource.value;
      vditorWrap.classList.remove('hidden');
      mdSource.classList.add('hidden');
      if (vditor) vditor.setValue(content);
      btn.textContent = '📝 源码';
      btn.title = '切换到 Markdown 源码模式';
    }
  }

  function openEditor() {
    if (!state.currentRel && !state.currentDir) {
      toast('请先选择一篇笔记或分类', true);
      return;
    }
    // 代码文件使用 Monaco Editor
    if (state.currentRel && isCodeFile(state.currentRel)) {
      openCodeEditor();
      return;
    }
    state.editing = true;
    $('#viewer').classList.add('hidden');
    $('#search-results').classList.add('hidden');
    $('#editor').classList.remove('hidden');
    $('#code-editor-section').classList.add('hidden');

    // 重置为可视化模式
    editorMode = 'wysiwyg';
    $('#vditor-wrap').classList.remove('hidden');
    $('#md-source').classList.add('hidden');
    const btn = $('#btn-toggle-md');
    btn.textContent = '📝 源码';
    btn.title = '切换到 Markdown 源码模式';

    ensureVditor().then(() => {
      if (state.currentRel) {
        api(noteApiUrl('/api/note')).then((d) => {
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
    let body = content;
    let fm = '';
    if (m) {
      fm = m[1];
      body = content.slice(m[0].length);
    }
    const tm = fm.match(/^tags:\s*\[?([^\]]*?)\]?$/m);
    const tags = tm
      ? tm[1]
          .split(/[,，\s]+/)
          .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
          .filter(Boolean)
      : [];
    // 从正文提取首个一级标题作为标题
    const titleMatch = body.match(/^\s*#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : '';
    return { title, tags, body };
  }

  async function saveNote() {
    const title = $('#edit-title').value.trim();
    const tags = $('#edit-tags').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    let body = editorMode === 'source' ? $('#md-source').value : (vditor ? vditor.getValue() : '');

    let oldContent = '';
    let newRel;
    if (state.currentRel) {
      newRel = state.currentRel;
      state.prevRel = null;
      try {
        const oldResp = await api('/api/note?rel=' + encodeURIComponent(state.currentRel));
        if (oldResp && oldResp.content) oldContent = oldResp.content;
      } catch {}
    } else {
      const name = (title || '未命名笔记').replace(/[\\/:*?"<>|]/g, '_');
      newRel = uniqueRel(state.currentDir || '', name);
    }

    // 代码文件直接保存，不处理 frontmatter
    if (state.currentRel && isCodeFile(state.currentRel)) {
      const body = editorMode === 'source' ? $('#md-source').value : (vditor ? vditor.getValue() : '');
      await api('/api/note', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rel: state.currentRel, content: body }),
      });
      toast('已保存: ' + state.currentRel);
      await Promise.all([loadTree(), loadTags(), loadStats()]);
      await openNote(state.currentRel);
      return;
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
      body: JSON.stringify({ rel: newRel, content, dir: state.currentNoteDir || '' }),
    });
    cleanupRemovedImages(oldContent, content).catch(() => {});
    toast('已保存: ' + newRel);
    await Promise.all([loadTree(), loadTags(), loadStats()]);
    await openNote(newRel);
  }

  function cancelEdit() {
    state.editing = false;
    $('#editor').classList.add('hidden');
    $('#code-editor-section').classList.add('hidden');
    if (monacoEditor) {
      monacoEditor.dispose();
      monacoEditor = null;
    }
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
    await renderMoveDialog();
    $('#dialog-move').classList.remove('hidden');
  }

  async function renderMoveDialog(expandRel) {
    const d = await api('/api/tree');
    $('#move-src').textContent = state.currentRel;
    const box = $('#move-tree');
    box.innerHTML = renderMoveTree(d.tree, 0, expandRel || '');
    if (!expandRel) window._moveTarget = '';
    bindMoveTree(box);
    if (expandRel) {
      box.querySelectorAll('.tree-node.dir.active').forEach((n) => n.classList.remove('active'));
      const node = box.querySelector('.tree-node[data-rel="' + escAttr(expandRel) + '"]');
      if (node) {
        node.classList.add('active');
        window._moveTarget = expandRel;
      }
    }
  }

  function renderMoveTree(node, depth = 0, targetRel = '') {
    if (!node) return '';
    const inPath = (rel) => !!targetRel && (targetRel === rel || targetRel.startsWith(rel + '/'));
    let html = '';
    const children = node.children || [];
    if (node.type === 'dir') {
      const open = depth < 2 || inPath(node.relPath);
      html +=
        '<div class="tree-node dir" data-rel="' + esc(node.relPath) + '" data-type="dir">' +
        '<span class="arrow">' + (children.length ? (open ? '▾' : '▸') : '') + '</span>' +
        '<span class="icon">📁</span><span>' + esc(node.name) + '</span>' +
        '</div>';
      html +=
        '<div class="tree-children' + (open ? '' : ' collapsed') + '" data-parent="' + esc(node.relPath) + '">' +
        children.map((c) => renderMoveTree(c, depth + 1, targetRel)).join('') +
        '</div>';
    } else if (node.type === 'file' && children.length) {
      // 该笔记拥有同名子目录（子笔记目录），作为可移动目标展示
      const subRel = String(node.relPath).replace(/\.[mM][dD]$/, '');
      const open = depth < 2 || inPath(subRel);
      html +=
        '<div class="tree-node dir" data-rel="' + esc(subRel) + '" data-type="dir">' +
        '<span class="arrow">' + (open ? '▾' : '▸') + '</span>' +
        '<span class="icon">📁</span><span>' + esc(subRel) + '</span>' +
        '</div>';
      html +=
        '<div class="tree-children' + (open ? '' : ' collapsed') + '" data-parent="' + esc(subRel) + '">' +
        children.map((c) => renderMoveTree(c, depth + 1, targetRel)).join('') +
        '</div>';
    }
    return html;
  }

  async function newMoveSubfolder() {
    const parent = window._moveTarget || state.currentDir || '';
    const name = prompt('输入新分类名称：', '新分类');
    if (!name) return;
    const clean = name.replace(/[\\/:*?"<>|]/g, '_').trim();
    if (!clean) return;
    const rel = parent ? parent + '/' + clean : clean;
    await api('/api/folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rel }),
    });
    toast('已创建分类: ' + rel);
    await renderMoveDialog(rel);
    await loadTree();
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

  let _classify = null; // 最近一次智能归类结果

  function classifyListValue(line) {
    const m = line.match(/:\s*\[?([^\]]*?)\]?\s*$/);
    return m ? m[1].split(/[,\s]+/).filter(Boolean) : [];
  }

  function mergeListLine(line, add) {
    const bracket = /\[[^\]]*\]/.test(line);
    const merged = [...new Set([...classifyListValue(line), ...add])];
    return (bracket ? '[' + merged.join(', ') + ']' : merged.join(', '));
  }

  function insertSummaryAfterTitle(body, summary) {
    const stripped = body.replace(/^(?:[ \t]*\r?\n)+/, '');
    const m = stripped.match(/^(#{1,6}\s+[^\n]*)(?=\r?\n|$)/);
    if (!m) return '> **摘要：** ' + summary + '\n\n' + body;
    const rest = stripped.slice(m[0].length).replace(/^(?:[ \t]*\r?\n)+/, '');
    return m[0] + '\n\n> **摘要：** ' + summary + '\n\n' + rest;
  }

  async function applyClassify() {
    const d = _classify;
    const box = $('#ai-classify-out');
    if (!state.currentRel || !d) return;
    if (d.relPath && d.relPath !== state.currentRel) {
      toast('当前笔记已变化，请重新分析', true);
      box.className = 'ai-out error';
      box.innerHTML = '⚠️ 当前笔记已变化，请点击"分析当前笔记"重新分析后再应用。';
      return;
    }
    const btn = $('#btn-apply-classify');
    if (btn) btn.disabled = true;
    try {
      const tags = (d.tags || []).map((s) => String(s).trim()).filter(Boolean);
      const keywords = (d.keywords || []).map((s) => String(s).trim()).filter(Boolean);
      const summary = String(d.summary || '').trim();
      const note = await api(noteApiUrl('/api/note'));
      let content = note.content;
      let fm = null;
      let body = content;
      const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
      if (fmMatch) {
        fm = fmMatch[1];
        body = content.slice(fmMatch[0].length);
      }
      if (fm) {
        const lines = fm.split(/\r?\n/);
        const tagIdx = lines.findIndex((l) => /^tags\s*:/.test(l));
        if (tagIdx >= 0) lines[tagIdx] = 'tags: ' + mergeListLine(lines[tagIdx], tags);
        else if (tags.length) lines.push('tags: [' + tags.join(', ') + ']');
        const kwIdx = lines.findIndex((l) => /^keywords\s*:/.test(l));
        if (kwIdx >= 0) lines[kwIdx] = 'keywords: ' + mergeListLine(lines[kwIdx], keywords);
        else if (keywords.length) lines.push('keywords: [' + keywords.join(', ') + ']');
        fm = lines.join('\n');
      } else {
        const lines = [];
        if (tags.length) lines.push('tags: [' + tags.join(', ') + ']');
        if (keywords.length) lines.push('keywords: [' + keywords.join(', ') + ']');
        fm = lines.join('\n') || null;
      }
      if (summary) body = insertSummaryAfterTitle(body, summary);
      const newContent = fm ? '---\n' + fm + '\n---\n\n' + body : body;
      await api('/api/note', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rel: state.currentRel, content: newContent }),
      });
      await Promise.all([loadTree(), loadTags(), loadStats()]);
      await openNote(state.currentRel);
      box.className = 'ai-out done';
      box.innerHTML = '✅ 已应用智能归类结果（摘要 / 标签 / 关键词）。';
      toast('已应用智能归类结果');
    } catch (e) {
      aiError(box, e);
    }
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
      _classify = d;
      box.className = 'ai-out done';
      box.innerHTML =
        '<b>建议分类：</b>' + esc(d.category || '—') + '<br>' +
        '<b>建议标签：</b>' + (d.tags?.length ? d.tags.map(esc).join(', ') : '—') + '<br>' +
        '<b>摘要：</b>' + esc(d.summary || '—') + '<br>' +
        '<b>关键词：</b>' + (d.keywords?.length ? d.keywords.map(esc).join(', ') : '—') +
        '<button id="btn-apply-classify" class="ai-btn">✅ 应用分析结果</button>';
      const btn = $('#btn-apply-classify');
      if (btn) btn.addEventListener('click', applyClassify);
    } catch (e) {
      aiError(box, e);
    }
  }

  // v1.2: 批量归类分析
  async function aiBatchClassify() {
    const box = aiLoading('#ai-batch-out', 'AI 正在分析全库笔记（可能需要几分钟）');
    try {
      const d = await api('/api/batch-classify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      box.className = 'ai-out done';
      let html = `<b>分析完成：</b>共 ${d.count} 篇笔记<br><br>`;
      html += '<table style="width:100%;border-collapse:collapse;font-size:12px;">';
      html += '<tr style="background:var(--code-bg);"><th style="padding:4px;text-align:left;border:1px solid var(--border);">原路径</th><th style="padding:4px;text-align:left;border:1px solid var(--border);">建议分类</th><th style="padding:4px;text-align:left;border:1px solid var(--border);">理由</th></tr>';
      for (const r of d.results || []) {
        html += `<tr><td style="padding:4px;border:1px solid var(--border);word-break:break-all;">${esc(r.relPath || '')}</td><td style="padding:4px;border:1px solid var(--border);">${esc(r.suggestedCategory || '')}</td><td style="padding:4px;border:1px solid var(--border);">${esc(r.reason || '')}</td></tr>`;
      }
      html += '</table>';
      html += `<br><button id="btn-download-report" class="ai-btn">📥 下载 Markdown 报告</button>`;
      box.innerHTML = html;
      const dlBtn = box.querySelector('#btn-download-report');
      if (dlBtn) {
        dlBtn.addEventListener('click', () => {
          const blob = new Blob([d.report || ''], { type: 'text/markdown' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = '批量归类报告.md';
          a.click();
        });
      }
    } catch (e) {
      aiError(box, e);
    }
  }

  // v1.4: 复习计划
  async function loadReviewPlan() {
    const box = aiLoading('#ai-review-plan', '加载复习计划');
    try {
      const d = await api('/api/review/due');
      box.className = 'ai-out done';
      const s = d.stats;
      let html = `<div style="margin-bottom:8px;">`;
      html += `<b>总计 ${s.total} 篇</b> · `;
      html += `<span style="color:var(--primary)">待复习 ${s.dueCount}</span> · `;
      html += `新笔记 ${s.newCount} · `;
      html += `已复习 ${s.reviewedCount} · `;
      html += `已掌握 ${s.masteredCount}`;
      html += `</div>`;
      if (!d.items?.length) {
        html += '<p style="color:var(--muted)">今日无需复习，干得好！</p>';
      } else {
        html += `<div id="review-list-toggle" style="cursor:pointer;color:var(--primary);font-size:13px;margin-bottom:4px;">▼ 展开复习列表（${d.items.length} 篇）</div>`;
        html += '<ul id="review-list" style="margin:4px 0;padding-left:18px;display:none;">';
        for (const item of d.items) {
          const label = item.isNew ? '📖 新' : '🔄 待复习';
          html += `<li><a href="#" class="review-link" data-rel="${esc(item.relPath)}" style="color:var(--primary);text-decoration:none;">${esc(item.title)}</a> <span style="color:var(--muted);font-size:12px;">${label}</span></li>`;
        }
        html += '</ul>';
        html += '<div style="margin-top:8px;font-size:12px;color:var(--muted);">打开笔记后，右下角出现评分面板，打分后自动标记复习完成。</div>';
      }
      box.innerHTML = html;
      // 折叠/展开
      const toggle = box.querySelector('#review-list-toggle');
      const list = box.querySelector('#review-list');
      if (toggle && list) {
        toggle.addEventListener('click', () => {
          const open = list.style.display !== 'none';
          list.style.display = open ? 'none' : '';
          toggle.textContent = open ? `▶ 展开复习列表（${d.items.length} 篇）` : `▼ 收起复习列表`;
        });
      }
      box.querySelectorAll('.review-link').forEach((a) => {
        a.addEventListener('click', (ev) => {
          ev.preventDefault();
          const rel = a.dataset.rel;
          if (rel) {
            state.reviewMode = true;
            openNote(rel);
          }
        });
      });
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
        const note = await api(noteApiUrl('/api/note'));
        const newContent = note.content.endsWith('\n') ? note.content + '\n' + text : note.content + '\n\n' + text;
        await api('/api/note', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rel: state.currentRel, content: newContent }),
        });
        box.className = 'ai-out done';
        box.innerHTML = '✅ 已追加到当前笔记';
        toast('已追加到当前笔记');
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

  async function createAiNote(rel, content) {
    await loadTree();
    let target = rel;
    let n = 2;
    const dir = relDir(rel);
    const stem = rel.split('/').pop().replace(/\.md$/i, '');
    while (relExists(target)) {
      target = (dir ? dir + '/' : '') + stem + '(' + n + ').md';
      n++;
    }
    await api('/api/note', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rel: target, content }),
    });
    await Promise.all([loadTree(), loadStats()]);
    return target;
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
      const text = d.markdown.replace(/^```(?:markdown)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
      const newRel = await createAiNote(state.currentRel.replace(/\.md$/i, '') + '·复习摘要.md', text);
      box.className = 'ai-out done';
      box.innerHTML = '✅ 复习摘要已生成：' + esc(newRel);
      toast('复习摘要已生成：' + newRel);
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
      const text = d.markdown.replace(/^```(?:markdown)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
      const newRel = await createAiNote(state.currentRel.replace(/\.md$/i, '') + '·自测题.md', text);
      box.className = 'ai-out done';
      box.innerHTML = '✅ 自测题已生成：' + esc(newRel);
      toast('自测题已生成：' + newRel);
    } catch (e) {
      aiError(box, e);
    }
  }

  let _chatBusy = false; // 对话窗口请求进行中

  function openAiChat() {
    const ctx = state.currentRel || (state.selectedRels.length ? dirName(state.selectedRels[0]) + ' 等 ' + state.selectedRels.length + ' 篇' : '');
    $('#ai-chat-ctx').textContent = ctx ? '参考：' + ctx : '';
    const dlg = $('#dialog-ai-chat');
    dlg.classList.remove('hidden');
    const q = $('#ai-ask-question').value.trim();
    if (q) {
      $('#ai-ask-question').value = '';
      $('#ai-chat-input').value = q;
      sendAiChat();
    } else {
      const input = $('#ai-chat-input');
      input.focus();
      const body = $('#ai-chat-body');
      if (!body.querySelector('.chat-msg')) {
        body.innerHTML = '<div class="chat-empty">输入问题开始与 AI 对话</div>';
      }
    }
  }

  function closeAiChat() {
    $('#dialog-ai-chat').classList.add('hidden');
  }

  function appendAiMsg(type, content, md) {
    const body = $('#ai-chat-body');
    const empty = body.querySelector('.chat-empty');
    if (empty) empty.remove();
    const row = document.createElement('div');
    row.className = 'chat-msg ' + type;
    if (type === 'user') {
      const bubble = document.createElement('div');
      bubble.className = 'chat-bubble';
      bubble.textContent = content;
      row.appendChild(bubble);
    } else if (content === 'thinking') {
      row.innerHTML = '<div class="chat-bubble"><div class="chat-tip">⏳ AI 检索并思考中...</div></div>';
    } else if (content === 'error') {
      row.innerHTML = '<div class="chat-bubble"><div class="chat-error">⚠️ ' + esc(md) + '</div></div>';
    } else {
      row.innerHTML =
        '<div class="chat-bubble markdown-body">' + renderMarkdown(content) + '</div>' +
        '<div class="chat-actions">' +
        '<button class="chat-act" data-act="copy">📋 复制</button>' +
        '<button class="chat-act" data-act="insert">📥 插入到当前笔记</button>' +
        '<button class="chat-act" data-act="new">📄 生成新笔记</button>' +
        '</div>';
      row.querySelectorAll('.chat-act').forEach((b) =>
        b.addEventListener('click', () => chatAnswerAction(b.dataset.act, md))
      );
    }
    body.appendChild(row);
    body.scrollTop = body.scrollHeight;
    return row;
  }

  function copyText(txt) {
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = txt;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e) { /* ignore */ }
      document.body.removeChild(ta);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(txt).catch(fallback);
    }
    return Promise.resolve(fallback());
  }

  async function chatAnswerAction(act, md) {
    if (act === 'copy') {
      await copyText(md);
      toast('已复制回答');
      return;
    }
    if (!state.currentRel) return toast('请先在左侧选择一篇笔记', true);
    try {
      if (act === 'insert') {
        const note = await api(noteApiUrl('/api/note'));
        const newContent = note.content.endsWith('\n') ? note.content + '\n' + md : note.content + '\n\n' + md;
        await api('/api/note', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rel: state.currentRel, content: newContent }),
        });
        await Promise.all([loadTree(), loadTags(), loadStats()]);
        await openNote(state.currentRel);
        toast('已插入到当前笔记');
      } else if (act === 'new') {
        const newRel = await createAiNote(state.currentRel.replace(/\.md$/i, '') + '·问答.md', md);
        toast('已生成新笔记：' + newRel);
      }
    } catch (e) {
      toast(act === 'insert' ? '插入失败: ' + e.message : '生成失败: ' + e.message, true);
    }
  }

  async function sendAiChat() {
    if (_chatBusy) return;
    const input = $('#ai-chat-input');
    const q = input.value.trim();
    if (!q) return;
    if (!state.selectedRels.length) {
      input.value = '';
      toast('请先选择笔记或分类', true);
      return;
    }
    input.value = '';
    appendAiMsg('user', q);
    appendAiMsg('ai', 'thinking');
    _chatBusy = true;
    $('#btn-ai-chat-send').disabled = true;
    try {
      const d = await api('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rels: state.selectedRels, question: q }),
      });
      const md = d.answer.replace(/^```(?:markdown)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
      const thinking = $('#ai-chat-body').querySelector('.chat-msg:last-child');
      if (thinking) thinking.remove();
      appendAiMsg('ai', md, md);
    } catch (e) {
      const thinking = $('#ai-chat-body').querySelector('.chat-msg:last-child');
      if (thinking) thinking.remove();
      appendAiMsg('ai', 'error', e.message || String(e));
    } finally {
      _chatBusy = false;
      $('#btn-ai-chat-send').disabled = false;
      $('#ai-chat-input').focus();
    }
  }

  // ---------- settings ----------
  const providerDefaults = {
    deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
    openai: { baseUrl: 'https://api.openai.com', model: 'gpt-4o' },
    claude: { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-20250514' },
    moonshot: { baseUrl: 'https://api.moonshot.cn', model: 'moonshot-v1-8k' },
    zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    ollama: { baseUrl: 'http://localhost:11434', model: 'llama3' },
    custom: { baseUrl: '', model: '' },
  };

  function getSelectedModel() {
    const select = $('#cfg-model-select');
    const input = $('#cfg-model-input');
    const val = select.value;
    if (val === '__custom__') return input.value.trim();
    return val;
  }

  async function loadModelList(provider, baseUrl, apiKey, currentModel) {
    const select = $('#cfg-model-select');
    const input = $('#cfg-model-input');
    const isOllama = provider === 'ollama';
    const noKeyNeeded = isOllama || provider === 'custom';
    $('#cfg-apikey-label').style.display = noKeyNeeded ? 'none' : '';
    if (isOllama && !baseUrl) $('#cfg-baseurl').value = 'http://localhost:11434';
    select.innerHTML = '<option value="">加载中...</option>';
    input.style.display = 'none';
    input.value = '';
    try {
      const params = new URLSearchParams({ provider, baseUrl: baseUrl || '', apiKey: apiKey || '' });
      const d = await api('/api/ai/models?' + params.toString());
      select.innerHTML = '';
      if (d.models && d.models.length) {
        for (const m of d.models) {
          const opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = m.name;
          select.appendChild(opt);
        }
        // 添加自定义选项
        const customOpt = document.createElement('option');
        customOpt.value = '__custom__';
        customOpt.textContent = '✏️ 手动输入模型名称...';
        select.appendChild(customOpt);
        input.style.display = 'none';
      } else {
        // 无模型列表，直接显示文本输入
        select.innerHTML = '<option value="__custom__">✏️ 手动输入模型名称</option>';
        input.style.display = '';
      }
      if (currentModel) {
        const exists = Array.from(select.options).some((o) => o.value === currentModel);
        if (exists) {
          select.value = currentModel;
        } else {
          select.value = '__custom__';
          input.value = currentModel;
          input.style.display = '';
        }
      }
    } catch {
      select.innerHTML = '<option value="__custom__">✏️ 手动输入模型名称</option>';
      input.style.display = '';
      if (currentModel) input.value = currentModel;
    }
  }

  function openSettings() {
    const dirs = state.config.notesDirs || (state.config.notesDir ? [state.config.notesDir] : []);
    $('#cfg-notesdirs').value = dirs.join('\n');
    const reviewDirs = state.config.reviewDirs || [];
    $('#cfg-reviewdirs').value = reviewDirs.join('\n');
    const ignoreDirs = (state.config.index?.ignoreDirs || []).filter((d) => d !== '_attachments');
    $('#cfg-ignore-dirs').value = ignoreDirs.join(', ');
    const provider = state.config.ai?.provider || 'deepseek';
    $('#cfg-ai-provider').value = provider;
    $('#cfg-apikey').value = '';
    const baseurl = state.config.ai?.baseUrl || '';
    $('#cfg-baseurl').value = baseurl;
    const model = state.config.ai?.model || state.config.deepseek?.model || '';
    $('#dialog-settings').classList.remove('hidden');
    loadModelList(provider, baseurl, '', model);
  }

  async function saveSettings() {
    const dirsText = $('#cfg-notesdirs').value.trim();
    const notesDirs = dirsText.split(/\n/).map((s) => s.trim()).filter(Boolean);
    if (!notesDirs.length) return toast('请至少填写一个笔记目录', true);
    const reviewDirsText = $('#cfg-reviewdirs').value.trim();
    const reviewDirs = reviewDirsText.split(/\n/).map((s) => s.trim()).filter(Boolean);
    const ignoreDirs = $('#cfg-ignore-dirs').value
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!ignoreDirs.includes('_attachments')) ignoreDirs.push('_attachments');
    const provider = $('#cfg-ai-provider').value;
    const apiKey = $('#cfg-apikey').value.trim();
    const baseUrl = $('#cfg-baseurl').value.trim();
    const model = getSelectedModel();
    const defaults = providerDefaults[provider] || providerDefaults.deepseek;
    const aiConfig = {
      provider,
      apiKey: apiKey || undefined,
      baseUrl: baseUrl || defaults.baseUrl,
      model: model || defaults.model,
    };
    const body = {
      notesDirs,
      reviewDirs,
      index: { ignoreDirs },
      ai: aiConfig,
    };
    if (!aiConfig.apiKey) delete body.ai.apiKey;
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

  // v1.3: 双链图
  async function openLinkGraph() {
    const container = $('#link-graph-container');
    container.innerHTML = '<p style="color:var(--muted)">加载中...</p>';
    $('#dialog-links').classList.remove('hidden');
    try {
      const data = await api('/api/links');
      if (!data.nodes?.length) {
        container.innerHTML = '<p style="color:var(--muted)">暂无笔记引用关系</p>';
        return;
      }
      // 构建邻接表
      const adj = new Map();
      const inDeg = new Map();
      for (const n of data.nodes) {
        adj.set(n.id, []);
        inDeg.set(n.id, 0);
      }
      for (const e of data.edges) {
        if (adj.has(e.source)) adj.get(e.source).push(e.target);
        inDeg.set(e.target, (inDeg.get(e.target) || 0) + 1);
      }
      // 找出被引用最多的笔记（核心节点）
      const sorted = [...data.nodes].sort((a, b) => (inDeg.get(b.id) || 0) - (inDeg.get(a.id) || 0));
      let html = `<p style="margin-bottom:12px;"><b>${data.nodes.length}</b> 篇笔记，<b>${data.edges.length}</b> 条引用关系</p>`;
      // 显示核心节点（被引用 >= 2 次）
      const core = sorted.filter((n) => (inDeg.get(n.id) || 0) >= 2);
      if (core.length) {
        html += '<div style="margin-bottom:12px;"><b>核心笔记（被引用 ≥2 次）：</b><ul style="margin:4px 0;">';
        for (const n of core) {
          html += `<li><a href="#" class="graph-link" data-rel="${esc(n.id)}">${esc(n.title)}</a> <span style="color:var(--muted)">（被引用 ${inDeg.get(n.id)} 次）</span></li>`;
        }
        html += '</ul></div>';
      }
      // 显示所有引用关系
      html += '<b>引用关系：</b><ul style="margin:4px 0;">';
      for (const e of data.edges) {
        const srcTitle = data.nodes.find((n) => n.id === e.source)?.title || e.source;
        const tgtTitle = data.nodes.find((n) => n.id === e.target)?.title || e.target;
        html += `<li><a href="#" class="graph-link" data-rel="${esc(e.source)}">${esc(srcTitle)}</a> → <a href="#" class="graph-link" data-rel="${esc(e.target)}">${esc(tgtTitle)}</a></li>`;
      }
      html += '</ul>';
      container.innerHTML = html;
      // 绑定链接点击
      container.querySelectorAll('.graph-link').forEach((a) => {
        a.addEventListener('click', (ev) => {
          ev.preventDefault();
          const rel = a.dataset.rel;
          if (rel) {
            $('#dialog-links').classList.add('hidden');
            openNote(rel);
          }
        });
      });
    } catch (e) {
      container.innerHTML = `<p style="color:var(--error)">加载失败: ${esc(e.message)}</p>`;
    }
  }

  // ---------- AI panel toggle ----------
  function applyAiPanelState() {
    const panel = $('#ai-panel');
    if (!panel) return;
    panel.classList.toggle('ai-collapsed', ui.aiCollapsed);
  }

  function toggleAiPanel() {
    ui.aiCollapsed = !ui.aiCollapsed;
    saveUI();
    applyAiPanelState();
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
    $('#btn-save-code').addEventListener('click', saveCodeFile);
    $('#btn-cancel-code').addEventListener('click', cancelCodeEdit);
    $('#btn-new').addEventListener('click', newNote);
    $('#btn-move').addEventListener('click', openMoveDialog);
    $('#btn-delete').addEventListener('click', deleteNote);
    $('#btn-review-enroll').addEventListener('click', () => toggleReviewEnroll(state.currentRel));

    $('#btn-cover').addEventListener('click', () => {
      ui.coverOn = !ui.coverOn;
      saveUI();
      applyCover();
    });
    $('#viewer-cover').addEventListener('click', (e) => {
      const a = e.target.closest('.cover-item');
      if (!a) return;
      e.preventDefault();
      const el = document.getElementById(a.dataset.target);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    $('#btn-save').addEventListener('click', saveNote);
    $('#btn-cancel-edit').addEventListener('click', cancelEdit);
    $('#btn-toggle-md').addEventListener('click', () => switchEditorMode(editorMode === 'source' ? 'wysiwyg' : 'source'));
    $('#file-upload').addEventListener('change', async (e) => {
      const files = Array.from(e.target.files);
      if (!files.length) return;
      for (const file of files) {
        const formData = new FormData();
        formData.append('file', file);
        try {
          const res = await fetch('/api/upload', { method: 'POST', body: formData });
          let data;
          const ct = res.headers.get('content-type') || '';
          if (ct.includes('application/json')) {
            data = await res.json();
          } else {
            const text = await res.text();
            throw new Error(text || '上传失败（服务器返回非 JSON 响应）');
          }
          if (!res.ok) throw new Error(data.error || '上传失败');
          const isImage = data.url.match(/\.(png|jpe?g|gif|webp|svg)$/i);
          if (isImage && editorMode !== 'source' && vditor && vditor._editor && typeof vditor._editor.chain === 'function') {
            vditor._editor.chain().focus().setImage({ src: data.url, alt: data.filename || '' }).run();
          } else {
            const md = isImage ? `![](${data.url})` : `[${data.filename}](${data.url})`;
            if (editorMode === 'source') {
              const ta = $('#md-source');
              const start = ta.selectionStart;
              ta.value = ta.value.slice(0, start) + md + ta.value.slice(start);
              ta.focus();
            } else if (vditor) {
              vditor.insertValue(md);
            }
          }
          toast('已上传: ' + data.filename);
        } catch (err) {
          toast(err.message, true);
        }
      }
      e.target.value = '';
    });

    $('#btn-ai-classify').addEventListener('click', aiClassify);
    $('#btn-ai-expand-append').addEventListener('click', () => aiExpand('append'));
    $('#btn-ai-expand-new').addEventListener('click', () => aiExpand('new'));
    $('#btn-ai-batch-classify').addEventListener('click', aiBatchClassify);
    $('#btn-review-due').addEventListener('click', loadReviewPlan);
    $('#btn-ai-summary').addEventListener('click', aiSummary);
    $('#btn-ai-quiz').addEventListener('click', aiQuiz);
    $('#btn-ai-ask').addEventListener('click', openAiChat);
    $('#btn-ai-chat-send').addEventListener('click', sendAiChat);
    $('#btn-ai-chat-close').addEventListener('click', closeAiChat);
    $('#btn-ai-toggle').addEventListener('click', toggleAiPanel);
    $('#ai-chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendAiChat();
      }
    });

    $('#btn-settings').addEventListener('click', (e) => {
      e.preventDefault();
      openSettings();
    });
    $('#btn-settings-ok').addEventListener('click', saveSettings);
    $('#btn-settings-cancel').addEventListener('click', () => $('#dialog-settings').classList.add('hidden'));
    // AI 服务商切换 & 刷新模型列表
    $('#cfg-ai-provider').addEventListener('change', () => {
      const provider = $('#cfg-ai-provider').value;
      const defaults = providerDefaults[provider] || {};
      $('#cfg-baseurl').value = defaults.baseUrl || '';
      loadModelList(provider, defaults.baseUrl || '', '', defaults.model || '');
    });
    $('#cfg-model-select').addEventListener('change', () => {
      const input = $('#cfg-model-input');
      input.style.display = $('#cfg-model-select').value === '__custom__' ? '' : 'none';
      if ($('#cfg-model-select').value === '__custom__') input.focus();
    });
    $('#btn-refresh-models').addEventListener('click', () => {
      const provider = $('#cfg-ai-provider').value;
      loadModelList(provider, $('#cfg-baseurl').value, $('#cfg-apikey').value, getSelectedModel());
    });
    // v1.3: 双链图
    $('#btn-show-links').addEventListener('click', openLinkGraph);
    $('#btn-links-close').addEventListener('click', () => $('#dialog-links').classList.add('hidden'));

    // 复习评分面板
    document.querySelectorAll('.score-btn').forEach((btn) => {
      btn.addEventListener('click', () => markReview(parseInt(btn.dataset.score)));
    });
    $('#btn-review-dismiss').addEventListener('click', () => $('#review-score-panel').classList.add('hidden'));

    $('#btn-move-newfolder').addEventListener('click', newMoveSubfolder);
    $('#btn-move-cancel').addEventListener('click', () => $('#dialog-move').classList.add('hidden'));
    $('#btn-move-ok').addEventListener('click', confirmMove);

    document.querySelectorAll('.modal').forEach((m) =>
      m.addEventListener('click', (e) => {
        if (e.target === m) m.classList.add('hidden');
      })
    );
  }

  // ---------- init ----------
  async function restoreView() {
    const v = ui.view;
    if (v && v.type === 'note' && relExists(v.rel)) {
      try {
        await openNote(v.rel);
        expandNodePath(v.rel);
        return;
      } catch (e) { /* 笔记可能已被删除或移动 */ }
    } else if (v && v.type === 'dir') {
      selectDir(v.rel || '');
      expandNodePath(v.rel || '');
      return;
    }
    selectDir('');
  }

  async function init() {
    bindEvents();
    bindTreeEvents();
    bindContextMenu();
    applyCover();
    applyAiPanelState();
    await fetchConfig();
    try {
      await Promise.all([loadTree(), loadTags(), loadStats()]);
    } catch (e) {
      toast('加载失败: ' + e.message, true);
    }
    await restoreView();
  }

  window.addEventListener('beforeunload', saveUI);

  init();
})();