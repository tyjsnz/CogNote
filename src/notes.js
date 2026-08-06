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
  return { from: toPosix(from), to: toPosix(to) };
}

async function deleteNote(notesDir, relPath) {
  const abs = safeResolve(notesDir, relPath);
  await fsp.unlink(abs);
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

  async function walk(dirAbs, dirRel, node) {
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
      } else if (e.isFile() && /\.md$/i.test(e.name)) {
        files.push(e.name);
      }
    }
    dirs.sort((a, b) => a.localeCompare(b, 'zh-CN'));
    files.sort((a, b) => a.localeCompare(b, 'zh-CN'));
    for (const d of dirs) {
      const childRel = dirRel ? `${dirRel}/${d}` : d;
      const child = { name: d, relPath: childRel, type: 'dir', children: [], noteCount: 0 };
      await walk(path.join(dirAbs, d), childRel, child);
      node.children.push(child);
      node.noteCount += child.noteCount;
    }
    for (const f of files) {
      const childRel = dirRel ? `${dirRel}/${f}` : f;
      node.children.push({ name: f, relPath: childRel, type: 'file' });
      node.noteCount += 1;
    }
  }

  await walk(notesDir, '', root);
  return root;
}

module.exports = { safeResolve, toPosix, fromPosix, readNote, writeNote, moveNote, deleteNote, buildTree };
