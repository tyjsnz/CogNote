/**
 * 命令行：重新扫描笔记目录并打印索引统计
 * 用法：node scripts/rescan.js [笔记目录]
 */
const path = require('node:path');
const fs = require('node:fs');
const { Indexer } = require('../src/indexer');

const ROOT = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

const notesDir = process.argv[2] ? path.resolve(process.argv[2]) : config.notesDir;

console.log('笔记目录:', notesDir);
if (!fs.existsSync(notesDir)) {
  console.error('目录不存在');
  process.exit(1);
}

const indexer = new Indexer(notesDir, { ...config.index, ignoreDirs: config.index.ignoreDirs });
const info = indexer.scan();
const stats = indexer.stats();

console.log(`扫描完成: ${stats.total} 篇笔记, ${stats.errors} 个读取错误`);
console.log(`忽略目录: ${[...indexer.ignoreDirs].join(', ')}`);
console.log('高频标签:');
for (const [tag, n] of stats.topTags.slice(0, 15)) {
  console.log(`  ${tag}  (${n})`);
}
console.log('高频标签词云（按出现笔记数）:', stats.topTags.length);
