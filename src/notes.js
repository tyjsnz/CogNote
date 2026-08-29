const path = require('node:path');
const fsp = require('node:fs/promises');
const fs = require('node:fs');

function safeResolve(baseDir, relPath) {
  const base = path.resolve(baseDir);
  const target = path.resolve(base, relPath);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error('非法路径: 越界访问');
  }
  return target;
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function fromPosix(p) {
  return p.split('/').join(path.sep);
}

async function readNote(notesDir, relPath) {
  const abs = safeResolve(notesDir, relPath);
  const content = await fsp.readFile(abs, 'utf8');
  const st = await fsp.stat(abs);
  return { relPath: toPosix(relPath), content, size: st.size, mtimeMs: st.mtimeMs };
}

async function writeNote(notesDir, relPath, content) {
  const abs = safeResolve(notesDir, relPath);
  const dir = path.dirname(abs);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(abs, content, 'utf8');
  return { relPath: toPosix(relPath) };
}

async function moveNote(notesDir, from, to) {
  const fromAbs = safeResolve(notesDir, from);
  const toAbs = safeResolve(notesDir, to);
  if (fromAbs === toAbs) throw new Error('目标路径相同');
  await fsp.mkdir(path.dirname(toAbs), { recursive: true });
  if (fs.existsSync(toAbs)) throw new Error('目标文件已存在');
  await fsp.rename(fromAbs, toAbs);
  // 同名子笔记目录随主笔记一起移动
  if (/\.[mM][dD]$/.test(fromAbs)) {
    const fromDirAbs = fromAbs.replace(/\.[mM][dD]$/, '');
    const toDirAbs = toAbs.replace(/\.[mM][dD]$/, '');
    if (fs.existsSync(fromDirAbs)) {
      if (fs.existsSync(toDirAbs)) throw new Error('目标子笔记目录已存在');
      await fsp.rename(fromDirAbs, toDirAbs);
    }
  }
  return { from: toPosix(from), to: toPosix(to) };
}

async function deleteNote(notesDir, relPath) {
  const abs = safeResolve(notesDir, relPath);
  await fsp.unlink(abs);
  // 同名子笔记目录一并删除
  if (/\.[mM][dD]$/.test(abs)) {
    const dirAbs = abs.replace(/\.[mM][dD]$/, '');
    if (fs.existsSync(dirAbs)) await fsp.rm(dirAbs, { recursive: true, force: true });
  }
  return { relPath: toPosix(relPath) };
}

async function buildTree(notesDir, ignoreDirs) {
  const ignore = new Set(ignoreDirs || ['.git', 'node_modules', 'img', 'images', '.obsidian']);
  const root = {
    name: path.basename(notesDir),
    relPath: '',
    type: 'dir',
    children: [],
    noteCount: 0,
  };

  async function walk(dirAbs, dirRel, node, visited) {
    let entries;
    try {
      entries = await fsp.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    const dirs = [];
    const files = [];
    for (const e of entries) {
      if (e.isDirectory()) {
        if (ignore.has(e.name)) continue;
        dirs.push(e.name);
} else if (e.isFile()) {
      if (/\.md$/i.test(e.name) || /\.pdf$/i.test(e.name)) files.push(e.name);
    } else if (e.isSymbolicLink()) {
        // 同步盘（fnos_sync_data 等）中的文件可能是 reparse point / 符号链接
        const abs = path.join(dirAbs, e.name);
        let st;
        try {
          st = await fsp.stat(abs);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          if (ignore.has(e.name)) continue;
          let real;
          try {
            real = await fsp.realpath(abs);
          } catch {
            real = abs;
          }
          if (visited.has(real)) continue; // 防止符号链接目录形成环
          visited.add(real);
          dirs.push(e.name);
        } else if (st.isFile() && /\.md$/i.test(e.name)) {
          files.push(e.name);
        }
      }
    }
    // 与同名笔记对应的「子笔记目录」（如 父笔记.md 的子目录 父笔记/），将作为该笔记的子节点展示
    const subDirs = new Set(files.map((f) => f.replace(/\.md$/i, '')));
    dirs.sort((a, b) => a.localeCompare(b, 'zh-CN'));
    files.sort((a, b) => a.localeCompare(b, 'zh-CN'));
    for (const d of dirs) {
      if (subDirs.has(d)) continue; // 归入对应笔记的子节点，不再单独显示
      const childRel = dirRel ? `${dirRel}/${d}` : d;
      const child = { name: d, relPath: childRel, type: 'dir', children: [], noteCount: 0 };
      await walk(path.join(dirAbs, d), childRel, child, visited);
      node.children.push(child);
      node.noteCount += child.noteCount;
    }
    for (const f of files) {
      const base = f.replace(/\.md$/i, '');
      const childRel = dirRel ? `${dirRel}/${f}` : f;
      const child = { name: f, relPath: childRel, type: 'file' };
      if (subDirs.has(base)) {
        const subRel = dirRel ? `${dirRel}/${base}` : base;
        const subNode = { name: base, relPath: subRel, type: 'dir', children: [], noteCount: 0 };
        await walk(path.join(dirAbs, base), subRel, subNode, visited);
        child.children = subNode.children;
        child.noteCount = subNode.noteCount;
      }
      node.children.push(child);
      node.noteCount += 1 + (child.noteCount || 0);
    }
  }

  await walk(notesDir, '', root, new Set());
  return root;
}

// 列出某目录（相对 notesDir）下的所有笔记相对路径（含子目录）
async function walkMdRel(notesDir, dirRel) {
  const out = [];
  const abs = path.join(notesDir, dirRel || '');
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return out;
  async function rec(a, r, visited) {
    const reld = r ? r + '/' : '';
    let entries;
    try {
      entries = await fsp.readdir(a, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(a, e.name);
      if (e.isDirectory()) {
        await rec(full, reld + e.name, visited);
      } else if (e.isFile() && (/\.md$/i.test(e.name) || /\.pdf$/i.test(e.name))) {
        out.push(reld + e.name);
      } else if (e.isSymbolicLink()) {
        let st;
        try {
          st = await fsp.stat(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          let real;
          try {
            real = await fsp.realpath(full);
          } catch {
            real = full;
          }
          if (visited.has(real)) continue;
          visited.add(real);
          await rec(full, reld + e.name, visited);
        } else if (st.isFile() && (/\.md$/i.test(e.name) || /\.pdf$/i.test(e.name))) {
          out.push(reld + e.name);
        }
      }
    }
  }
  await rec(abs, '', new Set());
  return out;
}

module.exports = { safeResolve, toPosix, fromPosix, readNote, writeNote, moveNote, deleteNote, buildTree, walkMdRel };
