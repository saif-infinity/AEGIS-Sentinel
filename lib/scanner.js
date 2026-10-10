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

  score = Math.max(0, Math.min(100, Math.round(score)));
  const grade = score >= 95 ? 'S' : score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : 'D';
  return { score, grade, findings: findings.sort((a, b) => b.pts - a.pts), disclaimer: 'Heuristic posture indicator only; not an antivirus or a guarantee of security.' };
}

/* ------------------------------------------------------------- quick scan */

async function quickScan() {
  const t0 = Date.now();
  const [system, disks, processSnapshot, firewall, updates, errors, encryption, network] = await Promise.all([
    getSystemInfo(),
    getDiskUsage(),
    getProcessSnapshot(),
    getFirewall(),
    getUpdates(),
    getSystemErrors(),
    getEncryption(),
    getNetwork().catch(() => null),
  ]);
  const processes = processSnapshot.available ? processSnapshot.items : [];
  const systemDisk = disks.find((disk) => disk.isSystem) || disks.find((disk) => disk.mount === '/') || null;
  const junk = await scanFiles({ mode: 'junk', maxMs: 45000, maxDepth: 8 });
  const networkSummary = network ? {
    connections: network.connections.length,
    listening: network.listening.length,
    exposed: network.available ? network.exposed.length : null,
    available: network.available,
    error: network.error,
  } : null;
  const score = computeHealthScore({ system, systemDisk, disks, processes, processesAvailable: processSnapshot.available, firewall, updates, errors, encryption, networkSummary });
  return {
    system, systemDisk, disks, processesAvailable: processSnapshot.available, processError: processSnapshot.error,
    processes: processes.slice(0, 400),
    suspicious: processes.filter((p) => p.suspicion > 0).slice(0, 50),
    firewall, encryption, updates, errors, networkSummary,
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
    console.log('==========================================================');
    console.log(' Scan completed in ' + (res.durationMs / 1000).toFixed(1) + 's');
  })().catch((e) => { console.error('SCAN FAILED:', e); process.exit(1); });
}

module.exports = {
  PLATFORM, IS_WIN, IS_MAC, IS_LINUX,
  getSystemInfo, getDiskUsage, getProcesses, getProcessSnapshot, killProcess,
  getInstalledApps, uninstallApp, getNetwork, getFirewall, enableFirewall,
  getEncryption, getUpdates, installUpdates, getSystemErrors, parseNetstatOutput,
  scanFiles, validateCleanCandidates, computeHealthScore, quickScan, fmtBytes,
  canUninstallApp, isSafeAppBundlePath, parseWindowsCommandLine,
};
