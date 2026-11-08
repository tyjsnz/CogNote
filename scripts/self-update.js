#!/usr/bin/env node
// Cognote 自动更新执行器
// 由 server.js 的 /api/update/apply 以 detached 方式启动，职责：
//   1. 等待主服务进程退出（避免端口/文件占用）
//   2. 备份将被覆盖的应用文件到 .update-backup/<旧版本>/
//   3. 删除上一版存在、新版已废弃的应用文件（依据 .update-files.json 清单）
//   4. 用 staging 中的新文件覆盖应用目录（只覆盖清单内文件，绝不触碰 config/索引/笔记数据）
//   5. 重启服务并等待端口可用；失败则自动回滚到旧版本再重启
//   6. 写 .update-result.json 供前端轮询读取
//
// 参数：process.argv[2] = JSON 字符串
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

let ARG = {};
try { ARG = JSON.parse(process.argv[2] || '{}'); } catch { /* 参数错误会立即写结果退出 */ }

const { parentPid, appRoot, staging, tmpDir, backup, fromVersion, toVersion, port } = ARG;
const RESULT_PATH = path.join(appRoot || '.', '.update-result.json');
const FILELIST_PATH = path.join(appRoot || '.', '.update-files.json');
const LOG_PATH = path.join(appRoot || '.', 'update.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch { /* 日志失败不阻断 */ }
  console.log('[update] ' + msg);
}

function writeResult(obj) {
  try {
    fs.writeFileSync(RESULT_PATH, JSON.stringify({ ...obj, from: fromVersion, to: toVersion, ts: Date.now() }, null, 2));
  } catch (e) { log('写结果文件失败: ' + e.message); }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitParentExit(pid, timeoutMs = 30000) {
  if (!pid) return true;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') return true; }
    await sleep(300);
  }
  return false;
}

// 递归列出目录内文件（相对路径，posix 分隔）
function listFiles(dir, prefix = '') {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const rel = prefix ? prefix + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...listFiles(path.join(dir, e.name), rel));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

// 把 staging 中的文件复制到应用目录
function applyFiles(files) {
  for (const rel of files) {
    copyFile(path.join(staging, rel), path.join(appRoot, rel));
  }
}

// 从备份恢复被覆盖的文件（回滚）
function rollback(backupDir, files) {
  let n = 0;
  for (const rel of files) {
    const src = path.join(backupDir, rel);
    if (fs.existsSync(src)) { copyFile(src, path.join(appRoot, rel)); n++; }
  }
  return n;
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

// 启动服务（detached，独立于本进程）
function restartServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: appRoot,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env: process.env,
  });
  child.unref();
  return child.pid;
}

// 等待端口可连接（服务起来了）
function waitPortUp(p, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tryOnce = () => {
      const sock = net.connect({ host: '127.0.0.1', port: p });
      sock.setTimeout(1000);
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', () => { sock.destroy(); retry(); });
      sock.once('timeout', () => { sock.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() - t0 >= timeoutMs) return resolve(false);
      setTimeout(tryOnce, 500);
    };
    tryOnce();
  });
}

async function main() {
  if (!appRoot || !staging || !toVersion) {
    log('参数不完整: ' + JSON.stringify(ARG));
    writeResult({ ok: false, error: '更新器参数不完整' });
    process.exit(1);
  }
  log(`开始更新 v${fromVersion} → v${toVersion}（父进程 pid=${parentPid}）`);

  // 1. 等主进程退出
  const exited = await waitParentExit(parentPid);
  if (!exited) {
    log('等待主进程退出超时');
    writeResult({ ok: false, error: '等待旧服务退出超时，未执行更新' });
    process.exit(1);
  }
  log('旧服务已退出');

  // 2. 备份 + 覆盖
  const backupDir = path.join(backup, `v${fromVersion || 'unknown'}`);
  const newFiles = listFiles(staging);
  if (!newFiles.length || !newFiles.includes('server.js')) {
    log('staging 内容异常: ' + JSON.stringify(newFiles.slice(0, 5)));
    writeResult({ ok: false, error: '更新包内容异常（缺少 server.js）' });
    process.exit(1);
  }

  const oldList = readJson(FILELIST_PATH) || [];
  const newSet = new Set(newFiles);
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    const backed = [];
    for (const rel of newFiles) {                 // 备份将被覆盖的文件
      const cur = path.join(appRoot, rel);
      if (fs.existsSync(cur)) { copyFile(cur, path.join(backupDir, rel)); backed.push(rel); }
    }
    log(`已备份 ${backed.length} 个文件 → ${backupDir}`);

    // 3. 删除上一版存在、新版已废弃的应用文件（仅限旧清单内，数据文件永不涉及）
    let removed = 0;
    for (const rel of oldList) {
      if (newSet.has(rel)) continue;
      const cur = path.join(appRoot, rel);
      try { if (fs.existsSync(cur)) { fs.unlinkSync(cur); removed++; } } catch (e) { log('删除废弃文件失败 ' + rel + ': ' + e.message); }
    }
    if (removed) log(`清理废弃文件 ${removed} 个`);

    // 4. 覆盖
    applyFiles(newFiles);
    fs.writeFileSync(FILELIST_PATH, JSON.stringify(newFiles, null, 2));
    log(`已覆盖 ${newFiles.length} 个应用文件`);
  } catch (e) {
    // 覆盖失败 → 回滚
    log('覆盖失败，开始回滚: ' + e.message);
    try { rollback(backupDir, newFiles.filter((r) => fs.existsSync(path.join(backupDir, r)))); } catch (e2) { log('回滚失败: ' + e2.message); }
    cleanupStaging();
    const pid = restartServer();
    writeResult({ ok: false, error: '写入更新文件失败: ' + e.message, restarted: !!pid });
    process.exit(1);
  }

  cleanupStaging();

  // 5. 重启并等待端口可用；失败则回滚旧版本
  let pid = null;
  try { pid = restartServer(); } catch (e) { log('重启失败: ' + e.message); }
  log('已发起重启 pid=' + pid);
  const up = await waitPortUp(Number(port) || 8570, 30000);
  if (up) {
    log('新版本服务已启动 ✓');
    writeResult({ ok: true, restarted: true, files: newFiles.length });
    process.exit(0);
  }

  // 新版本起不来 → 回滚旧版本并重启
  log('新版本服务未能启动，回滚到 v' + fromVersion);
  try { rollback(backupDir, oldList.filter((r) => fs.existsSync(path.join(backupDir, r)))); } catch (e) { log('回滚失败: ' + e.message); }
  try { fs.writeFileSync(FILELIST_PATH, JSON.stringify(oldList, null, 2)); } catch { /* 忽略 */ }
  let pid2 = null;
  try { pid2 = restartServer(); } catch (e) { log('回滚重启失败: ' + e.message); }
  writeResult({ ok: false, error: '新版本服务启动失败，已自动回滚到 v' + fromVersion + (pid2 ? '' : '（回滚重启也失败，请手动启动）'), restarted: !!pid2 });
  process.exit(1);
}

function cleanupStaging() {
  const dir = tmpDir || path.dirname(staging);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { log('清理临时目录失败: ' + e.message); }
}

main().catch((e) => {
  log('更新器异常: ' + (e && e.stack || e));
  writeResult({ ok: false, error: '更新器异常: ' + (e && e.message) });
  process.exit(1);
});
