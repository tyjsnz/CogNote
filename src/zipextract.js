// 零依赖 zip 解压（仅支持 store / deflate，足够覆盖本项目发行包）
// 用于自动更新：不依赖系统 unzip/tar（Windows 无 unzip、Linux GNU tar 不认 zip）
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// 从尾部搜索 EOCD（End of Central Directory）签名 0x06054b50
function findEOCD(buf) {
  const min = Math.max(0, buf.length - 65557); // 22 + 最大注释长度 65535
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('不是有效的 zip 文件（未找到目录结束标记）');
}

/**
 * 解压 zip 到目标目录
 * @param {string} zipPath zip 文件路径
 * @param {string} destDir 目标目录（不存在则创建）
 * @returns {string[]} 解压出的文件相对路径列表（不含目录项）
 */
function extractZip(zipPath, destDir) {
  const buf = fs.readFileSync(zipPath);
  const eocd = findEOCD(buf);
  const count = buf.readUInt16LE(eocd + 10);      // 中央目录条目数
  let off = buf.readUInt32LE(eocd + 16);          // 中央目录偏移
  const destRoot = path.resolve(destDir);
  const files = [];

  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) {
      throw new Error('zip 中央目录损坏');
    }
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    off += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue; // 目录项

    // 本地文件头 → 数据实际偏移
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) {
      throw new Error('zip 本地头损坏: ' + name);
    }
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataOff = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataOff, dataOff + compSize);

    let data;
    if (method === 0) data = raw;                              // store
    else if (method === 8) data = zlib.inflateRawSync(raw);    // deflate
    else throw new Error(`不支持的压缩方式 ${method}: ${name}`);

    const target = path.resolve(destRoot, name);
    // 防 zip slip（路径穿越）
    if (target !== destRoot && !target.startsWith(destRoot + path.sep)) {
      throw new Error('非法路径（zip slip）: ' + name);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    files.push(name);
  }
  if (!files.length) throw new Error('zip 中没有文件');
  return files;
}

module.exports = { extractZip };
