// Cognote 桌面版（Electron 主进程）
// 职责：启动内置 Node 服务 → 原生窗口加载本地页面 → 原生菜单/单实例/窗口状态记忆
// 现有 Web 端功能（笔记/搜索/双链/AI/同步/分享）完全复用，无需改动前端
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

app.setName('Cognote'); // 需在 ready 前设置，保证 userData 路径稳定

const SMOKE = process.argv.includes('--smoke');
const DEV = !app.isPackaged;

// 打包后应用文件位于 resources/app（asar 关闭，便于读取/更新）
const APP_ROOT = app.isPackaged ? path.join(process.resourcesPath, 'app') : path.join(__dirname, '..');

let mainWindow = null;
let serverChild = null;
let quitting = false;
let serverUrl = '';

// ---------- 窗口尺寸记忆 ----------
function statePath() { return path.join(app.getPath('userData'), 'window-state.json'); }

function loadWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    if (Number.isFinite(s.width) && Number.isFinite(s.height)) return s;
  } catch { /* 首次运行 */ }
  return { width: 1280, height: 860 };
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
  try {
    const b = mainWindow.getBounds();
    fs.writeFileSync(statePath(), JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height }), 'utf8');
  } catch { /* 忽略 */ }
}

// ---------- 内置服务 ----------
function startServer() {
  return new Promise((resolve, reject) => {
    const dataDir = app.getPath('userData');
    try { fs.mkdirSync(dataDir, { recursive: true }); } catch { /* ignore */ }
    const child = spawn(process.execPath, [path.join(APP_ROOT, 'server.js')], {
      cwd: APP_ROOT,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',   // 用 Electron 自带 Node 运行现有服务端
        COGNOTE_DESKTOP: '1',        // 数据写用户目录、不弹浏览器
        KB_DATA_DIR: dataDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    serverChild = child;

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('服务启动超时（30 秒）'));
    }, 30000);

    const onLine = (buf) => {
      const text = String(buf);
      process.stdout.write(text);
      const m = text.match(/已启动:\s*(http:\/\/[^\s]+)/);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        serverUrl = m[1];
        resolve(serverUrl);
      }
    };
    child.stdout.on('data', onLine);
    child.stderr.on('data', (buf) => process.stderr.write(String(buf)));
    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error('服务进程退出（code=' + code + '）'));
      } else if (!quitting) {
        dialog.showErrorBox('Cognote 服务已停止', '内置服务异常退出（code=' + code + '），应用将关闭。');
        app.quit();
      }
    });
  });
}

function stopServer() {
  if (!serverChild || serverChild.killed) return;
  try { serverChild.kill(); } catch { /* ignore */ }
}

// ---------- 菜单（保证 Cmd/Ctrl+C/V 等原生编辑快捷键可用） ----------
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about', label: '关于 Cognote' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏 Cognote' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: '退出 Cognote' },
      ],
    }] : []),
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        ...(DEV ? [{ role: 'toggleDevTools', label: '开发者工具' }] : []),
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'close', label: '关闭' },
        ...(isMac ? [{ role: 'front', label: '前置全部窗口' }] : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- 主窗口 ----------
function createWindow() {
  const st = loadWindowState();
  mainWindow = new BrowserWindow({
    width: st.width,
    height: st.height,
    x: st.x,
    y: st.y,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Cognote',
    backgroundColor: '#f6f8fa',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => { mainWindow.show(); });

  // 站外链接交给系统浏览器；站内导航保持在应用内
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (serverUrl && url.startsWith(serverUrl)) return;
    if (/^https?:/i.test(url)) { event.preventDefault(); shell.openExternal(url); }
  });

  mainWindow.on('close', saveWindowState);
  mainWindow.on('closed', () => { mainWindow = null; });

  // 已有服务地址时（mac 上重新打开窗口）直接加载
  if (serverUrl) mainWindow.loadURL(serverUrl);

  return mainWindow;
}

// ---------- 生命周期 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    buildMenu();
    const win = createWindow();
    // 先显示一个轻量启动页，服务就绪后切换
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      '<html><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;' +
      'font:14px -apple-system,BlinkMacSystemFont,\'PingFang SC\',sans-serif;color:#57606a;background:#f6f8fa">' +
      '正在启动 Cognote…</body></html>'));
    try {
      const url = await startServer();
      await win.loadURL(url);
      if (SMOKE) {
        const title = await win.webContents.executeJavaScript('document.title').catch(() => '');
        const hasApp = await win.webContents.executeJavaScript('!!document.querySelector("#topbar")').catch(() => false);
        console.log('SMOKE_RESULT ' + JSON.stringify({ url, title, hasApp }));
        setTimeout(() => app.quit(), 300);
      }
    } catch (e) {
      dialog.showErrorBox('Cognote 启动失败', String(e && e.message || e));
      app.quit();
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => { quitting = true; saveWindowState(); stopServer(); });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  process.on('exit', stopServer);
}
