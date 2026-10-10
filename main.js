'use strict';
/* AEGIS Sentinel — Electron main process */
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { fileURLToPath } = require('url');
const scanner = require('./lib/scanner');

let win = null;
const APP_HTML = path.resolve(__dirname, 'src', 'index.html');
const SCAN_SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_SCAN_SESSIONS = 8;
const scanSessions = new Map();
const appCatalog = new Map();

function isTrustedAppUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'file:' && path.resolve(fileURLToPath(url)) === APP_HTML;
  } catch { return false; }
}

function assertTrustedSender(event) {
  const frame = event && event.senderFrame;
  if (!win || !event || event.sender !== win.webContents || !frame || frame !== event.sender.mainFrame || !isTrustedAppUrl(frame.url)) {
    throw new Error('Untrusted IPC sender');
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 720,
    show: false,
    backgroundColor: '#07090B',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : { frame: false }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedAppUrl(url)) event.preventDefault();
  });
  win.webContents.on('will-redirect', (event, url) => {
    if (!isTrustedAppUrl(url)) event.preventDefault();
  });
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));

  win.loadFile(APP_HTML);
  win.once('ready-to-show', () => win && win.show());
  win.on('closed', () => {
    win = null;
    scanSessions.clear();
    appCatalog.clear();
  });
}

/* ------------------------------------------------------------- IPC API */

const wrap = (fn) => async (event, payload) => {
  try {
    assertTrustedSender(event);
    return { ok: true, data: await fn(payload) };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
};
const register = (channel, fn) => ipcMain.handle(channel, wrap(fn));

async function confirmNative(title, message, confirmLabel) {
  if (!win) return false;
  const result = await dialog.showMessageBox(win, {
    type: 'warning',
    title,
    message,
    buttons: [confirmLabel || 'Continue', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return result.response === 0;
}

function pruneScanSessions() {
  const now = Date.now();
  for (const [token, session] of scanSessions) if (session.expiresAt <= now) scanSessions.delete(token);
  while (scanSessions.size >= MAX_SCAN_SESSIONS) scanSessions.delete(scanSessions.keys().next().value);
}

register('sys:info', () => scanner.getSystemInfo());
register('disk:usage', () => scanner.getDiskUsage());
register('scan:quick', () => scanner.quickScan());
register('scan:files', async (options) => {
  const result = await scanner.scanFiles(options || {});
  pruneScanSessions();
  const scanToken = crypto.randomUUID();
  scanSessions.set(scanToken, {
    mode: result.mode,
    roots: result.roots,
    candidates: result.mode === 'junk' ? result.results : [],
    expiresAt: Date.now() + SCAN_SESSION_TTL_MS,
  });
  return { ...result, scanToken };
});
register('files:clean', async (payload) => {
  const token = payload && payload.scanToken;
  const paths = payload && payload.paths;
  const session = typeof token === 'string' ? scanSessions.get(token) : null;
  if (!session || session.expiresAt <= Date.now()) return { ok: false, error: 'Scan expired; scan again before cleaning' };
  if (session.mode !== 'junk') return { ok: false, error: 'Only old temporary/cache candidates can be moved to Trash' };
  if (!Array.isArray(paths) || !paths.length || paths.length > 200) return { ok: false, error: 'Select between 1 and 200 files' };
  const safePaths = await scanner.validateCleanCandidates(paths, session.candidates, session.roots);
  const confirmed = await confirmNative('Move files to Trash', `Move ${safePaths.length} old cleanup candidate(s) to the system Trash?`, 'Move to Trash');
  if (!confirmed) return { removed: 0, failed: 0, bytes: 0, cancelled: true };
  if (session.expiresAt <= Date.now()) return { ok: false, error: 'Scan expired during confirmation; scan again before cleaning' };
  // Recheck after the user dialog and immediately before each Trash operation.
  const currentPaths = await scanner.validateCleanCandidates(safePaths, session.candidates, session.roots);
  scanSessions.delete(token);
  const byPath = new Map(session.candidates.map((candidate) => [path.resolve(candidate.path), candidate]));
  let removed = 0;
  let failed = 0;
  let bytes = 0;
  for (const fullPath of currentPaths) {
    try {
      if (session.expiresAt <= Date.now()) throw new Error('Scan session expired');
      const [revalidated] = await scanner.validateCleanCandidates([fullPath], session.candidates, session.roots);
      await shell.trashItem(revalidated);
      removed++;
      bytes += Number((byPath.get(path.resolve(revalidated)) || {}).size) || 0;
    } catch { failed++; }
  }
  return { removed, failed, bytes };
});
register('proc:list', () => scanner.getProcessSnapshot());
register('proc:kill', async (payload) => {
  const pid = Number(payload && payload.pid);
  if (!Number.isSafeInteger(pid) || pid <= 4) return { ok: false, error: 'Invalid or protected PID' };
  const snapshot = await scanner.getProcessSnapshot();
  const target = snapshot.available ? snapshot.items.find((process) => process.pid === pid) : null;
  if (!target || !target.canStop) return { ok: false, error: 'Process no longer exists or is protected' };
  const name = String(target.name || 'unknown process').slice(0, 120);
  const executable = String(target.path || 'path unavailable').slice(0, 200);
  const confirmed = await confirmNative('Stop process', `Send a termination request to ${name} (PID ${pid})?\nExecutable: ${executable}\nUnsaved data may be lost.`, 'Stop process');
  return confirmed ? scanner.killProcess(pid, { name: target.name, path: target.path, startId: target.startId }) : { ok: false, error: 'Cancelled' };
});
register('apps:list', async () => {
  const apps = await scanner.getInstalledApps();
  appCatalog.clear();
  return apps.map((application) => {
    const id = crypto.randomUUID();
    appCatalog.set(id, application);
    return {
      id,
      name: String(application.name || '').slice(0, 256),
      version: String(application.version || '').slice(0, 128),
      publisher: String(application.publisher || '').slice(0, 256),
      installDate: String(application.installDate || '').slice(0, 64),
      size: Number(application.size) || 0,
      flags: Array.isArray(application.flags) ? application.flags.slice(0, 12).map((flag) => ({ label: String(flag.label || '').slice(0, 100), sev: ['high', 'medium', 'low'].includes(flag.sev) ? flag.sev : 'low' })) : [],
      canUninstall: scanner.canUninstallApp(application),
    };
  });
});
register('apps:uninstall', async (payload) => {
  const id = payload && payload.id;
  const application = typeof id === 'string' ? appCatalog.get(id) : null;
  if (!application || !scanner.canUninstallApp(application)) return { ok: false, error: 'Application is no longer available or has no safe uninstall method' };
  const confirmed = await confirmNative('Uninstall application', `Run the registered uninstall method for “${String(application.name).slice(0, 160)}”?`, 'Uninstall');
  if (!confirmed) return { ok: false, error: 'Cancelled' };
  let result;
  if (process.platform === 'darwin' && application.uninstallMethod === 'app-bundle') {
    if (!scanner.isSafeAppBundlePath(application.path)) return { ok: false, error: 'Refusing to remove an application outside Applications folders' };
    try {
      await shell.trashItem(application.path);
      result = { ok: true, error: null };
    } catch (err) {
      result = { ok: false, error: err.message || 'Could not move application to Trash' };
    }
  } else result = await scanner.uninstallApp(application);
  if (result.ok) appCatalog.delete(id);
  return result;
});
register('net:list', () => scanner.getNetworkAssessment());
register('persist:list', () => scanner.getPersistenceAssessment());
register('fw:status', () => scanner.getFirewall());
register('fw:enable', async () => {
  const confirmed = await confirmNative('Enable firewall', 'This changes system network filtering and may affect connectivity. Continue?', 'Enable firewall');
  return confirmed ? scanner.enableFirewall() : { ok: false, error: 'Cancelled' };
});
register('enc:status', () => scanner.getEncryption());
register('updates:check', () => scanner.getUpdates());
register('updates:install', async () => {
  const confirmed = await confirmNative('Install operating-system updates', 'Install all updates offered by the operating system? A restart may be required.', 'Install updates');
  return confirmed ? scanner.installUpdates() : { ok: false, error: 'Cancelled' };
});
register('errors:list', () => scanner.getSystemErrors());
register('dialog:pickDir', async () => {
  if (!win) throw new Error('No application window');
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths;
});
const REPORT_CHECK_TITLES = new Set([
  'Firewall service and inbound policy', 'System-volume encryption', 'Operating-system updates',
  'System error log (24h)', 'Process risk indicators', 'System disk space', 'Non-loopback listening endpoints',
  'Cross-sensor listener risk correlation', 'Startup and service persistence',
]);
const boundedNumber = (value, max) => value == null || value === '' ? null : Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.min(Math.floor(Number(value)), max) : null;
function makeReportSummary(input) {
  const system = input.system && typeof input.system === 'object' ? input.system : {};
  const posture = input.posture && typeof input.posture === 'object' ? input.posture : {};
  const counts = input.counts && typeof input.counts === 'object' ? input.counts : {};
  const grades = new Set(['S', 'A', 'B', 'C', 'D']);
  const checks = Array.isArray(input.checks) ? input.checks.slice(0, 9).flatMap((item) => {
    if (!item || !REPORT_CHECK_TITLES.has(item.title) || !['ok', 'warn', 'crit'].includes(item.status)) return [];
    return [{ title: item.title, status: item.status }];
  }) : [];
  return {
    app: 'AEGIS Sentinel',
    version: String(input.version || '').slice(0, 32),
    generatedAt: String(input.generatedAt || '').slice(0, 64),
    system: {
      platformLabel: ['Windows', 'macOS', 'Linux'].includes(system.platformLabel) ? system.platformLabel : 'Unknown',
      osCaption: String(system.osCaption || 'Unknown').slice(0, 100),
      arch: String(system.arch || 'Unknown').slice(0, 32),
      cpus: boundedNumber(system.cpus, 4096),
      totalRam: boundedNumber(system.totalRam, Number.MAX_SAFE_INTEGER),
    },
    posture: posture.score != null && posture.score !== '' && Number.isFinite(Number(posture.score)) ? {
      score: Math.max(0, Math.min(100, Math.round(Number(posture.score)))),
      grade: grades.has(posture.grade) ? posture.grade : 'D',
      disclaimer: 'Heuristic posture indicator only; not an antivirus or a guarantee of security.',
    } : null,
    checks,
    counts: {
      pendingUpdates: boundedNumber(counts.pendingUpdates, 10000000),
      recentErrorEvents: boundedNumber(counts.recentErrorEvents, 10000000),
      processRiskSignals: boundedNumber(counts.processRiskSignals, 10000000),
      listeningEndpoints: boundedNumber(counts.listeningEndpoints, 10000000),
      externallyBoundEndpoints: boundedNumber(counts.externallyBoundEndpoints, 10000000),
      correlatedRiskListeners: boundedNumber(counts.correlatedRiskListeners, 10000000),
      unattributedListeners: boundedNumber(counts.unattributedListeners, 10000000),
      startupItems: boundedNumber(counts.startupItems, 10000000),
      riskStartupItems: boundedNumber(counts.riskStartupItems, 10000000),
      riskStartupItemsWithListeners: boundedNumber(counts.riskStartupItemsWithListeners, 10000000),
      riskStartupItemsWithListenerCandidates: boundedNumber(counts.riskStartupItemsWithListenerCandidates, 10000000),
      startupInventoryPartial: counts.startupInventoryPartial === true ? true : counts.startupInventoryPartial === false ? false : null,
    },
    privacyNote: 'This summary omits hostname, username, file paths, process names, service/startup names and commands, remote IP addresses, and raw log messages.',
  };
}
register('report:save', async (report) => {
  if (!win) throw new Error('No application window');
  if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('Invalid report');
  const content = JSON.stringify(makeReportSummary(report), null, 2);
  if (Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) throw new Error('Report exceeds the 2 MB safety limit');
  const result = await dialog.showSaveDialog(win, {
    defaultPath: 'aegis-sentinel-report.json',
    filters: [{ name: 'JSON report', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return null;
  fs.writeFileSync(result.filePath, content, { encoding: 'utf8', mode: 0o600 });
  return result.filePath;
});
register('win:minimize', () => { if (win) win.minimize(); });
register('win:toggleMax', () => { if (win) win.isMaximized() ? win.unmaximize() : win.maximize(); });
register('win:close', () => { if (win) win.close(); });

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
