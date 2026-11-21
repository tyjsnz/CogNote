#!/usr/bin/env node
/**
 * draw.io 编码一致性守卫（v1.1.2 空画布回归的防线）
 *
 * 背景：Cherry 的 drawio 集成把图形 XML 存进图片行的 `data-xml` 属性。
 * 写入侧曾有两种编码（新建插入 encodeURI / 二次编辑保存 encodeURIComponent），
 * 而读取侧统一 decodeURI —— decodeURI 无法还原 encodeURIComponent 转义的
 * 保留字符（= / & ? # 等），解析失败后 draw.io 画布是空的。
 *
 * 本脚本静态校验 vendor 产物里的三处关键实现，避免升级 vendor 时被覆盖回旧版本。
 * 用法：node scripts/test-drawio-encoding.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const cherry = path.join(root, 'public/vendor/cherry/dist/cherry-markdown.min.js');
const demo = path.join(root, 'public/vendor/drawio/assets/scripts/drawio-demo.js');

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => {
  if (cond) {
    pass++;
    console.log('  ✅ ' + name);
  } else {
    fail++;
    console.log('  ❌ ' + name + (extra ? ' — ' + extra : ''));
  }
};

console.log('\n[1] Cherry 读取侧：必须 decodeURIComponent（兼容两种历史形态）');
const cs = fs.readFileSync(cherry, 'utf8');
ok(
  /decodeURIComponent\(l\.getAttribute\("data-xml"\)\)/.test(cs),
  '点击编辑时用 decodeURIComponent 解码 data-xml'
);
const badRead = /[^a-zA-Z]decodeURI\(l\.getAttribute\("data-xml"\)\)/.test(cs);
ok(!badRead, '没有残留 decodeURI(data-xml) 旧实现');

console.log('\n[2] Cherry 写入侧：新建插入必须 encodeURIComponent');
ok(
  /data-type=drawio data-xml=[^;]*encodeURIComponent\(o\)/.test(cs),
  '工具栏新建 draw.io 时用 encodeURIComponent 编码'
);
const badWrite = /data-type=drawio data-xml=[^;]*[^a-zA-Z]encodeURI\(o\)/.test(cs);
ok(!badWrite, '没有残留 encodeURI(o) 旧实现');

console.log('\n[3] drawio-demo.js：setData 解析失败不得抛出，且必须应答');
const ds = fs.readFileSync(demo, 'utf8');
ok(
  /case 'setData':/.test(ds) && /try\s*\{[\s\S]*?parseXml\(value\)[\s\S]*?\}\s*catch/.test(ds),
  'setData 分支对 parseXml 有 try/catch 保护'
);
const setDataBlock = (ds.match(/case 'setData':[\s\S]*?break;/) || [''])[0];
ok(
  /setData:success/.test(setDataBlock),
  'setData 失败路径仍 postMessage 应答（避免父窗口挂起）'
);
ok(
  /parsererror/.test(setDataBlock),
  'setData 检测 parsererror 文档'
);

console.log('\n[4] 编码/解码对称性（Bug 的可执行证据）');
const xml = '<mxGraphModel dx="1" dy="1"><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';
ok(
  decodeURI(encodeURIComponent(xml)) !== xml,
  'decodeURI(encodeURIComponent(xml)) 不能还原（旧实现必然失败）'
);
ok(
  decodeURIComponent(encodeURIComponent(xml)) === xml,
  'decodeURIComponent(encodeURIComponent(xml)) 完整还原'
);
ok(
  decodeURIComponent(encodeURI(xml)) === xml,
  'decodeURIComponent 也能还原 encodeURI 形态（存量笔记兼容）'
);

console.log(`\n========== draw.io 编码守卫: ${pass} 通过, ${fail} 失败 ==========`);
process.exit(fail ? 1 : 0);
