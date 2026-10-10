'use strict';
/*
 * AEGIS Sentinel — core scanning engine
 * Pure Node.js (no Electron dependency). Works on Windows / macOS / Linux.
 * Standalone test:  node lib/scanner.js [--json]
 */
const os = require('os');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const PLATFORM = process.platform;
const IS_WIN = PLATFORM === 'win32';
const IS_MAC = PLATFORM === 'darwin';
const IS_LINUX = PLATFORM === 'linux';
const CMD_TIMEOUT = 25000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- helpers */

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, {
        timeout: opts.timeout || CMD_TIMEOUT,
        maxBuffer: 128 * 1024 * 1024,
        windowsHide: true,
      }, (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err ? (err.code == null ? 1 : err.code) : 0,
          stdout: stdout || '',
          stderr: (stderr || '').slice(0, 4000),
        });
      });
    } catch (e) {
      resolve({ ok: false, code: 1, stdout: '', stderr: String(e) });
    }
  });
}

const ps = (script, timeout) =>
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: timeout || CMD_TIMEOUT });

function parseJsonLoose(text) {
  if (!text) return null;
  let t = String(text).replace(/^﻿/, '').trim();
  const candidates = [t.indexOf('['), t.indexOf('{')].filter((i) => i >= 0);
  if (!candidates.length) return null;
  t = t.slice(Math.min(...candidates));
  try { return JSON.parse(t); } catch { /* trim trailing noise */ }
  const last = Math.max(t.lastIndexOf(']'), t.lastIndexOf('}'));
  try { return JSON.parse(t.slice(0, last + 1)); } catch { return null; }
}

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n >= 100 ? 0 : 1) + ' ' + u[i];
}

/* ------------------------------------------------------------ system info */

async function getSystemInfo() {
  let user = 'unknown';
  try { user = os.userInfo().username; } catch { /* ignore */ }
  const base = {
    hostname: os.hostname(),
    platform: PLATFORM,
    platformLabel: IS_WIN ? 'Windows' : IS_MAC ? 'macOS' : 'Linux',
    arch: os.arch(),
    release: os.release(),
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0] ? os.cpus()[0].model : 'Unknown CPU',
    totalRam: os.totalmem(),
    freeRam: os.freemem(),
    uptimeSec: os.uptime(),
    user,
    homedir: os.homedir(),
    osCaption: '',
    osBuild: '',
    machineModel: '',
    gpu: '',
  };
  try {
    if (IS_WIN) {
      const r = await ps([
        '$o = Get-CimInstance Win32_OperatingSystem;',
        '$c = Get-CimInstance Win32_ComputerSystem;',
        '$g = Get-CimInstance Win32_VideoController | Select-Object -First 1;',
        '[pscustomobject]@{ Caption = $o.Caption; Build = $o.BuildNumber; Version = $o.Version;',
        '  Manufacturer = $c.Manufacturer; Model = $c.Model; GPU = $g.Name } | ConvertTo-Json -Compress',
      ].join('\n'));
      const j = parseJsonLoose(r.stdout);
      if (j) {
        base.osCaption = j.Caption || '';
        base.osBuild = String(j.Build || '');
        base.machineModel = ((j.Manufacturer || '') + ' ' + (j.Model || '')).trim();
        base.gpu = j.GPU || '';
      }
    } else if (IS_MAC) {
      const v = await run('sw_vers', ['-productVersion']);
      const nm = await run('sw_vers', ['-productName']);
      const model = await run('sysctl', ['-n', 'hw.model']);
      const brand = await run('sysctl', ['-n', 'machdep.cpu.brand_string']);
      base.osCaption = ((nm.stdout.trim() || 'macOS') + ' ' + v.stdout.trim()).trim();
      base.machineModel = model.stdout.trim();
      if (brand.stdout.trim()) base.cpuModel = brand.stdout.trim();
      const gpu = await run('system_profiler', ['SPDisplaysDataType']);
      const gm = gpu.stdout.match(/Chipset Model:\s*(.+)/);
      if (gm) base.gpu = gm[1].trim();
    } else {
      let pretty = '';
      try {
        const osr = await fsp.readFile('/etc/os-release', 'utf8');
        const m = osr.match(/PRETTY_NAME="?([^"\n]+)"?/);
        pretty = m ? m[1] : '';
      } catch { /* ignore */ }
      base.osCaption = pretty || ('Linux ' + os.release());
      const cpu = await run('lscpu', []);
      const mm = cpu.stdout.match(/Model name:\s*(.+)/);
      if (mm) base.cpuModel = mm[1].trim();
      const gpu = await run('lspci', ['-nn']);
      base.gpu = gpu.stdout.split('\n')
        .filter((line) => /vga|3d controller|display controller/i.test(line))
        .slice(0, 3).map((line) => line.trim()).filter(Boolean).join(' | ');
    }
  } catch (e) {
    base.infoError = String(e);
  }
  return base;
}

async function getDiskUsage() {
  if (IS_WIN) {
    const r = await ps([
      'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" |',
      'Select-Object DeviceID, VolumeName, @{n="Size";e={[int64]$_.Size}}, @{n="Free";e={[int64]$_.FreeSpace}} |',
      'ConvertTo-Json -Compress',
    ].join('\n'));
    if (!r.ok) return [];
    const j = parseJsonLoose(r.stdout);
    const arr = Array.isArray(j) ? j : (j ? [j] : []);
    const systemDrive = String(process.env.SystemDrive || 'C:').toLowerCase();
    return arr.map((d) => {
      const device = String(d.DeviceID || '').toUpperCase();
      const size = Number(d.Size) || 0;
      const free = Number(d.Free) || 0;
      return { device: device + '\\', mount: device + '\\', label: d.VolumeName || device, size, free, used: size - free, isSystem: device.toLowerCase() === systemDrive };
    });
  }
  const mounts = [...new Set(['/', os.homedir()].filter(Boolean))];
  const out = [];
  const seen = new Set();
  for (const mount of mounts) {
    const r = await run('df', ['-k', '-P', mount]);
    if (!r.ok) continue;
    for (const line of r.stdout.trim().split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) continue;
      const size = parseInt(parts[1], 10) * 1024;
      const used = parseInt(parts[2], 10) * 1024;
      const actualMount = parts[5];
      const key = parts[0] + '\0' + actualMount;
      if (!Number.isFinite(size) || !Number.isFinite(used) || seen.has(key)) continue;
      seen.add(key);
      out.push({ device: parts[0], mount: actualMount, label: actualMount, size, used, free: size - used, isSystem: actualMount === '/' });
    }
  }
  return out;
}

/* ------------------------------------------------------------- processes */

const MINER_RE = /xmrig|minerd|cpuminer|nicehash|kdevtmpfsi|kinsing|watchbog|ddgs|stratum|minergate|hashvault|cryptonight|lolminer|nbminer|t-rex miner/i;
const TEMP_DIR_RE = /(\\Temp\\|\\AppData\\Local\\Temp|(^|\\)Temp\\|(^|\/)tmp\/|(^|\/)var\/tmp\/|(^|\/)dev\/shm\/|(^|\/)Library\/Caches\/)/i;
const CRITICAL_PROCESS_RE = /^(system|system idle process|smss|csrss|wininit|winlogon|services|lsass|svchost|systemd|init|launchd|kernel_task)$/i;

function isWithin(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

function suspicion(p) {
  const reasons = [];
  let score = 0;
  if (p.path && TEMP_DIR_RE.test(p.path)) {
    score += 35;
    reasons.push('Executable located in a temporary/cache directory (heuristic)');
  }
  if (MINER_RE.test((p.name || '') + ' ' + (p.path || ''))) {
    score += 55;
    reasons.push('Name matches a cryptominer keyword (heuristic; not a malware verdict)');
  }
  if ((p.cpu || 0) >= 80) {
    score += 15;
    reasons.push('High measured CPU usage');
  } else if ((p.cpu || 0) >= 50) {
    score += 7;
    reasons.push('Elevated measured CPU usage');
  }
  if ((p.memBytes || 0) > 2 * 1024 ** 3) {
    score += 8;
    reasons.push('Large memory footprint');
  }
  if (!p.path) {
    score += 5;
    reasons.push('Executable path unavailable');
  }
  if (/^(werfault|svchost|csrss|lsass)$/i.test((p.name || '').replace(/\.exe$/i, '')) && p.path) {
    const root = String(process.env.SystemRoot || 'C:\\Windows').replace(/[\\/]+$/, '').toLowerCase();
    const candidate = path.win32.normalize(p.path).toLowerCase();
    if (candidate !== root && !candidate.startsWith(root + '\\')) {
      score += 35;
      reasons.push('Critical Windows process name outside the Windows directory');
    }
  }
  score = Math.min(score, 100);
  const level = score >= 70 ? 'critical' : score >= 35 ? 'high' : score > 0 ? 'medium' : 'clean';
  return { score, reasons, level };
}

async function linuxCpuSnapshot(pids) {
  let total = 0;
  try {
    const stat = await fsp.readFile('/proc/stat', 'utf8');
    const cpu = stat.split('\n').find((line) => /^cpu\s/.test(line));
    if (!cpu) return null;
    total = cpu.trim().split(/\s+/).slice(1).reduce((sum, value) => sum + (Number(value) || 0), 0);
  } catch { return null; }
  const processes = new Map();
  await Promise.all(pids.map(async (pid) => {
    try {
      const text = await fsp.readFile('/proc/' + pid + '/stat', 'utf8');
      const close = text.lastIndexOf(')');
      if (close < 0) return;
      const fields = text.slice(close + 2).trim().split(/\s+/);
      const ticks = (Number(fields[11]) || 0) + (Number(fields[12]) || 0); // utime + stime
      processes.set(pid, { cpuTicks: ticks, startTicks: Number(fields[19]) || 0 });
    } catch { /* process exited or access denied */ }
  }));
  return { total, processes };
}

async function getProcessSnapshot() {
  let list = [];
  if (IS_WIN) {
    const script = [
      'Get-Process | Select-Object Id, ProcessName, WorkingSet64,',
      '  @{n="Path";e={try{$_.Path}catch{""}}},',
      '  @{n="Company";e={try{$_.Company}catch{""}}},',
      '  @{n="Product";e={try{$_.Product}catch{""}}},',
      '  @{n="StartTime";e={try{$_.StartTime.ToUniversalTime().ToString("o")}catch{""}}} | ConvertTo-Json -Compress',
    ].join('\n');
    const r = await ps(script, 30000);
    if (!r.ok) return { available: false, items: [], error: r.stderr || 'Could not query Windows processes' };
    const j = parseJsonLoose(r.stdout);
    const arr = Array.isArray(j) ? j : (j ? [j] : []);
    list = arr.map((p) => ({
      pid: Number(p.Id),
      name: (p.ProcessName || 'unknown') + '.exe',
      cpu: 0,
      memBytes: Number(p.WorkingSet64) || 0,
      path: p.Path || '',
      company: p.Company || '',
      product: p.Product || '',
      startId: p.StartTime || '',
    }));
    const sample = async () => {
      const rr = await ps('Get-Process | Select-Object Id, CPU | ConvertTo-Json -Compress', 30000);
      const jj = parseJsonLoose(rr.stdout);
      const aa = Array.isArray(jj) ? jj : (jj ? [jj] : []);
      return new Map(aa.map((x) => [Number(x.Id), Number(x.CPU) || 0]));
    };
    const m1 = await sample();
    await sleep(1000);
    const m2 = await sample();
    const cores = os.cpus().length || 1;
    for (const p of list) {
      const d = (m2.get(p.pid) || 0) - (m1.get(p.pid) || 0);
      p.cpu = Math.max(0, Math.round((d / cores) * 10) / 10);
    }
  } else {
    const r = await run('ps', ['-eo', 'pid,pcpu,pmem,rss,comm,args']);
    if (!r.ok) return { available: false, items: [], error: r.stderr || 'Could not query process inventory' };
    for (const line of r.stdout.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const m = t.match(/^(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (!m) continue;
      const pid = parseInt(m[1], 10);
      let exe = (m[6].split(' ')[0]) || m[5];
      if (IS_LINUX) {
        try { exe = (await fsp.readlink('/proc/' + pid + '/exe')) || exe; } catch { /* keep ps path */ }
      }
      list.push({
        pid,
        name: path.basename(exe) || m[5],
        cpu: parseFloat(m[2]) || 0,
        memBytes: (parseInt(m[4], 10) || 0) * 1024,
        path: exe,
        company: '',
        product: '',
        startId: '',
      });
    }
    if (IS_LINUX && list.length) {
      // ps %CPU is a lifetime average. Replace it with a short, normalized sample.
      const pids = list.map((p) => p.pid);
      const first = await linuxCpuSnapshot(pids);
      await sleep(1000);
      const second = await linuxCpuSnapshot(pids);
      if (first && second && second.total > first.total) {
        for (const p of list) {
          const before = first.processes.get(p.pid);
          const after = second.processes.get(p.pid);
          p.startId = String((before && before.startTicks) || (after && after.startTicks) || '');
          p.cpu = !before || !after ? 0 : Math.max(0, Math.round(((after.cpuTicks - before.cpuTicks) / (second.total - first.total)) * 1000) / 10);
        }
      }
    }
  }
  if (!list.length) return { available: false, items: [], error: 'The operating system returned no process records' };
  for (const p of list) {
    const s = suspicion(p);
    p.suspicion = s.score;
    p.suspicionLevel = s.level;
    p.flags = s.reasons;
    p.canStop = Number.isSafeInteger(p.pid) && p.pid > 4 && p.pid !== process.pid && p.pid !== process.ppid && !CRITICAL_PROCESS_RE.test(String(p.name || '').replace(/\.exe$/i, ''));
  }
  list.sort((a, b) => (b.suspicion - a.suspicion) || (b.cpu - a.cpu));
  return { available: true, items: list, error: null };
}

async function getProcesses() {
  const snapshot = await getProcessSnapshot();
  return snapshot.available ? snapshot.items : [];
}

async function killProcess(pidValue, expected = null) {
  const pid = Number(pidValue);
  if (!Number.isSafeInteger(pid) || pid <= 4 || pid === process.pid || pid === process.ppid) {
    return { ok: false, error: 'Invalid or protected PID' };
  }
  const snapshot = await getProcessSnapshot();
  if (!snapshot.available) return { ok: false, error: snapshot.error || 'Process inventory is unavailable' };
  const target = snapshot.items.find((p) => p.pid === pid);
  if (!target) return { ok: false, error: 'Process no longer exists or is not visible' };
  if (expected && typeof expected === 'object') {
    const norm = (value) => IS_WIN ? String(value || '').toLowerCase() : String(value || '');
    if ((expected.name && norm(target.name) !== norm(expected.name)) || (expected.path && norm(path.resolve(target.path || '')) !== norm(path.resolve(expected.path))) || (expected.startId && norm(target.startId) !== norm(expected.startId))) {
      return { ok: false, error: 'Process identity changed; refresh the process list and try again' };
    }
  }
  if (CRITICAL_PROCESS_RE.test(String(target.name || '').replace(/\.exe$/i, ''))) {
    return { ok: false, error: 'Refusing to stop a protected system process' };
  }
  if (IS_WIN) {
    const r = await run('taskkill', ['/PID', String(pid), '/F']);
    return { ok: r.ok, error: r.ok ? null : (r.stderr || r.stdout || 'taskkill failed') };
  }
  try {
    process.kill(pid, 'SIGTERM');
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e.message || 'kill failed' };
  }
}

/* ------------------------------------------------------------ applications */

const BLOAT_RE = /toolbar|pc optimizer|driver updater|driver booster|registry cleaner|speed up|cleaner pro|system care|advanced systemcare|iobit|driver easy|slimdrivers|driver support|mcafee webadvisor|norton.*online backup/i;
const SAFE_PACKAGE_RE = /^[a-z0-9][a-z0-9+.-]*(?::[a-z0-9-]+)?$/i;

function appFlags(app) {
  const flags = [];
  if (BLOAT_RE.test(app.name + ' ' + (app.publisher || ''))) flags.push({ label: 'Possible bloatware (heuristic)', sev: 'high' });
  if (!app.publisher) flags.push({ label: 'Unknown publisher', sev: 'medium' });
  if (!app.version) flags.push({ label: 'No version info', sev: 'low' });
  return flags;
}

function parseWindowsCommandLine(commandLine) {
  if (typeof commandLine !== 'string' || !commandLine.trim() || /[\0\r\n]/.test(commandLine)) return [];
  const args = [];
  let i = 0;
  while (i < commandLine.length) {
    while (/\s/.test(commandLine[i] || '')) i++;
    if (i >= commandLine.length) break;
    let arg = '';
    let quoted = false;
    while (i < commandLine.length) {
      if (commandLine[i] === '\\') {
        let start = i;
        while (commandLine[i] === '\\') i++;
        const slashes = i - start;
        if (commandLine[i] === '"') {
          arg += '\\'.repeat(Math.floor(slashes / 2));
          if (slashes % 2) { arg += '"'; i++; }
          else { quoted = !quoted; i++; }
        } else arg += '\\'.repeat(slashes);
      } else if (commandLine[i] === '"') {
        quoted = !quoted;
        i++;
      } else if (/\s/.test(commandLine[i]) && !quoted) break;
      else arg += commandLine[i++];
    }
    if (quoted) return [];
    args.push(arg);
    while (/\s/.test(commandLine[i] || '')) i++;
  }
  return args;
}

function isSafeAppBundlePath(appPath) {
  if (!IS_MAC || typeof appPath !== 'string' || !appPath.endsWith('.app') || !path.isAbsolute(appPath)) return false;
  const candidate = path.resolve(appPath);
  try {
    const stat = fs.lstatSync(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const realCandidate = fs.realpathSync(candidate);
    const roots = ['/Applications', path.join(os.homedir(), 'Applications')];
    return roots.some((rootPath) => {
      try {
        const root = fs.realpathSync(rootPath);
        return realCandidate !== root && isWithin(root, realCandidate);
      } catch { return false; }
    });
  } catch { return false; }
}

function canUninstallApp(app) {
  if (!app || typeof app !== 'object') return false;
  if (IS_WIN) {
    const args = parseWindowsCommandLine(app.uninstallString);
    if (!args.length) return false;
    const exe = args[0];
    const base = path.win32.basename(exe);
    if (/^msiexec(?:\.exe)?$/i.test(base)) return args.slice(1).join(' ').match(/\/(?:I|X)\s*\{[0-9A-F-]{36}\}/i) != null;
    const blocked = new Set(['cmd.exe', 'powershell.exe', 'pwsh.exe', 'wscript.exe', 'cscript.exe', 'mshta.exe', 'rundll32.exe', 'regsvr32.exe', 'explorer.exe']);
    if (blocked.has(base.toLowerCase()) || !path.win32.isAbsolute(exe) || path.win32.extname(exe).toLowerCase() !== '.exe') return false;
    const installLocation = String(app.installLocation || '').trim();
    if (!path.win32.isAbsolute(installLocation)) return false;
    const installRoot = path.win32.resolve(installLocation);
    const candidate = path.win32.resolve(exe);
    const relative = path.win32.relative(installRoot, candidate);
    if (!relative || relative === '..' || relative.startsWith('..\\') || path.win32.isAbsolute(relative)) return false;
    const systemRoot = path.win32.resolve(process.env.SystemRoot || 'C:\\Windows');
    const systemRelative = path.win32.relative(systemRoot, candidate);
    if (systemRelative === '' || (!systemRelative.startsWith('..\\') && systemRelative !== '..' && !path.win32.isAbsolute(systemRelative))) return false;
    try { return fs.existsSync(candidate) && fs.statSync(candidate).isFile(); } catch { return false; }
  }
  if (IS_MAC) return isSafeAppBundlePath(app.path) || ((app.uninstallMethod === 'brew-formula' || app.uninstallMethod === 'brew-cask') && SAFE_PACKAGE_RE.test(app.package || ''));
  if (IS_LINUX) return app.uninstallMethod === 'apt' && SAFE_PACKAGE_RE.test(app.package || '');
  return false;
}

async function getInstalledApps() {
  let apps = [];
  if (IS_WIN) {
    const script = [
      "$paths = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
      "         'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
      "         'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*';",
      'Get-ItemProperty $paths -ErrorAction SilentlyContinue |',
      '  Where-Object { $_.DisplayName } |',
      '  Select-Object DisplayName, DisplayVersion, Publisher, InstallDate, InstallLocation, EstimatedSize, UninstallString |',
      '  ConvertTo-Json -Compress',
    ].join('\n');
    const r = await ps(script, 40000);
    const j = parseJsonLoose(r.stdout);
    const arr = Array.isArray(j) ? j : (j ? [j] : []);
    apps = arr.map((a) => ({
      name: String(a.DisplayName || '').trim(),
      version: a.DisplayVersion || '',
      publisher: String(a.Publisher || '').trim(),
      installDate: a.InstallDate || '',
      installLocation: a.InstallLocation || '',
      size: (Number(a.EstimatedSize) || 0) * 1024,
      uninstallString: a.UninstallString || '',
      package: '',
      path: '',
      uninstallMethod: 'windows-registry',
    })).filter((a) => a.name);
  } else if (IS_MAC) {
    const dirs = ['/Applications', path.join(os.homedir(), 'Applications')];
    const seen = new Set();
    for (const dir of dirs) {
      let entries = [];
      try { entries = await fsp.readdir(dir); } catch { continue; }
      for (const e of entries) {
        if (!e.endsWith('.app') || seen.has(e)) continue;
        seen.add(e);
        const p = path.join(dir, e);
        if (!isSafeAppBundlePath(p)) continue;
        let size = 0;
        const du = await run('du', ['-sm', p]);
        const dm = du.stdout.match(/^(\d+)/);
        if (dm) size = parseInt(dm[1], 10) * 1024 * 1024;
        apps.push({ name: e.replace(/\.app$/, ''), version: '', publisher: '', installDate: '', size, uninstallString: '', package: '', path: p, uninstallMethod: 'app-bundle' });
      }
    }
    for (const [kind, args, method] of [
      ['formula', ['list', '--formula', '--versions'], 'brew-formula'],
      ['cask', ['list', '--cask', '--versions'], 'brew-cask'],
    ]) {
      const brew = await run('brew', args);
      if (!brew.ok) continue;
      for (const line of brew.stdout.trim().split('\n')) {
        const m = line.match(/^(\S+)\s+(.+)$/);
        if (m && SAFE_PACKAGE_RE.test(m[1])) apps.push({ name: m[1], version: m[2].trim(), publisher: 'Homebrew', installDate: '', size: 0, uninstallString: '', package: m[1], path: '', uninstallMethod: method, appKind: kind });
      }
    }
  } else if (IS_LINUX) {
    const dirs = ['/usr/share/applications', path.join(os.homedir(), '.local/share/applications')];
    const seen = new Set();
    for (const dir of dirs) {
      let entries = [];
      try { entries = await fsp.readdir(dir); } catch { continue; }
      for (const e of entries) {
        if (!e.endsWith('.desktop') || seen.has(e)) continue;
        seen.add(e);
        const desktopPath = path.join(dir, e);
        try {
          const txt = await fsp.readFile(desktopPath, 'utf8');
          const get = (k) => { const m = txt.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : ''; };
          const name = get('Name');
          if (!name || get('NoDisplay') === 'true' || get('Hidden') === 'true') continue;
          let pkg = '';
          const owner = await run('dpkg-query', ['-S', desktopPath]);
          const match = owner.stdout.match(/^([^:\s]+(?::[^:\s]+)?):\s/);
          if (owner.ok && match && SAFE_PACKAGE_RE.test(match[1])) pkg = match[1];
          apps.push({ name, version: '', publisher: get('Comment'), installDate: '', size: 0, uninstallString: '', package: pkg, path: desktopPath, uninstallMethod: pkg ? 'apt' : '' });
        } catch { /* ignore unreadable entries */ }
      }
    }
    const cnt = await run('dpkg-query', ['-W', '-f=${binary:Package}\n']);
    apps.totalPackages = cnt.ok ? cnt.stdout.trim().split('\n').filter(Boolean).length : 0;
  }
  for (const a of apps) {
    a.flags = appFlags(a);
    a.canUninstall = canUninstallApp(a);
  }
  apps.sort((a, b) => a.name.localeCompare(b.name));
  return apps;
}

async function uninstallApp(app) {
  if (!canUninstallApp(app)) return { ok: false, error: 'No safe uninstall method is available for this application' };
  if (IS_WIN) {
    const args = parseWindowsCommandLine(app.uninstallString);
    let exe = args.shift();
    const base = path.win32.basename(exe);
    if (/^msiexec(?:\.exe)?$/i.test(base)) {
      exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'msiexec.exe');
      const joined = args.join(' ');
      const msi = joined.match(/(?:^|\s)\/(?:I|X)\s*(\{[0-9A-F-]{36}\})/i);
      if (!msi) return { ok: false, error: 'Unsupported MSI uninstall string' };
      args.splice(0, args.length, '/x', msi[1], '/passive', '/norestart');
    }
    const r = await run(exe, args, { timeout: 120000 });
    return { ok: r.ok, error: r.ok ? null : (r.stderr || r.stdout || 'Uninstaller failed') };
  }
  if (IS_MAC && (app.uninstallMethod === 'brew-formula' || app.uninstallMethod === 'brew-cask')) {
    const r = await run('brew', ['uninstall', ...(app.uninstallMethod === 'brew-cask' ? ['--cask'] : []), '--', app.package], { timeout: 120000 });
    return { ok: r.ok, error: r.ok ? null : (r.stderr || r.stdout || 'Homebrew uninstall failed') };
  }
  if (IS_LINUX) {
    const r = await run('sudo', ['-n', 'apt-get', 'remove', '-y', '--', app.package], { timeout: 120000 });
    return { ok: r.ok, error: r.ok ? null : (r.stderr || r.stdout || 'Removal requires administrator authorization') };
  }
  return { ok: false, error: 'Move this application to Trash manually to remove it safely' };
}

/* ---------------------------------------------------------------- network */

function isExternallyBound(address) {
  if (!address) return true;
  let host = String(address).trim();
  if (host.startsWith('[')) host = host.slice(1, host.indexOf(']') >= 0 ? host.indexOf(']') : undefined);
  else {
    const colon = host.lastIndexOf(':');
    if (colon >= 0) host = host.slice(0, colon);
  }
  host = host.toLowerCase();
  if (!host || host === '*' || host === '0.0.0.0' || host === '::' || host === '[::]') return true;
  if (host === '::1' || host.startsWith('127.') || host.startsWith('::ffff:127.')) return false;
  return true;
}

function connectionIsListening(c) {
  if (c.proto === 'UDP') return /^(UNCONN|BOUND|UDP|LISTEN)$/i.test(c.state || '');
  return /LISTEN/i.test(c.state || '');
}

function parseNetstatOutput(text) {
  const output = [];
  const stateNames = new Set([
    'LISTEN', 'ESTABLISHED', 'SYN_SENT', 'SYN_RECV', 'FIN_WAIT1', 'FIN_WAIT2',
    'TIME_WAIT', 'CLOSE', 'CLOSE_WAIT', 'LAST_ACK', 'CLOSING', 'UNKNOWN',
  ]);
  for (const line of String(text || '').split('\n')) {
    const match = line.trim().match(/^(tcp6?|udp6?)\s+\d+\s+\d+\s+(\S+)\s+(\S+)(?:\s+(.*))?$/i);
    if (!match) continue;
    const proto = match[1].toLowerCase().startsWith('udp') ? 'UDP' : 'TCP';
    const tail = (match[4] || '').trim().split(/\s+/).filter(Boolean);
    let state = '';
    if (proto === 'UDP') state = 'UNCONN';
    else if (tail.length && stateNames.has(tail[0].toUpperCase())) state = tail.shift().toUpperCase();
    const processToken = tail.find((part) => /^(\d+)\/(.+)$/.test(part)) || '';
    const processMatch = processToken.match(/^(\d+)\/(.+)$/);
    output.push({
      proto,
      local: match[2],
      remote: match[3],
      state,
      pid: processMatch ? Number(processMatch[1]) : 0,
      process: processMatch ? processMatch[2] : '',
    });
  }
  return output;
}

async function getNetwork() {
  const connections = [];
  let available = true;
  let error = '';
  if (IS_WIN) {
    const script = [
      '$procs = @{};',
      'Get-Process | ForEach-Object { $procs[$_.Id] = $_.ProcessName };',
      '$out = @(); $available = $false; $queryError = "";',
      'try {',
      '  foreach ($c in (Get-NetTCPConnection -ErrorAction Stop)) {',
      '    $out += [pscustomobject]@{ Proto = "TCP"; Local = ($c.LocalAddress + ":" + $c.LocalPort);',
      '      Remote = ($c.RemoteAddress + ":" + $c.RemotePort); State = $c.State;',
      '      Pid = $c.OwningProcess; Process = $procs[$c.OwningProcess] } }',
      '  foreach ($u in (Get-NetUDPEndpoint -ErrorAction Stop)) {',
      '    $out += [pscustomobject]@{ Proto = "UDP"; Local = ($u.LocalAddress + ":" + $u.LocalPort);',
      '      Remote = "-"; State = "BOUND"; Pid = $u.OwningProcess; Process = $procs[$u.OwningProcess] } }',
      '  $available = $true;',
      '} catch { $queryError = $_.Exception.Message }',
      '[pscustomobject]@{ Available = $available; Error = $queryError; Connections = $out } | ConvertTo-Json -Compress -Depth 4',
    ].join('\n');
    const r = await ps(script, 30000);
    const j = parseJsonLoose(r.stdout);
    if (!r.ok || !j || !(j.Available === true || j.Available === 'True')) {
      available = false;
      error = (j && j.Error) || r.stderr || 'Could not query Windows network endpoints';
    }
    const rawConnections = j && !Array.isArray(j) ? j.Connections : j;
    const arr = Array.isArray(rawConnections) ? rawConnections : (rawConnections ? [rawConnections] : []);
    for (const c of arr) connections.push({
      proto: String(c.Proto || 'TCP').toUpperCase(), local: c.Local || '', remote: c.Remote || '',
      state: c.State || '', pid: Number(c.Pid) || 0, process: c.Process || '',
    });
  } else if (IS_LINUX) {
    let r = await run('ss', ['-tunap']);
    if (r.ok && r.stdout.trim()) {
      for (const line of r.stdout.split('\n')) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 6 || !/^(tcp|udp)/i.test(cols[0])) continue;
        const remoteIndex = line.lastIndexOf(cols[5]);
        const text = remoteIndex >= 0 ? line.slice(remoteIndex + cols[5].length) : '';
        const pm = text.match(/users:\(\("([^"]+)",pid=(\d+)/);
        connections.push({
          proto: cols[0].toUpperCase(), state: cols[1].toUpperCase(), local: cols[4], remote: cols[5],
          pid: pm ? Number(pm[2]) : 0, process: pm ? pm[1] : '',
        });
      }
    } else if (r.ok) {
      // An empty but successful `ss` response is a valid empty snapshot.
    } else {
      r = await run('netstat', ['-tunap']);
      if (r.ok) connections.push(...parseNetstatOutput(r.stdout));
      else { available = false; error = r.stderr || 'Neither ss nor netstat could query network endpoints'; }
    }
  } else {
    const r = await run('lsof', ['-nP', '-i']);
    if (!r.ok) { available = false; error = r.stderr || 'Could not query macOS network endpoints'; }
    for (const line of r.stdout.split('\n').slice(1)) {
      const m = line.match(/^(\S+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(IPv[46])\s+\S+\s+\S+\s+\d+\s+(TCP|UDP)\s+(.+)$/);
      if (!m) continue;
      const rest = m[7];
      const sm = rest.match(/^(.*?)\s*(?:\((.+)\))?$/);
      const addr = (sm ? sm[1] : rest).trim();
      const state = sm && sm[2] ? sm[2].toUpperCase() : (m[6] === 'UDP' ? 'UDP' : '');
      let local = addr, remote = '';
      if (addr.includes('->')) { const parts = addr.split('->'); local = parts[0]; remote = parts[1]; }
      connections.push({ proto: m[6].toUpperCase(), local, remote: remote || '-', state, pid: Number(m[2]), process: m[1] });
    }
  }
  const listening = connections.filter(connectionIsListening);
  const exposed = listening.filter((c) => isExternallyBound(c.local));
  return { connections, listening, exposed, available, error: available ? null : error };
}

function correlateNetworkExposure(processSnapshot, network) {
  if (!network || network.available !== true || !Array.isArray(network.exposed)) {
    return { available: false, reason: 'Network endpoint inventory is unavailable', assessed: null, flagged: null, unattributed: null, items: [] };
  }
  if (!processSnapshot || processSnapshot.available !== true || !Array.isArray(processSnapshot.items)) {
    return { available: false, reason: 'Process inventory is unavailable', assessed: null, flagged: null, unattributed: null, items: [] };
  }

  const processByPid = new Map(processSnapshot.items.map((item) => [Number(item.pid), item]));
  const listeners = network.exposed.map((endpoint) => {
    const owner = processByPid.get(Number(endpoint.pid)) || null;
    return { endpoint, owner };
  });
  const risky = listeners.filter(({ owner }) => owner && (Number(owner.suspicion) >= 35 || ['high', 'critical'].includes(owner.suspicionLevel)));
  const items = risky.slice(0, 50).map(({ endpoint, owner }) => ({
    proto: String(endpoint.proto || '—'),
    local: String(endpoint.local || '—'),
    pid: Number(endpoint.pid) || 0,
    process: String(owner.name || endpoint.process || 'unknown'),
    suspicion: Number(owner.suspicion) || 0,
    flags: Array.isArray(owner.flags) ? owner.flags.slice(0, 5).map(String) : [],
  }));
  return {
    available: true,
    reason: null,
    assessed: listeners.length,
    flagged: risky.length,
    unattributed: listeners.filter(({ owner }) => !owner).length,
    items,
  };
}

async function getNetworkAssessment() {
  const [network, processSnapshot] = await Promise.all([
    getNetwork(),
    getProcessSnapshot().catch((error) => ({ available: false, items: [], error: String(error && error.message || error) })),
  ]);
  return { ...network, correlation: correlateNetworkExposure(processSnapshot, network) };
}

/* ----------------------------------------- startup / service inventory */

const MAX_PERSISTENCE_ITEMS = 1200;
const MAX_SYSTEMD_UNITS = 300;
const MAX_LAUNCHD_PLISTS = 120;

function parseSystemdUnitFileList(text) {
  const units = [];
  for (const line of String(text || '').split('\n')) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 2 || !/\.service$/i.test(columns[0]) || columns[0] === 'UNIT') continue;
    units.push({ name: columns[0], state: columns[1], preset: columns[2] || '' });
  }
  return units;
}

function parseSystemctlListUnits(text) {
  const units = [];
  for (const line of String(text || '').split('\n')) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 4 || !/\.service$/i.test(columns[0]) || columns[0] === 'UNIT') continue;
    units.push({ name: columns[0], loadState: columns[1], activeState: columns[2], subState: columns[3] });
  }
  return units;
}

function parseSystemctlShow(text) {
  const records = [];
  let current = null;
  for (const line of String(text || '').split('\n')) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9]*)=(.*)$/);
    if (!match) continue;
    if (match[1] === 'Id') {
      if (current) records.push(current);
      current = { name: match[2] };
    } else if (current) current[match[1]] = match[2];
  }
  if (current) records.push(current);
  return records;
}

function parseXdgDesktopEntry(text) {
  let inDesktopEntry = false;
  const values = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const section = line.trim().match(/^\[([^\]]+)\]$/);
    if (section) { inDesktopEntry = section[1] === 'Desktop Entry'; continue; }
    if (!inDesktopEntry || !line.trim() || /^\s*[#;]/.test(line)) continue;
    const equal = line.indexOf('=');
    if (equal < 1) continue;
    const key = line.slice(0, equal).trim();
    if (['Name', 'Exec', 'TryExec', 'Hidden', 'X-GNOME-Autostart-enabled', 'Type'].includes(key)) values[key] = line.slice(equal + 1).trim();
  }
  if (values.Type && values.Type !== 'Application') return null;
  const command = values.Exec || values.TryExec || '';
  return {
    name: values.Name || '',
    command,
    executable: extractExecutable(command),
    enabled: !/^true$/i.test(values.Hidden || '') && !/^false$/i.test(values['X-GNOME-Autostart-enabled'] || ''),
  };
}

function parseLaunchctlList(text) {
  const jobs = [];
  for (const line of String(text || '').split('\n')) {
    const match = line.trim().match(/^(\S+)\s+(-?\d+)\s+(.+)$/);
    if (!match || /^pid$/i.test(match[1])) continue;
    const pid = /^\d+$/.test(match[1]) ? Number(match[1]) : null;
    jobs.push({ pid: pid && pid > 0 ? pid : null, status: Number(match[2]), label: match[3].trim() });
  }
  return jobs;
}

function posixCommandToken(command) {
  const value = String(command || '').trim();
  if (!value) return '';
  const match = value.match(/^(?:"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|(\S+))/);
  return match ? (match[1] || match[2] || match[3] || '').replace(/\\(["'\\])/g, '$1') : '';
}

function extractExecutable(command) {
  const value = String(command || '').trim();
  if (!value) return '';
  // systemctl renders ExecStart as a structured string containing path=...
  const systemdPath = value.match(/(?:^|[\s{;,])path=(?:"([^"]+)"|([^\s;}]+))/);
  if (systemdPath) return (systemdPath[1] || systemdPath[2] || '').trim();
  if (IS_WIN) {
    const args = parseWindowsCommandLine(value);
    return args[0] || '';
  }
  let token = posixCommandToken(value);
  if (path.basename(token) === 'env') {
    const rest = value.slice(value.indexOf(token) + token.length).trim().replace(/^(?:-[A-Za-z]+\s+|[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)+/, '');
    token = posixCommandToken(rest);
  }
  return token;
}

function sourceResult(id, label, available, complete, count, error = null) {
  return { id, label, available: !!available, complete: !!complete, count: Math.max(0, Number(count) || 0), error: error ? String(error).slice(0, 500) : null };
}

function finishPersistenceInventory(sources, items, truncated = false) {
  const boundedItems = items.slice(0, MAX_PERSISTENCE_ITEMS);
  const wasTruncated = truncated || items.length > MAX_PERSISTENCE_ITEMS;
  return {
    available: sources.some((source) => source.available),
    complete: sources.length > 0 && sources.every((source) => source.complete) && !wasTruncated,
    partial: sources.some((source) => !source.complete) || wasTruncated,
    sources,
    items: boundedItems,
    count: items.length,
    truncated: wasTruncated,
    error: sources.every((source) => !source.available) ? (sources.find((source) => source.error) || {}).error || 'Startup/service sources are unavailable' : null,
  };
}

function normalizePersistenceText(value, limit = 2000) {
  return String(value == null ? '' : value).replace(/[\0\r]/g, '').trim().slice(0, limit);
}

function normalizeWindowsPersistence(json) {
  const sources = [];
  const items = [];
  const arrayOf = (value) => Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
  const add = (sourceId, label, available, error, rows, mapper) => {
    const records = arrayOf(rows);
    sources.push(sourceResult(sourceId, label, available, available, records.length, error));
    for (const record of records) {
      const item = mapper(record);
      if (item && item.name) items.push(item);
    }
  };
  add('windows-services', 'Windows services', json.ServicesAvailable, json.ServicesError, json.Services, (service) => {
    const command = normalizePersistenceText(service.PathName);
    const startMode = normalizePersistenceText(service.StartMode, 64);
    const pid = Number(service.ProcessId);
    return {
      kind: 'service', source: 'Windows Service', scope: 'system',
      name: normalizePersistenceText(service.DisplayName || service.Name, 300),
      command, executable: extractExecutable(command), sourcePath: '',
      enabled: /^(auto|automatic|boot|system)$/i.test(startMode),
      state: normalizePersistenceText(service.State, 64) || 'Unknown',
      startMode, pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
    };
  });
  add('windows-startup-commands', 'Windows startup commands', json.StartupAvailable, json.StartupError, json.StartupCommands, (entry) => {
    const command = normalizePersistenceText(entry.Command);
    return {
      kind: 'startup', source: 'Windows Startup', scope: normalizePersistenceText(entry.User, 200) || 'user',
      name: normalizePersistenceText(entry.Name || command, 300), command, executable: extractExecutable(command),
      sourcePath: normalizePersistenceText(entry.Location, 500), enabled: true, state: 'Configured', pid: null,
    };
  });
  add('windows-scheduled-tasks', 'Windows logon/startup scheduled tasks', json.TasksAvailable, json.TasksError, json.Tasks, (task) => {
    const command = [task.Execute, task.Arguments].filter(Boolean).map((part) => normalizePersistenceText(part)).join(' ');
    return {
      kind: 'scheduled-task', source: 'Task Scheduler', scope: normalizePersistenceText(task.User, 200) || 'system',
      name: normalizePersistenceText((task.TaskPath || '') + (task.TaskName || ''), 400), command,
      executable: extractExecutable(command), sourcePath: normalizePersistenceText(task.TaskPath, 500),
      enabled: true, state: normalizePersistenceText(task.State, 64) || 'Ready', pid: null,
    };
  });
  return finishPersistenceInventory(sources, items);
}

const WINDOWS_PERSISTENCE_SCRIPT = [
  '$services = @(); $servicesAvailable = $false; $servicesError = "";',
  'try { $services = @(Get-CimInstance -ClassName Win32_Service -ErrorAction Stop | Where-Object { $_.StartMode -in @("Auto", "Boot", "System") -or $_.State -eq "Running" } | Select-Object Name, DisplayName, State, StartMode, PathName, ProcessId); $servicesAvailable = $true } catch { $servicesError = $_.Exception.Message }',
  '$startup = @(); $startupAvailable = $false; $startupError = "";',
  'try { $startup = @(Get-CimInstance -ClassName Win32_StartupCommand -ErrorAction Stop | Select-Object Name, Command, Location, User); $startupAvailable = $true } catch { $startupError = $_.Exception.Message }',
  '$tasks = @(); $tasksAvailable = $false; $tasksError = "";',
  'try {',
  '  $tasks = @(Get-ScheduledTask -ErrorAction Stop | ForEach-Object {',
  '    $task = $_; $hasStartupTrigger = @($task.Triggers | Where-Object { $_.CimClass.CimClassName -match "(Logon|Boot)Trigger" }).Count -gt 0;',
  '    if ($task.State -ne "Disabled" -and $hasStartupTrigger) { foreach ($action in @($task.Actions)) { [pscustomobject]@{ TaskName = $task.TaskName; TaskPath = $task.TaskPath; State = $task.State; Execute = $action.Execute; Arguments = $action.Arguments; User = $task.Principal.UserId } } }',
  '  }); $tasksAvailable = $true',
  '} catch { $tasksError = $_.Exception.Message }',
  '[pscustomobject]@{ ServicesAvailable = $servicesAvailable; ServicesError = $servicesError; Services = $services; StartupAvailable = $startupAvailable; StartupError = $startupError; StartupCommands = $startup; TasksAvailable = $tasksAvailable; TasksError = $tasksError; Tasks = $tasks } | ConvertTo-Json -Compress -Depth 8',
].join('\n');

async function collectWindowsPersistence() {
  const result = await ps(WINDOWS_PERSISTENCE_SCRIPT, 40000);
  const json = parseJsonLoose(result.stdout);
  if (!result.ok || !json || typeof json !== 'object') {
    const error = result.stderr || 'Could not query Windows startup and service sources';
    return finishPersistenceInventory([
      sourceResult('windows-services', 'Windows services', false, false, 0, error),
      sourceResult('windows-startup-commands', 'Windows startup commands', false, false, 0, error),
      sourceResult('windows-scheduled-tasks', 'Windows logon/startup scheduled tasks', false, false, 0, error),
    ], []);
  }
  return normalizeWindowsPersistence(json);
}

async function collectSystemdDomain(userDomain) {
  const scope = userDomain ? 'user' : 'system';
  const prefix = userDomain ? ['--user'] : [];
  const [fileResult, unitResult] = await Promise.all([
    run('systemctl', [...prefix, 'list-unit-files', '--type=service', '--no-legend', '--no-pager'], { timeout: 12000 }),
    run('systemctl', [...prefix, 'list-units', '--type=service', '--all', '--no-legend', '--no-pager'], { timeout: 12000 }),
  ]);
  const fileUnits = fileResult.ok ? parseSystemdUnitFileList(fileResult.stdout) : [];
  const loadedUnits = unitResult.ok ? parseSystemctlListUnits(unitResult.stdout) : [];
  const fileText = String(fileResult.stdout || '').trim();
  const unitsText = String(unitResult.stdout || '').trim();
  const filesParsed = fileResult.ok && (!fileText || fileUnits.length > 0 || /no files found/i.test(fileText));
  const unitsParsed = unitResult.ok && (!unitsText || loadedUnits.length > 0 || /^(?:no loaded units listed|\d+ loaded units? listed)/i.test(unitsText));
  const enabledStates = new Set(['enabled', 'enabled-runtime', 'linked', 'linked-runtime']);
  const enabledNames = fileUnits.filter((unit) => enabledStates.has(unit.state.toLowerCase())).map((unit) => unit.name);
  const activeNames = loadedUnits.filter((unit) => unit.activeState === 'active' || unit.activeState === 'activating').map((unit) => unit.name);
  const names = [...new Set([...enabledNames, ...activeNames])].sort();
  const truncated = names.length > MAX_SYSTEMD_UNITS;
  const selected = names.slice(0, MAX_SYSTEMD_UNITS);
  let detailResult = { ok: true, stdout: '', stderr: '' };
  if (selected.length) {
    detailResult = await run('systemctl', [...prefix, 'show', '--no-pager', '--property=Id,MainPID,ActiveState,SubState,UnitFileState,FragmentPath,ExecStart', ...selected], { timeout: 15000 });
  }
  const details = detailResult.ok ? parseSystemctlShow(detailResult.stdout) : [];
  const detailsComplete = selected.length === 0 || detailResult.ok && details.length === selected.length;
  const fileByName = new Map(fileUnits.map((unit) => [unit.name, unit]));
  const loadedByName = new Map(loadedUnits.map((unit) => [unit.name, unit]));
  const detailByName = new Map(details.map((unit) => [unit.name, unit]));
  const items = selected.map((name) => {
    const detail = detailByName.get(name) || {};
    const file = fileByName.get(name) || {};
    const loaded = loadedByName.get(name) || {};
    const pid = Number(detail.MainPID);
    const startMode = normalizePersistenceText(detail.UnitFileState || file.state || 'unknown', 64);
    const command = normalizePersistenceText(detail.ExecStart);
    return {
      kind: 'service', source: 'systemd (' + scope + ')', scope,
      name, command, executable: extractExecutable(command),
      sourcePath: normalizePersistenceText(detail.FragmentPath, 1000),
      enabled: enabledStates.has(startMode.toLowerCase()),
      state: normalizePersistenceText(detail.ActiveState || loaded.activeState || 'unknown', 64) + (detail.SubState || loaded.subState ? '/' + normalizePersistenceText(detail.SubState || loaded.subState, 64) : ''),
      startMode, pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
    };
  });
  const errors = [
    fileResult.ok ? filesParsed ? '' : 'Could not parse systemd unit-file listing' : fileResult.stderr,
    unitResult.ok ? unitsParsed ? '' : 'Could not parse systemd loaded-unit listing' : unitResult.stderr,
    detailResult.ok ? detailsComplete ? '' : 'Some systemd unit detail records were unavailable' : detailResult.stderr,
  ].filter(Boolean);
  const available = filesParsed || unitsParsed;
  const complete = filesParsed && unitsParsed && detailsComplete;
  return {
    source: sourceResult('systemd-' + scope, 'systemd services (' + scope + ')', available, complete && !truncated, items.length, errors.join(' · ') || (truncated ? 'Unit display limit reached' : null)),
    items, truncated,
  };
}

async function collectXdgAutostart(dir, scope, id) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch (error) {
    if (error && error.code === 'ENOENT') return { source: sourceResult(id, 'XDG autostart (' + scope + ')', true, true, 0), items: [] };
    return { source: sourceResult(id, 'XDG autostart (' + scope + ')', false, false, 0, error && error.message || error), items: [] };
  }
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.desktop')).slice(0, 300);
  const items = [];
  let readFailures = 0;
  for (const entry of files) {
    const filePath = path.join(dir, entry.name);
    try {
      const parsed = parseXdgDesktopEntry(await fsp.readFile(filePath, 'utf8'));
      if (!parsed) continue;
      items.push({
        kind: 'startup', source: 'XDG autostart', scope,
        name: normalizePersistenceText(parsed.name || entry.name, 300), command: normalizePersistenceText(parsed.command),
        executable: normalizePersistenceText(parsed.executable, 1000), sourcePath: filePath,
        enabled: parsed.enabled, state: 'Configured', pid: null,
      });
    } catch { readFailures++; }
  }
  const clipped = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.desktop')).length > files.length;
  return {
    source: sourceResult(id, 'XDG autostart (' + scope + ')', true, readFailures === 0 && !clipped, items.length, readFailures ? readFailures + ' file(s) could not be read' : clipped ? 'File scan limit reached' : null),
    items, truncated: clipped,
  };
}

async function collectLinuxPersistence() {
  const [systemdSystem, systemdUser, xdgSystem, xdgUser] = await Promise.all([
    collectSystemdDomain(false),
    collectSystemdDomain(true),
    collectXdgAutostart('/etc/xdg/autostart', 'system', 'xdg-system'),
    collectXdgAutostart(path.join(os.homedir(), '.config', 'autostart'), 'user', 'xdg-user'),
  ]);
  return finishPersistenceInventory(
    [systemdSystem.source, systemdUser.source, xdgSystem.source, xdgUser.source],
    [...systemdSystem.items, ...systemdUser.items, ...xdgSystem.items, ...xdgUser.items],
    systemdSystem.truncated || systemdUser.truncated || xdgSystem.truncated || xdgUser.truncated,
  );
}

async function mapLimit(items, limit, mapper) {
  const output = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      try { output[index] = await mapper(items[index], index); } catch (error) { output[index] = { error: String(error && error.message || error) }; }
    }
  }));
  return output;
}

async function collectMacPersistence() {
  // Prefer user and third-party launch items before Apple's large system catalog.
  const sourceDirs = [
    { dir: path.join(os.homedir(), 'Library', 'LaunchAgents'), scope: 'user', kind: 'login-agent' },
    { dir: '/Library/LaunchAgents', scope: 'system', kind: 'login-agent' },
    { dir: '/Library/LaunchDaemons', scope: 'system', kind: 'service' },
    { dir: '/System/Library/LaunchAgents', scope: 'system', kind: 'login-agent' },
    { dir: '/System/Library/LaunchDaemons', scope: 'system', kind: 'service' },
  ];
  const launchctl = await run('launchctl', ['list'], { timeout: 10000 });
  const loadedJobs = launchctl.ok ? parseLaunchctlList(launchctl.stdout) : [];
  const loadedByLabel = new Map(loadedJobs.map((job) => [job.label, job]));
  const files = [];
  const sources = [sourceResult('launchctl-loaded', 'Loaded launchd jobs', launchctl.ok, launchctl.ok, loadedJobs.length, launchctl.ok ? null : launchctl.stderr || 'launchctl list failed')];
  let truncated = false;
  for (const source of sourceDirs) {
    try {
      const entries = await fsp.readdir(source.dir, { withFileTypes: true });
      const plists = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.plist'));
      const room = Math.max(0, MAX_LAUNCHD_PLISTS - files.length);
      const selected = plists.slice(0, room).map((entry) => ({ ...source, sourceIndex: sourceDirs.indexOf(source), filePath: path.join(source.dir, entry.name), fileName: entry.name }));
      files.push(...selected);
      const clipped = selected.length < plists.length;
      truncated = truncated || clipped;
      sources.push(sourceResult('launchd-' + sourceDirs.indexOf(source), source.dir, true, !clipped, selected.length, clipped ? 'Plist scan limit reached' : null));
    } catch (error) {
      if (error && error.code === 'ENOENT' && source.scope === 'user') {
        sources.push(sourceResult('launchd-' + sourceDirs.indexOf(source), source.dir, true, true, 0));
      } else {
        sources.push(sourceResult('launchd-' + sourceDirs.indexOf(source), source.dir, false, false, 0, error && error.message || error));
      }
    }
  }
  const parsedPlists = await mapLimit(files, 8, async (file) => {
    const result = await run('plutil', ['-convert', 'json', '-o', '-', file.filePath], { timeout: 2000 });
    const plist = result.ok ? parseJsonLoose(result.stdout) : null;
    if (!plist || typeof plist !== 'object') return { error: result.stderr || 'Could not parse property list', sourceId: 'launchd-' + file.sourceIndex };
    const label = normalizePersistenceText(plist.Label || file.fileName.replace(/\.plist$/i, ''), 300);
    const loaded = loadedByLabel.get(label);
    const args = Array.isArray(plist.ProgramArguments) ? plist.ProgramArguments.map((value) => normalizePersistenceText(value, 1000)).filter(Boolean) : [];
    const executable = normalizePersistenceText(plist.Program || args[0] || '', 1000);
    const command = [executable, ...args.slice(executable === args[0] ? 1 : 0)].filter(Boolean).join(' ');
    return {
      item: {
        kind: file.kind, source: 'launchd', scope: file.scope, name: label,
        command: normalizePersistenceText(command), executable,
        sourcePath: file.filePath, enabled: plist.Disabled !== true,
        state: loaded ? loaded.pid ? 'Running' : 'Loaded' : 'Configured',
        pid: loaded && loaded.pid ? loaded.pid : null,
      },
      label,
    };
  });
  const items = [];
  const parsedLabels = new Set();
  const failuresBySource = new Map();
  for (const parsed of parsedPlists) {
    if (!parsed || parsed.error) {
      const sourceId = parsed && parsed.sourceId || 'launchd-0';
      failuresBySource.set(sourceId, (failuresBySource.get(sourceId) || 0) + 1);
      continue;
    }
    items.push(parsed.item);
    parsedLabels.add(parsed.label);
  }
  for (const job of loadedJobs) {
    if (parsedLabels.has(job.label)) continue;
    items.push({
      kind: 'launchd-job', source: 'launchd loaded job', scope: 'runtime', name: normalizePersistenceText(job.label, 300),
      command: '', executable: '', sourcePath: '', enabled: null,
      state: job.pid ? 'Running' : 'Loaded', pid: job.pid,
    });
  }
  for (const [sourceId, failures] of failuresBySource) {
    const source = sources.find((entry) => entry.id === sourceId);
    if (!source) continue;
    source.complete = false;
    source.error = [source.error, failures + ' plist(s) could not be parsed'].filter(Boolean).join(' · ').slice(0, 500);
  }
  return finishPersistenceInventory(sources, items, truncated);
}

async function getPersistenceInventory() {
  if (IS_WIN) return collectWindowsPersistence();
  if (IS_MAC) return collectMacPersistence();
  if (IS_LINUX) return collectLinuxPersistence();
  return finishPersistenceInventory([sourceResult('unsupported', 'Startup/service inventory', false, false, 0, 'Unsupported platform')], []);
}

function normalizeComparablePath(value) {
  const pathValue = String(value || '').trim();
  if (!pathValue) return '';
  try { return IS_WIN ? path.win32.normalize(pathValue).toLowerCase() : path.normalize(pathValue); }
  catch { return pathValue; }
}

function isProcessRisky(item) {
  return !!item && (Number(item.suspicion) >= 35 || ['high', 'critical'].includes(item.suspicionLevel));
}

function processHeuristicScore(item) {
  if (!item) return 0;
  const score = Number(item.suspicion);
  const implied = item.suspicionLevel === 'critical' || item.suspicionLevel === 'high' ? 70 : item.suspicionLevel === 'medium' ? 35 : 0;
  return Math.max(Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0, implied);
}

function correlatePersistenceItems(inventory, processSnapshot, network) {
  const processes = processSnapshot && processSnapshot.available === true && Array.isArray(processSnapshot.items) ? processSnapshot.items : [];
  const processByPid = new Map(processes.filter((process) => process && Number.isSafeInteger(Number(process.pid))).map((process) => [Number(process.pid), process]));
  const processByPath = new Map();
  for (const process of processes) {
    const key = normalizeComparablePath(process.path);
    const current = key ? processByPath.get(key) : null;
    if (key && (!current || processHeuristicScore(process) > processHeuristicScore(current))) processByPath.set(key, process);
  }
  const listeningByPid = new Map();
  if (network && network.available === true && Array.isArray(network.listening)) {
    for (const endpoint of network.listening) {
      const pid = Number(endpoint && endpoint.pid);
      if (Number.isSafeInteger(pid) && pid > 0) listeningByPid.set(pid, (listeningByPid.get(pid) || 0) + 1);
    }
  }
  const processAvailable = processSnapshot && processSnapshot.available === true && Array.isArray(processSnapshot.items);
  const networkAvailable = network && network.available === true && Array.isArray(network.listening);
  const items = (inventory && Array.isArray(inventory.items) ? inventory.items : []).map((entry) => {
    const entryPid = Number.isSafeInteger(Number(entry.pid)) && Number(entry.pid) > 0 ? Number(entry.pid) : null;
    const directProcess = entryPid ? processByPid.get(entryPid) || null : null;
    const executableKey = normalizeComparablePath(entry.executable);
    const pathCandidate = !directProcess && executableKey ? processByPath.get(executableKey) || null : null;
    const process = directProcess || pathCandidate;
    const commandAssessment = suspicion({ name: [entry.name, entry.command].filter(Boolean).join(' '), path: entry.executable || '', cpu: 0, memBytes: 0 });
    // Resource-based process scores transfer only across a shared PID. An
    // executable-path match is a candidate, not proof that the instance came
    // from this startup entry.
    const processScore = directProcess ? processHeuristicScore(directProcess) : 0;
    const candidateProcessScore = pathCandidate && isProcessRisky(pathCandidate) ? processHeuristicScore(pathCandidate) : 0;
    const score = Math.max(commandAssessment.score, processScore, candidateProcessScore);
    const risky = score >= 35 || (directProcess && isProcessRisky(directProcess)) || (pathCandidate && isProcessRisky(pathCandidate));
    const flags = [...commandAssessment.reasons];
    if (directProcess && isProcessRisky(directProcess) && Array.isArray(directProcess.flags)) flags.push(...directProcess.flags);
    if (pathCandidate && isProcessRisky(pathCandidate) && Array.isArray(pathCandidate.flags)) flags.push(...pathCandidate.flags);
    const pid = entryPid;
    let listenerCount = null;
    let listenerCandidateCount = null;
    if (networkAvailable) {
      if (entryPid) {
        listenerCount = listeningByPid.get(entryPid) || 0;
        listenerCandidateCount = listenerCount;
      } else if (pathCandidate) {
        listenerCandidateCount = listeningByPid.get(Number(pathCandidate.pid)) || 0;
      } else if (processAvailable) {
        listenerCount = 0;
        listenerCandidateCount = 0;
      }
    }
    return {
      ...entry,
      pid,
      matchedPid: process ? Number(process.pid) || null : null,
      processName: process ? normalizePersistenceText(process.name, 300) : null,
      processMatched: !!process,
      processMatchType: directProcess ? 'pid' : pathCandidate ? 'executable-path-candidate' : null,
      processRiskScore: processScore,
      processCandidateRiskScore: candidateProcessScore,
      riskScore: score,
      riskLevel: score >= 70 ? 'critical' : score >= 35 ? 'high' : score > 0 ? 'medium' : 'clean',
      riskSignal: !!risky,
      riskOrigin: commandAssessment.score >= 35 && directProcess && isProcessRisky(directProcess) ? 'startup-and-running-process' : commandAssessment.score >= 35 ? 'startup-definition' : directProcess && isProcessRisky(directProcess) ? 'running-process' : pathCandidate && isProcessRisky(pathCandidate) ? 'executable-path-candidate' : null,
      riskFlags: [...new Set(flags)].slice(0, 8),
      listenerCount,
      listenerCandidateCount,
    };
  });
  const riskItems = items.filter((item) => item.riskSignal);
  const summary = {
    totalItems: Number.isSafeInteger(inventory && inventory.count) ? inventory.count : items.length,
    enabledItems: items.filter((item) => item.enabled === true).length,
    runningItems: items.filter((item) => Number(item.pid) > 0).length,
    riskItems: riskItems.length,
    riskItemsWithListeners: riskItems.filter((item) => item.listenerCount > 0).length,
    riskItemsWithListenerCandidates: riskItems.filter((item) => item.processMatchType === 'executable-path-candidate' && item.listenerCandidateCount > 0).length,
    pidMatchedItems: items.filter((item) => item.processMatchType === 'pid').length,
    executableMatchedItems: items.filter((item) => item.processMatchType === 'executable-path-candidate').length,
    unattributedRunningItems: items.filter((item) => Number(item.pid) > 0 && !item.processMatched).length,
  };
  const baseInventory = inventory || finishPersistenceInventory([], []);
  const attributionPartial = !processAvailable || !networkAvailable;
  return {
    ...baseInventory,
    sourcePartial: !!baseInventory.partial,
    partial: !!baseInventory.partial || attributionPartial,
    complete: baseInventory.complete === true && !attributionPartial,
    items,
    summary,
    processAvailable: !!processAvailable,
    networkAvailable: !!networkAvailable,
    processError: processAvailable ? null : normalizePersistenceText(processSnapshot && processSnapshot.error || 'Process inventory is unavailable', 500),
    networkError: networkAvailable ? null : normalizePersistenceText(network && network.error || 'Network endpoint inventory is unavailable', 500),
  };
}

async function getPersistenceAssessment() {
  const [inventory, processSnapshot, network] = await Promise.all([
    getPersistenceInventory().catch((error) => finishPersistenceInventory([sourceResult('persistence', 'Startup/service inventory', false, false, 0, error && error.message || error)], [])),
    getProcessSnapshot().catch((error) => ({ available: false, items: [], error: String(error && error.message || error) })),
    getNetwork().catch((error) => ({ available: false, connections: [], listening: [], exposed: [], error: String(error && error.message || error) })),
  ]);
  return correlatePersistenceItems(inventory, processSnapshot, network);
}

/* ---------------------------------------------------- firewall / security */

async function getFirewall() {
  if (IS_WIN) {
    const r = await ps('Get-NetFirewallProfile | Select-Object Name, Enabled, DefaultInboundAction | ConvertTo-Json -Compress');
    const j = parseJsonLoose(r.stdout);
    const arr = Array.isArray(j) ? j : (j ? [j] : []);
    const profiles = arr.map((p) => ({ name: p.Name, enabled: p.Enabled === true || p.Enabled === 'True', inboundAction: String(p.DefaultInboundAction || 'Unknown') }));
    if (!r.ok || !profiles.length) return { enabled: null, verified: false, profiles: [], details: r.stderr || 'Could not read Windows firewall profiles' };
    return {
      enabled: profiles.some((p) => p.enabled),
      verified: profiles.length >= 3 && profiles.every((p) => p.enabled && /^Block$/i.test(p.inboundAction)),
      profiles,
      details: profiles.map((p) => p.name + ': ' + (p.enabled ? 'ON' : 'OFF') + ' · inbound ' + p.inboundAction).join(' / '),
    };
  }
  if (IS_MAC) {
    const r = await run('/usr/libexec/ApplicationFirewall/socketfilterfw', ['--getglobalstate']);
    const txt = r.stdout + r.stderr;
    const stateMatch = txt.match(/State\s*=\s*(\d)/i);
    const hasState = /is enabled|is disabled/i.test(txt) || !!stateMatch;
    const enabled = /is enabled/i.test(txt) || (stateMatch && stateMatch[1] === '1');
    const gk = await run('spctl', ['--status']);
    const gatekeeper = /assessments enabled/i.test(gk.stdout + gk.stderr);
    const details = hasState
      ? (enabled ? 'Application Firewall is enabled' : 'Application Firewall is disabled') + '; application-specific inbound rules are not audited'
      : (txt.trim() || 'Application Firewall status unavailable');
    return {
      enabled: hasState ? !!enabled : null,
      // The global service flag does not establish which inbound app rules are permitted.
      verified: false,
      profiles: [{ name: 'Application Firewall', enabled: hasState ? !!enabled : null }],
      details: details + (gk.ok ? '; Gatekeeper ' + (gatekeeper ? 'enabled' : 'disabled') + ' (not a firewall)' : ''),
    };
  }

  const [ufw, firewalld, zone, nft] = await Promise.all([
    run('ufw', ['status', 'verbose']),
    run('firewall-cmd', ['--state']),
    run('firewall-cmd', ['--get-default-zone']),
    run('nft', ['list', 'ruleset']),
  ]);
  const ufwKnown = ufw.ok && /^Status:\s*(active|inactive)/im.test(ufw.stdout);
  const ufwActive = ufwKnown && /^Status:\s*active/im.test(ufw.stdout);
  const ufwDefaultDeny = ufwActive && /Default:\s*deny\s*\(incoming\)/i.test(ufw.stdout);
  const firewalldActive = firewalld.ok && firewalld.stdout.trim() === 'running';
  let firewalldDefaultDrop = false;
  if (firewalldActive && zone.ok && zone.stdout.trim()) {
    const z = await run('firewall-cmd', ['--list-all', '--zone=' + zone.stdout.trim()]);
    firewalldDefaultDrop = z.ok && /^\s*target:\s*(DROP|REJECT)\s*$/im.test(z.stdout);
  }
  const nftRules = nft.ok ? nft.stdout : '';
  const nftActive = nft.ok && nftRules.trim().length > 0;
  const nftDefaultDrop = nftActive && /hook\s+input[^}]*policy\s+(drop|reject)/is.test(nftRules);
  const known = ufwKnown || firewalld.ok || nft.ok;
  const enabled = ufwActive || firewalldActive || nftActive;
  const verified = ufwDefaultDeny || firewalldDefaultDrop || nftDefaultDrop;
  const profiles = [
    { name: 'ufw', enabled: ufwKnown ? ufwActive : null },
    { name: 'firewalld', enabled: firewalld.ok ? firewalldActive : null },
    { name: 'nftables ruleset', enabled: nft.ok ? nftActive : null },
  ];
  const details = !known
    ? 'Could not determine Linux firewall status'
    : !enabled
      ? 'No active UFW, firewalld, or nftables ruleset detected'
      : (verified ? 'Firewall active; a default-deny inbound policy was detected' : 'Firewall service/ruleset detected; effective inbound policy could not be verified');
  return { enabled: known ? enabled : null, verified, profiles, details };
}

async function enableFirewall() {
  if (IS_WIN) {
    const r = await run('netsh', ['advfirewall', 'set', 'allprofiles', 'state', 'on']);
    if (!r.ok) return { ok: false, error: r.stderr || 'Could not enable Windows Firewall; administrator rights may be required' };
    const status = await getFirewall();
    return { ok: status.enabled === true && status.verified, error: status.verified ? null : 'Firewall was enabled, but its default inbound policy could not be verified' };
  }
  if (IS_MAC) {
    const r = await run('/usr/libexec/ApplicationFirewall/socketfilterfw', ['--setglobalstate', 'on']);
    if (!r.ok) return { ok: false, error: r.stderr || 'Could not enable macOS Firewall; administrator approval may be required' };
    const status = await getFirewall();
    return {
      ok: status.enabled === true,
      verified: status.verified === true,
      error: status.enabled ? (status.verified ? null : 'Firewall is enabled; application-specific inbound rules still need manual review') : 'Firewall command completed but status could not be verified',
    };
  }
  const ufwStatus = await run('ufw', ['status']);
  if (ufwStatus.ok || /ufw:|command not found/i.test(ufwStatus.stderr)) {
    if (!ufwStatus.ok && /not found/i.test(ufwStatus.stderr)) return { ok: false, error: 'UFW is not installed; configure an installed Linux firewall manually' };
    const r = await run('sudo', ['-n', 'ufw', '--force', 'enable'], { timeout: 30000 });
    if (!r.ok) return { ok: false, error: r.stderr || 'Administrator authorization is required to enable UFW' };
    const status = await getFirewall();
    return { ok: status.enabled === true && status.verified, error: status.verified ? null : 'UFW was enabled but its inbound policy could not be verified' };
  }
  const state = await run('firewall-cmd', ['--state']);
  if (state.ok || !/not found/i.test(state.stderr)) {
    const r = await run('sudo', ['-n', 'systemctl', 'enable', '--now', 'firewalld'], { timeout: 30000 });
    if (!r.ok) return { ok: false, error: r.stderr || 'Administrator authorization is required to enable firewalld' };
    const status = await getFirewall();
    return { ok: status.enabled === true && status.verified, error: status.verified ? null : 'firewalld was started but its inbound policy could not be verified' };
  }
  return { ok: false, error: 'No supported Linux firewall manager was found' };
}

async function getEncryption() {
  if (IS_WIN) {
    const drive = process.env.SystemDrive || 'C:';
    const r = await run('manage-bde', ['-status', drive]);
    const txt = r.stdout + r.stderr;
    const conv = (txt.match(/Conversion Status:\s*(.+)/i) || [])[1] || '';
    const pct = (txt.match(/Percentage Encrypted:\s*(.+)/i) || [])[1] || '';
    const protection = (txt.match(/Protection Status:\s*(.+)/i) || [])[1] || '';
    if (!conv && !pct && !protection) return { enabled: null, details: txt.trim() || 'BitLocker status unavailable' };
    const fully = /Fully Encrypted/i.test(conv) && /100%/.test(pct);
    const protectedNow = /Protection On/i.test(protection);
    return { enabled: fully && protectedNow, details: [conv.trim(), pct.trim(), protection.trim()].filter(Boolean).join(' · ') || 'BitLocker status incomplete' };
  }
  if (IS_MAC) {
    const r = await run('fdesetup', ['status']);
    const txt = r.stdout + r.stderr;
    if (/FileVault is On/i.test(txt)) return { enabled: true, details: txt.trim().split('\n')[0] };
    if (/FileVault is Off/i.test(txt)) return { enabled: false, details: txt.trim().split('\n')[0] };
    return { enabled: null, details: txt.trim() || 'FileVault status unavailable' };
  }
  const root = await run('findmnt', ['-n', '-o', 'SOURCE,FSTYPE', '/']);
  if (!root.ok || !root.stdout.trim()) return { enabled: null, details: root.stderr || 'Could not identify the root filesystem' };
  const source = root.stdout.trim().split(/\s+/)[0];
  if (!source.startsWith('/dev/')) return { enabled: null, details: 'Root filesystem is not a directly inspectable block device (' + source + ')' };
  const chain = await run('lsblk', ['-s', '-n', '-o', 'TYPE,FSTYPE', source]);
  if (!chain.ok) return { enabled: null, details: chain.stderr || 'Could not inspect the root device encryption chain' };
  const encrypted = /(^|\n)\s*(crypt\b|\S+\s+crypto_LUKS\b)/i.test(chain.stdout);
  return { enabled: encrypted, details: encrypted ? 'Encryption detected in the root device chain' : 'No encrypted layer detected for the root filesystem' };
}

/* --------------------------------------------------------------- updates */

async function getUpdates() {
  if (IS_WIN) {
    const script = [
      '$pending = @(); $queryOk = $false; $queryError = "";',
      'try {',
      '  $session = New-Object -ComObject Microsoft.Update.Session;',
      '  $searcher = $session.CreateUpdateSearcher();',
      '  $search = $searcher.Search("IsInstalled=0 and IsHidden=0 and Type=\'Software\'");',
      '  for ($i = 0; $i -lt $search.Updates.Count; $i++) {',
      '    $u = $search.Updates.Item($i);',
      '    $pending += [pscustomobject]@{ Title=$u.Title; KB=(@($u.KBArticleIDs) -join ","); Size=[int64]$u.MaxDownloadSize }',
      '  }',
      '  $queryOk = $true;',
      '} catch { $queryError = $_.Exception.Message }',
      '$h = @(Get-HotFix -ErrorAction SilentlyContinue | Sort-Object InstalledOn -Descending | Select-Object -First 25 HotFixID, Description, InstalledOn);',
      '$reboot = Test-Path "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired";',
      '[pscustomobject]@{ HotFixes=$h; RebootRequired=$reboot; Pending=$pending; QueryOk=$queryOk; QueryError=$queryError } | ConvertTo-Json -Compress -Depth 5',
    ].join('\n');
    const r = await ps(script, 90000);
    const j = parseJsonLoose(r.stdout);
    if (!j) return { items: [], history: [], checkStatus: 'error', note: r.stderr || 'Windows Update query returned no data', rebootRequired: null };
    const hotfixes = (Array.isArray(j.HotFixes) ? j.HotFixes : (j.HotFixes ? [j.HotFixes] : []))
      .map((h) => ({ name: h.HotFixID, version: h.Description || '', time: h.InstalledOn || '', source: 'Windows Update' }));
    let lastInstalled = null;
    for (const h of hotfixes) {
      const d = new Date(h.time);
      if (!isNaN(d) && (!lastInstalled || d > lastInstalled)) lastInstalled = d;
    }
    const pending = Array.isArray(j.Pending) ? j.Pending : (j.Pending ? [j.Pending] : []);
    const items = pending.map((u) => ({ name: u.Title || 'Update', version: u.KB || '', size: Number(u.Size) || 0, source: 'Windows Update' }));
    const queryOk = j.QueryOk === true || j.QueryOk === 'True';
    return {
      items, history: hotfixes,
      lastInstalled: lastInstalled ? lastInstalled.toISOString().slice(0, 10) : null,
      daysSinceLastUpdate: lastInstalled ? Math.floor((Date.now() - lastInstalled.getTime()) / 86400000) : null,
      rebootRequired: j.RebootRequired === true || j.RebootRequired === 'True',
      checkStatus: queryOk ? 'ok' : 'error',
      note: queryOk ? (items.length ? items.length + ' update(s) available' : 'Windows Update reports no pending software updates') : ('Windows Update check failed: ' + (j.QueryError || r.stderr || 'unknown error')),
    };
  }
  if (IS_MAC) {
    const r = await run('softwareupdate', ['-l'], { timeout: 120000 });
    if (!r.ok) return { items: [], history: [], checkStatus: 'error', note: r.stderr || r.stdout || 'Apple Software Update query failed', rebootRequired: null };
    const items = [];
    const re = /^\s*\*\s*Label:\s*(.+)$/gm;
    let m;
    while ((m = re.exec(r.stdout)) !== null) items.push({ name: m[1].trim(), version: '', size: 0, source: 'Apple Software Update' });
    const restart = /restart/i.test(r.stdout);
    return { items, history: [], lastInstalled: null, daysSinceLastUpdate: null, rebootRequired: restart, checkStatus: 'ok', note: restart ? 'A restart is required to finish updating' : (items.length ? items.length + ' update(s) available' : 'Apple Software Update reports no pending updates') };
  }
  const r = await run('apt', ['list', '--upgradable'], { timeout: 120000 });
  if (!r.ok) return { items: [], history: [], checkStatus: 'error', note: r.stderr || 'Could not query APT updates', rebootRequired: null };
  const items = [];
  for (const line of r.stdout.trim().split('\n')) {
    const m = line.match(/^(\S+)\/(\S+)\s+(\S+)\s+(\S+)/);
    if (m) items.push({ name: m[1], version: m[3], arch: m[4], source: 'apt (' + m[2] + ')' });
  }
  return {
    items, history: [], lastInstalled: null, daysSinceLastUpdate: null, rebootRequired: false,
    checkStatus: 'ok',
    note: items.length ? items.length + ' package update(s) available' : 'No upgradable packages in the local APT index; refresh package metadata to confirm',
  };
}

async function installUpdates() {
  if (IS_WIN) {
    const script = [
      '$session = New-Object -ComObject Microsoft.Update.Session;',
      '$searcher = $session.CreateUpdateSearcher();',
      '$search = $searcher.Search("IsInstalled=0 and IsHidden=0 and Type=\'Software\'");',
      '$updates = New-Object -ComObject Microsoft.Update.UpdateColl;',
      'for ($i = 0; $i -lt $search.Updates.Count; $i++) {',
      '  $u = $search.Updates.Item($i); if (-not $u.EulaAccepted) { $u.AcceptEula() }; [void]$updates.Add($u)',
      '}',
      'if ($updates.Count -eq 0) { [pscustomobject]@{ ResultCode=2; RebootRequired=$false; Count=0 } | ConvertTo-Json -Compress; exit 0 }',
      '$installer = $session.CreateUpdateInstaller(); $installer.Updates = $updates;',
      '$result = $installer.Install();',
      '[pscustomobject]@{ ResultCode=$result.ResultCode; RebootRequired=$result.RebootRequired; Count=$updates.Count } | ConvertTo-Json -Compress',
    ].join('\n');
    const r = await ps(script, 600000);
    const j = parseJsonLoose(r.stdout);
    if (!r.ok || !j) return { ok: false, error: r.stderr || r.stdout || 'Windows Update installation failed' };
    const code = Number(j.ResultCode);
    const ok = code === 2 || code === 3;
    return { ok, rebootRequired: j.RebootRequired === true || j.RebootRequired === 'True', note: ok ? (Number(j.Count) ? 'Windows Update completed for ' + j.Count + ' update(s)' : 'No updates were pending') : 'Windows Update returned result code ' + code };
  }
  if (IS_MAC) {
    const r = await run('softwareupdate', ['-i', '-a'], { timeout: 600000 });
    return { ok: r.ok, note: (r.stdout || '').slice(-600), error: r.ok ? null : (r.stderr || 'Administrator approval may be required') };
  }
  const r = await run('sudo', ['-n', 'apt-get', 'upgrade', '-y'], { timeout: 600000 });
  return { ok: r.ok, note: (r.stdout || '').slice(-600), error: r.ok ? null : (r.stderr || 'Administrator authorization is required to install updates') };
}

/* ------------------------------------------------------------ system logs */

async function getSystemErrors() {
  if (IS_WIN) {
    const script = [
      '$since = (Get-Date).AddHours(-24); $available = $true; $queryError = \'\'; $events = @();',
      "try { $events = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; Level = 2; StartTime = $since } -MaxEvents 200 -ErrorAction Stop) } catch {",
      "  if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*' -or $_.Exception.Message -match 'No events were found') { $events = @() }",
      '  else { $available = $false; $queryError = $_.Exception.Message; $events = @() }',
      '}',
      '$items = @($events | Select-Object TimeCreated, Id, ProviderName,',
      '  @{n="Message";e={ $msg=[string]$_.Message; $msg.Substring(0,[Math]::Min(220,$msg.Length)) }});',
      '[pscustomobject]@{ Available=$available; Error=$queryError; Items=$items } | ConvertTo-Json -Compress -Depth 4',
    ].join('\n');
    const r = await ps(script, 40000);
    const j = parseJsonLoose(r.stdout);
    if (!r.ok || !j || j.Available === false || j.Available === 'False') {
      return { items: [], count24h: null, available: false, window: 'unavailable', error: (j && j.Error) || r.stderr || 'Could not read Windows event log' };
    }
    const rawItems = j.Items;
    const arr = Array.isArray(rawItems) ? rawItems : (rawItems ? [rawItems] : []);
    const items = arr.map((e) => ({ time: e.TimeCreated || '', source: e.ProviderName || 'System', id: e.Id || '', message: (e.Message || '').replace(/\s+/g, ' ').trim() }));
    return { items, count24h: items.length, available: true, window: 'last 24h (up to 200 System error events)' };
  }
  if (IS_MAC) {
    const r = await run('log', ['show', '--last', '24h', '--predicate', 'eventType == "error"', '--style', 'compact'], { timeout: 60000 });
    if (!r.ok) return { items: [], count24h: null, available: false, window: 'unavailable', error: r.stderr || 'Could not read macOS unified log' };
    const all = r.stdout.trim().split('\n').filter(Boolean);
    const items = all.slice(-200).map((line) => {
      const m = line.match(/^(\S+\s+\S+)\s+(.*)$/);
      return { time: m ? m[1] : '', source: 'macOS unified log', id: '', message: (m ? m[2] : line).replace(/\s+/g, ' ').trim().slice(0, 240) };
    });
    return { items, count24h: all.length, available: true, window: 'last 24h (up to 200 displayed error events)' };
  }
  const r = await run('journalctl', ['-p', '3', '--since', '24 hours ago', '-n', '200', '--no-pager', '-o', 'short-iso'], { timeout: 60000 });
  if (!r.ok) return { items: [], count24h: null, available: false, window: 'unavailable', error: r.stderr || 'Could not read the system journal' };
  const lines = r.stdout.trim().split('\n').filter(Boolean);
  const items = lines.map((line) => {
    const m = line.match(/^(\S+\s+\S+)\s+(\S+)\s+([^:]+):\s*(.*)$/);
    return m ? { time: m[1], source: m[3].trim(), id: '', message: m[4].trim().slice(0, 240) } : { time: '', source: 'journal', id: '', message: line.trim().slice(0, 240) };
  });
  return { items, count24h: items.length, available: true, window: 'last 24h (up to 200 newest journal errors)' };
}

/* ------------------------------------------------------------ file scanner */

const SKIP_DIRS = new Set([
  'proc', 'sys', 'dev', 'run', 'snap', '.git', 'node_modules',
  'System Volume Information', '$Recycle.Bin', 'Windows', 'Program Files',
  'Program Files (x86)', 'ProgramData', 'AppData', 'Library', 'private',
]);
const JUNK_NAME = [/^\.DS_Store$/i, /^Thumbs\.db$/i, /^desktop\.ini$/i, /^~\$/, /\.(tmp|temp|bak|old|dmp|chk|gid|crdownload|part|download)$/i, /~$/];
const JUNK_DIR_HINT = /(^|[\\/])(Temp|tmp|__pycache__|Minidump|\.cache|Caches)([\\/]|$)/i;
const MIN_JUNK_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_SCAN_FILES = 250000;
const MAX_SCAN_DEPTH = 12;
const MAX_SCAN_MS = 120000;

function isJunk(name, full) {
  if (JUNK_NAME.some((re) => re.test(name))) return true;
  return JUNK_DIR_HINT.test(full);
}
function junkKind(name, full) {
  if (/__pycache__|(^|[\\/])(?:\.cache|Caches)([\\/]|$)/i.test(full)) return 'Cache (review before removal)';
  if (/\.(bak|old|tmp|temp|dmp|chk)$/i.test(name) || /~$/.test(name)) return 'Temporary / backup file';
  if (/^\.DS_Store$/i.test(name) || /^Thumbs\.db$/i.test(name) || /^desktop\.ini$/i.test(name)) return 'Generated metadata';
  return 'Old temporary file';
}

function hashFile(file, timeoutMs = MAX_SCAN_MS) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    const timer = setTimeout(() => {
      const error = new Error('File hashing exceeded the scan time limit');
      error.code = 'ETIMEDOUT';
      stream.destroy(error);
    }, Math.max(1, timeoutMs));
    const finish = (error, value) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    stream.on('error', (error) => finish(error));
    stream.on('data', (data) => h.update(data));
    stream.on('end', () => finish(null, h.digest('hex')));
  });
}

function defaultRoots(mode) {
  const home = os.homedir();
  if (mode === 'junk') {
    const roots = [os.tmpdir(), path.join(home, '.cache')];
    if (IS_WIN) roots.push(path.join(home, 'AppData', 'Local', 'Temp'), path.join(home, 'AppData', 'Local', 'Microsoft', 'Windows', 'INetCache'));
    if (IS_MAC) roots.push(path.join(home, 'Library', 'Caches'));
    return [...new Set(roots.filter(Boolean))];
  }
  return [home].filter(Boolean);
}

async function normalizeRoots(values, strict, onSkipped = null) {
  if (!Array.isArray(values) || values.length > 16) throw new Error('Provide at most 16 scan folders');
  const roots = [];
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim() || value.length > 4096 || !path.isAbsolute(value)) {
      if (strict) throw new Error('Scan folders must be absolute paths');
      if (onSkipped) onSkipped(null, value);
      continue;
    }
    let real;
    try {
      real = await fsp.realpath(path.resolve(value));
      const stat = await fsp.stat(real);
      if (!stat.isDirectory()) {
        if (strict) throw new Error('A scan folder is not a directory');
        if (onSkipped) onSkipped(null, value);
        continue;
      }
    } catch (e) {
      if (strict) throw new Error('Scan folder is unavailable: ' + value);
      if (onSkipped && !['ENOENT', 'ENOTDIR'].includes(e.code)) onSkipped(e, value);
      continue;
    }
    roots.push(real);
  }
  const key = (value) => IS_WIN ? value.toLowerCase() : value;
  const sorted = [...new Set(roots.map(key))].sort((a, b) => a.length - b.length);
  const unique = [];
  for (const rootKey of sorted) {
    const root = roots.find((r) => key(r) === rootKey);
    if (!unique.some((parent) => isWithin(parent, root))) unique.push(root);
  }
  return unique;
}

async function scanFiles(opts = {}) {
  if (!opts || typeof opts !== 'object' || Array.isArray(opts)) throw new Error('Invalid scan options');
  const mode = opts.mode || 'junk';
  if (!['junk', 'large', 'duplicates'].includes(mode)) throw new Error('Unsupported scan mode');
  const customRoots = Array.isArray(opts.roots) && opts.roots.length > 0;
  if (opts.roots != null && !Array.isArray(opts.roots)) throw new Error('Scan folders must be an array');
  const requestedRoots = customRoots ? opts.roots : defaultRoots(mode);
  let skipped = 0;
  const roots = await normalizeRoots(requestedRoots, customRoots, () => { skipped++; });
  const requestedMinSize = Number(opts.minSize);
  const minSize = Number.isFinite(requestedMinSize) && requestedMinSize > 0
    ? Math.min(Math.max(Math.floor(requestedMinSize), 1), 10 * 1024 ** 4)
    : 100 * 1024 * 1024;
  const requestedMaxMs = Number(opts.maxMs);
  const maxMs = Number.isFinite(requestedMaxMs) && requestedMaxMs > 0
    ? Math.min(Math.max(Math.floor(requestedMaxMs), 1000), MAX_SCAN_MS)
    : MAX_SCAN_MS;
  const requestedMaxDepth = Number(opts.maxDepth);
  const maxDepth = Number.isFinite(requestedMaxDepth)
    ? Math.min(Math.max(Math.floor(requestedMaxDepth), 0), MAX_SCAN_DEPTH)
    : MAX_SCAN_DEPTH;
  if (!roots.length) return {
    available: false, error: 'No accessible scan folders were found', incomplete: true, skipped,
    mode, roots, scanned: 0, bytes: 0, truncated: false, durationMs: 0, maxMs, maxDepth,
    count: 0, reclaimable: 0, minJunkAgeMs: MIN_JUNK_AGE_MS, results: [],
  };
  const results = [];
  const sizeMap = new Map();
  const visitedFiles = new Set();
  let scanned = 0;
  let bytes = 0;
  let truncated = false;
  const t0 = Date.now();
  const timeUp = () => Date.now() - t0 >= maxMs;
  const fileKey = (value) => IS_WIN ? value.toLowerCase() : value;
  const noteFsIssue = (error) => {
    if (!error || !['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) skipped++;
  };

  async function walk(dir, depth) {
    if (truncated || scanned >= MAX_SCAN_FILES || timeUp()) { truncated = true; return; }
    let directory;
    try { directory = await fsp.opendir(dir); } catch (error) { noteFsIssue(error); return; }
    try {
      for await (const e of directory) {
        if (truncated || scanned >= MAX_SCAN_FILES || timeUp()) { truncated = true; return; }
        const full = path.resolve(path.join(dir, e.name));
        if (e.isDirectory()) {
          if (depth < maxDepth && !SKIP_DIRS.has(e.name)) await walk(full, depth + 1);
        } else if (e.isFile()) {
          const key = fileKey(full);
          if (visitedFiles.has(key)) continue;
          visitedFiles.add(key);
          let stat;
          try { stat = await fsp.lstat(full); } catch (error) { noteFsIssue(error); continue; }
          if (!stat.isFile() || stat.isSymbolicLink()) continue;
          const size = stat.size;
          scanned++;
          bytes += size;
          if (mode === 'junk' && isJunk(e.name, full) && Date.now() - stat.mtimeMs >= MIN_JUNK_AGE_MS) {
            results.push({ path: full, size, mtimeMs: stat.mtimeMs, kind: junkKind(e.name, full) });
          } else if (mode === 'large' && size >= minSize) {
            results.push({ path: full, size, mtimeMs: stat.mtimeMs, kind: 'Large file (>= ' + fmtBytes(minSize) + ')' });
          } else if (mode === 'duplicates' && size > 0 && size < 512 * 1024 * 1024) {
            if (!sizeMap.has(size)) sizeMap.set(size, []);
            sizeMap.get(size).push({ path: full, size, mtimeMs: stat.mtimeMs });
          }
          if (results.length > 20000) { truncated = true; return; }
        }
      }
    } catch (error) { noteFsIssue(error); }
  }

  for (const root of roots) await walk(root, 0);

  if (mode === 'duplicates') {
    const groups = [];
    for (const [size, files] of sizeMap) {
      if (truncated) break;
      if (files.length < 2) continue;
      const byHash = new Map();
      for (const file of files) {
        if (timeUp()) { truncated = true; break; }
        try {
          const before = await fsp.stat(file.path);
          const hash = await hashFile(file.path, maxMs - (Date.now() - t0));
          const after = await fsp.stat(file.path);
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.size !== file.size || before.mtimeMs !== file.mtimeMs) { skipped++; continue; }
          if (!byHash.has(hash)) byHash.set(hash, []);
          byHash.get(hash).push(file.path);
        } catch (error) {
          if (error.code === 'ETIMEDOUT') { truncated = true; break; }
          noteFsIssue(error); /* ignore unreadable or changed files */
        }
      }
      for (const files2 of byHash.values()) {
        if (files2.length > 1) groups.push({
          size, count: files2.length, files: files2.slice(0, 20), omitted: Math.max(0, files2.length - 20),
          wasted: size * (files2.length - 1),
        });
      }
    }
    groups.sort((a, b) => b.wasted - a.wasted);
    if (groups.length > 500) truncated = true;
    for (const g of groups.slice(0, 500)) results.push({ kind: 'Duplicate group x' + g.count, size: g.size, wasted: g.wasted, files: g.files, omitted: g.omitted, count: g.count });
  }

  results.sort((a, b) => (b.wasted || b.size) - (a.wasted || a.size));
  const reclaimable = results.reduce((sum, result) => sum + (result.wasted || (mode === 'junk' ? result.size : 0)), 0);
  const visibleResults = results.slice(0, 2000);
  const resultsTruncated = truncated || results.length > visibleResults.length;
  return {
    available: true, error: null, incomplete: resultsTruncated || skipped > 0, skipped,
    mode, roots, scanned, bytes, truncated: resultsTruncated, durationMs: Date.now() - t0, maxMs, maxDepth,
    count: results.length, reclaimable, minJunkAgeMs: MIN_JUNK_AGE_MS,
    results: visibleResults,
  };
}

async function validateCleanCandidates(paths, allowedCandidates, roots) {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 200) throw new Error('Select between 1 and 200 files');
  if (!Array.isArray(allowedCandidates) || !Array.isArray(roots)) throw new Error('No valid scan session; scan again before cleaning');
  const allowed = new Map(allowedCandidates.filter((x) => x && typeof x.path === 'string').map((x) => [path.resolve(x.path), x]));
  const rootPaths = [];
  for (const root of roots) {
    try { rootPaths.push(await fsp.realpath(root)); } catch { /* a root disappeared */ }
  }
  const output = [];
  const seen = new Set();
  for (const value of paths) {
    if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid file path');
    const full = path.resolve(value);
    if (seen.has(full)) continue;
    seen.add(full);
    const scanned = allowed.get(full);
    if (!scanned) throw new Error('Refusing to remove a file that was not in the latest junk scan');
    const stat = await fsp.lstat(full);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Refusing to remove directories or symbolic links');
    if (stat.size !== scanned.size || stat.mtimeMs !== scanned.mtimeMs) throw new Error('File changed since the scan; scan again before cleaning');
    if (Date.now() - stat.mtimeMs < MIN_JUNK_AGE_MS || !isJunk(path.basename(full), full)) throw new Error('File is not an old, recognized cleanup candidate');
    const real = await fsp.realpath(full);
    if (!rootPaths.some((root) => isWithin(root, real))) throw new Error('File is outside the scanned folders');
    output.push(real);
  }
  return output;
}

/* ---------------------------------------------------------- health score */

function computeHealthScore(d) {
  let score = 100;
  const findings = [];
  const push = (pts, sev, msg) => { score -= pts; findings.push({ sev, msg, pts }); };

  if (!d.firewall || d.firewall.enabled == null) push(8, 'warning', 'Firewall status could not be verified');
  else if (d.firewall.enabled === false) push(35, 'critical', 'No supported firewall is active');
  else if (d.firewall.verified !== true) push(8, 'warning', 'Firewall is active but its inbound policy is not verified');
  if (!d.encryption || d.encryption.enabled == null) push(5, 'info', 'System-volume encryption status is unknown');
  else if (d.encryption.enabled === false) push(10, 'warning', 'System-volume encryption is not detected');

  if (!d.updates || d.updates.checkStatus !== 'ok') push(8, 'warning', 'Operating-system update status could not be checked');
  else if (Array.isArray(d.updates.items) && d.updates.items.length) {
    push(Math.min(20, d.updates.items.length * 3), 'warning', d.updates.items.length + ' pending operating-system update(s)');
  }
  if (d.updates && d.updates.rebootRequired === true) push(5, 'warning', 'A restart is required to finish installing updates');
  if (d.updates && d.updates.daysSinceLastUpdate != null && d.updates.daysSinceLastUpdate > 45) push(8, 'warning', 'Last recorded system update was ' + d.updates.daysSinceLastUpdate + ' days ago');

  if (!d.errors || d.errors.available === false) push(3, 'info', 'Recent system logs could not be checked');
  else {
    const errCount = Number.isFinite(d.errors.count24h) ? d.errors.count24h : Array.isArray(d.errors.items) ? d.errors.items.length : null;
    if (errCount == null) push(3, 'info', 'Recent system error count is unavailable');
    else if (errCount > 0) push(Math.min(12, Math.ceil(errCount / 2)), 'warning', errCount + ' system error event(s) in the last 24h');
  }

  const processes = Array.isArray(d.processes) ? d.processes : [];
  if (!Array.isArray(d.processes)) push(3, 'info', 'Process inventory could not be read');
  if (d.processesAvailable === false) push(5, 'warning', 'Process inventory could not be read');
  const critical = processes.filter((p) => p.suspicion >= 70 || p.suspicionLevel === 'critical');
  const high = processes.filter((p) => p.suspicion >= 35 && p.suspicion < 70 && p.suspicionLevel !== 'critical');
  if (critical.length) push(Math.min(70, critical.length * 45), 'critical', critical.length + ' process(es) match high-risk heuristic indicators — investigate manually');
  if (high.length) push(Math.min(25, high.length * 12), 'warning', high.length + ' process(es) match medium/high-risk heuristic indicators');

  if (processes.length) {
    const cpu = Math.min(100, processes.reduce((sum, p) => sum + (p.cpu || 0), 0));
    if (cpu > 90) push(4, 'info', 'Measured CPU usage is very high (' + Math.round(cpu) + '%)');
  }
  const sys = d.system || {};
  const ramPct = sys.totalRam ? (1 - sys.freeRam / sys.totalRam) * 100 : null;
  if (ramPct == null) push(3, 'info', 'Memory usage could not be checked');
  else if (ramPct > 92) push(5, 'warning', 'Memory usage is above 92%');
  const disk = d.systemDisk || (d.disks || []).find((x) => x.isSystem) || (d.disks || []).find((x) => x.mount === '/');
  if (!disk || !disk.size) push(3, 'info', 'System disk usage could not be checked');
  else if (disk.used / disk.size > 0.92) push(5, 'warning', 'System disk is almost full');
  if (!d.networkSummary || d.networkSummary.available === false || !Number.isFinite(d.networkSummary.exposed)) {
    push(3, 'info', 'Network endpoint exposure could not be assessed');
  } else if (d.networkSummary.exposed > 0) {
    const exposed = d.networkSummary.exposed;
    push(Math.min(10, exposed * 2), 'warning', exposed + ' externally bound listening endpoint(s) need review');
  }
  if (d.networkCorrelation && d.networkCorrelation.available === true && d.networkCorrelation.flagged > 0) {
    push(Math.min(15, d.networkCorrelation.flagged * 6), 'warning', d.networkCorrelation.flagged + ' non-loopback listener(s) are owned by process(es) with high-risk heuristics; investigate manually');
  }
  if (!d.persistence || d.persistence.available !== true || !d.persistence.summary) {
    push(3, 'info', 'Startup and service sources could not be checked');
  } else {
    if (d.persistence.partial === true) push(2, 'info', 'Startup/service or process/network attribution coverage is partial');
    const riskItems = Number.isFinite(d.persistence.summary.riskItems) ? d.persistence.summary.riskItems : null;
    const listenerItems = Number.isFinite(d.persistence.summary.riskItemsWithListeners) ? d.persistence.summary.riskItemsWithListeners : null;
    const candidateListenerItems = Number.isFinite(d.persistence.summary.riskItemsWithListenerCandidates) ? d.persistence.summary.riskItemsWithListenerCandidates : null;
    if (riskItems == null) push(3, 'info', 'Startup/service risk summary is unavailable');
    else if (riskItems > 0) push(Math.min(12, riskItems * 4), 'warning', riskItems + ' startup/service item(s) match process-risk heuristics; review the source and command');
    if (d.persistence.networkAvailable !== true || listenerItems == null) push(2, 'info', 'Startup/service listener correlation is unavailable');
    else if (listenerItems > 0) push(Math.min(10, listenerItems * 5), 'warning', listenerItems + ' risk-marked startup/service item(s) share a PID with a listening endpoint');
    if (d.persistence.processAvailable !== true || d.persistence.networkAvailable !== true || candidateListenerItems == null) push(1, 'info', 'Executable-path listener candidates could not be fully assessed');
    else if (candidateListenerItems > 0) push(Math.min(6, candidateListenerItems * 3), 'info', candidateListenerItems + ' risk-marked startup definition(s) have a possible executable-path listener match; ownership is unconfirmed');
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const grade = score >= 95 ? 'S' : score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : 'D';
  return { score, grade, findings: findings.sort((a, b) => b.pts - a.pts), disclaimer: 'Heuristic posture indicator only; not an antivirus or a guarantee of security.' };
}

/* ------------------------------------------------------------- quick scan */

async function quickScan() {
  const t0 = Date.now();
  const [system, disks, processSnapshot, firewall, updates, errors, encryption, network, persistenceInventory] = await Promise.all([
    getSystemInfo(),
    getDiskUsage(),
    getProcessSnapshot(),
    getFirewall(),
    getUpdates(),
    getSystemErrors(),
    getEncryption(),
    getNetwork().catch(() => null),
    getPersistenceInventory().catch((error) => finishPersistenceInventory([sourceResult('persistence', 'Startup/service inventory', false, false, 0, error && error.message || error)], [])),
  ]);
  const processes = processSnapshot.available ? processSnapshot.items : [];
  const networkCorrelation = correlateNetworkExposure(processSnapshot, network);
  const persistence = correlatePersistenceItems(persistenceInventory, processSnapshot, network);
  const systemDisk = disks.find((disk) => disk.isSystem) || disks.find((disk) => disk.mount === '/') || null;
  const junk = await scanFiles({ mode: 'junk', maxMs: 45000, maxDepth: 8 });
  const networkSummary = network ? {
    connections: network.connections.length,
    listening: network.listening.length,
    exposed: network.available ? network.exposed.length : null,
    available: network.available,
    error: network.error,
  } : null;
  const score = computeHealthScore({ system, systemDisk, disks, processes, processesAvailable: processSnapshot.available, firewall, updates, errors, encryption, networkSummary, networkCorrelation, persistence });
  return {
    system, systemDisk, disks, processesAvailable: processSnapshot.available, processError: processSnapshot.error,
    processes: processes.slice(0, 400),
    suspicious: processes.filter((p) => p.suspicion > 0).slice(0, 50),
    firewall, encryption, updates, errors, networkSummary, networkCorrelation,
    persistenceAvailable: persistence.available, persistencePartial: persistence.partial, persistenceSummary: persistence.summary,
    junk: { available: junk.available, incomplete: junk.incomplete, skipped: junk.skipped, error: junk.error || null, scanned: junk.scanned, reclaimable: junk.reclaimable, count: junk.count, truncated: junk.truncated },
    score, durationMs: Date.now() - t0,
  };
}

/* ------------------------------------------------------------------ CLI */

if (require.main === module) {
  const args = process.argv.slice(2);
  (async () => {
    if (args.includes('--info')) {
      console.log(JSON.stringify(await getSystemInfo(), null, 2));
      return;
    }
    const res = await quickScan();
    if (args.includes('--json')) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    const s = res.system;
    console.log('==========================================================');
    console.log(' AEGIS Sentinel — standalone engine test');
    console.log('==========================================================');
    console.log(' OS        : ' + (s.osCaption || s.platformLabel) + ' (' + s.arch + ')');
    console.log(' Machine   : ' + (s.machineModel || '-') + ' | ' + s.cpus + ' cores');
    console.log(' CPU       : ' + s.cpuModel);
    console.log(' RAM       : ' + fmtBytes(s.totalRam) + ' total / ' + fmtBytes(s.freeRam) + ' free');
    console.log(' Uptime    : ' + Math.floor(s.uptimeSec / 3600) + 'h ' + Math.floor((s.uptimeSec % 3600) / 60) + 'm');
    console.log('----------------------------------------------------------');
    console.log(' HEALTH    : ' + res.score.score + '/100  (grade ' + res.score.grade + ')');
    console.log(' NOTICE    : ' + res.score.disclaimer);
    for (const f of res.score.findings) console.log('   [' + f.sev + '] -' + f.pts + '  ' + f.msg);
    console.log('----------------------------------------------------------');
    console.log(' Firewall  : ' + (res.firewall.enabled === true ? 'ENABLED' : res.firewall.enabled === false ? 'DISABLED' : 'UNKNOWN') + ' — ' + res.firewall.details);
    console.log(' Encryption: ' + (res.encryption.enabled === true ? 'ON' : res.encryption.enabled === false ? 'OFF' : 'UNKNOWN') + ' — ' + res.encryption.details);
    console.log(' Processes : ' + (res.processesAvailable ? res.processes.length + ' scanned, ' + res.suspicious.length + ' risk signal(s)' : 'UNKNOWN — ' + res.processError));
    for (const p of res.suspicious.slice(0, 8)) {
      console.log('   ! ' + p.name + ' (pid ' + p.pid + ') score=' + p.suspicion + ' cpu=' + p.cpu + '% — ' + p.flags.join('; '));
    }
    console.log(' Updates   : ' + (res.updates.checkStatus === 'ok'
      ? res.updates.items.length + ' pending | last: ' + (res.updates.lastInstalled || 'n/a') + ' | reboot required: ' + res.updates.rebootRequired
      : 'UNKNOWN — ' + res.updates.note));
    console.log(' Errors24h : ' + (res.errors.available
      ? (res.errors.count24h == null ? res.errors.items.length : res.errors.count24h) + ' event(s) (' + res.errors.window + ')'
      : 'UNKNOWN — ' + res.errors.error));
    console.log(' Junk      : ' + (res.junk.available === false
      ? 'UNKNOWN — ' + (res.junk.error || 'no accessible scan folders')
      : res.junk.count + ' files, ' + fmtBytes(res.junk.reclaimable) + ' reclaimable (' + res.junk.scanned + ' files scanned' + (res.junk.incomplete ? '; partial coverage' + (res.junk.truncated ? ', scan limit reached' : '') + (res.junk.skipped ? ', ' + res.junk.skipped + ' path(s) skipped' : '') : '') + ')'));
    console.log(' Network   : ' + (res.networkSummary && res.networkSummary.available
      ? res.networkSummary.connections + ' connections, ' + res.networkSummary.listening + ' listening, ' + res.networkSummary.exposed + ' non-loopback endpoints'
      : 'UNKNOWN — endpoint data unavailable'));
    console.log(' Correlate : ' + (res.networkCorrelation.available
      ? res.networkCorrelation.flagged + ' high-risk listener(s), ' + res.networkCorrelation.unattributed + ' unattributed endpoint(s)'
      : 'UNKNOWN — ' + res.networkCorrelation.reason));
    console.log(' Persistence: ' + (res.persistenceAvailable
      ? res.persistenceSummary.riskItems + ' startup/service risk item(s), ' + res.persistenceSummary.riskItemsWithListeners + ' PID-linked listener(s)' + (res.persistencePartial ? ' (partial coverage)' : '')
      : 'UNKNOWN — source inventory unavailable'));
    console.log('==========================================================');
    console.log(' Scan completed in ' + (res.durationMs / 1000).toFixed(1) + 's');
  })().catch((e) => { console.error('SCAN FAILED:', e); process.exit(1); });
}

module.exports = {
  PLATFORM, IS_WIN, IS_MAC, IS_LINUX,
  getSystemInfo, getDiskUsage, getProcesses, getProcessSnapshot, killProcess,
  getInstalledApps, uninstallApp, getNetwork, getNetworkAssessment, correlateNetworkExposure, getPersistenceInventory, getPersistenceAssessment, correlatePersistenceItems,
  parseSystemdUnitFileList, parseSystemctlListUnits, parseSystemctlShow, parseXdgDesktopEntry, parseLaunchctlList, extractExecutable, getFirewall, enableFirewall,
  getEncryption, getUpdates, installUpdates, getSystemErrors, parseNetstatOutput,
  scanFiles, validateCleanCandidates, computeHealthScore, quickScan, fmtBytes,
  canUninstallApp, isSafeAppBundlePath, parseWindowsCommandLine,
};
