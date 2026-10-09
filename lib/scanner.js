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
      const gpu = await run('sh', ['-c', "lspci 2>/dev/null | grep -iE 'vga|3d|display' | head -3"]);
      base.gpu = gpu.stdout.trim().split('\n').filter(Boolean).join(' | ');
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
    const j = parseJsonLoose(r.stdout);
    const arr = Array.isArray(j) ? j : (j ? [j] : []);
    return arr.map((d) => ({
      device: (d.DeviceID || '') + '\\',
      mount: (d.DeviceID || '') + '\\',
      label: d.VolumeName || (d.DeviceID || ''),
      size: Number(d.Size) || 0,
      free: Number(d.Free) || 0,
      used: (Number(d.Size) || 0) - (Number(d.Free) || 0),
    }));
  }
  const mounts = [...new Set([os.homedir(), '/'])].filter(Boolean);
  const out = [];
  for (const m of mounts) {
    const r = await run('df', ['-k', '-P', m]);
    for (const ln of r.stdout.trim().split('\n').slice(1)) {
      const p = ln.trim().split(/\s+/);
      if (p.length >= 6) {
        const size = parseInt(p[1], 10) * 1024;
        const used = parseInt(p[2], 10) * 1024;
        out.push({ device: p[0], mount: p[5], label: p[5], size, used, free: size - used });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------- processes */

const MINER_RE = /xmrig|minerd|cpuminer|nicehash|kdevtmpfsi|kinsing|watchbog|ddgs|stratum|minergate|hashvault|cryptonight|lolminer|nbminer|t-rex miner/i;
const TEMP_DIR_RE = /(\\Temp\\|\\AppData\\Local\\Temp|(^|\\)Temp\\|(^|\/)tmp\/|(^|\/)var\/tmp\/|(^|\/)dev\/shm\/|(^|\/)Library\/Caches\/)/i;

function suspicion(p) {
  const reasons = [];
  let score = 0;
  if (p.path && TEMP_DIR_RE.test(p.path)) {
    score += 45;
    reasons.push('Executable located in a temporary directory');
  }
  if (MINER_RE.test((p.name || '') + ' ' + (p.path || ''))) {
    score += 50;
    reasons.push('Name matches a known cryptominer signature');
  }
  if ((p.cpu || 0) >= 70) {
    score += 20;
    reasons.push('Abnormally high CPU usage (' + Math.round(p.cpu) + '%)');
  } else if ((p.cpu || 0) >= 40) {
    score += 8;
    reasons.push('Elevated CPU usage');
  }
  if ((p.memBytes || 0) > 1.5 * 1024 ** 3) {
    score += 12;
    reasons.push('Very high memory footprint (' + fmtBytes(p.memBytes) + ')');
  }
  if (!p.path) {
    score += 6;
    reasons.push('No executable path exposed (packed or hidden process)');
  }
  if (/^(werfault|svchost|csrss|lsass)$/i.test((p.name || '').replace(/\.exe$/i, '')) &&
      p.path && !/windows[\\/]/i.test(p.path)) {
    score += 30;
    reasons.push('Critical system process name with a non-system path');
  }
  score = Math.min(score, 100);
  const level = score >= 60 ? 'critical' : score >= 30 ? 'high' : score > 0 ? 'medium' : 'clean';
  return { score, reasons, level };
}

async function getProcesses() {
  let list = [];
  if (IS_WIN) {
    const script = [
      'try {',
      '  Get-Process | Select-Object Id, ProcessName, CPU, WorkingSet64,',
      '    @{n="Path";e={try{$_.Path}catch{""}}},',
      '    @{n="Company";e={try{$_.Company}catch{""}}},',
      '    @{n="Product";e={try{$_.Product}catch{""}}} | ConvertTo-Json -Compress',
      '} catch { "[]" }',
    ].join('\n');
    const r = await ps(script, 30000);
    const j = parseJsonLoose(r.stdout);
    const arr = Array.isArray(j) ? j : (j ? [j] : []);
    list = arr.map((p) => ({
      pid: p.Id,
      name: (p.ProcessName || 'unknown') + '.exe',
      cpu: 0,
      memBytes: Number(p.WorkingSet64) || 0,
      path: p.Path || '',
      company: p.Company || '',
      product: p.Product || '',
    }));
    // two-pass CPU sampling: CPU is cumulative seconds, so we diff two reads
    const sample = async () => {
      const rr = await ps('Get-Process | Select-Object Id, CPU | ConvertTo-Json -Compress', 30000);
      const jj = parseJsonLoose(rr.stdout);
      const aa = Array.isArray(jj) ? jj : (jj ? [jj] : []);
      return new Map(aa.map((x) => [x.Id, Number(x.CPU) || 0]));
    };
    const m1 = await sample();
    await sleep(1200);
    const m2 = await sample();
    const cores = os.cpus().length || 1;
    for (const p of list) {
      const d = (m2.get(p.pid) || 0) - (m1.get(p.pid) || 0);
      p.cpu = Math.max(0, Math.round((d / 1.2 / cores) * 100));
    }
  } else {
    const r = await run('ps', ['-eo', 'pid,pcpu,pmem,rss,comm,args']);
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
      });
    }
  }
  for (const p of list) {
    const s = suspicion(p);
    p.suspicion = s.score;
    p.suspicionLevel = s.level;
    p.flags = s.reasons;
  }
  list.sort((a, b) => (b.suspicion - a.suspicion) || (b.cpu - a.cpu));
  return list;
}

async function killProcess(pid) {
  pid = parseInt(pid, 10);
  if (!pid || pid <= 1) return { ok: false, error: 'Invalid PID' };
  if (IS_WIN) {
    const r = await run('taskkill', ['/PID', String(pid), '/F', '/T']);
    return { ok: r.ok, error: r.ok ? null : (r.stderr || r.stdout || 'taskkill failed') };
  }
  try {
    process.kill(pid, 'SIGKILL');
    return { ok: true, error: null };
  } catch (e) {
    const r = await run('kill', ['-9', String(pid)]);
    return { ok: r.ok, error: r.ok ? null : (e.message || 'kill failed') };
  }
}

/* ------------------------------------------------------------ applications */

const BLOAT_RE = /toolbar|pc optimizer|driver updater|driver booster|registry cleaner|speed up|cleaner pro|system care|advanced systemcare|iobit|driver easy|slimdrivers| Driver Support| McAfee WebAdvisor|Norton.*Online Backup/i;

function appFlags(app) {
  const flags = [];
  if (BLOAT_RE.test(app.name + ' ' + (app.publisher || ''))) flags.push({ label: 'Possible bloatware', sev: 'high' });
  if (!app.publisher) flags.push({ label: 'Unknown publisher', sev: 'medium' });
  if (!app.version) flags.push({ label: 'No version info', sev: 'low' });
  return flags;
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
      '  Select-Object DisplayName, DisplayVersion, Publisher, InstallDate, EstimatedSize, UninstallString |',
      '  ConvertTo-Json -Compress',
    ].join('\n');
    const r = await ps(script, 40000);
    const j = parseJsonLoose(r.stdout);
    const arr = Array.isArray(j) ? j : (j ? [j] : []);
    apps = arr.map((a) => ({
      name: (a.DisplayName || '').trim(),
      version: a.DisplayVersion || '',
      publisher: (a.Publisher || '').trim(),
      installDate: a.InstallDate || '',
      size: (Number(a.EstimatedSize) || 0) * 1024, // registry value is KB
      uninstallString: a.UninstallString || '',
      package: '',
      path: '',
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
        let size = 0;
        const du = await run('du', ['-sm', p]);
        const dm = du.stdout.match(/^(\d+)/);
        if (dm) size = parseInt(dm[1], 10) * 1024 * 1024;
        apps.push({ name: e.replace(/\.app$/, ''), version: '', publisher: '', installDate: '', size, uninstallString: '', package: '', path: p });
      }
    }
    const brew = await run('brew', ['list', '--versions']);
    if (brew.ok) {
      for (const line of brew.stdout.trim().split('\n')) {
        const m = line.match(/^(\S+)\s+(.+)$/);
        if (m) apps.push({ name: m[1], version: m[2].trim(), publisher: 'Homebrew', installDate: '', size: 0, uninstallString: '', package: m[1], path: '' });
      }
    }
  } else {
    const dirs = ['/usr/share/applications', path.join(os.homedir(), '.local/share/applications')];
    const seen = new Set();
    for (const dir of dirs) {
      let entries = [];
      try { entries = await fsp.readdir(dir); } catch { continue; }
      for (const e of entries) {
        if (!e.endsWith('.desktop') || seen.has(e)) continue;
        seen.add(e);
        try {
          const txt = await fsp.readFile(path.join(dir, e), 'utf8');
          const get = (k) => { const m = txt.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : ''; };
          const name = get('Name');
          if (!name || get('NoDisplay') === 'true' || get('Hidden') === 'true') continue;
          apps.push({
            name,
            version: '',
            publisher: get('Comment'),
            installDate: '',
            size: 0,
            uninstallString: '',
            package: e.replace(/\.desktop$/, ''),
            path: path.join(dir, e),
          });
        } catch { /* ignore */ }
      }
    }
    const cnt = await run('sh', ['-c', "dpkg -l 2>/dev/null | grep -c '^ii' || true"]);
    apps.totalPackages = parseInt(cnt.stdout.trim(), 10) || 0;
  }
  for (const a of apps) a.flags = appFlags(a);
  apps.sort((a, b) => a.name.localeCompare(b.name));
  return apps;
}

async function uninstallApp(app) {
  if (!app) return { ok: false, error: 'No application provided' };
  if (IS_WIN && app.uninstallString) {
    const r = await run('cmd.exe', ['/c', 'start', '/wait', '', app.uninstallString], { timeout: 120000 });
    return { ok: r.ok, error: r.ok ? null : (r.stderr || 'Uninstaller exited with an error') };
  }
  if (IS_MAC && app.path && app.path.endsWith('.app')) {
    const r = await run('rm', ['-rf', app.path]);
    return { ok: r.ok, error: r.ok ? null : (r.stderr || 'Removal failed') };
  }
  if (IS_LINUX && app.package) {
    const r = await run('sh', ['-c', 'sudo -n apt-get remove -y ' + JSON.stringify(app.package) + ' 2>&1 || apt-get remove -y ' + JSON.stringify(app.package) + ' 2>&1'], { timeout: 120000 });
    const ok = r.ok && !/E:|not installed|Permission denied/i.test(r.stdout + r.stderr);
    return { ok, error: ok ? null : (r.stdout + r.stderr).slice(0, 500) };
  }
  return { ok: false, error: 'No uninstall method available for this application on ' + PLATFORM };
}

/* ---------------------------------------------------------------- network */

async function getNetwork() {
  const connections = [];
  if (IS_WIN) {
    const script = [
      '$procs = @{};',
      'Get-Process | ForEach-Object { $procs[$_.Id] = $_.ProcessName };',
      '$out = @();',
      'foreach ($c in (Get-NetTCPConnection -ErrorAction SilentlyContinue)) {',
      '  $out += [pscustomobject]@{ Proto = "TCP"; Local = ($c.LocalAddress + ":" + $c.LocalPort);',
      '    Remote = ($c.RemoteAddress + ":" + $c.RemotePort); State = $c.State;',
      '    Pid = $c.OwningProcess; Process = $procs[$c.OwningProcess] } }',
      'foreach ($u in (Get-NetUDPEndpoint -ErrorAction SilentlyContinue)) {',
      '  $out += [pscustomobject]@{ Proto = "UDP"; Local = ($u.LocalAddress + ":" + $u.LocalPort);',
      '    Remote = "-"; State = "LISTEN"; Pid = $u.OwningProcess; Process = $procs[$u.OwningProcess] } }',
      '$out | ConvertTo-Json -Compress',
    ].join('\n');
    const r = await ps(script, 30000);
    const j = parseJsonLoose(r.stdout);
    const arr = Array.isArray(j) ? j : (j ? [j] : []);
    for (const c of arr) {
      connections.push({
        proto: c.Proto || 'TCP',
        local: c.Local || '',
        remote: c.Remote || '',
        state: c.State || '',
        pid: c.Pid || 0,
        process: c.Process || '',
      });
    }
  } else if (IS_LINUX) {
    let r = await run('ss', ['-tunap']);
    if (!r.ok || !r.stdout.trim()) r = await run('netstat', ['-tunap']);
    for (const line of r.stdout.split('\n')) {
      const m = line.match(/^(\w+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/);
      if (!m) continue;
      const pm = (m[7] || '').match(/\(\("([^"]+)",pid=(\d+)/);
      connections.push({
        proto: m[1].toUpperCase(),
        local: m[5],
        remote: m[6],
        state: m[2],
        pid: pm ? parseInt(pm[2], 10) : 0,
        process: pm ? pm[1] : '',
      });
    }
  } else {
    const r = await run('lsof', ['-nP', '-i']);
    for (const line of r.stdout.split('\n').slice(1)) {
      const m = line.match(/^(\S+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(IPv[46])\s+\S+\s+\S+\s+\d+\s+(TCP|UDP)\s+(.+)$/);
      if (!m) continue;
      const rest = m[8];
      const sm = rest.match(/^(.*?)\s*(?:\((.+)\))?$/);
      const addr = (sm ? sm[1] : rest).trim();
      const state = sm && sm[2] ? sm[2] : '';
      let local = addr, remote = '';
      if (addr.includes('->')) { const parts = addr.split('->'); local = parts[0]; remote = parts[1]; }
      connections.push({
        proto: m[7],
        local,
        remote: remote || (state === 'LISTEN' ? '-' : ''),
        state: state || (m[7] === 'UDP' ? 'UDP' : ''),
        pid: parseInt(m[2], 10),
        process: m[1],
      });
    }
  }
  const listening = connections.filter((c) => /LISTEN/i.test(c.state));
  return { connections, listening };
}

/* ---------------------------------------------------- firewall / security */

async function getFirewall() {
  if (IS_WIN) {
    const r = await ps('Get-NetFirewallProfile | Select-Object Name, Enabled | ConvertTo-Json -Compress');
    const j = parseJsonLoose(r.stdout);
    const arr = Array.isArray(j) ? j : (j ? [j] : []);
    const profiles = arr.map((p) => ({ name: p.Name, enabled: p.Enabled === true || p.Enabled === 'True' }));
    return {
      enabled: profiles.length > 0 && profiles.every((p) => p.enabled),
      profiles,
      details: profiles.map((p) => p.name + ': ' + (p.enabled ? 'ON' : 'OFF')).join(' / ') || 'No firewall profiles found',
    };
  }
  if (IS_MAC) {
    const r = await run('/usr/libexec/ApplicationFirewall/socketfilterfw', ['--getglobalstate']);
    const txt = r.stdout + r.stderr;
    const stateMatch = txt.match(/State\s*=\s*(\d)/i);
    const enabled = /is enabled/i.test(txt) || (stateMatch && stateMatch[1] === '1');
    const gk = await run('spctl', ['--master']);
    const gatekeeper = /assessments enabled/i.test(gk.stdout + gk.stderr);
    return {
      enabled,
      profiles: [{ name: 'Application Firewall', enabled }, { name: 'Gatekeeper', enabled: gatekeeper }],
      details: txt.trim().split('\n')[0] || 'Application Firewall',
    };
  }
  // Linux
  const [ufwActive, fwActive, nftActive, ufwStatus, ipt] = await Promise.all([
    run('systemctl', ['is-active', 'ufw']),
    run('systemctl', ['is-active', 'firewalld']),
    run('systemctl', ['is-active', 'nftables']),
    run('sh', ['-c', 'sudo -n ufw status 2>/dev/null | head -1 || ufw status 2>&1 | head -1 || true']),
    run('sh', ['-c', 'sudo -n iptables -S 2>/dev/null | head -3 || iptables -S 2>&1 | head -3 || true']),
  ]);
  const active = (r) => r.ok && r.stdout.trim() === 'active';
  const anyService = active(ufwActive) || active(fwActive) || active(nftActive);
  const ufwLine = (ufwStatus.stdout || '').trim();
  const enabled = anyService || /^Status:\s*active/i.test(ufwLine);
  const profiles = [
    { name: 'ufw', enabled: active(ufwActive) || /^Status:\s*active/i.test(ufwLine) },
    { name: 'firewalld', enabled: active(fwActive) },
    { name: 'nftables', enabled: active(nftActive) },
  ];
  return {
    enabled,
    profiles,
    details: enabled
      ? 'Firewall service active (' + profiles.filter((p) => p.enabled).map((p) => p.name).join(', ') + ')'
      : (ufwLine || ipt.stdout.trim() || 'No active firewall service detected (ufw / firewalld / nftables)'),
  };
}

async function enableFirewall() {
  if (IS_WIN) {
    const r = await run('netsh', ['advfirewall', 'set', 'allprofiles', 'state', 'on']);
    return { ok: r.ok, error: r.ok ? null : (r.stderr || 'netsh failed — try running as Administrator') };
  }
  if (IS_MAC) {
    let r = await run('/usr/libexec/ApplicationFirewall/socketfilterfw', ['--setglobalstate', 'on']);
    if (!r.ok) r = await run('sh', ['-c', 'echo "$(osascript -e \'tell application "System Events" to keystroke "y" using {command down}\')" >/dev/null 2>&1; sudo -n /usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate on 2>&1 || true']);
    return { ok: r.ok, error: r.ok ? null : 'Could not enable — macOS may require approval in System Settings' };
  }
  let r = await run('sh', ['-c', 'sudo -n ufw enable 2>&1 || sudo -n systemctl enable --now ufw 2>&1 || true']);
  if (!/enabled|active/i.test(r.stdout + r.stderr)) {
    r = await run('sh', ['-c', 'sudo -n systemctl enable --now nftables 2>&1 || true']);
  }
  const ok = /enabled|active|Active/i.test(r.stdout + r.stderr);
  return { ok, error: ok ? null : (r.stdout + r.stderr).slice(0, 400) || 'Enable failed — root privileges required' };
}

async function getEncryption() {
  if (IS_WIN) {
    const r = await run('manage-bde', ['-status', 'C:']);
    const txt = r.stdout + r.stderr;
    const conv = (txt.match(/Conversion Status:\s*(.+)/i) || [])[1] || '';
    const pct = (txt.match(/Percentage Encrypted:\s*(.+)/i) || [])[1] || '';
    return {
      enabled: /Fully Encrypted|Fully Decrypted/i.test(conv) ? /Fully Encrypted/i.test(conv) : null,
      details: (conv.trim() + ' ' + pct.trim()).trim() || 'BitLocker status unavailable',
    };
  }
  if (IS_MAC) {
    const r = await run('fdesetup', ['status']);
    const txt = r.stdout + r.stderr;
    return { enabled: /FileVault is On/i.test(txt), details: txt.trim().split('\n')[0] || 'FileVault' };
  }
  const r = await run('lsblk', ['-no', 'TYPE,FSTYPE,MOUNTPOINT']);
  const luks = /crypto_LUKS/i.test(r.stdout);
  const cryptType = /crypt/i.test(r.stdout);
  return {
    enabled: luks || cryptType,
    details: luks ? 'LUKS encrypted volume detected' : (cryptType ? 'Encrypted (crypt) volume detected' : 'No encrypted volume detected'),
  };
}

/* --------------------------------------------------------------- updates */

async function getUpdates() {
  if (IS_WIN) {
    const script = [
      '$h = Get-HotFix | Sort-Object InstalledOn -Descending | Select-Object -First 25 HotFixID, Description, InstalledOn;',
      '$wu = (Get-Service wuauserv -ErrorAction SilentlyContinue).Status;',
      '$reboot = Test-Path "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired";',
      '$pending = $null;',
      'if (Get-Module -ListAvailable -Name PSWindowsUpdate) {',
      '  try { $pending = Get-WUList -MicrosoftUpdate | Select-Object -First 50 Title, @{n="KB";e={$_.KBArticleIDs}}, @{n="Size";e={$_.Size}} } catch {} }',
      '[pscustomobject]@{ HotFixes = $h; WuService = "$wu"; RebootRequired = $reboot; Pending = $pending } | ConvertTo-Json -Compress -Depth 4',
    ].join('\n');
    const r = await ps(script, 90000);
    const j = parseJsonLoose(r.stdout);
    if (!j) return { items: [], note: 'Windows Update query failed', rebootRequired: false };
    const hotfixes = (Array.isArray(j.HotFixes) ? j.HotFixes : (j.HotFixes ? [j.HotFixes] : []))
      .map((h) => ({ name: h.HotFixID, version: h.Description || '', time: h.InstalledOn || '', source: 'Windows Update' }));
    let lastInstalled = null;
    for (const h of hotfixes) {
      const d = new Date(h.time);
      if (!isNaN(d) && (!lastInstalled || d > lastInstalled)) lastInstalled = d;
    }
    const pending = j.Pending ? (Array.isArray(j.Pending) ? j.Pending : [j.Pending]).map((u) => ({
      name: u.Title || 'Update', version: u.KB || '', size: Number(u.Size) || 0, source: 'Windows Update',
    })) : [];
    return {
      items: pending,
      history: hotfixes,
      lastInstalled: lastInstalled ? lastInstalled.toISOString().slice(0, 10) : null,
      daysSinceLastUpdate: lastInstalled ? Math.floor((Date.now() - lastInstalled.getTime()) / 86400000) : null,
      rebootRequired: j.RebootRequired === true || j.RebootRequired === 'True',
      serviceStatus: j.WuService || 'unknown',
      note: pending.length ? 'Pending updates reported by PSWindowsUpdate' : 'Showing recent update history (install PSWindowsUpdate for pending-update detection)',
    };
  }
  if (IS_MAC) {
    const r = await run('softwareupdate', ['-l'], { timeout: 120000 });
    const items = [];
    const re = /^\s*\*\s*Label:\s*(.+)$/gm;
    let m;
    while ((m = re.exec(r.stdout)) !== null) items.push({ name: m[1].trim(), version: '', size: 0, source: 'Apple Software Update' });
    const restart = /restart/i.test(r.stdout);
    return { items, history: [], lastInstalled: null, daysSinceLastUpdate: null, rebootRequired: restart, note: restart ? 'A restart is required to finish updating' : '' };
  }
  // Linux (apt-based)
  const r = await run('sh', ['-c', 'apt list --upgradable 2>/dev/null | grep -v "^Listing" || true']);
  const items = [];
  for (const line of r.stdout.trim().split('\n')) {
    const m = line.match(/^(\S+)\/(\S+)\s+(\S+)\s+(\S+)/);
    if (m) items.push({ name: m[1], version: m[3], arch: m[4], source: 'apt (' + m[2] + ')' });
  }
  const count = await run('sh', ['-c', "apt-get -s dist-upgrade 2>/dev/null | grep -c '^Inst' || true"]);
  return {
    items,
    history: [],
    lastInstalled: null,
    daysSinceLastUpdate: null,
    rebootRequired: false,
    pendingCount: parseInt(count.stdout.trim(), 10) || items.length,
    note: items.length ? items.length + ' package update(s) available' : 'System is up to date (run "sudo apt update" to refresh the package index)',
  };
}

async function installUpdates() {
  if (IS_WIN) {
    const r = await run('UsoClient', ['StartInteractiveScan']);
    if (!r.ok) await run('powershell.exe', ['-NoProfile', '-Command', 'Start-Process usoClient -ArgumentList StartInteractiveScan']);
    return { ok: true, note: 'Windows Update interactive scan started — complete the install in Settings and restart if prompted' };
  }
  if (IS_MAC) {
    const r = await run('sh', ['-c', 'sudo -n softwareupdate -i -a 2>&1 || softwareupdate -i -a 2>&1 || true'], { timeout: 300000 });
    return { ok: true, note: (r.stdout || '').slice(0, 300) || 'softwareupdate started — administrator approval may be required' };
  }
  const r = await run('sh', ['-c', 'sudo -n apt-get upgrade -y 2>&1 | tail -5 || apt-get upgrade -y 2>&1 | tail -5 || true'], { timeout: 600000 });
  const ok = !/E:|Permission denied|not allowed/i.test(r.stdout + r.stderr);
  return { ok, note: (r.stdout || r.stderr || '').slice(0, 400) };
}

/* ------------------------------------------------------------ system logs */

async function getSystemErrors() {
  if (IS_WIN) {
    const script = [
      "Get-WinEvent -FilterHashtable @{ LogName = 'System'; Level = 2 } -MaxEvents 60 -ErrorAction SilentlyContinue |",
      '  Select-Object TimeCreated, Id, ProviderName,',
      '    @{n="Message";e={$_.Message.Substring(0, [Math]::Min(220, $_.Message.Length))}} |',
      '  ConvertTo-Json -Compress',
    ].join('\n');
    const r = await ps(script, 40000);
    const j = parseJsonLoose(r.stdout);
    const arr = Array.isArray(j) ? j : (j ? [j] : []);
    return {
      items: arr.map((e) => ({
        time: e.TimeCreated || '',
        source: e.ProviderName || 'System',
        id: e.Id || '',
        message: (e.Message || '').replace(/\s+/g, ' ').trim(),
      })),
      window: 'last 24h (System log, Error level)',
    };
  }
  if (IS_MAC) {
    const r = await run('log', ['show', '--last', '24h', '--predicate', 'eventType == "error"', '--style', 'compact'], { timeout: 60000 });
    const items = r.stdout.trim().split('\n').filter(Boolean).slice(-60).map((line) => {
      const m = line.match(/^(\S+\s+\S+)\s+(.*)$/);
      return { time: m ? m[1] : '', source: 'macOS unified log', id: '', message: (m ? m[2] : line).replace(/\s+/g, ' ').trim().slice(0, 240) };
    });
    return { items, window: 'last 24h (unified log, error events)' };
  }
  const r = await run('journalctl', ['-p', '3', '-n', '80', '--no-pager', '-o', 'short-iso'], { timeout: 30000 });
  let items = [];
  if (r.ok && r.stdout.trim()) {
    items = r.stdout.trim().split('\n').map((line) => {
      const m = line.match(/^(\S+\s+\S+)\s+(\S+)\s+([^:]+):\s*(.*)$/);
      return m
        ? { time: m[1], source: m[3].trim(), id: '', message: m[4].trim().slice(0, 240) }
        : { time: '', source: 'journal', id: '', message: line.trim().slice(0, 240) };
    });
  } else {
    const g = await run('sh', ['-c', "grep -iE ' err |error|critical|failed' /var/log/syslog 2>/dev/null | tail -60 || journalctl -p 3 -n 60 --no-pager 2>/dev/null || true"]);
    items = g.stdout.trim().split('\n').filter(Boolean).map((line) => ({ time: '', source: 'syslog', id: '', message: line.trim().slice(0, 240) }));
  }
  const c = await run('sh', ['-c', 'journalctl -p 3 --since "24 hours ago" --no-pager -o cat 2>/dev/null | wc -l || echo 0']);
  return { items, count24h: parseInt(c.stdout.trim(), 10) || items.length, window: 'last 24h (journal, err level)' };
}

/* ------------------------------------------------------------ file scanner */

const SKIP_DIRS = new Set([
  'proc', 'sys', 'dev', 'run', 'snap', '.git', 'node_modules',
  'System Volume Information', '$Recycle.Bin', 'Windows', 'Program Files',
  'Program Files (x86)', 'ProgramData', 'AppData', 'Library', 'private',
]);
const JUNK_NAME = [/^\.DS_Store$/i, /^Thumbs\.db$/i, /^desktop\.ini$/i, /^~\$/, /\.(tmp|temp|log|bak|old|cache|dmp|chk|gid|crdownload|part|download)$/i, /~$/];
const JUNK_DIR_HINT = /(^|[\\/])(Temp|tmp|cache|Cache|Caches|CachedData|Cookies|__pycache__|Log Files|Logs|Diagnostic Reports|Minidump|WindowsUpdate.log)([\\/]|$)/i;

function isJunk(name, full) {
  if (JUNK_NAME.some((re) => re.test(name))) return true;
  return JUNK_DIR_HINT.test(full);
}
function junkKind(name, full) {
  if (/\.log$/i.test(name) || /(^|[\\/])Logs?([\\/]|$)/i.test(full)) return 'Log file';
  if (/__pycache__|(^|[\\/])[Cc]ache(s|dData)?([\\/]|$)/i.test(full)) return 'Cache';
  if (/\.(bak|old|tmp|temp|dmp|chk)$/i.test(name) || /~$/.test(name)) return 'Backup / temp';
  if (/^\.DS_Store$/i.test(name) || /^Thumbs\.db$/i.test(name) || /^desktop\.ini$/i.test(name)) return 'System junk';
  return 'Temporary file';
}

function md5File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('md5');
    const s = fs.createReadStream(file);
    s.on('error', reject);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

function defaultRoots(mode) {
  const home = os.homedir();
  if (mode === 'junk') {
    const roots = [os.tmpdir(), '/tmp', '/var/tmp', path.join(home, '.cache'), path.join(home, 'Library', 'Caches')];
    if (IS_WIN) roots.push('C:\\Windows\\Temp', path.join(home, 'AppData', 'Local', 'Temp'), path.join(home, 'AppData', 'Local', 'Microsoft', 'Windows', 'INetCache'));
    return [...new Set(roots.filter(Boolean))];
  }
  if (mode === 'duplicates') return [path.join(home, 'Downloads'), path.join(home, 'Documents'), path.join(home, 'Desktop'), home].filter(Boolean);
  return [home];
}

async function scanFiles(opts = {}) {
  const mode = opts.mode || 'junk'; // junk | large | duplicates
  const roots = (opts.roots && opts.roots.length ? opts.roots : defaultRoots(mode)).filter(Boolean);
  const minSize = opts.minSize || 100 * 1024 * 1024;
  const maxFiles = opts.maxFiles || 250000;
  const maxDepth = opts.maxDepth == null ? 12 : opts.maxDepth;
  const maxMs = opts.maxMs || 120000;
  const results = [];
  const sizeMap = new Map();
  let scanned = 0;
  let bytes = 0;
  let truncated = false;
  const t0 = Date.now();
  const timeUp = () => Date.now() - t0 > maxMs;

  async function walk(dir, depth) {
    if (truncated || scanned > maxFiles || timeUp()) { truncated = true; return; }
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (truncated || scanned > maxFiles || timeUp()) { truncated = true; return; }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIRS.has(e.name)) await walk(full, depth + 1);
      } else if (e.isFile()) {
        let size = 0;
        try { size = (await fsp.stat(full)).size; } catch { continue; }
        scanned++;
        bytes += size;
        if (mode === 'junk' && isJunk(e.name, full)) {
          results.push({ path: full, size, kind: junkKind(e.name, full) });
        } else if (mode === 'large' && size >= minSize) {
          results.push({ path: full, size, kind: 'Large file (>= ' + fmtBytes(minSize) + ')' });
        } else if (mode === 'duplicates' && size > 0 && size < 512 * 1024 * 1024) {
          if (!sizeMap.has(size)) sizeMap.set(size, []);
          sizeMap.get(size).push(full);
        }
        if (results.length > 20000) { truncated = true; return; }
      }
    }
  }

  for (const r of roots) await walk(r, 0);

  if (mode === 'duplicates') {
    const groups = [];
    for (const [size, files] of sizeMap) {
      if (files.length < 2) continue;
      const byHash = new Map();
      for (const f of files) {
        if (timeUp()) { truncated = true; break; }
        try {
          const h = await md5File(f);
          if (!byHash.has(h)) byHash.set(h, []);
          byHash.get(h).push(f);
        } catch { /* ignore unreadable */ }
      }
      for (const [, fs2] of byHash) {
        if (fs2.length > 1) groups.push({ size, files: fs2, wasted: size * (fs2.length - 1) });
      }
    }
    groups.sort((a, b) => b.wasted - a.wasted);
    for (const g of groups.slice(0, 500)) {
      results.push({ kind: 'Duplicate group x' + g.files.length, size: g.size, wasted: g.wasted, files: g.files, count: g.files.length });
    }
  }

  results.sort((a, b) => (b.wasted || b.size) - (a.wasted || a.size));
  const reclaimable = results.reduce((s, r) => s + (r.wasted || (mode === 'junk' ? r.size : 0)), 0);
  return {
    mode,
    roots,
    scanned,
    bytes,
    truncated,
    durationMs: Date.now() - t0,
    count: results.length,
    reclaimable,
    results: results.slice(0, 2000),
  };
}

async function cleanFiles(paths) {
  let removed = 0;
  let failed = 0;
  let bytes = 0;
  for (const p of paths || []) {
    try {
      const st = await fsp.stat(p);
      await fsp.rm(p, { force: true });
      removed++;
      bytes += st.size;
    } catch { failed++; }
  }
  return { removed, failed, bytes };
}

/* ---------------------------------------------------------- health score */

function computeHealthScore(d) {
  let score = 100;
  const findings = [];
  const push = (pts, sev, msg) => { score -= pts; findings.push({ sev, msg, pts }); };

  if (d.firewall && d.firewall.enabled === false) push(15, 'critical', 'Firewall is disabled');
  if (d.encryption && d.encryption.enabled === false) push(10, 'warning', 'Disk encryption is not enabled');
  if (d.updates) {
    if (d.updates.rebootRequired) push(6, 'warning', 'A restart is required to finish installing updates');
    if (Array.isArray(d.updates.items) && d.updates.items.length) {
      push(Math.min(15, d.updates.items.length * 2), 'warning', d.updates.items.length + ' pending system update(s)');
    }
    if (d.updates.daysSinceLastUpdate != null && d.updates.daysSinceLastUpdate > 45) {
      push(10, 'warning', 'Last system update was ' + d.updates.daysSinceLastUpdate + ' days ago');
    }
  }
  const errCount = d.errors && Array.isArray(d.errors.items) ? d.errors.items.length : 0;
  if (errCount) push(Math.min(15, errCount), 'warning', errCount + ' system error(s) in the last 24h');
  const susp = (d.processes || []).filter((p) => p.suspicion >= 30);
  if (susp.length) push(Math.min(20, susp.length * 6), 'critical', susp.length + ' suspicious process(es) detected');
  const procs = d.processes || [];
  if (procs.length) {
    const cpu = Math.min(100, procs.reduce((s, p) => s + (p.cpu || 0), 0));
    if (cpu > 85) push(6, 'info', 'CPU usage is very high (' + Math.round(cpu) + '%)');
  }
  const sys = d.system || {};
  const ramPct = sys.totalRam ? (1 - sys.freeRam / sys.totalRam) * 100 : 0;
  if (ramPct > 92) push(5, 'warning', 'Memory usage above 92%');
  const disk = (d.disks || [])[0];
  if (disk && disk.size && disk.used / disk.size > 0.92) push(5, 'warning', 'System disk is almost full');
  if (d.junk && d.junk.reclaimable > 2 * 1024 ** 3) {
    push(Math.min(10, Math.ceil(d.junk.reclaimable / 1024 ** 3)), 'info', fmtBytes(d.junk.reclaimable) + ' of junk files can be reclaimed');
  }
  if (d.networkSummary && d.networkSummary.listening > 25) {
    push(5, 'info', d.networkSummary.listening + ' listening ports exposed');
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const grade = score >= 90 ? 'S' : score >= 75 ? 'A' : score >= 60 ? 'B' : score >= 45 ? 'C' : 'D';
  return { score, grade, findings: findings.sort((a, b) => b.pts - a.pts) };
}

/* ------------------------------------------------------------- quick scan */

async function quickScan() {
  const t0 = Date.now();
  const [system, disks, processes, firewall, updates, errors, encryption, network] = await Promise.all([
    getSystemInfo(),
    getDiskUsage(),
    getProcesses(),
    getFirewall(),
    getUpdates(),
    getSystemErrors(),
    getEncryption(),
    getNetwork().catch(() => null),
  ]);
  const junk = await scanFiles({ mode: 'junk', maxMs: 45000, maxDepth: 8 });
  const score = computeHealthScore({
    system, disks, processes, firewall, updates, errors, encryption,
    junk: { reclaimable: junk.reclaimable },
    networkSummary: network ? { connections: network.connections.length, listening: network.listening.length } : null,
  });
  return {
    system,
    disks,
    processes: processes.slice(0, 400),
    suspicious: processes.filter((p) => p.suspicion > 0).slice(0, 50),
    firewall,
    encryption,
    updates,
    errors,
    networkSummary: network ? { connections: network.connections.length, listening: network.listening.length } : null,
    junk: { scanned: junk.scanned, reclaimable: junk.reclaimable, count: junk.count, truncated: junk.truncated },
    score,
    durationMs: Date.now() - t0,
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
    for (const f of res.score.findings) console.log('   [' + f.sev + '] -' + f.pts + '  ' + f.msg);
    console.log('----------------------------------------------------------');
    console.log(' Firewall  : ' + (res.firewall.enabled === true ? 'ENABLED' : res.firewall.enabled === false ? 'DISABLED' : 'UNKNOWN') + ' — ' + res.firewall.details);
    console.log(' Encryption: ' + (res.encryption.enabled === true ? 'ON' : res.encryption.enabled === false ? 'OFF' : 'UNKNOWN') + ' — ' + res.encryption.details);
    console.log(' Processes : ' + res.processes.length + ' scanned, ' + res.suspicious.length + ' flagged');
    for (const p of res.suspicious.slice(0, 8)) {
      console.log('   ! ' + p.name + ' (pid ' + p.pid + ') score=' + p.suspicion + ' cpu=' + p.cpu + '% — ' + p.flags.join('; '));
    }
    console.log(' Updates   : ' + res.updates.items.length + ' pending | last: ' + (res.updates.lastInstalled || 'n/a') + ' | reboot required: ' + res.updates.rebootRequired);
    console.log(' Errors24h : ' + res.errors.items.length + ' item(s)');
    console.log(' Junk      : ' + res.junk.count + ' files, ' + fmtBytes(res.junk.reclaimable) + ' reclaimable (' + res.junk.scanned + ' files scanned)');
    console.log(' Network   : ' + (res.networkSummary ? res.networkSummary.connections + ' connections, ' + res.networkSummary.listening + ' listening' : 'n/a'));
    console.log('==========================================================');
    console.log(' Scan completed in ' + (res.durationMs / 1000).toFixed(1) + 's');
  })().catch((e) => { console.error('SCAN FAILED:', e); process.exit(1); });
}

module.exports = {
  PLATFORM, IS_WIN, IS_MAC, IS_LINUX,
  getSystemInfo, getDiskUsage, getProcesses, killProcess,
  getInstalledApps, uninstallApp, getNetwork, getFirewall, enableFirewall,
  getEncryption, getUpdates, installUpdates, getSystemErrors,
  scanFiles, cleanFiles, computeHealthScore, quickScan, fmtBytes,
};
