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

async function api(channel, payload) {
  const res = await IPC.invoke(channel, payload);
  if (!res || res.ok === false) {
    toast((res && res.error) || 'Operation failed', 'error');
    return null;
  }
  return res.data;
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
  star: '<path d="M12 3l2.7 5.8 6.3.8-4.6 4.3 1.2 6.1L12 17l-5.6 3 1.2-6.1L3 9.6l6.3-.8z"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
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
  license: { tier: 'free', key: null, since: null },
  sys: null,
  scan: null,
  version: '1.0.0',
};
const FREE_ROW_LIMIT = 8;
let activeTimers = [];
const isPro = () => state.license && state.license.tier === 'pro';

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

function confirmDialog(title, msg, danger, onYes) {
  openModal(`
    <div class="modal-head"><h3>${esc(title)}</h3><button class="modal-x" id="m-x">${icon('x')}</button></div>
    <p style="color:var(--dim);font-size:13px;line-height:1.7">${esc(msg)}</p>
    <div class="btn-row mt24">
      <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="m-ok">${danger ? 'CONFIRM' : 'CONTINUE'}</button>
      <button class="btn" id="m-cancel">CANCEL</button>
    </div>`);
  $('#m-x').onclick = closeModal;
  $('#m-cancel').onclick = closeModal;
  $('#m-ok').onclick = () => { closeModal(); onYes(); };
}

/* ------------------------------------------------------------ gating */
function gate(feature, fn) {
  if (isPro()) return fn();
  openProModal(feature);
}

function openProModal(feature) {
  openModal(`
    <div class="modal-head"><h3>AEGIS <em>PRO</em></h3><button class="modal-x" id="m-x">${icon('x')}</button></div>
    <div style="display:flex;gap:14px;align-items:flex-start">
      <div style="color:var(--amber)">${icon('lock')}</div>
      <div>
        <p style="font-size:13px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--txt)">"${esc(feature)}" is a PRO feature</p>
        <p style="color:var(--dim);font-size:12px;line-height:1.7;margin-top:8px">
          The free edition shows a limited preview. Upgrade to AEGIS PRO to unlock unlimited scans,
          one-click cleaning, application removal, auto-fixes, update installation and full reports.
        </p>
      </div>
    </div>
    <div class="tag-row mt16">
      <span class="chip">${icon('zap')} Unlimited scans</span>
      <span class="chip">${icon('trash')} Auto-clean</span>
      <span class="chip">${icon('shield')} Real-time shield</span>
      <span class="chip">${icon('star')} Priority support</span>
    </div>
    <div class="btn-row mt24">
      <button class="btn btn-primary" id="m-upgrade">VIEW PLANS — FROM $29.99</button>
      <button class="btn" id="m-key">I HAVE A KEY</button>
    </div>`, true);
  $('#m-x').onclick = closeModal;
  $('#m-upgrade').onclick = () => { closeModal(); navigate('pro'); };
  $('#m-key').onclick = () => { closeModal(); navigate('pro'); setTimeout(() => { const k = $('#key-input'); if (k) k.focus(); }, 50); };
}

function lockedRow(colspan, label) {
  return `<tr class="locked-row"><td colspan="${colspan}">
    <div class="locked-box">${icon('lock')}<span>${esc(label)}</span>
    <button class="btn btn-primary btn-sm" data-unlock>UNLOCK PRO</button></div></td></tr>`;
}

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
  const color = score >= 75 ? 'var(--green)' : score >= 50 ? 'var(--amber)' : 'var(--red)';
  let s = `<div class="gauge" style="color:${color}">`;
  for (let i = 0; i < segs; i++) s += `<i class="${i < lit ? 'on' : ''}"></i>`;
  return s + '</div>';
}

VIEWS.dashboard = {
  label: 'Dashboard',
  render() {
    if (!state.scan) {
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
    const color = sc.score >= 75 ? 'var(--green)' : sc.score >= 50 ? 'var(--amber)' : 'var(--red)';
    const cpuPct = clampPct(d.processes.reduce((a, p) => a + (p.cpu || 0), 0));
    const ramPct = s.totalRam ? clampPct((1 - s.freeRam / s.totalRam) * 100) : 0;
    const disk = (d.disks || [])[0] || {};
    const diskPct = disk.size ? clampPct((disk.used / disk.size) * 100) : 0;
    const updCount = (d.updates.items || []).length;
    const errCount = (d.errors.items || []).length;

    const statCard = (label, value, sub, pct, cls) => `
      <div class="card stat ${cls || ''}">
        <div class="stat-label">${label}</div>
        <div class="stat-value">${value}</div>
        <div class="stat-sub">${sub}</div>
        <div class="stat-bar"><i style="width:${pct}%"></i></div>
      </div>`;

    const suspRows = d.suspicious.length
      ? d.suspicious.slice(0, 6).map((p) => `
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
        <span class="badge ${updCount === 0 ? 'ok' : 'warn'}"><span class="dot"></span>UPDATES ${updCount === 0 ? 'CURRENT' : updCount + ' PENDING'}</span>
        <span class="badge ${errCount === 0 ? 'ok' : 'warn'}"><span class="dot"></span>ERRORS 24H ${errCount}</span>
        <span class="badge ${d.suspicious.length === 0 ? 'ok' : 'crit'}"><span class="dot"></span>THREATS ${d.suspicious.length}</span>
      </div>`;

    const tickerItems = [
      ...sc.findings.map((f) => `<span class="${f.sev === 'critical' ? 'crit' : ''}"><b>${f.sev.toUpperCase()}</b> ${esc(f.msg)}</span>`),
      ...d.suspicious.slice(0, 5).map((p) => `<span class="crit"><b>THREAT</b> ${esc(p.name)} — ${esc(p.flags[0] || 'anomaly')}</span>`),
      `<span><b>SCAN</b> ${fmtNum(d.junk.scanned)} files analysed · ${fmtBytes(d.junk.reclaimable)} reclaimable</span>`,
      `<span><b>NET</b> ${d.networkSummary ? d.networkSummary.connections + ' connections · ' + d.networkSummary.listening + ' listening' : 'n/a'}</span>`,
      `<span class="ok"><b>ENGINE</b> ${d.processes.length} processes profiled in ${(d.durationMs / 1000).toFixed(1)}s</span>`,
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
          </div>
        </div>
      </div>

      <div class="grid-4 mt16">
        ${statCard('CPU Load', cpuPct + '<small>%</small>', s.cpuModel.slice(0, 42), cpuPct, cpuPct >= 85 ? 'crit' : cpuPct >= 60 ? 'warn' : '')}
        ${statCard('Memory', ramPct + '<small>%</small>', fmtBytes(s.totalRam) + ' total · ' + s.cpus + ' cores', ramPct, ramPct >= 92 ? 'crit' : ramPct >= 75 ? 'warn' : '')}
        ${statCard('System Disk', diskPct + '<small>%</small>', disk.mount || '—', diskPct, diskPct >= 92 ? 'crit' : diskPct >= 80 ? 'warn' : 'ok')}
        ${statCard('Network', (d.networkSummary ? d.networkSummary.listening : 0) + '<small> ports</small>', d.networkSummary ? d.networkSummary.connections + ' active connections' : 'no data', d.networkSummary ? clampPct((d.networkSummary.listening / 40) * 100) : 0, '')}
      </div>

      <div class="sec-head"><span class="sec-sq"></span><span class="sec-title">Threat Monitor</span><span class="sec-line"></span><span class="sec-idx">REALTIME PROFILES</span></div>
      <div class="grid-2">
        <div class="card">
          <div class="card-title">${icon('warn')} Suspicious Processes</div>
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
        <button class="btn" data-act="junk">${icon('trash')} Clean Junk Files</button>
        <button class="btn" data-act="procs">${icon('chip')} Review Processes</button>
        <button class="btn" data-act="upd">${icon('download')} Check Updates</button>
        <button class="btn" data-act="audit">${icon('shield')} Security Audit</button>
      </div>

      <div class="ticker mt24"><span class="ticker-label">LIVE FEED</span><div class="ticker-track">${tickerTrack}</div></div>`;
  },
  init() {
    if (!state.scan) startQuickScan();
    $$('[data-act]').forEach((b) => b.addEventListener('click', () => {
      const act = b.dataset.act;
      if (act === 'rescan') startQuickScan();
      if (act === 'junk') gate('Junk cleaning', () => navigate('files', { autoJunk: true }));
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
    log('> computing health score ...', 'cy');
    state.scan = res;
    state.sys = res.system;
    state.scanAt = new Date().toISOString();
    setLastScan('LAST SCAN ' + new Date().toLocaleTimeString());
    log('> scan complete in ' + (res.durationMs / 1000).toFixed(1) + 's — health ' + res.score.score + '/100 (grade ' + res.score.grade + ')', 'ok');
    navigate('dashboard');
  }
  scanState.running = false;
  setBusy(false);
}

/* ---------------------------------------------------------- files */

const filesState = { result: null, busy: false };

VIEWS.files = {
  label: 'File Scanner',
  render() {
    const r = filesState.result;
    let results = '';
    if (r) {
      const free = !isPro();
      const rows = r.results.slice(0, free ? FREE_ROW_LIMIT : r.results.length);
      const dup = r.mode === 'duplicates';
      results = `
        <div class="tag-row mt16">
          <span class="chip">${icon('file')} <b>${fmtNum(r.scanned)}</b> files scanned</span>
          <span class="chip">${icon('hdd')} <b>${fmtBytes(r.bytes)}</b> read</span>
          <span class="chip">${icon('search')} <b>${r.count}</b> ${dup ? 'duplicate groups' : 'items found'}</span>
          <span class="chip">${icon('trash')} <b>${fmtBytes(r.reclaimable)}</b> reclaimable</span>
          ${r.truncated ? '<span class="badge warn"><span class="dot"></span>TRUNCATED — NARROW THE SCOPE</span>' : ''}
          <span class="chip">${icon('clock')} ${(r.durationMs / 1000).toFixed(1)}s</span>
        </div>
        <div class="table-wrap mt16">
          <table class="data">
            <thead><tr>
              ${isPro() ? '<th style="width:34px"><input type="checkbox" id="sel-all"></th>' : ''}
              <th>${dup ? 'Group' : 'Path'}</th><th>Type</th><th class="right">Size</th>${dup ? '<th class="right">Wasted</th><th class="right">Copies</th>' : ''}
            </tr></thead>
            <tbody>
              ${rows.map((x, i) => dup
                ? `<tr>
                     <td class="cell-main">${esc(x.files[0])}<span class="cell-sub">+ ${x.files.length - 1} more location(s)</span></td>
                     <td class="dim">${esc(x.kind)}</td>
                     <td class="right mono">${fmtBytes(x.size)}</td>
                     <td class="right mono" style="color:var(--amber)">${fmtBytes(x.wasted)}</td>
                     <td class="right mono">${x.count}</td>
                   </tr>`
                : `<tr>
                     ${isPro() ? `<td><input type="checkbox" class="sel" data-path="${esc(x.path)}"></td>` : ''}
                     <td class="path-cell" title="${esc(x.path)}">${esc(x.path)}</td>
                     <td class="dim">${esc(x.kind)}</td>
                     <td class="right mono">${fmtBytes(x.size)}</td>
                   </tr>`).join('')}
              ${free ? lockedRow(dup ? 5 : 3, `${r.count - FREE_ROW_LIMIT} more result(s) hidden — unlock AEGIS PRO for the full list`) : ''}
            </tbody>
          </table>
        </div>
        ${isPro() && !dup ? `
        <div class="btn-row mt16">
          <button class="btn btn-danger" id="btn-clean" disabled>${icon('trash')} Delete Selected</button>
          <span class="muted" style="font-family:var(--mono);font-size:10px;align-self:center">DELETES ARE PERMANENT — REVIEW SELECTION FIRST</span>
        </div>` : ''}`;
    }
    return `
      <div class="sec-head"><span class="sec-sq"></span><span class="sec-title">File Scanner</span><span class="sec-line"></span><span class="sec-idx">STORAGE SENSORS</span></div>
      <div class="card">
        <div class="grid-4" style="gap:14px">
          <div class="field"><label>Scan Mode</label>
            <select class="input" id="f-mode">
              <option value="junk">Junk &amp; temp files</option>
              <option value="large">Large files</option>
              <option value="duplicates">Duplicate files</option>
            </select></div>
          <div class="field"><label>Target Folder</label>
            <div style="display:flex;gap:8px">
              <input class="input" id="f-path" placeholder="Default locations" />
              <button class="btn" id="f-browse">${icon('folder')} Browse</button>
            </div></div>
          <div class="field"><label>Min Size (MB) — large mode</label>
            <input class="input" id="f-size" type="number" value="100" min="1" /></div>
          <div class="field"><label>&nbsp;</label>
            <button class="btn btn-primary" id="f-scan" style="width:100%;justify-content:center">${icon('play')} Start Scan</button></div>
        </div>
        <div id="f-progress" style="display:none;margin-top:16px">
          <div class="progress"><i></i></div>
          <div class="muted mono" style="font-size:10px;margin-top:8px" id="f-status">Sweeping filesystem…</div>
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
      $$('.sel').forEach((c) => { c.checked = selAll.checked; });
      $('#btn-clean').disabled = !selAll.checked;
    });
    $$('.sel').forEach((c) => c.addEventListener('change', () => {
      $('#btn-clean').disabled = !$$('.sel').some((x) => x.checked);
    }));
    const clean = $('#btn-clean');
    if (clean) clean.addEventListener('click', cleanSelected);
    $$('[data-unlock]').forEach((b) => b.addEventListener('click', () => openProModal('Full scan results')));
    if (filesState.autoJunk) { filesState.autoJunk = false; runFilesScan(); }
  },
};

async function runFilesScan() {
  if (filesState.busy) return;
  filesState.busy = true;
  setBusy(true, 'FILE SCAN');
  $('#f-progress').style.display = 'block';
  $('#f-scan').disabled = true;
  const statuses = ['Sweeping filesystem…', 'Hashing candidates…', 'Classifying artifacts…', 'Computing reclaimable space…'];
  let si = 0;
  const timer = setInterval(() => { si = (si + 1) % statuses.length; $('#f-status').textContent = statuses[si]; }, 900);
  activeTimers.push(timer);
  const mode = $('#f-mode').value;
  const payload = {
    mode,
    minSize: (parseInt($('#f-size').value, 10) || 100) * 1024 * 1024,
    roots: ($('#f-path').value || '').trim() ? [$('#f-path').value.trim()] : undefined,
  };
  const res = await api('scan:files', payload);
  clearInterval(timer);
  filesState.busy = false;
  setBusy(false);
  $('#f-progress').style.display = 'none';
  $('#f-scan').disabled = false;
  if (res) {
    filesState.result = res;
    VIEWS.files.render && navigate('files');
    toast(`Scan complete — ${res.count} item(s), ${fmtBytes(res.reclaimable)} reclaimable`, 'success');
  }
}

function cleanSelected() {
  const paths = $$('.sel').filter((c) => c.checked).map((c) => c.dataset.path);
  if (!paths.length) return;
  confirmDialog('Delete files', `Permanently delete ${paths.length} selected file(s)? This cannot be undone.`, true, async () => {
    setBusy(true, 'CLEANING');
    const res = await api('files:clean', { paths });
    setBusy(false);
    if (res) {
      toast(`Removed ${res.removed} file(s) — ${fmtBytes(res.bytes)} freed${res.failed ? ` (${res.failed} failed)` : ''}`, res.failed ? 'warn' : 'success');
      filesState.result = null;
      navigate('files');
    }
  });
}

/* ---------------------------------------------------------- processes */

const procState = { list: [], sortKey: 'suspicion', sortDir: -1, filter: '', auto: true };

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
      <div class="sec-head"><span class="sec-sq"></span><span class="sec-title">Process Monitor</span><span class="sec-line"></span><span class="sec-idx">LIVE PROFILES</span></div>
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
                <td><button class="btn btn-sm btn-danger" data-kill="${p.pid}" ${p.pid <= 4 ? 'disabled' : ''}>${icon('power')}</button></td>
              </tr>`;
            }).join('') || `<tr><td colspan="7" class="dim" style="text-align:center;padding:30px">NO PROCESSES LOADED — PRESS REFRESH</td></tr>`}
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
      activeTimers.push(setInterval(() => { if (state.route === 'processes') loadProcesses(true); }, 4000));
    }
    if (!procState.list.length) loadProcesses();
  },
};

function renderRowsOnly() { navigate('processes'); }

async function loadProcesses(silent = false) {
  if (!silent) setBusy(true, 'PROCESS SCAN');
  const res = await api('proc:list');
  if (res) {
    procState.list = res;
    if (state.route === 'processes') navigate('processes');
  }
  if (!silent) setBusy(false);
}

function killProcess(pid) {
  confirmDialog('End process', `Force-stop process PID ${pid}? Unsaved data in that process will be lost.`, true, async () => {
    setBusy(true, 'STOPPING PROCESS');
    const res = await api('proc:kill', { pid });
    setBusy(false);
    if (res && res.ok) { toast(`Process ${pid} terminated`, 'success'); loadProcesses(); }
    else if (res) toast(res.error || 'Could not stop process', 'error');
  });
}

/* ---------------------------------------------------------- apps */

const appsState = { list: [], filter: '', sortKey: 'name', sortDir: 1 };

VIEWS.apps = {
  label: 'Applications',
  render() {
    const q = appsState.filter.toLowerCase();
    let rows = appsState.list.filter((a) => !q || a.name.toLowerCase().includes(q) || (a.publisher || '').toLowerCase().includes(q));
    rows = [...rows].sort((a, b) => {
      const k = appsState.sortKey;
      const va = a[k] == null ? '' : a[k];
      const vb = b[k] == null ? '' : b[k];
      const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
      return cmp * appsState.sortDir;
    });
    const flagged = appsState.list.filter((a) => a.flags.some((f) => f.sev === 'high')).length;
    const th = (key, label) =>
      `<th class="sortable" data-sort="${key}">${label}${appsState.sortKey === key ? `<span class="sort-ic">${appsState.sortDir === 1 ? '▲' : '▼'}</span>` : ''}</th>`;
    return `
      <div class="sec-head"><span class="sec-sq"></span><span class="sec-title">Installed Applications</span><span class="sec-line"></span><span class="sec-idx">SOFTWARE INVENTORY</span></div>
      <div class="toolbar">
        <span class="chip">${icon('layers')} <b>${appsState.list.length}</b> applications</span>
        <span class="chip">${icon('warn')} <b>${flagged}</b> flagged</span>
        <span class="spacer"></span>
        <input class="input" id="a-filter" placeholder="Filter applications…" value="${esc(appsState.filter)}" />
        <button class="btn" id="a-refresh">${icon('refresh')} Refresh</button>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr>${th('name', 'Application')}${th('publisher', 'Publisher')}${th('version', 'Version')}${th('size', 'Size')}${th('Flags')}<th></th></tr></thead>
          <tbody>
            ${rows.slice(0, 200).map((a) => `
              <tr>
                <td class="cell-main">${esc(a.name)}</td>
                <td class="dim">${esc(a.publisher || '—')}</td>
                <td class="mono dim">${esc(a.version || '—')}</td>
                <td class="mono">${a.size ? fmtBytes(a.size) : '—'}</td>
                <td>${a.flags.length ? a.flags.map((f) => `<span class="badge ${f.sev === 'high' ? 'warn' : 'neutral'}" style="margin:1px">${esc(f.label)}</span>`).join(' ') : '<span class="badge ok"><span class="dot"></span>OK</span>'}</td>
                <td><button class="btn btn-sm" data-uninstall="${esc(a.name)}">${icon('trash')} Remove</button></td>
              </tr>`).join('') || `<tr><td colspan="6" class="dim" style="text-align:center;padding:30px">NO APPLICATIONS LOADED — PRESS REFRESH</td></tr>`}
          </tbody>
        </table>
      </div>
      <p class="muted mono mt16" style="font-size:10px;letter-spacing:.08em">REMOVAL IS A PRO FEATURE — FREE EDITION SHOWS THE FULL INVENTORY.</p>`;
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
    $$('[data-uninstall]').forEach((b) => b.addEventListener('click', () => {
      const name = b.dataset.uninstall;
      const app = appsState.list.find((a) => a.name === name);
      gate('Application removal', () => {
        confirmDialog('Remove application', `Uninstall "${name}"? The application and its files will be removed.`, true, async () => {
          setBusy(true, 'UNINSTALLING');
          const res = await api('apps:uninstall', { app });
          setBusy(false);
          if (res && res.ok) { toast(`"${name}" removed`, 'success'); loadApps(); }
          else if (res) toast(res.error || 'Uninstall failed', 'error');
        });
      });
    }));
    if (!appsState.list.length) loadApps();
  },
};

async function loadApps() {
  setBusy(true, 'APP INVENTORY');
  const res = await api('apps:list');
  if (res) { appsState.list = res; if (state.route === 'apps') navigate('apps'); }
  setBusy(false);
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
    const fw = n.firewall;
    const fwBadge = fw.enabled === true
      ? '<span class="badge ok"><span class="dot"></span>FIREWALL ACTIVE</span>'
      : fw.enabled === false
        ? '<span class="badge crit"><span class="dot"></span>FIREWALL DISABLED</span>'
        : '<span class="badge neutral"><span class="dot"></span>STATUS UNKNOWN</span>';
    const listenChips = n.net.listening.slice(0, 60).map((c) =>
      `<span class="chip" title="${esc(c.local)}">${icon('wifi')} <b>${esc((c.local || '').split(':').pop())}</b> ${esc(c.process || c.proto)}</span>`).join('');
    return `
      <div class="sec-head"><span class="sec-sq"></span><span class="sec-title">Network</span><span class="sec-line"></span><span class="sec-idx">CONNECTION MAPPING</span></div>
      <div class="grid-2">
        <div class="card tick">
          <div class="card-title">${icon('shield')} Firewall Status</div>
          <div style="display:flex;align-items:center;gap:16px">
            <div style="font-size:34px;font-weight:700;color:${fw.enabled === true ? 'var(--green)' : fw.enabled === false ? 'var(--red)' : 'var(--dim)'}">${fw.enabled === true ? 'PROTECTED' : fw.enabled === false ? 'EXPOSED' : 'UNKNOWN'}</div>
            ${fwBadge}
          </div>
          <p class="mono muted mt16" style="font-size:10.5px;line-height:1.8">${esc(fw.details)}</p>
          <div class="tag-row mt16">
            ${fw.profiles.map((p) => `<span class="badge ${p.enabled ? 'ok' : 'crit'}"><span class="dot"></span>${esc(p.name)}: ${p.enabled ? 'ON' : 'OFF'}</span>`).join('')}
          </div>
          <div class="btn-row mt16">
            ${fw.enabled === false ? `<button class="btn btn-primary" id="n-fwfix">${icon('shield')} Enable Firewall</button>` : ''}
            <button class="btn" id="n-refresh">${icon('refresh')} Refresh</button>
          </div>
        </div>
        <div class="card">
          <div class="card-title">${icon('globe')} Listening Ports <span class="muted" style="letter-spacing:.05em">(${n.net.listening.length})</span></div>
          <div class="tag-row" style="max-height:190px;overflow-y:auto">${listenChips || '<span class="muted" style="font-size:11px">No listening ports detected</span>'}</div>
        </div>
      </div>
      <div class="sec-head"><span class="sec-sq"></span><span class="sec-title">Active Connections</span><span class="sec-line"></span><span class="sec-idx">${n.net.connections.length} TOTAL</span></div>
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
    if (fix) fix.addEventListener('click', () => gate('Automatic firewall repair', enableFirewallNow));
    const f = $('#n-filter');
    if (f) f.addEventListener('input', (e) => renderConnections(e.target.value));
    renderConnections('');
    if (!VIEWS.network.data) loadNetwork();
  },
  data: null,
};

function renderConnections(q) {
  const n = VIEWS.network.data;
  const tbody = $('#n-tbody');
  if (!n || !tbody) return;
  const qq = (q || '').toLowerCase();
  const rows = n.net.connections.filter((c) =>
    !qq || c.local.toLowerCase().includes(qq) || c.remote.toLowerCase().includes(qq) || (c.process || '').toLowerCase().includes(qq));
  tbody.innerHTML = rows.slice(0, 400).map((c) => {
    const st = /LISTEN/i.test(c.state)
      ? '<span class="badge info"><span class="dot"></span>LISTEN</span>'
      : /ESTABLISHED/i.test(c.state)
        ? '<span class="badge ok"><span class="dot"></span>ESTABLISHED</span>'
        : `<span class="badge neutral"><span class="dot"></span>${esc(c.state || '—')}</span>`;
    return `<tr>
      <td class="mono"><b>${esc(c.proto)}</b></td>
      <td class="mono">${esc(c.local)}</td>
      <td class="mono dim">${esc(c.remote)}</td>
      <td>${st}</td>
      <td class="cell-main">${esc(c.process || '—')}</td>
      <td class="mono dim">${c.pid || '—'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="dim" style="text-align:center;padding:24px">NO CONNECTIONS MATCH</td></tr>';
}

async function loadNetwork() {
  setBusy(true, 'NETWORK SCAN');
  const [net, firewall] = await Promise.all([api('net:list'), api('fw:status')]);
  if (net && firewall) {
    VIEWS.network.data = { net, firewall };
    if (state.route === 'network') navigate('network');
    setTimeout(() => renderConnections($('#n-filter') ? $('#n-filter').value : ''), 30);
  }
  setBusy(false);
}

async function enableFirewallNow() {
  setBusy(true, 'REPAIRING');
  const res = await api('fw:enable');
  setBusy(false);
  if (res && res.ok) { toast('Firewall enabled', 'success'); loadNetwork(); }
  else if (res) toast(res.error || 'Could not enable the firewall', 'error');
}

/* ---------------------------------------------------------- audit */

VIEWS.audit = {
  label: 'Security Audit',
  data: null,
  render() {
    const a = VIEWS.audit.data;
    if (!a) {
      return `
        <div class="sec-head"><span class="sec-sq"></span><span class="sec-title">Security Audit</span><span class="sec-line"></span></div>
        <div class="card tick" style="max-width:640px">
          <div class="card-title">${icon('shield')} Automated Security Audit</div>
          <p class="muted" style="font-size:12.5px;line-height:1.75">Run a full audit: firewall posture, disk encryption, update freshness, recent system errors, suspicious processes, disk pressure and exposed listening ports.</p>
          <div class="btn-row mt16">
            <button class="btn btn-primary" id="au-run">${icon('play')} Run Full Audit</button>
          </div>
        </div>`;
    }
    const overall = a.items.filter((i) => i.status === 'crit').length === 0 && a.items.filter((i) => i.status === 'warn').length === 0;
    const rows = a.items.map((i) => `
      <div class="audit-item ${i.status}">
        ${icon(i.status === 'ok' ? 'check' : i.status === 'warn' ? 'warn' : 'x')}
        <div class="ai-body">
          <div class="ai-title">${esc(i.title)}</div>
          <div class="ai-sub">${esc(i.detail)}</div>
        </div>
        ${i.actionLabel ? `<button class="btn btn-sm ${i.actionDanger ? 'btn-danger' : ''}" data-au="${i.action}">${esc(i.actionLabel)}</button>` : ''}
      </div>`).join('');
    return `
      <div class="sec-head"><span class="sec-sq"></span><span class="sec-title">Security Audit</span><span class="sec-line"></span><span class="sec-idx">${a.at}</span></div>
      <div class="card tick hatch" style="display:flex;align-items:center;gap:18px;margin-bottom:16px">
        ${icon(overall ? 'check' : 'warn', 'sev-ic ' + (overall ? 'ok' : 'high'))}
        <div>
          <div style="font-size:15px;font-weight:700;letter-spacing:.14em;text-transform:uppercase">${overall ? 'System posture: SOLID' : 'Issues require attention'}</div>
          <div class="mono muted" style="font-size:10.5px;margin-top:4px">${a.items.filter((i) => i.status !== 'ok').length} finding(s) · ${a.items.length} checks · completed in ${a.ms}ms</div>
        </div>
        <span class="spacer"></span>
        <button class="btn" id="au-again">${icon('refresh')} Re-run</button>
        <button class="btn btn-primary" id="au-export">${icon('download')} Export Report</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:10px">${rows}</div>`;
  },
  init() {
    const run = $('#au-run'); if (run) run.addEventListener('click', runAudit);
    const again = $('#au-again'); if (again) again.addEventListener('click', runAudit);
    const exp = $('#au-export'); if (exp) exp.addEventListener('click', () => gate('Report export', exportReport));
    $$('[data-au]').forEach((b) => b.addEventListener('click', () => auditAction(b.dataset.au)));
  },
};

async function runAudit() {
  setBusy(true, 'AUDIT');
  const t0 = Date.now();
  const [firewall, encryption, updates, errors, procs, disks, net] = await Promise.all([
    api('fw:status'), api('enc:status'), api('updates:check'), api('errors:list'), api('proc:list'), api('disk:usage'), api('net:list'),
  ]);
  const susp = (procs || []).filter((p) => p.suspicion >= 30);
  const disk = (disks || [])[0] || {};
  const diskPct = disk.size ? (disk.used / disk.size) * 100 : 0;
  const errs = (errors && errors.items) || [];
  const upd = (updates && updates.items) || [];
  const items = [
    {
      title: 'Firewall active', status: firewall && firewall.enabled === true ? 'ok' : 'crit',
      detail: firewall ? firewall.details : 'no data',
      action: firewall && firewall.enabled === false ? 'fw' : null, actionLabel: firewall && firewall.enabled === false ? 'Enable now' : null, actionDanger: false,
    },
    {
      title: 'Disk encryption', status: encryption && encryption.enabled === true ? 'ok' : encryption && encryption.enabled === false ? 'warn' : 'warn',
      detail: encryption ? encryption.details : 'no data',
      action: 'enc', actionLabel: 'How to enable', actionDanger: false,
    },
    {
      title: 'System updates', status: upd.length === 0 && !(updates && updates.rebootRequired) ? 'ok' : 'warn',
      detail: upd.length ? upd.length + ' pending update(s)' : (updates && updates.note) || 'up to date',
      action: 'upd', actionLabel: upd.length ? 'Review updates' : null, actionDanger: false,
    },
    {
      title: 'System errors (24h)', status: errs.length === 0 ? 'ok' : 'warn',
      detail: errs.length ? errs.length + ' error event(s) in the last 24 hours' : 'no errors logged',
      action: 'err', actionLabel: errs.length ? 'Inspect logs' : null, actionDanger: false,
    },
    {
      title: 'Suspicious processes', status: susp.length === 0 ? 'ok' : 'crit',
      detail: susp.length ? susp.map((p) => p.name + ' (risk ' + p.suspicion + ')').join(', ') : 'no suspicious processes running',
      action: 'proc', actionLabel: susp.length ? 'Review processes' : null, actionDanger: true,
    },
    {
      title: 'Disk space', status: diskPct < 85 ? 'ok' : diskPct < 92 ? 'warn' : 'crit',
      detail: disk.mount ? disk.mount + ' — ' + diskPct.toFixed(0) + '% used (' + fmtBytes(disk.free) + ' free)' : 'no data',
      action: 'disk', actionLabel: 'Find large files', actionDanger: false,
    },
    {
      title: 'Exposed listening ports', status: net && net.listening.length <= 10 ? 'ok' : 'warn',
      detail: net ? net.listening.length + ' listening port(s) — review services that accept external connections' : 'no data',
      action: 'net', actionLabel: 'Inspect network', actionDanger: false,
    },
  ];
  VIEWS.audit.data = { items, at: new Date().toLocaleString(), ms: Date.now() - t0, raw: { firewall, encryption, updates, errors, susp, disk, disks, net } };
  if (state.route === 'audit') navigate('audit');
  setBusy(false);
}

function auditAction(act) {
  if (act === 'fw') gate('Automatic firewall repair', enableFirewallNow);
  if (act === 'upd') navigate('updates');
  if (act === 'proc') navigate('processes');
  if (act === 'disk') { filesState.result = null; navigate('files'); setTimeout(() => { $('#f-mode').value = 'large'; }, 30); }
  if (act === 'net') navigate('network');
  if (act === 'err') {
    const errs = (VIEWS.audit.data.raw.errors.items || []).slice(0, 40)
      .map((e) => `<div class="list-row"><div class="lr-body"><div class="lr-title" style="font-family:var(--mono);font-size:10.5px">${esc(e.time)} · ${esc(e.source)}</div><div class="lr-sub">${esc(e.message)}</div></div></div>`).join('');
    openModal(`<div class="modal-head"><h3>System <em>Errors</em> — 24h</h3><button class="modal-x" id="m-x">${icon('x')}</button></div>${errs || '<p class="muted">No errors logged.</p>'}`, true);
    $('#m-x').onclick = closeModal;
  }
  if (act === 'enc') {
    const osLabel = state.sys ? state.sys.platformLabel : 'your OS';
    openModal(`
      <div class="modal-head"><h3>Enable <em>Encryption</em></h3><button class="modal-x" id="m-x">${icon('x')}</button></div>
      <div style="color:var(--dim);font-size:12.5px;line-height:1.8">
        <p><b style="color:var(--txt)">Windows:</b> enable BitLocker — Settings → Privacy &amp; Security → Device encryption, or run <span class="mono" style="color:var(--cyan)">manage-bde -on C:</span> as Administrator.</p>
        <p style="margin-top:10px"><b style="color:var(--txt)">macOS:</b> System Settings → Privacy &amp; Security → FileVault → Turn On.</p>
        <p style="margin-top:10px"><b style="color:var(--txt)">Linux:</b> install with full-disk LUKS, or add a encrypted home/crypt container with <span class="mono" style="color:var(--cyan)">cryptsetup</span>.</p>
      </div>
      <div class="btn-row mt24"><button class="btn btn-primary" id="m-ok">GOT IT</button></div>`);
    $('#m-x').onclick = closeModal;
    $('#m-ok').onclick = closeModal;
  }
}

async function exportReport() {
  const a = VIEWS.audit.data;
  if (!a) return;
  const report = {
    app: 'AEGIS Sentinel', version: state.version, generatedAt: new Date().toISOString(),
    system: state.sys || (state.scan && state.scan.system),
    health: state.scan && state.scan.score,
    audit: a.items.map(({ title, status, detail }) => ({ title, status, detail })),
    raw: a.raw,
  };
  setBusy(true, 'EXPORTING');
  const res = await api('report:save', report);
  setBusy(false);
  if (res) toast('Report exported: ' + res, 'success');
}

/* ---------------------------------------------------------- updates */

VIEWS.updates = {
  label: 'Updates',
  data: null,
  render() {
    const u = VIEWS.updates.data;
    if (!u) {
      return `
        <div class="sec-head"><span class="sec-sq"></span><span class="sec-title">System Updates</span><span class="sec-line"></span></div>
        <div class="card" style="display:flex;gap:16px;align-items:center">
          <span class="spinner"></span><span class="muted" style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;font-weight:600">Checking for updates…</span>
        </div>`;
    }
    const items = u.items || [];
    const rows = items.length
      ? items.slice(0, 200).map((x) => `<tr>
          <td class="cell-main">${esc(x.name)}</td>
          <td class="mono dim">${esc(x.version || '—')}</td>
          <td class="dim">${esc(x.source || '')}</td>
          <td class="mono right">${x.size ? fmtBytes(x.size) : '—'}</td>
        </tr>`).join('')
      : '<tr><td colspan="4"><div class="empty">' + icon('check') + '<p>System is up to date</p></div></td></tr>';
    return `
      <div class="sec-head"><span class="sec-sq"></span><span class="sec-title">System Updates</span><span class="sec-line"></span><span class="sec-idx">PATCH MANAGEMENT</span></div>
      <div class="grid-3">
        <div class="card stat"><div class="stat-label">Pending Updates</div><div class="stat-value">${items.length}</div><div class="stat-sub">${esc(u.note || '')}</div></div>
        <div class="card stat"><div class="stat-label">Last Installed</div><div class="stat-value" style="font-size:22px">${u.lastInstalled ? esc(u.lastInstalled) : 'n/a'}</div><div class="stat-sub">most recent patch</div></div>
        <div class="card stat ${u.rebootRequired ? 'warn' : 'ok'}"><div class="stat-label">Restart</div><div class="stat-value" style="font-size:22px">${u.rebootRequired ? 'REQUIRED' : 'NOT REQUIRED'}</div><div class="stat-sub">to finish updates</div></div>
      </div>
      <div class="btn-row mt16">
        <button class="btn" id="u-refresh">${icon('refresh')} Re-check</button>
        <button class="btn btn-primary" id="u-install">${icon('download')} Install All Updates</button>
      </div>
      <div class="sec-head"><span class="sec-sq"></span><span class="sec-title">Available Updates</span><span class="sec-line"></span></div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>Update</th><th>Version / KB</th><th>Source</th><th class="right">Size</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${u.history && u.history.length ? `
      <div class="sec-head"><span class="sec-sq"></span><span class="sec-title">Recent Update History</span><span class="sec-line"></span></div>
      <div class="table-wrap" style="max-height:240px">
        <table class="data">
          <thead><tr><th>HotFix</th><th>Description</th><th>Installed</th></tr></thead>
          <tbody>${u.history.map((h) => `<tr><td class="mono">${esc(h.name)}</td><td class="dim">${esc(h.version)}</td><td class="mono dim">${esc(h.time || '—')}</td></tr>`).join('')}</tbody>
        </table>
      </div>` : ''}`;
  },
  init() {
    const r = $('#u-refresh'); if (r) r.addEventListener('click', loadUpdates);
    const i = $('#u-install'); if (i) i.addEventListener('click', () => gate('Automatic update installation', installAllUpdates));
    if (!VIEWS.updates.data) loadUpdates();
  },
};

async function loadUpdates() {
  setBusy(true, 'UPDATE CHECK');
  const res = await api('updates:check');
  if (res) { VIEWS.updates.data = res; if (state.route === 'updates') navigate('updates'); }
  setBusy(false);
}

async function installAllUpdates() {
  confirmDialog('Install updates', 'Start the operating system update installation now? A restart may be required afterwards.', false, async () => {
    setBusy(true, 'UPDATING');
    const res = await api('updates:install');
    setBusy(false);
    if (res) toast(res.note || 'Update process started', res.ok ? 'success' : 'warn');
  });
}

/* ---------------------------------------------------------- pro */

VIEWS.pro = {
  label: 'AEGIS PRO',
  render() {
    if (isPro()) {
      return `
        <div class="sec-head"><span class="sec-sq"></span><span class="sec-title">License</span><span class="sec-line"></span></div>
        <div class="card tick" style="max-width:640px">
          <div class="card-title">${icon('check')} AEGIS PRO — ACTIVE</div>
          <div class="stat-value" style="font-size:26px">ALL MODULES UNLOCKED</div>
          <p class="mono muted mt16" style="font-size:11px;line-height:1.9">
            LICENSE KEY: <b style="color:var(--green)">${esc(state.license.key)}</b><br>
            ACTIVATED: ${esc(state.license.since || '—')}<br>
            TIER: PRO · PERPETUAL LICENSE
          </p>
          <div class="btn-row mt24"><button class="btn btn-danger" id="pr-deact">DEACTIVATE LICENSE</button></div>
        </div>`;
    }
    return `
      <div class="pro-hero hatch">
        <div class="hatch-bg"><svg viewBox="0 0 100 100" fill="none" stroke="rgba(31,224,255,.25)" stroke-width="1">
          <path d="M50 5 95 30v40L50 95 5 70V30z"/><path d="M50 20 80 37v26L50 80 20 63V37z"/><path d="M50 35 65 44v12L50 65 35 56V44z"/>
        </svg></div>
        <h1>AEGIS <em>PRO</em></h1>
        <p>The full system command center. Unlimited scans, one-click repair, application removal,
        automatic updates, real-time shields and priority support — on Windows, macOS and Linux.</p>
        <div class="btn-row mt24">
          <a href="#plans" style="text-decoration:none"><button class="btn btn-primary">SEE PLANS</button></a>
          <button class="btn" id="pr-key-btn">I HAVE A KEY</button>
        </div>
      </div>

      <div class="sec-head"><span class="sec-sq"></span><span class="sec-title">Why Go Pro</span><span class="sec-line"></span></div>
      <div class="feat-grid">
        ${[['zap', 'Unlimited Scans', 'Full-depth filesystem sweeps with no result caps or daily limits.'],
          ['trash', 'One-Click Cleaning', 'Select and permanently remove junk, duplicates and large files in bulk.'],
          ['layers', 'App Removal', 'Uninstall applications directly from the inventory — no control panel needed.'],
          ['download', 'Auto-Update', 'Install missing OS updates from inside the app, on your schedule.'],
          ['shield', 'Real-Time Shield', 'Watch processes, ports and startup items as they change.'],
          ['star', 'Priority Support', 'Direct line to the AEGIS engineering team, 24/7.']]
        .map(([ic, t, d]) => `<div class="feat">${icon(ic)}<h4>${t}</h4><p>${d}</p></div>`).join('')}
      </div>

      <div class="sec-head" id="plans"><span class="sec-sq"></span><span class="sec-title">Plans</span><span class="sec-line"></span><span class="sec-idx">DEMO CHECKOUT — NO REAL PAYMENT</span></div>
      <div class="grid-2" style="max-width:900px">
        <div class="card price-card tick selected" data-plan="pro" data-price="29.99" data-name="AEGIS PRO — 1 DEVICE">
          <div class="card-title">PRO · SINGLE DEVICE</div>
          <div class="price">$29.99 <small>one-time</small></div>
          <div class="muted" style="font-size:11px;letter-spacing:.08em">PERPETUAL LICENSE · 1 PC/MAC</div>
          <ul>
            <li>${icon('check')} All PRO modules unlocked</li>
            <li>${icon('check')} Lifetime updates for v1.x</li>
            <li>${icon('check')} 1 device activation</li>
            <li>${icon('check')} Email support</li>
          </ul>
        </div>
        <div class="card price-card" data-plan="team" data-price="79.99" data-name="AEGIS PRO — 5 DEVICES">
          <div class="card-title">PRO · TEAM / FAMILY</div>
          <div class="price">$79.99 <small>one-time</small></div>
          <div class="muted" style="font-size:11px;letter-spacing:.08em">PERPETUAL LICENSE · 5 DEVICES</div>
          <ul>
            <li>${icon('check')} Everything in PRO</li>
            <li>${icon('check')} 5 device activations</li>
            <li>${icon('check')} Central license management</li>
            <li>${icon('check')} Priority 24/7 support</li>
          </ul>
        </div>
      </div>

      <div class="sec-head"><span class="sec-sq"></span><span class="sec-title">Checkout</span><span class="sec-line"></span></div>
      <div class="card" style="max-width:900px">
        <div class="grid-2" style="gap:14px">
          <div class="field"><label>Full Name</label><input class="input" id="ck-name" placeholder="Alex Martin" /></div>
          <div class="field"><label>Email</label><input class="input" id="ck-email" placeholder="alex@studio.com" /></div>
          <div class="field"><label>Card Number</label><input class="input" id="ck-card" inputmode="numeric" placeholder="4242 4242 4242 4242" maxlength="19" /></div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
            <div class="field"><label>Expiry (MM/YY)</label><input class="input" id="ck-exp" placeholder="08/28" maxlength="5" /></div>
            <div class="field"><label>CVC</label><input class="input" id="ck-cvc" inputmode="numeric" placeholder="123" maxlength="4" /></div>
          </div>
        </div>
        <div class="btn-row mt24">
          <button class="btn btn-primary" id="ck-pay">${icon('lock')} Pay $29.99 &amp; Activate</button>
          <span class="muted mono" style="font-size:10px;align-self:center">DEMO MODE — NO REAL CHARGE. ANY VALID-LOOKING CARD WORKS.</span>
        </div>
      </div>

      <div class="sec-head"><span class="sec-sq"></span><span class="sec-title">Activate a License Key</span><span class="sec-line"></span></div>
      <div class="card" style="max-width:900px">
        <div style="display:flex;gap:10px">
          <input class="input" id="key-input" placeholder="AEGIS-XXXX-XXXX-XXXX-XXXX" style="max-width:340px" />
          <button class="btn btn-primary" id="key-activate">ACTIVATE</button>
        </div>
      </div>`;
  },
  init() {
    if (isPro()) {
      $('#pr-deact').addEventListener('click', () => {
        confirmDialog('Deactivate license', 'Return AEGIS Sentinel to the FREE edition on this machine?', false, async () => {
          await api('license:set', { tier: 'free', key: null, since: null });
          state.license = { tier: 'free', key: null, since: null };
          refreshLicenseUI();
          toast('License deactivated — FREE edition active', 'warn');
          navigate('pro');
        });
      });
      return;
    }
    let plan = { price: '29.99', name: 'AEGIS PRO — 1 DEVICE' };
    $$('.price-card').forEach((c) => c.addEventListener('click', () => {
      $$('.price-card').forEach((x) => x.classList.remove('selected'));
      c.classList.add('selected');
      plan = { price: c.dataset.price, name: c.dataset.name };
      $('#ck-pay').innerHTML = `${icon('lock')} Pay $${plan.price} &amp; Activate`;
    }));
    $('#ck-card').addEventListener('input', (e) => {
      const d = e.target.value.replace(/\D/g, '').slice(0, 16);
      e.target.value = d.replace(/(.{4})/g, '$1 ').trim();
    });
    $('#ck-exp').addEventListener('input', (e) => {
      let d = e.target.value.replace(/\D/g, '').slice(0, 4);
      if (d.length >= 3) d = d.slice(0, 2) + '/' + d.slice(2);
      e.target.value = d;
    });
    $('#ck-pay').addEventListener('click', () => {
      const name = $('#ck-name').value.trim();
      const email = $('#ck-email').value.trim();
      const card = $('#ck-card').value.replace(/\D/g, '');
      const exp = $('#ck-exp').value;
      const cvc = $('#ck-cvc').value;
      if (name.length < 2) return toast('Enter the cardholder name', 'warn');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return toast('Enter a valid email address', 'warn');
      if (card.length !== 16) return toast('Card number must be 16 digits', 'warn');
      if (!/^\d{2}\/\d{2}$/.test(exp)) return toast('Expiry must be MM/YY', 'warn');
      if (!/^\d{3,4}$/.test(cvc)) return toast('CVC must be 3-4 digits', 'warn');
      const rnd = () => Array.from(crypto.getRandomValues(new Uint8Array(4))).map((b) => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[b % 31]).join('');
      const key = `AEGIS-${rnd()}-${rnd()}-${rnd()}-${rnd()}`;
      activateLicense(key);
    });
    $('#key-activate').addEventListener('click', () => {
      const v = $('#key-input').value.trim().toUpperCase();
      if (!/^AEGIS-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(v)) {
        return toast('Invalid key format — expected AEGIS-XXXX-XXXX-XXXX-XXXX', 'error');
      }
      activateLicense(v);
    });
    $('#pr-key-btn').addEventListener('click', () => { const k = $('#key-input'); if (k) k.focus(); });
  },
};

async function activateLicense(key) {
  const license = { tier: 'pro', key, since: new Date().toISOString() };
  const saved = await api('license:set', license);
  if (saved) {
    state.license = saved;
    refreshLicenseUI();
    toast('AEGIS PRO activated — all modules unlocked', 'success');
    navigate('pro');
  }
}

function refreshLicenseUI() {
  const chip = $('#lic-chip');
  const label = $('#lic-label');
  if (isPro()) {
    chip.classList.add('pro');
    label.textContent = 'PRO — LICENSED';
  } else {
    chip.classList.remove('pro');
    label.textContent = 'FREE EDITION';
  }
}

/* ============================================================ router */

function navigate(route, opts = {}) {
  activeTimers.forEach(clearInterval);
  activeTimers = [];
  state.route = route;
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.route === route));
  const view = VIEWS[route];
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
  inject($('.nav-foot'));
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
  $('#tb-min').addEventListener('click', () => IPC.invoke('win:minimize'));
  $('#tb-max').addEventListener('click', () => IPC.invoke('win:toggleMax'));
  $('#tb-close').addEventListener('click', () => IPC.invoke('win:close'));
  $$('.nav-item').forEach((n) => n.addEventListener('click', () => navigate(n.dataset.route)));

  const lic = await api('license:get');
  if (lic) { state.license = lic; refreshLicenseUI(); }

  const info = await api('sys:info');
  if (info) {
    state.sys = info;
    $('#sb-os').textContent = (info.osCaption || info.platformLabel) + ' · ' + info.arch.toUpperCase() + ' · ' + info.hostname;
    $('#brand-ver').textContent = 'v' + state.version;
  }
  navigate('dashboard');
}

boot();
