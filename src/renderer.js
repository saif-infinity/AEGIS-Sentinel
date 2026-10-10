'use strict';
/* ============================================================
   AEGIS Sentinel — renderer (SPA)
   ============================================================ */

if (!window.aegis) {
  document.body.innerHTML = '<div style="padding:60px;font-family:monospace;color:#1FE0FF;background:#07090B;height:100vh">' +
    'AEGIS Sentinel UI must run inside the desktop app — start it with <b>npm start</b>.</div>';
  throw new Error('IPC bridge missing');
}
const IPC = window.aegis;

/* ------------------------------------------------------------ helpers */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtBytes = (n) => {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n >= 100 ? 0 : 1) + ' ' + u[i];
};
const fmtNum = (n) => Number(n || 0).toLocaleString('en-US');
const clampPct = (n) => Math.max(0, Math.min(100, Math.round(n || 0)));
const barClass = (p) => (p >= 85 ? 'r' : p >= 60 ? 'a' : 'g');
const timeAgo = (iso) => {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (isNaN(d)) return 'unknown';
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 60) return Math.floor(s) + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
};

const API_METHODS = {
  'sys:info': () => IPC.getSystemInfo(),
  'disk:usage': () => IPC.getDiskUsage(),
  'scan:quick': () => IPC.quickScan(),
  'scan:files': (payload) => IPC.scanFiles(payload),
  'files:clean': (payload) => IPC.cleanFiles(payload),
  'proc:list': () => IPC.listProcesses(),
  'proc:kill': (payload) => IPC.killProcess(payload),
  'apps:list': () => IPC.listApps(),
  'apps:uninstall': (payload) => IPC.uninstallApp(payload),
  'net:list': () => IPC.getNetwork(),
  'fw:status': () => IPC.getFirewall(),
  'fw:enable': () => IPC.enableFirewall(),
  'enc:status': () => IPC.getEncryption(),
  'updates:check': () => IPC.checkUpdates(),
  'updates:install': () => IPC.installUpdates(),
  'errors:list': () => IPC.getSystemErrors(),
  'dialog:pickDir': () => IPC.pickDirectory(),
  'report:save': (payload) => IPC.saveReport(payload),
};

async function api(channel, payload) {
  const method = API_METHODS[channel];
  if (!method) { toast('Unsupported application operation', 'error'); return null; }
  try {
    const res = await method(payload);
    if (!res || res.ok === false) {
      toast((res && res.error) || 'Operation failed', 'error');
      return null;
    }
    return res.data;
  } catch (err) {
    toast(String(err && err.message || err || 'Operation failed'), 'error');
    return null;
  }
}

/* ------------------------------------------------------------ icons */
const ICONS = {
  grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
  folder: '<path d="M3 5h6l2 3h10v11H3z"/>',
  chip: '<rect x="7" y="7" width="10" height="10"/><path d="M4 10h3M4 14h3M17 10h3M17 14h3M10 4v3M14 4v3M10 17v3M14 17v3"/>',
  layers: '<path d="M12 3 21 8l-9 5-9-5z"/><path d="M3 13.5l9 5 9-5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3.2 3.6 3.2 14.4 0 18M12 3c-3.2 3.6-3.2 14.4 0 18"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
  min: '<path d="M5 12h14"/>',
  max: '<path d="M5 5h14v14H5z"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M4 12l5 5L20 7"/>',
  warn: '<path d="M12 3 22 20H2z"/><path d="M12 9.5v4.5M12 17.2v.01"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  play: '<path d="M7 4l13 8-13 8z"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M4 20h16"/>',
  lock: '<rect x="5" y="11" width="14" height="9"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  zap: '<path d="M13 2 4 14h6l-1 8 9-12h-6z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
  hdd: '<rect x="3" y="8" width="18" height="8"/><path d="M6 12h.01M10 12h.01M5 8V5h14v3"/>',
  terminal: '<path d="M4 5h16v14H4z"/><path d="M7 9l3 3-3 3M12 15h5"/>',
  power: '<path d="M12 3v8"/><path d="M6.3 6.3a8 8 0 1 0 11.4 0"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 5l3 3M13 8l2.5 2.5"/>',
  wifi: '<path d="M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0M12 19.5v.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.01"/>',
  bug: '<circle cx="12" cy="13" r="5"/><path d="M12 8V5M8.5 9.5 5.5 6.5M15.5 9.5l3-3M7 13H3M21 13h-4M8.5 16.5l-3 3M15.5 16.5l3 3"/>',
};
const icon = (name, cls = '') =>
  `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter">${ICONS[name] || ''}</svg>`;

const LOGO = `<svg viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="miter">
  <path d="M20 2 37 9v12c0 9-7 14.5-17 19C10 35.5 3 30 3 21V9z"/>
  <path d="M12 27 20 10l8 17M14.8 21.5h10.4" stroke-width="2.4"/>
</svg>`;

/* ------------------------------------------------------------ state */
const state = {
  route: null,
  sys: null,
  scan: null,
  scanError: '',
  version: '1.0.0',
};
let activeTimers = [];

/* ------------------------------------------------------------ toast / modal */
function toast(msg, type = 'info') {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  const ic = type === 'success' ? 'check' : type === 'error' ? 'x' : type === 'warn' ? 'warn' : 'info';
  t.innerHTML = icon(ic) + `<span>${esc(msg)}</span>`;
  $('#toast-root').appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, 4200);
}

function openModal(html, wide = false) {
  $('#modal-root').innerHTML =
    `<div class="modal-backdrop" id="modal-bg"></div><div class="modal${wide ? ' wide' : ''}">${html}</div>`;
  $('#modal-bg').addEventListener('click', closeModal);
}
function closeModal() { $('#modal-root').innerHTML = ''; }

/* ------------------------------------------------------------ statusbar */
function setBusy(busy, label) {
  const el = $('#sb-status');
  el.textContent = busy ? (label || 'WORKING') : 'READY';
  el.classList.toggle('busy', busy);
}
function setLastScan(txt) { $('#sb-scan').textContent = txt; }

/* ============================================================ VIEWS */

const VIEWS = {};

/* ---------------------------------------------------------- dashboard */

function gaugeHtml(score) {
  const segs = 25;
  const lit = Math.round((score / 100) * segs);
  const color = score >= 85 ? 'var(--green)' : score >= 70 ? 'var(--amber)' : 'var(--red)';
  let s = `<div class="gauge" style="color:${color}">`;
  for (let i = 0; i < segs; i++) s += `<i class="${i < lit ? 'on' : ''}"></i>`;
  return s + '</div>';
}

VIEWS.dashboard = {
  label: 'Dashboard',
  render() {
    if (!state.scan) {
      if (state.scanError) return `
        <div class="sec-head"><span class="sec-sq"></span><span class="sec-title">System Overview</span><span class="sec-line"></span><span class="sec-idx">SCAN UNAVAILABLE</span></div>
        <div class="card tick" style="max-width:720px">
          <div class="card-title">${icon('warn')} Initial scan could not be completed</div>
          <p class="muted" style="font-size:12px;line-height:1.7">${esc(state.scanError)}</p>
          <div class="btn-row mt16"><button class="btn btn-primary" id="dash-retry">${icon('refresh')} Retry scan</button></div>
        </div>`;
      return `
        <div class="sec-head"><span class="sec-sq"></span><span class="sec-title">System Overview</span><span class="sec-line"></span><span class="sec-idx">INITIAL SCAN</span></div>
        <div class="grid-2">
          <div class="card tick" style="display:flex;gap:18px;align-items:center">
            <span class="spinner" style="width:22px;height:22px;border-width:3px"></span>
            <div>
              <div style="font-size:12px;font-weight:700;letter-spacing:.18em;text-transform:uppercase">Running first system scan</div>
              <div style="font-family:var(--mono);font-size:10px;color:var(--dim);margin-top:5px">SENSORS: FILESYSTEM / PROCESSES / NETWORK / FIREWALL / UPDATES / LOGS</div>
            </div>
          </div>
          <div class="card"><div class="progress"><i></i></div></div>
        </div>
        <div class="sec-head"><span class="sec-sq"></span><span class="sec-title">Scan Console</span><span class="sec-line"></span></div>
        <div class="console" id="scan-console"></div>`;
    }
    const d = state.scan;
    const s = d.system;
    const sc = d.score;
    const color = sc.score >= 85 ? 'var(--green)' : sc.score >= 70 ? 'var(--amber)' : 'var(--red)';
    const processAvailable = d.processesAvailable !== false;
    const processList = Array.isArray(d.processes) ? d.processes : [];
    const suspicious = Array.isArray(d.suspicious) ? d.suspicious : [];
    const cpuPct = clampPct(processList.reduce((a, p) => a + (p.cpu || 0), 0));
    const ramPct = s.totalRam ? clampPct((1 - s.freeRam / s.totalRam) * 100) : null;
    const disk = d.systemDisk || (d.disks || []).find((item) => item.isSystem) || (d.disks || []).find((item) => item.mount === '/') || {};
    const diskPct = disk.size ? clampPct((disk.used / disk.size) * 100) : 0;
    const updCount = (d.updates && Array.isArray(d.updates.items)) ? d.updates.items.length : null;
    const errCount = (d.errors && Array.isArray(d.errors.items)) ? d.errors.items.length : null;
    const networkAvailable = !!(d.networkSummary && d.networkSummary.available !== false && Number.isFinite(d.networkSummary.exposed));
    const junkAvailable = !!(d.junk && d.junk.available !== false);

    const statCard = (label, value, sub, pct, cls) => `
      <div class="card stat ${cls || ''}">
        <div class="stat-label">${esc(label)}</div>
        <div class="stat-value">${value}</div>
        <div class="stat-sub">${esc(sub)}</div>
        <div class="stat-bar"><i style="width:${clampPct(pct)}%"></i></div>
      </div>`;

    const suspRows = !processAvailable
      ? `<div class="empty">${icon('info')}<p>Process inventory unavailable</p></div>`
      : suspicious.length
      ? suspicious.slice(0, 6).map((p) => `
          <div class="list-row">
            ${icon(p.suspicionLevel === 'critical' ? 'x' : 'warn', 'sev-ic ' + (p.suspicionLevel === 'critical' ? 'crit' : p.suspicionLevel === 'high' ? 'high' : 'med'))}
            <div class="lr-body">
              <div class="lr-title">${esc(p.name)} <span class="muted" style="font-family:var(--mono);font-size:10px">PID ${p.pid} — RISK ${p.suspicion}/100</span></div>
              <div class="lr-sub">${esc(p.flags.join(' · ') || 'No anomalies detected')}</div>
            </div>
          </div>`).join('')
      : `<div class="empty">${icon('check')}<p>No suspicious processes detected</p></div>`;

    const findingsRows = sc.findings.length
      ? sc.findings.map((f) => `
          <div class="list-row">
            ${icon(f.sev === 'critical' ? 'x' : f.sev === 'warning' ? 'warn' : 'info', 'sev-ic ' + (f.sev === 'critical' ? 'crit' : f.sev === 'warning' ? 'high' : 'info'))}
            <div class="lr-body"><div class="lr-title">${esc(f.msg)}</div></div>
            <span class="badge ${f.sev === 'critical' ? 'crit' : f.sev === 'warning' ? 'warn' : 'info'}">-${f.pts}</span>
          </div>`).join('')
      : `<div class="empty">${icon('check')}<p>System is healthy — no findings</p></div>`;

    const chips = `
      <div class="tag-row" style="margin-top:14px">
        <span class="badge ${d.firewall.enabled === true ? 'ok' : d.firewall.enabled === false ? 'crit' : 'neutral'}"><span class="dot"></span>FIREWALL ${d.firewall.enabled === true ? 'ON' : d.firewall.enabled === false ? 'OFF' : '?'}</span>
        <span class="badge ${d.encryption.enabled === true ? 'ok' : d.encryption.enabled === false ? 'warn' : 'neutral'}"><span class="dot"></span>ENCRYPTION ${d.encryption.enabled === true ? 'ON' : d.encryption.enabled === false ? 'OFF' : '?'}</span>
        <span class="badge ${d.updates && d.updates.checkStatus === 'ok' ? (updCount === 0 ? 'ok' : 'warn') : 'neutral'}"><span class="dot"></span>UPDATES ${!d.updates || d.updates.checkStatus !== 'ok' ? 'UNKNOWN' : updCount === 0 ? 'NO PENDING' : updCount + ' PENDING'}</span>
        <span class="badge ${d.errors && d.errors.available ? (errCount === 0 ? 'ok' : 'warn') : 'neutral'}"><span class="dot"></span>ERRORS 24H ${d.errors && d.errors.available ? errCount : 'UNKNOWN'}</span>
        <span class="badge ${!processAvailable ? 'neutral' : suspicious.length === 0 ? 'ok' : 'warn'}"><span class="dot"></span>RISK SIGNALS ${processAvailable ? suspicious.length : 'UNKNOWN'}</span>
      </div>`;

    const tickerItems = [
      ...sc.findings.map((f) => `<span class="${f.sev === 'critical' ? 'crit' : ''}"><b>${f.sev.toUpperCase()}</b> ${esc(f.msg)}</span>`),
      ...suspicious.slice(0, 5).map((p) => `<span class="crit"><b>RISK SIGNAL</b> ${esc(p.name)} — ${esc(p.flags[0] || 'anomaly')}</span>`),
      `<span><b>SCAN</b> ${junkAvailable ? fmtNum(d.junk.scanned) + ' files inspected · ' + fmtBytes(d.junk.reclaimable) + (d.junk.incomplete ? ' observed in partial coverage' : ' old cleanup candidates') : 'cleanup-folder coverage unavailable'}</span>`,
      `<span><b>NET</b> ${networkAvailable ? d.networkSummary.connections + ' connections · ' + d.networkSummary.exposed + ' non-loopback listeners' : 'endpoint exposure unknown'}</span>`,
      processAvailable ? `<span class="ok"><b>ENGINE</b> ${processList.length} processes profiled in ${(d.durationMs / 1000).toFixed(1)}s</span>` : `<span><b>ENGINE</b> process inventory unavailable</span>`,
    ];
    const tickerTrack = (tickerItems.concat(tickerItems)).map((t) => `<span>${t}</span>`).join('');

    return `
      <div class="sec-head"><span class="sec-sq"></span><span class="sec-title">System Overview</span><span class="sec-line"></span><span class="sec-idx">SCANNED ${timeAgo(state.scanAt)}</span></div>
      <div class="card tick hatch" style="padding:26px 28px">
        <div class="hero-kpi">
          <div>
            <div class="stat-label">Health Score</div>
            <div class="score-num" style="color:${color};margin-top:10px">${sc.score}<small>/100</small></div>
            <span class="score-grade" style="color:${color}">GRADE ${sc.grade}</span>
          </div>
          <div class="divider-v"></div>
          <div class="flex1">
            ${gaugeHtml(sc.score)}
            <div class="gauge-legend"><span>0</span><span>50</span><span>100</span></div>
            ${chips}
            <div class="muted mono" style="font-size:10px;margin-top:10px">${esc(sc.disclaimer || 'Heuristic indicator only; not an antivirus or a guarantee of security.')}</div>
          </div>
        </div>
      </div>

      <div class="grid-4 mt16">
        ${statCard('Process CPU', (processAvailable ? cpuPct : '—') + (processAvailable ? '<small>%</small>' : ''), processAvailable ? (s.cpuModel || 'Unknown CPU').slice(0, 42) : 'process data unavailable', processAvailable ? cpuPct : 0, processAvailable && cpuPct >= 85 ? 'crit' : processAvailable && cpuPct >= 60 ? 'warn' : '')}
        ${statCard('Memory', ramPct == null ? '—' : ramPct + '<small>%</small>', s.totalRam ? fmtBytes(s.totalRam) + ' total · ' + s.cpus + ' cores' : 'usage unavailable', ramPct || 0, ramPct == null ? '' : ramPct >= 92 ? 'crit' : ramPct >= 75 ? 'warn' : '')}
        ${statCard('System Disk', (disk.size ? diskPct : '—') + (disk.size ? '<small>%</small>' : ''), disk.size ? (disk.mount || 'system volume') : 'usage unavailable', disk.size ? diskPct : 0, disk.size ? (diskPct >= 92 ? 'crit' : diskPct >= 80 ? 'warn' : 'ok') : '')}
        ${statCard('Network', (networkAvailable ? d.networkSummary.exposed : '—') + '<small> endpoints</small>', networkAvailable ? d.networkSummary.connections + ' active connections' : 'exposure status unavailable', networkAvailable ? clampPct((d.networkSummary.exposed / 20) * 100) : 0, '')}
      </div>

      <div class="sec-head"><span class="sec-sq"></span><span class="sec-title">Process Risk Indicators</span><span class="sec-line"></span><span class="sec-idx">HEURISTIC SNAPSHOT</span></div>
      <div class="grid-2">
        <div class="card">
          <div class="card-title">${icon('warn')} Process risk signals</div>
          ${suspRows}
        </div>
        <div class="card">
          <div class="card-title">${icon('shield')} Score Findings</div>
          ${findingsRows}
        </div>
      </div>

      <div class="sec-head"><span class="sec-sq"></span><span class="sec-title">Quick Actions</span><span class="sec-line"></span></div>
      <div class="btn-row">
        <button class="btn btn-primary" data-act="rescan">${icon('refresh')} Run Full Scan</button>
        <button class="btn" data-act="junk">${icon('trash')} Review old cleanup candidates</button>
        <button class="btn" data-act="procs">${icon('chip')} Review Processes</button>
        <button class="btn" data-act="upd">${icon('download')} Check Updates</button>
        <button class="btn" data-act="audit">${icon('shield')} Security Audit</button>
      </div>

      <div class="ticker mt24"><span class="ticker-label">LIVE FEED</span><div class="ticker-track">${tickerTrack}</div></div>`;
  },
  init() {
    const retry = $('#dash-retry');
    if (retry) retry.addEventListener('click', startQuickScan);
    if (!state.scan && !state.scanError) startQuickScan();
    $$('[data-act]').forEach((b) => b.addEventListener('click', () => {
      const act = b.dataset.act;
      if (act === 'rescan') startQuickScan();
      if (act === 'junk') navigate('files', { autoJunk: true });
      if (act === 'procs') navigate('processes');
      if (act === 'upd') navigate('updates');
      if (act === 'audit') navigate('audit');
    }));
  },
};

const scanState = { running: false };
async function startQuickScan() {
  if (scanState.running) return; // re-entrancy guard: init -> startQuickScan -> navigate -> init
  scanState.running = true;
  state.scanError = '';
  setBusy(true, 'SCANNING');
  navigate('dashboard'); // shows loading view
  const c = $('#scan-console');
  const log = (txt, cls = '') => {
    if (!c) return;
    const div = document.createElement('div');
    div.className = 'ln ' + cls;
    div.textContent = txt;
    c.appendChild(div);
    c.scrollTop = c.scrollHeight;
  };
  log('> aegis engine v1.0.0 — initialising sensors');
  await sleep(140);
  log('> reading system information & hardware profile');
  await sleep(140);
  log('> profiling processes (two-pass CPU sampling)');
  await sleep(140);
  log('> checking firewall, encryption & update state');
  await sleep(140);
  log('> parsing system error logs (last 24h)');
  await sleep(140);
  log('> sweeping temp, cache & log storage');
  const res = await api('scan:quick');
  if (res) {
    log('> computing heuristic posture indicator ...', 'cy');
    state.scan = res;
    state.scanError = '';
    state.sys = res.system;
    state.scanAt = new Date().toISOString();
    setLastScan('LAST SCAN ' + new Date().toLocaleTimeString());
    log('> scan complete in ' + (res.durationMs / 1000).toFixed(1) + 's — health ' + res.score.score + '/100 (grade ' + res.score.grade + ')', 'ok');
    navigate('dashboard');
  } else {
    state.scanError = 'The system scan did not return usable data. Check permissions and OS command availability, then retry.';
    navigate('dashboard');
  }
  scanState.running = false;
  setBusy(false);
}

/* ---------------------------------------------------------- files */

const filesState = { result: null, busy: false, autoJunk: false };

VIEWS.files = {
  label: 'File Scanner',
  render() {
    const r = filesState.result;
    let results = '';
    if (r) {
      const rows = r.results || [];
      const dup = r.mode === 'duplicates';
      const cleanable = r.mode === 'junk' && r.available !== false && !!r.scanToken;
      const reclaimLabel = dup ? 'Potential duplicate space' : r.mode === 'junk' ? 'Old candidates (review first)' : 'Removal estimate';
      results = `
        <div class="tag-row mt16">
          <span class="chip">${icon('file')} <b>${r.available === false ? '—' : fmtNum(r.scanned)}</b> files scanned</span>
          <span class="chip">${icon('hdd')} <b>${r.available === false ? '—' : fmtBytes(r.bytes)}</b> read</span>
          <span class="chip">${icon('search')} <b>${r.available === false ? '—' : r.count}</b> ${dup ? 'duplicate groups' : 'items found'}</span>
          <span class="chip">${icon('trash')} <b>${r.available === false || r.mode === 'large' ? '—' : fmtBytes(r.reclaimable)}</b> ${esc(reclaimLabel)}</span>
          ${r.mode === 'junk' ? '<span class="badge info"><span class="dot"></span>FILES MUST BE AT LEAST 24 HOURS OLD</span>' : ''}
          ${r.available === false ? `<span class="badge neutral"><span class="dot"></span>SCAN UNAVAILABLE · ${esc(r.error || 'NO ACCESSIBLE FOLDERS')}</span>` : r.incomplete ? `<span class="badge warn"><span class="dot"></span>PARTIAL COVERAGE${r.truncated ? ' · SCAN LIMIT REACHED' : ''}${r.skipped ? ' · ' + fmtNum(r.skipped) + ' PATH(S) SKIPPED' : ''}</span>` : ''}
          <span class="chip">${icon('clock')} ${(r.durationMs / 1000).toFixed(1)}s</span>
        </div>
        <div class="table-wrap mt16">
          <table class="data">
            <thead><tr>
              ${cleanable ? '<th style="width:34px"><input type="checkbox" id="sel-all" aria-label="Select all cleanup candidates"></th>' : ''}
              <th>${dup ? 'Duplicate group' : 'Path'}</th><th>Type</th><th class="right">Size</th>${dup ? '<th class="right">Potentially redundant</th><th class="right">Copies</th>' : ''}
            </tr></thead>
            <tbody>
              ${rows.map((x) => dup
                ? `<tr>
                     <td class="cell-main">${esc(x.files[0] || '')}<span class="cell-sub">${x.files.slice(1).map((file) => esc(file)).join('<br>')}${x.omitted ? '<br>… and ' + fmtNum(x.omitted) + ' more path(s) not shown' : ''}</span></td>
                     <td class="dim">${esc(x.kind)}</td>
                     <td class="right mono">${fmtBytes(x.size)}</td>
                     <td class="right mono" style="color:var(--amber)">${fmtBytes(x.wasted)}</td>
                     <td class="right mono">${x.count}</td>
                   </tr>`
                : `<tr>
                     ${cleanable ? `<td><input type="checkbox" class="sel" data-path="${esc(x.path)}" aria-label="Select ${esc(x.path)}"></td>` : ''}
                     <td class="path-cell" title="${esc(x.path)}">${esc(x.path)}</td>
                     <td class="dim">${esc(x.kind)}</td>
                     <td class="right mono">${fmtBytes(x.size)}</td>
                   </tr>`).join('') || `<tr><td colspan="${cleanable ? 4 : dup ? 5 : 3}" class="dim" style="text-align:center;padding:24px">${r.available === false ? 'SCAN UNAVAILABLE — ' + esc(r.error || 'NO ACCESSIBLE FOLDERS') : r.incomplete ? 'NO CANDIDATES FOUND IN THE SCANNED LOCATIONS; COVERAGE IS PARTIAL' : 'NO CANDIDATES FOUND'}</td></tr>`}
            </tbody>
          </table>
        </div>
        ${cleanable ? `
        <div class="btn-row mt16">
          <button class="btn btn-danger" id="btn-clean" disabled>${icon('trash')} Move Selected to Trash</button>
          <span class="muted mono" style="font-size:10px;align-self:center">OLD TEMP/CACHE CANDIDATES ONLY · 200 FILES PER ACTION · NATIVE CONFIRMATION REQUIRED</span>
        </div>` : ''}`;
    }
    return `
      <div class="sec-head"><span class="sec-sq"></span><span class="sec-title">File Scanner</span><span class="sec-line"></span><span class="sec-idx">STORAGE SENSORS</span></div>
      <div class="card">
        <div class="grid-4" style="gap:14px">
          <div class="field"><label>Scan Mode</label>
            <select class="input" id="f-mode">
              <option value="junk">Old junk &amp; temporary files</option>
              <option value="large">Large files</option>
              <option value="duplicates">Duplicate files</option>
            </select></div>
          <div class="field"><label>Target Folder</label>
            <div style="display:flex;gap:8px">
              <input class="input" id="f-path" placeholder="Default locations" />
              <button class="btn" id="f-browse">${icon('folder')} Browse</button>
            </div></div>
          <div class="field"><label>Min Size (MB) — large mode</label>
            <input class="input" id="f-size" type="number" value="100" min="1" max="10485760" /></div>
          <div class="field"><label>&nbsp;</label>
            <button class="btn btn-primary" id="f-scan" style="width:100%;justify-content:center">${icon('play')} Start Scan</button></div>
        </div>
        <div class="muted" style="font-size:11px;margin-top:12px">Cleanup candidates are at least 24 hours old and are moved to the system Trash. Large files and duplicates are informational only.</div>
        <div id="f-progress" style="display:none;margin-top:16px">
          <div class="progress"><i></i></div>
          <div class="muted mono" style="font-size:10px;margin-top:8px" id="f-status">Scanning selected folder…</div>
        </div>
      </div>
      ${results}`;
  },
  init() {
    $('#f-browse').addEventListener('click', async () => {
      const paths = await api('dialog:pickDir');
      if (paths && paths[0]) $('#f-path').value = paths[0];
    });
    $('#f-scan').addEventListener('click', runFilesScan);
    const selAll = $('#sel-all');
    if (selAll) selAll.addEventListener('change', () => {
      $$('.sel').forEach((checkbox) => { checkbox.checked = selAll.checked; });
      const clean = $('#btn-clean');
      if (clean) clean.disabled = !selAll.checked;
    });
    $$('.sel').forEach((checkbox) => checkbox.addEventListener('change', () => {
      const clean = $('#btn-clean');
      if (clean) clean.disabled = !$$('.sel').some((item) => item.checked);
    }));
    const clean = $('#btn-clean');
    if (clean) clean.addEventListener('click', cleanSelected);
    if (filesState.autoJunk) { filesState.autoJunk = false; runFilesScan(); }
  },
};

async function runFilesScan() {
  if (filesState.busy) return;
  filesState.busy = true;
  setBusy(true, 'FILE SCAN');
  $('#f-progress').style.display = 'block';
  $('#f-scan').disabled = true;
  const statuses = ['Checking folder access…', 'Inspecting file metadata…', 'Hashing duplicate candidates…', 'Preparing safe results…'];
  let si = 0;
  const timer = setInterval(() => {
    const label = $('#f-status');
    if (label) { si = (si + 1) % statuses.length; label.textContent = statuses[si]; }
  }, 900);
  activeTimers.push(timer);
  const mode = $('#f-mode').value;
  const sizeMb = Number($('#f-size').value);
  const payload = {
    mode,
    minSize: (Number.isFinite(sizeMb) && sizeMb > 0 ? Math.min(sizeMb, 10485760) : 100) * 1024 * 1024,
    roots: ($('#f-path').value || '').trim() ? [$('#f-path').value.trim()] : undefined,
  };
  const res = await api('scan:files', payload);
  clearInterval(timer);
  filesState.busy = false;
  setBusy(false);
  const progress = $('#f-progress');
  const scanButton = $('#f-scan');
  if (progress) progress.style.display = 'none';
  if (scanButton) scanButton.disabled = false;
  if (res) {
    filesState.result = res;
    navigate('files');
    const message = res.available === false
      ? 'File scan unavailable — no accessible scan folders'
      : `Scan ${res.incomplete ? 'partially complete' : 'complete'} — ${res.count} item(s) found${res.skipped ? `; ${res.skipped} path(s) skipped` : ''}`;
    toast(message, res.available === false || res.incomplete ? 'warn' : 'success');
  }
}

async function cleanSelected() {
  const paths = $$('.sel').filter((checkbox) => checkbox.checked).map((checkbox) => checkbox.dataset.path);
  if (!paths.length || !filesState.result || !filesState.result.scanToken) return;
  if (paths.length > 200) { toast('Move no more than 200 files at a time; narrow your selection and retry.', 'warn'); return; }
  setBusy(true, 'MOVING TO TRASH');
  const res = await api('files:clean', { scanToken: filesState.result.scanToken, paths });
  setBusy(false);
  if (res) {
    if (res.cancelled) return;
    if (res.ok === false) { toast(res.error || 'Could not move selected files', 'error'); return; }
    toast(`Moved ${Number(res.removed) || 0} file(s) to Trash${res.failed ? `; ${res.failed} failed` : ''}`, res.failed ? 'warn' : 'success');
    filesState.result = null;
    navigate('files');
  }
}

/* ---------------------------------------------------------- processes */

const procState = { list: [], available: null, error: '', loading: false, sortKey: 'suspicion', sortDir: -1, filter: '', auto: true };

VIEWS.processes = {
  label: 'Processes',
  render() {
    const q = procState.filter.toLowerCase();
    let rows = procState.list.filter((p) =>
      !q || p.name.toLowerCase().includes(q) || String(p.pid).includes(q) || (p.path || '').toLowerCase().includes(q));
    rows = [...rows].sort((a, b) => {
      const k = procState.sortKey;
      const va = a[k] == null ? 0 : a[k];
      const vb = b[k] == null ? 0 : b[k];
      const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
      return cmp * procState.sortDir;
    });
    const susp = procState.list.filter((p) => p.suspicion > 0).length;
    const highCpu = procState.list.filter((p) => (p.cpu || 0) >= 60).length;
    const th = (key, label) =>
      `<th class="sortable" data-sort="${key}">${label}${procState.sortKey === key ? `<span class="sort-ic">${procState.sortDir === 1 ? '▲' : '▼'}</span>` : ''}</th>`;
    return `
      <div class="sec-head"><span class="sec-sq"></span><span class="sec-title">Process Monitor</span><span class="sec-line"></span><span class="sec-idx">HEURISTIC SNAPSHOT</span></div>
      <div class="toolbar">
        <span class="chip">${icon('chip')} <b>${procState.list.length}</b> processes</span>
        <span class="chip">${icon('warn')} <b>${susp}</b> flagged</span>
        <span class="chip">${icon('zap')} <b>${highCpu}</b> high CPU</span>
        <span class="spacer"></span>
        <input class="input" id="p-filter" placeholder="Filter by name / pid / path…" value="${esc(procState.filter)}" />
        <button class="btn ${procState.auto ? 'btn-primary' : ''}" id="p-auto">${icon('refresh')} AUTO ${procState.auto ? 'ON' : 'OFF'}</button>
        <button class="btn" id="p-refresh">${icon('refresh')} Refresh</button>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr>${th('pid', 'PID')}${th('name', 'Process')}${th('cpu', 'CPU')}${th('memBytes', 'Memory')}${th('path', 'Executable Path')}${th('suspicion', 'Risk')}<th></th></tr></thead>
          <tbody>
            ${rows.slice(0, 300).map((p) => {
              const rowCls = p.suspicion >= 60 ? 'row-crit' : p.suspicion >= 30 ? 'row-high' : p.suspicion > 0 ? 'row-med' : '';
              const badges = p.flags.length
                ? p.flags.map((f) => `<span class="badge ${p.suspicionLevel === 'critical' ? 'crit' : p.suspicionLevel === 'high' ? 'warn' : 'info'}" style="margin:1px">${esc(f)}</span>`).join(' ')
                : '<span class="badge ok"><span class="dot"></span>CLEAN</span>';
              return `<tr class="${rowCls}">
                <td class="mono dim">${p.pid}</td>
                <td class="cell-main">${esc(p.name)}${p.company ? `<span class="cell-sub">${esc(p.company)}</span>` : ''}</td>
                <td><span class="mini-bar"><i class="${barClass(p.cpu || 0)}" style="width:${clampPct(p.cpu)}%"></i></span><span class="mono">${(p.cpu || 0).toFixed(1)}%</span></td>
                <td class="mono">${fmtBytes(p.memBytes)}</td>
                <td class="path-cell" title="${esc(p.path)}">${esc(p.path || '—')}</td>
                <td>${badges}</td>
                <td><button class="btn btn-sm btn-danger" data-kill="${p.pid}" ${p.canStop === false || p.pid <= 4 ? 'disabled title="Process is protected or cannot be stopped safely"' : ''}>${icon('power')}</button></td>
              </tr>`;
            }).join('') || `<tr><td colspan="7" class="dim" style="text-align:center;padding:30px">${procState.available === false ? 'PROCESS INVENTORY UNAVAILABLE — ' + esc(procState.error || 'QUERY FAILED') : procState.available === true ? 'NO PROCESSES MATCH THE FILTER' : 'NO PROCESS DATA — PRESS REFRESH'}</td></tr>`}
          </tbody>
        </table>
      </div>`;
  },
  init() {
    $('#p-refresh').addEventListener('click', loadProcesses);
    $('#p-auto').addEventListener('click', () => {
      procState.auto = !procState.auto;
      navigate('processes');
    });
    $('#p-filter').addEventListener('input', (e) => { procState.filter = e.target.value; renderRowsOnly(); });
    $$('th.sortable').forEach((h) => h.addEventListener('click', () => {
      const k = h.dataset.sort;
      if (procState.sortKey === k) procState.sortDir *= -1;
      else { procState.sortKey = k; procState.sortDir = k === 'name' || k === 'path' ? 1 : -1; }
      renderRowsOnly();
    }));
    $$('[data-kill]').forEach((b) => b.addEventListener('click', () => killProcess(parseInt(b.dataset.kill, 10))));
    if (procState.auto) {
      activeTimers.push(setInterval(() => { if (state.route === 'processes' && procState.available !== false) loadProcesses(true); }, 5000));
    }
    if (procState.available === null) loadProcesses();
  },
};

function renderRowsOnly() { navigate('processes'); }

async function loadProcesses(silent = false) {
  if (procState.loading) return;
  procState.loading = true;
  if (!silent) setBusy(true, 'PROCESS SCAN');
  try {
    const res = await api('proc:list');
    procState.available = !!(res && res.available === true && Array.isArray(res.items));
    procState.list = procState.available ? res.items : [];
    procState.error = procState.available ? '' : (res && res.error) || 'Process inventory unavailable';
    if (state.route === 'processes') navigate('processes');
  } finally {
    procState.loading = false;
    if (!silent) setBusy(false);
  }
}

async function killProcess(pid) {
  setBusy(true, 'STOPPING PROCESS');
  const res = await api('proc:kill', { pid });
  setBusy(false);
  if (res && res.ok) { toast(`Process ${pid} terminated`, 'success'); loadProcesses(); }
  else if (res && res.error !== 'Cancelled') toast(res.error || 'Could not stop process', 'error');
}

/* ---------------------------------------------------------- apps */

const appsState = { list: [], filter: '', sortKey: 'name', sortDir: 1 };

VIEWS.apps = {
  label: 'Applications',
  render() {
    const q = appsState.filter.toLowerCase();
    let rows = appsState.list.filter((a) => !q || String(a.name || '').toLowerCase().includes(q) || String(a.publisher || '').toLowerCase().includes(q));
    rows = [...rows].sort((a, b) => {
      const k = appsState.sortKey;
      const va = a[k] == null ? '' : a[k];
      const vb = b[k] == null ? '' : b[k];
      const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
      return cmp * appsState.sortDir;
    });
    const flagged = appsState.list.filter((a) => (a.flags || []).some((f) => f.sev === 'high')).length;
    const th = (key, label) =>
      `<th class="sortable" data-sort="${key}">${label}${appsState.sortKey === key ? `<span class="sort-ic">${appsState.sortDir === 1 ? '▲' : '▼'}</span>` : ''}</th>`;
    return `
      <div class="sec-head"><span class="sec-sq"></span><span class="sec-title">Installed Applications</span><span class="sec-line"></span><span class="sec-idx">SOFTWARE INVENTORY</span></div>
      <div class="toolbar">
        <span class="chip">${icon('layers')} <b>${appsState.list.length}</b> applications</span>
        <span class="chip">${icon('warn')} <b>${flagged}</b> heuristic flags</span>
        <span class="spacer"></span>
        <input class="input" id="a-filter" placeholder="Filter applications…" value="${esc(appsState.filter)}" />
        <button class="btn" id="a-refresh">${icon('refresh')} Refresh</button>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr>${th('name', 'Application')}${th('publisher', 'Publisher')}${th('version', 'Version')}${th('size', 'Size')}${th('Flags')}<th>Removal</th></tr></thead>
          <tbody>
            ${rows.slice(0, 300).map((a) => `
              <tr>
                <td class="cell-main">${esc(a.name)}</td>
                <td class="dim">${esc(a.publisher || '—')}</td>
                <td class="mono dim">${esc(a.version || '—')}</td>
                <td class="mono">${a.size ? fmtBytes(a.size) : '—'}</td>
                <td>${a.flags && a.flags.length ? a.flags.map((f) => `<span class="badge ${f.sev === 'high' ? 'warn' : 'neutral'}" style="margin:1px">${esc(f.label)}</span>`).join(' ') : '<span class="badge ok"><span class="dot"></span>OK</span>'}</td>
                <td><button class="btn btn-sm ${a.canUninstall ? 'btn-danger' : ''}" data-uninstall="${esc(a.id)}" ${a.canUninstall ? '' : 'disabled title="No safe removal method is available"'}>${icon('trash')} ${a.canUninstall ? 'Uninstall' : 'Unavailable'}</button></td>
              </tr>`).join('') || `<tr><td colspan="6" class="dim" style="text-align:center;padding:30px">${appsState.list.length ? 'NO APPLICATIONS MATCH THE FILTER' : appsState.loaded ? 'NO APPLICATIONS REPORTED' : 'APPLICATION INVENTORY UNAVAILABLE — PRESS REFRESH'}</td></tr>`}
          </tbody>
        </table>
      </div>
      <p class="muted mono mt16" style="font-size:10px;letter-spacing:.04em">Uninstall actions are confirmed by the operating system dialog; unsupported package types remain read-only.</p>`;
  },
  init() {
    $('#a-refresh').addEventListener('click', loadApps);
    $('#a-filter').addEventListener('input', (e) => { appsState.filter = e.target.value; navigate('apps'); });
    $$('th.sortable').forEach((h) => h.addEventListener('click', () => {
      const k = h.dataset.sort;
      if (appsState.sortKey === k) appsState.sortDir *= -1;
      else { appsState.sortKey = k; appsState.sortDir = 1; }
      navigate('apps');
    }));
    $$('[data-uninstall]').forEach((button) => button.addEventListener('click', () => uninstallApp(button.dataset.uninstall)));
    if (!appsState.loaded) loadApps();
  },
};

async function loadApps() {
  if (appsState.loading) return;
  appsState.loading = true;
  setBusy(true, 'APP INVENTORY');
  try {
    const res = await api('apps:list');
    if (Array.isArray(res)) {
      appsState.list = res;
      appsState.loaded = true;
      if (state.route === 'apps') navigate('apps');
    }
  } finally {
    appsState.loading = false;
    setBusy(false);
  }
}

async function uninstallApp(id) {
  const app = appsState.list.find((item) => item.id === id);
  if (!app || !app.canUninstall) return;
  setBusy(true, 'UNINSTALLING');
  const res = await api('apps:uninstall', { id });
  setBusy(false);
  if (res && res.ok) { toast(`“${app.name}” removal completed`, 'success'); loadApps(); }
  else if (res && res.error !== 'Cancelled') toast(res.error || 'Uninstall failed', 'error');
}

/* ---------------------------------------------------------- network */

VIEWS.network = {
  label: 'Network',
  render() {
    const n = VIEWS.network.data;
    if (!n) {
      return `
        <div class="sec-head"><span class="sec-sq"></span><span class="sec-title">Network</span><span class="sec-line"></span></div>
        <div class="card" style="display:flex;gap:16px;align-items:center">
          <span class="spinner"></span><span class="muted" style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;font-weight:600">Mapping network connections…</span>
        </div>`;
    }
    const fw = n.firewall || { enabled: null, verified: false, profiles: [], details: 'Status unavailable' };
    const net = n.net || { connections: [], listening: [], exposed: [], available: false, error: 'Network status unavailable' };
    const connections = Array.isArray(net.connections) ? net.connections : [];
    const listening = Array.isArray(net.listening) ? net.listening : [];
    const exposed = Array.isArray(net.exposed) ? net.exposed : [];
    const networkAvailable = net.available !== false;
    const fwVerified = fw.enabled === true && fw.verified === true;
    const fwBadge = fw.enabled === true
      ? `<span class="badge ${fwVerified ? 'ok' : 'warn'}"><span class="dot"></span>${fwVerified ? 'INBOUND POLICY VERIFIED' : 'ACTIVE · POLICY UNKNOWN'}</span>`
      : fw.enabled === false
        ? '<span class="badge crit"><span class="dot"></span>NO ACTIVE FIREWALL</span>'
        : '<span class="badge neutral"><span class="dot"></span>STATUS UNKNOWN</span>';
    const listenChips = listening.slice(0, 60).map((c) =>
      `<span class="chip" title="${esc(c.local)}">${icon('wifi')} <b>${esc((c.local || '').split(':').pop())}</b> ${esc(c.process || c.proto)}</span>`).join('');
    return `
      <div class="sec-head"><span class="sec-sq"></span><span class="sec-title">Network</span><span class="sec-line"></span><span class="sec-idx">LOCAL CONNECTION SNAPSHOT</span></div>
      <div class="grid-2">
        <div class="card tick">
          <div class="card-title">${icon('shield')} Firewall Status</div>
          <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
            <div style="font-size:28px;font-weight:700;color:${fwVerified ? 'var(--green)' : fw.enabled === false ? 'var(--red)' : 'var(--amber)'}">${fwVerified ? 'POLICY VERIFIED' : fw.enabled === true ? 'ACTIVE — REVIEW POLICY' : fw.enabled === false ? 'NOT ACTIVE' : 'UNKNOWN'}</div>
            ${fwBadge}
          </div>
          <p class="mono muted mt16" style="font-size:10.5px;line-height:1.8">${esc(fw.details || 'Firewall status unavailable')}</p>
          <div class="tag-row mt16">
            ${(fw.profiles || []).map((profile) => `<span class="badge ${profile.enabled === true ? 'ok' : profile.enabled === false ? 'crit' : 'neutral'}"><span class="dot"></span>${esc(profile.name)}: ${profile.enabled === true ? 'ON' : profile.enabled === false ? 'OFF' : '?'}</span>`).join('')}
          </div>
          <div class="btn-row mt16">
            ${fw.enabled === false ? `<button class="btn btn-primary" id="n-fwfix">${icon('shield')} Enable Firewall</button>` : ''}
            <button class="btn" id="n-refresh">${icon('refresh')} Refresh</button>
          </div>
          <p class="muted" style="font-size:10px;margin-top:10px">A running firewall service does not prove every inbound rule is safe.</p>
        </div>
        <div class="card">
          <div class="card-title">${icon('globe')} Listening / Bound Endpoints <span class="muted" style="letter-spacing:.05em">(${networkAvailable ? listening.length : '?'})</span></div>
          <div class="muted mono" style="font-size:10px;margin:8px 0 12px">${networkAvailable ? exposed.length + ' bound to a non-loopback address' : esc(net.error || 'Endpoint exposure unavailable')}</div>
          <div class="tag-row" style="max-height:190px;overflow-y:auto">${listenChips || `<span class="muted" style="font-size:11px">${networkAvailable ? 'No listening endpoints detected' : 'Network endpoint data unavailable'}</span>`}</div>
        </div>
      </div>
      <div class="sec-head"><span class="sec-sq"></span><span class="sec-title">Active Connections</span><span class="sec-line"></span><span class="sec-idx">${networkAvailable ? connections.length + ' TOTAL' : 'STATUS UNKNOWN'}</span></div>
      <div class="toolbar">
        <input class="input" id="n-filter" placeholder="Filter by address / process…" />
        <span class="spacer"></span>
        <button class="btn" id="n-refresh2">${icon('refresh')} Refresh</button>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>Proto</th><th>Local Address</th><th>Remote Address</th><th>State</th><th>Process</th><th>PID</th></tr></thead>
          <tbody id="n-tbody"></tbody>
        </table>
      </div>`;
  },
  init() {
    const refresh = () => loadNetwork();
    const b1 = $('#n-refresh'); if (b1) b1.addEventListener('click', refresh);
    const b2 = $('#n-refresh2'); if (b2) b2.addEventListener('click', refresh);
    const fix = $('#n-fwfix');
    if (fix) fix.addEventListener('click', enableFirewallNow);
    const filter = $('#n-filter');
    if (filter) filter.addEventListener('input', (event) => renderConnections(event.target.value));
    renderConnections('');
    if (!VIEWS.network.data) loadNetwork();
  },
  data: null,
};

function renderConnections(q) {
  const n = VIEWS.network.data;
  const tbody = $('#n-tbody');
  if (!n || !tbody) return;
  if (n.net && n.net.available === false) {
    tbody.innerHTML = `<tr><td colspan="6" class="dim" style="text-align:center;padding:24px">${esc(n.net.error || 'NETWORK ENDPOINT DATA UNAVAILABLE')}</td></tr>`;
    return;
  }
  const connections = (n.net && Array.isArray(n.net.connections) && n.net.connections) || [];
  const query = String(q || '').toLowerCase();
  const rows = connections.filter((c) =>
    !query || String(c.local || '').toLowerCase().includes(query) || String(c.remote || '').toLowerCase().includes(query) || String(c.process || '').toLowerCase().includes(query));
  tbody.innerHTML = rows.slice(0, 400).map((c) => {
    const state = String(c.state || '—');
    const st = /LISTEN|BOUND|UNCONN/i.test(state)
      ? `<span class="badge info"><span class="dot"></span>${esc(state)}</span>`
      : /ESTABLISHED/i.test(state)
        ? '<span class="badge ok"><span class="dot"></span>ESTABLISHED</span>'
        : `<span class="badge neutral"><span class="dot"></span>${esc(state)}</span>`;
    return `<tr>
      <td class="mono"><b>${esc(c.proto)}</b></td>
      <td class="mono">${esc(c.local)}</td>
      <td class="mono dim">${esc(c.remote)}</td>
      <td>${st}</td>
      <td class="cell-main">${esc(c.process || '—')}</td>
      <td class="mono dim">${Number(c.pid) || '—'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="dim" style="text-align:center;padding:24px">NO CONNECTIONS MATCH</td></tr>';
}

async function loadNetwork() {
  setBusy(true, 'NETWORK SCAN');
  const [net, firewall] = await Promise.all([api('net:list'), api('fw:status')]);
  VIEWS.network.data = {
    net: net || { connections: [], listening: [], exposed: [], available: false, error: 'Network endpoint query failed' },
    firewall: firewall || { enabled: null, verified: false, profiles: [], details: 'Firewall status could not be read' },
  };
  if (state.route === 'network') navigate('network');
  setTimeout(() => renderConnections($('#n-filter') ? $('#n-filter').value : ''), 30);
  setBusy(false);
}

async function enableFirewallNow() {
  setBusy(true, 'CHANGING FIREWALL');
  const result = await api('fw:enable');
  setBusy(false);
  if (result && result.ok) {
    toast(result.error || (result.verified === false ? 'Firewall is active; review inbound application rules manually' : 'Firewall command completed and status verified'), result.verified === false ? 'warn' : 'success');
    loadNetwork();
  } else if (result && result.error !== 'Cancelled') toast(result.error || 'Could not verify firewall status', 'error');
}

/* ---------------------------------------------------------- audit */

VIEWS.audit = {
  label: 'Security Audit',
  data: null,
  render() {
    const audit = VIEWS.audit.data;
    if (!audit) {
      return `
        <div class="sec-head"><span class="sec-sq"></span><span class="sec-title">Security Audit</span><span class="sec-line"></span></div>
        <div class="card tick" style="max-width:720px">
          <div class="card-title">${icon('shield')} Local posture checks</div>
          <p class="muted" style="font-size:12.5px;line-height:1.75">Checks firewall status, system-volume encryption, update status, recent error logs, process risk indicators, system disk pressure and externally bound listening endpoints. This is a heuristic check, not a vulnerability scan and not an antivirus.</p>
          <div class="btn-row mt16"><button class="btn btn-primary" id="au-run">${icon('play')} Run Checks</button></div>
        </div>`;
    }
    const overall = audit.items.every((item) => item.status === 'ok');
    const rows = audit.items.map((item) => `
      <div class="audit-item ${item.status}">
        ${icon(item.status === 'ok' ? 'check' : item.status === 'warn' ? 'warn' : 'x')}
        <div class="ai-body"><div class="ai-title">${esc(item.title)}</div><div class="ai-sub">${esc(item.detail)}</div></div>
        ${item.actionLabel ? `<button class="btn btn-sm ${item.actionDanger ? 'btn-danger' : ''}" data-au="${item.action}">${esc(item.actionLabel)}</button>` : ''}
      </div>`).join('');
    return `
      <div class="sec-head"><span class="sec-sq"></span><span class="sec-title">Security Audit</span><span class="sec-line"></span><span class="sec-idx">${esc(audit.at)}</span></div>
      <div class="card tick hatch" style="display:flex;align-items:center;gap:18px;margin-bottom:16px">
        ${icon(overall ? 'check' : 'warn', 'sev-ic ' + (overall ? 'ok' : 'high'))}
        <div>
          <div style="font-size:15px;font-weight:700;letter-spacing:.14em;text-transform:uppercase">${overall ? 'No findings in available checks' : 'Review the findings below'}</div>
          <div class="mono muted" style="font-size:10.5px;margin-top:4px">${audit.items.filter((item) => item.status !== 'ok').length} item(s) need attention · ${audit.items.length} checks · ${audit.ms}ms</div>
        </div>
        <span class="spacer"></span>
        <button class="btn" id="au-again">${icon('refresh')} Re-run</button>
        <button class="btn btn-primary" id="au-export">${icon('download')} Export Summary</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:10px">${rows}</div>
      <p class="muted" style="font-size:10px;margin-top:14px">This heuristic checklist is not an antivirus and cannot certify that a system is secure or malware-free.</p>`;
  },
  init() {
    const run = $('#au-run'); if (run) run.addEventListener('click', runAudit);
    const again = $('#au-again'); if (again) again.addEventListener('click', runAudit);
    const exp = $('#au-export'); if (exp) exp.addEventListener('click', exportReport);
    $$('[data-au]').forEach((button) => button.addEventListener('click', () => auditAction(button.dataset.au)));
  },
};

async function runAudit() {
  setBusy(true, 'AUDIT');
  const t0 = Date.now();
  const [firewall, encryption, updates, errors, processes, disks, net] = await Promise.all([
    api('fw:status'), api('enc:status'), api('updates:check'), api('errors:list'), api('proc:list'), api('disk:usage'), api('net:list'),
  ]);
  const processList = processes && processes.available === true && Array.isArray(processes.items) ? processes.items : null;
  const suspicious = (processList || []).filter((process) => process.suspicion >= 35);
  const disk = (disks || []).find((item) => item.isSystem) || (disks || []).find((item) => item.mount === '/') || null;
  const diskPct = disk && disk.size ? (disk.used / disk.size) * 100 : null;
  const errorItems = errors && Array.isArray(errors.items) ? errors.items : [];
  const updatesAvailable = updates && Array.isArray(updates.items) ? updates.items : [];
  const exposed = net && net.available !== false && Array.isArray(net.exposed) ? net.exposed : null;
  const items = [
    {
      title: 'Firewall service and inbound policy',
      status: !firewall || firewall.enabled == null ? 'warn' : firewall.enabled === false ? 'crit' : firewall.verified ? 'ok' : 'warn',
      detail: firewall ? firewall.details : 'Firewall status could not be read',
      action: firewall && firewall.enabled === false ? 'fw' : null,
      actionLabel: firewall && firewall.enabled === false ? 'Enable firewall' : null,
    },
    {
      title: 'System-volume encryption',
      status: encryption && encryption.enabled === true ? 'ok' : 'warn',
      detail: encryption ? encryption.details : 'Encryption status could not be read',
      action: 'enc', actionLabel: 'Guidance',
    },
    {
      title: 'Operating-system updates',
      status: !updates || updates.checkStatus !== 'ok' ? 'warn' : updatesAvailable.length || updates.rebootRequired ? 'warn' : 'ok',
      detail: !updates || updates.checkStatus !== 'ok' ? (updates && updates.note) || 'Update status unavailable' : updatesAvailable.length ? updatesAvailable.length + ' pending update(s)' : updates.note || 'No pending updates reported by the OS service',
      action: 'upd', actionLabel: 'Review updates',
    },
    {
      title: 'System error log (24h)',
      status: !errors || errors.available === false ? 'warn' : errorItems.length ? 'warn' : 'ok',
      detail: !errors || errors.available === false ? (errors && errors.error) || 'Recent error logs are unavailable' : (errors.count24h || 0) + ' recent error event(s); ' + (errors.window || 'time window reported by the OS'),
      action: errorItems.length ? 'err' : null, actionLabel: errorItems.length ? 'Inspect logs' : null,
    },
    {
      title: 'Process risk indicators',
      status: suspicious.length ? 'crit' : processList ? 'ok' : 'warn',
      detail: suspicious.length ? suspicious.length + ' process(es) matched simple name/path/resource heuristics; investigate manually' : processList ? 'No processes matched the current heuristics (this is not a malware scan)' : 'Process inventory unavailable',
      action: suspicious.length ? 'proc' : null, actionLabel: suspicious.length ? 'Review processes' : null, actionDanger: false,
    },
    {
      title: 'System disk space',
      status: diskPct == null ? 'warn' : diskPct < 85 ? 'ok' : diskPct < 92 ? 'warn' : 'crit',
      detail: disk && diskPct != null ? disk.mount + ' — ' + diskPct.toFixed(0) + '% used (' + fmtBytes(disk.free) + ' free)' : 'System disk usage unavailable',
      action: 'disk', actionLabel: 'Find large files',
    },
    {
      title: 'Non-loopback listening endpoints',
      status: exposed == null ? 'warn' : exposed.length ? 'warn' : 'ok',
      detail: exposed == null ? 'Network endpoint exposure could not be assessed' : exposed.length + ' endpoint(s) bound beyond loopback; verify whether each is intentional',
      action: 'net', actionLabel: 'Inspect network',
    },
  ];
  VIEWS.audit.data = {
    items,
    at: new Date().toLocaleString(),
    ms: Date.now() - t0,
    raw: { firewall, encryption, updates, errors, suspicious, processesAvailable: !!processList, disk, disks, net },
  };
  if (state.route === 'audit') navigate('audit');
  setBusy(false);
}

function auditAction(action) {
  if (action === 'fw') enableFirewallNow();
  if (action === 'upd') navigate('updates');
  if (action === 'proc') navigate('processes');
  if (action === 'disk') { filesState.result = null; navigate('files'); setTimeout(() => { const mode = $('#f-mode'); if (mode) mode.value = 'large'; }, 30); }
  if (action === 'net') navigate('network');
  if (action === 'err') {
    const entries = (((VIEWS.audit.data || {}).raw || {}).errors || {}).items || [];
    const html = entries.slice(0, 40).map((entry) => `<div class="list-row"><div class="lr-body"><div class="lr-title" style="font-family:var(--mono);font-size:10.5px">${esc(entry.time)} · ${esc(entry.source)}</div><div class="lr-sub">${esc(entry.message)}</div></div></div>`).join('');
    openModal(`<div class="modal-head"><h3>Recent System <em>Errors</em></h3><button class="modal-x" id="m-x">${icon('x')}</button></div>${html || '<p class="muted">No events to show.</p>'}`, true);
    $('#m-x').onclick = closeModal;
  }
  if (action === 'enc') {
    openModal(`
      <div class="modal-head"><h3>Enable System <em>Encryption</em></h3><button class="modal-x" id="m-x">${icon('x')}</button></div>
      <div style="color:var(--dim);font-size:12.5px;line-height:1.8">
        <p><b style="color:var(--txt)">Windows:</b> use Settings → Privacy &amp; Security → Device encryption / BitLocker for the operating-system volume. Store the recovery key safely.</p>
        <p style="margin-top:10px"><b style="color:var(--txt)">macOS:</b> System Settings → Privacy &amp; Security → FileVault → Turn On.</p>
        <p style="margin-top:10px"><b style="color:var(--txt)">Linux:</b> full-disk encryption is normally configured during installation; back up recovery material before changing storage encryption.</p>
      </div>
      <div class="btn-row mt24"><button class="btn btn-primary" id="m-ok">GOT IT</button></div>`);
    $('#m-x').onclick = closeModal;
    $('#m-ok').onclick = closeModal;
  }
}

async function exportReport() {
  const audit = VIEWS.audit.data;
  if (!audit) return;
  const scan = state.scan || {};
  const raw = audit.raw || {};
  const report = {
    app: 'AEGIS Sentinel',
    version: state.version,
    generatedAt: new Date().toISOString(),
    system: {
      platformLabel: (state.sys || {}).platformLabel || 'Unknown',
      osCaption: (state.sys || {}).osCaption || 'Unknown',
      arch: (state.sys || {}).arch || 'Unknown',
      cpus: Number((state.sys || {}).cpus) || null,
      totalRam: Number((state.sys || {}).totalRam) || null,
    },
    posture: scan.score ? { score: scan.score.score, grade: scan.score.grade, disclaimer: scan.score.disclaimer } : null,
    checks: audit.items.map(({ title, status }) => ({ title, status })),
    counts: {
      pendingUpdates: raw.updates && raw.updates.checkStatus === 'ok' && Array.isArray(raw.updates.items) ? raw.updates.items.length : null,
      recentErrorEvents: raw.errors && raw.errors.available !== false && Number.isFinite(raw.errors.count24h) ? raw.errors.count24h : null,
      processRiskSignals: raw.processesAvailable && Array.isArray(raw.suspicious) ? raw.suspicious.length : null,
      listeningEndpoints: raw.net && raw.net.available !== false && Array.isArray(raw.net.listening) ? raw.net.listening.length : null,
      externallyBoundEndpoints: raw.net && raw.net.available !== false && Array.isArray(raw.net.exposed) ? raw.net.exposed.length : null,
    },
    privacyNote: 'This summary omits hostname, username, file paths, process names, remote IP addresses, and raw log messages.',
  };
  setBusy(true, 'EXPORTING');
  const result = await api('report:save', report);
  setBusy(false);
  if (result) toast('Privacy-limited report exported', 'success');
}

/* ---------------------------------------------------------- updates */

VIEWS.updates = {
  label: 'Updates',
  data: null,
  render() {
    const updates = VIEWS.updates.data;
    if (!updates) {
      return `
        <div class="sec-head"><span class="sec-sq"></span><span class="sec-title">System Updates</span><span class="sec-line"></span></div>
        <div class="card" style="display:flex;gap:16px;align-items:center">
          <span class="spinner"></span><span class="muted" style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;font-weight:600">Checking with the operating system…</span>
        </div>`;
    }
    const items = Array.isArray(updates.items) ? updates.items : [];
    const checkFailed = updates.checkStatus !== 'ok';
    const rows = items.length
      ? items.slice(0, 200).map((item) => `<tr>
          <td class="cell-main">${esc(item.name)}</td>
          <td class="mono dim">${esc(item.version || '—')}</td>
          <td class="dim">${esc(item.source || '')}</td>
          <td class="mono right">${item.size ? fmtBytes(item.size) : '—'}</td>
        </tr>`).join('')
      : checkFailed
        ? `<tr><td colspan="4"><div class="empty">${icon('warn')}<p>Update status could not be verified</p></div></td></tr>`
        : `<tr><td colspan="4"><div class="empty">${icon('check')}<p>No pending updates were reported by the OS service</p></div></td></tr>`;
    return `
      <div class="sec-head"><span class="sec-sq"></span><span class="sec-title">System Updates</span><span class="sec-line"></span><span class="sec-idx">OPERATING-SYSTEM SERVICE</span></div>
      <div class="grid-3">
        <div class="card stat"><div class="stat-label">Pending Updates</div><div class="stat-value">${checkFailed ? 'UNKNOWN' : items.length}</div><div class="stat-sub">${esc(updates.note || '')}</div></div>
        <div class="card stat"><div class="stat-label">Last Installed</div><div class="stat-value" style="font-size:22px">${updates.lastInstalled ? esc(updates.lastInstalled) : 'n/a'}</div><div class="stat-sub">most recent recorded update</div></div>
        <div class="card stat ${updates.rebootRequired === true ? 'warn' : updates.rebootRequired == null ? '' : 'ok'}"><div class="stat-label">Restart</div><div class="stat-value" style="font-size:22px">${updates.rebootRequired == null ? 'UNKNOWN' : updates.rebootRequired ? 'REQUIRED' : 'NOT REQUIRED'}</div><div class="stat-sub">to finish updates</div></div>
      </div>
      <div class="btn-row mt16">
        <button class="btn" id="u-refresh">${icon('refresh')} Re-check</button>
        <button class="btn btn-primary" id="u-install" ${checkFailed || items.length === 0 ? 'disabled' : ''}>${icon('download')} Install Available Updates</button>
      </div>
      <div class="sec-head"><span class="sec-sq"></span><span class="sec-title">Available Updates</span><span class="sec-line"></span></div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>Update</th><th>Version / KB</th><th>Source</th><th class="right">Size</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${updates.history && updates.history.length ? `
      <div class="sec-head"><span class="sec-sq"></span><span class="sec-title">Recent Update History</span><span class="sec-line"></span></div>
      <div class="table-wrap" style="max-height:240px">
        <table class="data">
          <thead><tr><th>HotFix</th><th>Description</th><th>Installed</th></tr></thead>
          <tbody>${updates.history.map((item) => `<tr><td class="mono">${esc(item.name)}</td><td class="dim">${esc(item.version)}</td><td class="mono dim">${esc(item.time || '—')}</td></tr>`).join('')}</tbody>
        </table>
      </div>` : ''}
      <p class="muted" style="font-size:10px;margin-top:12px">The app reports the OS update service result; verify completion and restart status in system settings.</p>`;
  },
  init() {
    const refresh = $('#u-refresh'); if (refresh) refresh.addEventListener('click', loadUpdates);
    const install = $('#u-install'); if (install) install.addEventListener('click', installAllUpdates);
    if (!VIEWS.updates.data) loadUpdates();
  },
};

async function loadUpdates() {
  setBusy(true, 'UPDATE CHECK');
  const result = await api('updates:check');
  VIEWS.updates.data = result || { items: [], history: [], checkStatus: 'error', note: 'Update status could not be verified', rebootRequired: null };
  if (state.route === 'updates') navigate('updates');
  setBusy(false);
}

async function installAllUpdates() {
  setBusy(true, 'INSTALLING UPDATES');
  const result = await api('updates:install');
  setBusy(false);
  if (!result || result.error === 'Cancelled') return;
  toast(result.note || result.error || 'Update command finished', result.ok ? 'success' : 'error');
  if (result.ok) loadUpdates();
}

/* ============================================================ router */

function navigate(route, opts = {}) {
  const view = VIEWS[route];
  if (!view) return;
  activeTimers.forEach(clearInterval);
  activeTimers = [];
  state.route = route;
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.route === route));
  $('#view').innerHTML = view.render();
  $('#view').scrollTop = 0;
  const label = view.label || route;
  $('#crumb').innerHTML = `AEGIS <b>//</b> ${esc(label.toUpperCase())}`;
  if (route === 'files' && opts.autoJunk) filesState.autoJunk = true;
  view.init && view.init();
}

/* ------------------------------------------------------------ boot */

function injectIcons() {
  const inject = (root) => {
    root.innerHTML = root.innerHTML.replace(/__ICON_(\w+)__/g, (_m, n) => icon(n.toLowerCase()));
  };
  inject($('#nav'));
  inject($('.titlebar-right'));
  $('#brand-mark').innerHTML = LOGO;
}

function startClock() {
  const tick = () => { $('#clock').textContent = new Date().toLocaleTimeString('en-GB'); };
  tick();
  setInterval(tick, 1000);
}

async function boot() {
  injectIcons();
  startClock();
  $('#tb-min').addEventListener('click', () => IPC.minimize());
  $('#tb-max').addEventListener('click', () => IPC.toggleMaximize());
  $('#tb-close').addEventListener('click', () => IPC.close());
  $$('.nav-item').forEach((n) => n.addEventListener('click', () => navigate(n.dataset.route)));


  const info = await api('sys:info');
  if (info) {
    state.sys = info;
    $('#sb-os').textContent = (info.osCaption || info.platformLabel || 'Unknown OS') + ' · ' + String(info.arch || 'unknown').toUpperCase() + ' · ' + (info.hostname || 'unknown host');
    $('#brand-ver').textContent = 'v' + state.version;
  }
  navigate('dashboard');
}

boot();
