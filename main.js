'use strict';
/* AEGIS Sentinel — Electron main process */
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const scanner = require('./lib/scanner');

let win = null;

const licenseFile = () => path.join(app.getPath('userData'), 'license.json');

function getLicense() {
  try {
    const l = JSON.parse(fs.readFileSync(licenseFile(), 'utf8'));
    if (l && l.tier === 'pro' && l.key) return l;
  } catch { /* no license yet */ }
  return { tier: 'free', key: null, since: null };
}

function setLicense(license) {
  fs.mkdirSync(path.dirname(licenseFile()), { recursive: true });
  fs.writeFileSync(licenseFile(), JSON.stringify(license));
  return license;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 720,
    show: false,
    backgroundColor: '#07090B',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' }
      : { frame: false }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
}

/* ------------------------------------------------------------- IPC API */

const wrap = (fn) => async (_e, payload) => {
  try { return { ok: true, data: await fn(payload) }; }
  catch (err) { return { ok: false, error: String(err && err.message || err) }; }
};

ipcMain.handle('sys:info', wrap(() => scanner.getSystemInfo()));
ipcMain.handle('disk:usage', wrap(() => scanner.getDiskUsage()));
ipcMain.handle('scan:quick', wrap(() => scanner.quickScan()));
ipcMain.handle('scan:files', wrap((o) => scanner.scanFiles(o || {})));
ipcMain.handle('files:clean', wrap((o) => scanner.cleanFiles(o && o.paths)));
ipcMain.handle('proc:list', wrap(() => scanner.getProcesses()));
ipcMain.handle('proc:kill', wrap((o) => scanner.killProcess(o && o.pid)));
ipcMain.handle('apps:list', wrap(() => scanner.getInstalledApps()));
ipcMain.handle('apps:uninstall', wrap((o) => scanner.uninstallApp(o && o.app)));
ipcMain.handle('net:list', wrap(() => scanner.getNetwork()));
ipcMain.handle('fw:status', wrap(() => scanner.getFirewall()));
ipcMain.handle('fw:enable', wrap(() => scanner.enableFirewall()));
ipcMain.handle('enc:status', wrap(() => scanner.getEncryption()));
ipcMain.handle('updates:check', wrap(() => scanner.getUpdates()));
ipcMain.handle('updates:install', wrap(() => scanner.installUpdates()));
ipcMain.handle('errors:list', wrap(() => scanner.getSystemErrors()));

ipcMain.handle('license:get', async () => ({ ok: true, data: getLicense() }));
ipcMain.handle('license:set', async (_e, license) => ({ ok: true, data: setLicense(license) }));

ipcMain.handle('dialog:pickDir', async () => {
  if (!win) return { ok: false, error: 'no window' };
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return { ok: true, data: r.canceled ? null : r.filePaths };
});

ipcMain.handle('report:save', async (_e, report) => {
  if (!win) return { ok: false, error: 'no window' };
  const r = await dialog.showSaveDialog(win, {
    defaultPath: 'aegis-sentinel-report.json',
    filters: [{ name: 'JSON report', extensions: ['json'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false, error: 'cancelled' };
  fs.writeFileSync(r.filePath, JSON.stringify(report, null, 2));
  return { ok: true, data: r.filePath };
});

ipcMain.handle('win:minimize', () => { if (win) win.minimize(); });
ipcMain.handle('win:toggleMax', () => { if (win) { win.isMaximized() ? win.unmaximize() : win.maximize(); } });
ipcMain.handle('win:close', () => { if (win) win.close(); });

/* ------------------------------------------------------------ lifecycle */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}
