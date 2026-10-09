'use strict';
/* Headless smoke test: boots the real renderer in jsdom with a stubbed IPC bridge,
 * walks every route, and exercises the freemium / checkout flows. */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const errors = [];

const sysInfo = {
  hostname: 'testbox', platform: 'linux', platformLabel: 'Linux', arch: 'x64',
  release: '6.1.0', cpus: 8, cpuModel: 'Test CPU x8', totalRam: 16 * 1024 ** 3,
  freeRam: 8 * 1024 ** 3, uptimeSec: 3600, user: 'tester', homedir: '/home/tester',
  osCaption: 'Debian GNU/Linux 13', osBuild: '1', machineModel: 'TestBox', gpu: 'Test GPU',
};
const procClean = { pid: 1, name: 'init', cpu: 0.2, memBytes: 2048, path: '/sbin/init', company: 'systemd', product: '', suspicion: 0, suspicionLevel: 'clean', flags: [] };
const procBad = { pid: 99, name: 'xmrig', cpu: 95, memBytes: 500 * 1024 ** 2, path: '/tmp/xmrig', company: '', product: '', suspicion: 95, suspicionLevel: 'critical', flags: ['Name matches a known cryptominer signature', 'Executable located in a temporary directory'] };
const scanQuick = {
  system: sysInfo,
  disks: [{ device: '/dev/sda', mount: '/', label: '/', size: 100 * 1024 ** 3, used: 40 * 1024 ** 3, free: 60 * 1024 ** 3 }],
  processes: [procClean, procBad],
  suspicious: [procBad],
  firewall: { enabled: true, profiles: [{ name: 'ufw', enabled: true }], details: 'ufw active' },
  encryption: { enabled: true, details: 'LUKS encrypted volume detected' },
  updates: { items: [], history: [], lastInstalled: '2026-10-01', daysSinceLastUpdate: 8, rebootRequired: false, note: 'up to date' },
  errors: { items: [{ time: '2026-10-09 10:00', source: 'kernel', id: '', message: 'test error event' }], window: '24h' },
  networkSummary: { connections: 12, listening: 3 },
  junk: { scanned: 1000, reclaimable: 5 * 1024 ** 3, count: 42, truncated: false },
  score: { score: 88, grade: 'A', findings: [{ sev: 'warning', msg: '1 system error(s) in the last 24h', pts: 1 }] },
  durationMs: 1200,
};

const canned = {
  'license:get': { tier: 'free', key: null, since: null },
  'license:set': (p) => p,
  'sys:info': sysInfo,
  'scan:quick': scanQuick,
  'proc:list': [procClean, procBad],
  'apps:list': [
    { name: 'Firefox', version: '130.0', publisher: 'Mozilla', size: 200 * 1024 ** 2, flags: [], uninstallString: '', package: 'firefox', path: '' },
    { name: 'Super Toolbar Free', version: '1.0', publisher: '', size: 0, flags: [{ label: 'Possible bloatware', sev: 'high' }], uninstallString: '', package: '', path: '' },
  ],
  'net:list': {
    connections: [
      { proto: 'TCP', local: '0.0.0.0:22', remote: '0.0.0.0:*', state: 'LISTEN', pid: 900, process: 'sshd' },
      { proto: 'TCP', local: '10.0.0.2:51234', remote: '1.2.3.4:443', state: 'ESTABLISHED', pid: 901, process: 'firefox' },
    ],
    listening: [{ proto: 'TCP', local: '0.0.0.0:22', remote: '', state: 'LISTEN', pid: 900, process: 'sshd' }],
  },
  'fw:status': { enabled: true, profiles: [{ name: 'ufw', enabled: true }], details: 'ufw active' },
  'fw:enable': { ok: true, error: null },
  'enc:status': { enabled: true, details: 'LUKS encrypted volume detected' },
  'updates:check': { items: [{ name: 'openssl', version: '3.0.15', source: 'apt (stable)' }], history: [], lastInstalled: '2026-10-01', daysSinceLastUpdate: 8, rebootRequired: false, note: '1 package update available' },
  'updates:install': { ok: true, note: 'started' },
  'errors:list': { items: [{ time: '2026-10-09 10:00', source: 'kernel', id: '', message: 'test error event' }], window: '24h' },
  'disk:usage': [{ device: '/dev/sda', mount: '/', label: '/', size: 100 * 1024 ** 3, used: 40 * 1024 ** 3, free: 60 * 1024 ** 3 }],
  'scan:files': {
    mode: 'junk', roots: ['/tmp'], scanned: 10, bytes: 4096, truncated: false, durationMs: 50,
    count: 12, reclaimable: 2048,
    results: Array.from({ length: 12 }, (_, i) => ({ path: '/tmp/junk-' + i + '.log', size: 100 + i, kind: 'Log file' })),
  },
  'files:clean': { removed: 3, failed: 0, bytes: 300 },
  'proc:kill': { ok: true, error: null },
  'apps:uninstall': { ok: true, error: null },
  'dialog:pickDir': null,
  'report:save': '/tmp/aegis-report.json',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond) => {
  console.log((cond ? '  PASS ' : '  FAIL ') + name);
  if (!cond) failures++;
};

(async () => {
  let html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  html = html.replace('<script src="./renderer.js"></script>', '');

  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push('jsdomError: ' + e.message));
  vc.on('error', (m) => errors.push('console.error: ' + m));

  const dom = new JSDOM(html, {
    url: 'file://' + path.join(ROOT, 'src', 'index.html'),
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const { window } = dom;
  window.addEventListener('error', (e) => errors.push('window.onerror: ' + e.message));
  process.on('uncaughtException', (e) => errors.push('uncaught: ' + (e && e.stack || e)));

  // stub the IPC bridge before the renderer boots
  window.aegis = {
    invoke: (channel, payload) => {
      const v = canned[channel];
      if (v === undefined) return Promise.resolve({ ok: false, error: 'unknown channel ' + channel });
      return Promise.resolve({ ok: true, data: typeof v === 'function' ? v(payload) : v });
    },
    on: () => () => {},
  };

  const rendererSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer.js'), 'utf8');
  window.eval(rendererSrc);

  const $ = (s) => window.document.querySelector(s);
  const $$ = (s) => [...window.document.querySelectorAll(s)];
  const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const navTo = async (route) => {
    const btn = $(`.nav-item[data-route="${route}"]`);
    click(btn);
    await sleep(450);
  };

  console.log('== boot & dashboard ==');
  await sleep(1800); // boot + first quick scan (has ~0.7s of staged console sleeps)
  check('dashboard renders system overview', $('#view').innerHTML.includes('System Overview'));
  check('health score 88 rendered', $('#view').innerHTML.includes('88'));
  check('grade A rendered', $('#view').innerHTML.includes('GRADE A'));
  check('suspicious process xmrig listed', $('#view').innerHTML.includes('xmrig'));
  check('gauge has 25 segments', $$('.gauge i').length === 25);
  check('live ticker present', $$('.ticker-track span').length > 10);
  check('statusbar shows OS', $('#sb-os').textContent.includes('Debian'));
  check('license chip = FREE', $('#lic-label').textContent.includes('FREE'));

  console.log('== route tour ==');
  await navTo('files');
  check('files view renders', $('#view').innerHTML.includes('File Scanner'));
  await navTo('processes');
  check('processes view renders rows', $$('#view table.data tbody tr').length >= 2);
  check('suspicious row flagged critical', $('#view').innerHTML.includes('row-crit'));
  await navTo('apps');
  check('apps view renders rows', $$('#view table.data tbody tr').length === 2);
  check('bloatware flag shown', $('#view').innerHTML.includes('Possible bloatware'));
  await navTo('network');
  check('network view renders firewall card', $('#view').innerHTML.includes('Firewall Status'));
  check('listening port chip 22 shown', $('#view').innerHTML.includes('sshd'));
  check('connections table rendered', $$('#n-tbody tr').length === 2);
  await navTo('updates');
  check('updates view renders pending item', $('#view').innerHTML.includes('openssl'));
  await navTo('audit');
  check('audit view shows run button', !!$('#au-run'));
  await navTo('pro');
  check('pro view renders pricing', $('#view').innerHTML.includes('$29.99') && $('#view').innerHTML.includes('$79.99'));

  console.log('== freemium gating ==');
  await navTo('dashboard');
  click($('[data-act="junk"]'));
  await sleep(200);
  check('gated action opens PRO modal', $('#modal-root').innerHTML.includes('PRO feature'));
  click($('#modal-bg'));
  await sleep(150);
  check('modal closes', $('#modal-root').innerHTML === '');

  await navTo('files');
  click($('#f-scan'));
  await sleep(900);
  const fileRows = $$('#view table.data tbody tr');
  check('free scan shows only 8 rows + locked row', fileRows.length === 9);
  check('locked row present', $('#view').innerHTML.includes('UNLOCK PRO'));
  click($('[data-unlock]'));
  await sleep(200);
  check('unlock opens PRO modal', $('#modal-root').innerHTML.includes('PRO'));
  click($('#modal-bg'));

  console.log('== audit ==');
  await navTo('audit');
  click($('#au-run'));
  await sleep(900);
  check('audit produced 7 checks', $$('.audit-item').length === 7);
  check('audit shows suspicious process finding', $('#view').innerHTML.includes('xmrig'));

  console.log('== checkout (demo) ==');
  await navTo('pro');
  $('#ck-name').value = 'Alex Martin';
  $('#ck-email').value = 'alex@studio.com';
  $('#ck-card').value = '4242424242424242';
  $('#ck-exp').value = '08/28';
  $('#ck-cvc').value = '123';
  click($('#ck-pay'));
  await sleep(500);
  check('license activated (chip = PRO)', $('#lic-label').textContent.includes('PRO'));
  check('pro view shows ACTIVE', $('#view').innerHTML.includes('ALL MODULES UNLOCKED'));
  check('license key generated', /AEGIS-[A-Z2-9]{4}-/.test($('#view').innerHTML));

  console.log('== pro unlocks file results ==');
  await navTo('files');
  click($('#f-scan'));
  await sleep(900);
  check('pro scan shows all 12 rows, no locked row', $$('#view table.data tbody tr').length === 12 && !$('#view').innerHTML.includes('UNLOCK PRO'));
  check('pro sees delete button', !!$('#btn-clean'));

  console.log('== toasts ==');
  check('toast notifications rendered', $$('.toast').length > 0);

  console.log('');
  if (errors.length) {
    console.log('RUNTIME ERRORS (' + errors.length + '):');
    errors.slice(0, 15).forEach((e) => console.log('  ! ' + e));
  }
  console.log(failures === 0 && errors.length === 0
    ? 'SMOKE TEST: ALL CHECKS PASSED'
    : `SMOKE TEST: ${failures} check(s) failed, ${errors.length} runtime error(s)`);
  process.exit(failures === 0 && errors.length === 0 ? 0 : 1);
})().catch((e) => { console.error('SMOKE TEST CRASHED:', e); process.exit(1); });
