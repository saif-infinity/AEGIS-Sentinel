'use strict';
/*
 * Headless smoke + scanner regression tests for the first public version.
 * Boots the real renderer with a stub matching the restricted preload API,
 * then covers UI routes, file-scan flows, audit summaries, and scanner bounds.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const scanner = require('../lib/scanner');

const ROOT = path.join(__dirname, '..');
const errors = [];
let failures = 0;
const check = (name, condition) => {
  console.log((condition ? '  PASS ' : '  FAIL ') + name);
  if (!condition) failures++;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeBridge(canned, calls) {
  const call = (channel, payload) => {
    calls.push({ channel, payload });
    const value = canned[channel];
    if (value === undefined) return Promise.resolve({ ok: false, error: 'unknown operation' });
    return Promise.resolve({ ok: true, data: typeof value === 'function' ? value(payload) : value });
  };
  return Object.freeze({
    getSystemInfo: () => call('sys:info'), getDiskUsage: () => call('disk:usage'),
    quickScan: () => call('scan:quick'), scanFiles: (payload) => call('scan:files', payload), cleanFiles: (payload) => call('files:clean', payload),
    listProcesses: () => call('proc:list'), killProcess: (payload) => call('proc:kill', payload),
    listApps: () => call('apps:list'), uninstallApp: (payload) => call('apps:uninstall', payload),
    getNetwork: () => call('net:list'), listPersistence: () => call('persist:list'), getFirewall: () => call('fw:status'), enableFirewall: () => call('fw:enable'),
    getEncryption: () => call('enc:status'), checkUpdates: () => call('updates:check'), installUpdates: () => call('updates:install'),
    getSystemErrors: () => call('errors:list'), pickDirectory: () => call('dialog:pickDir'), saveReport: (payload) => call('report:save', payload),
    minimize: () => call('win:minimize'), toggleMaximize: () => call('win:toggleMax'), close: () => call('win:close'),
  });
}

async function scannerTests() {
  console.log('== scanner unit/regression checks ==');
  const netstat = [
    'Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name',
    'tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN      812/sshd',
    'tcp6       0      0 :::443                  :::*                    LISTEN      920/nginx',
    'udp        0      0 127.0.0.1:5353          0.0.0.0:*                           742/avahi-daemon',
  ].join('\n');
  const parsed = scanner.parseNetstatOutput(netstat);
  check('netstat fallback captures TCP remote address and queue-state fields', parsed[0] && parsed[0].remote === '0.0.0.0:*' && parsed[0].state === 'LISTEN');
  check('netstat fallback parses PID/program', parsed[0] && parsed[0].pid === 812 && parsed[0].process === 'sshd');
  check('netstat fallback handles IPv6 TCP', parsed[1] && parsed[1].proto === 'TCP' && parsed[1].local === ':::443' && parsed[1].pid === 920);
  check('netstat fallback handles UDP with blank state', parsed[2] && parsed[2].state === 'UNCONN' && parsed[2].pid === 742);
  const riskOwner = { pid: 812, name: 'xmrig', path: '/tmp/xmrig', suspicion: 92, suspicionLevel: 'critical', flags: ['Cryptominer keyword heuristic'] };
  const moderateOwner = { pid: 813, name: 'unknown-daemon', suspicion: 42, suspicionLevel: 'medium', flags: ['Untrusted path heuristic'] };
  const correlation = scanner.correlateNetworkExposure({ available: true, items: [riskOwner, moderateOwner] }, {
    available: true,
    exposed: [
      { proto: 'TCP', local: '0.0.0.0:3333', pid: 812, process: 'xmrig' },
      { proto: 'UDP', local: ':::5353', pid: 813, process: 'unknown-daemon' },
      { proto: 'TCP', local: '0.0.0.0:22', pid: 814, process: 'sshd' },
    ],
  });
  check('listener correlation applies the numeric risk threshold and counts unattributed owners', correlation.available && correlation.assessed === 3 && correlation.flagged === 2 && correlation.unattributed === 1 && correlation.items.some((item) => item.process === 'xmrig'));
  const cleanCorrelation = scanner.correlateNetworkExposure({ available: true, items: [{ pid: 900, name: 'sshd', suspicion: 0, suspicionLevel: 'clean' }] }, {
    available: true, exposed: [{ proto: 'TCP', local: '0.0.0.0:22', pid: 900, process: 'sshd' }],
  });
  check('listener correlation distinguishes attributable clean owners from risky owners', cleanCorrelation.available && cleanCorrelation.assessed === 1 && cleanCorrelation.flagged === 0 && cleanCorrelation.unattributed === 0 && cleanCorrelation.items.length === 0);
  const missingProcessCorrelation = scanner.correlateNetworkExposure({ available: false, items: [] }, { available: true, exposed: [] });
  const missingNetworkCorrelation = scanner.correlateNetworkExposure({ available: true, items: [] }, { available: false, exposed: [] });
  check('listener correlation reports process inventory unavailability instead of a clean result', !missingProcessCorrelation.available && /Process inventory is unavailable/.test(missingProcessCorrelation.reason) && missingProcessCorrelation.flagged === null);
  check('listener correlation reports network inventory unavailability instead of a clean result', !missingNetworkCorrelation.available && /Network endpoint inventory is unavailable/.test(missingNetworkCorrelation.reason) && missingNetworkCorrelation.assessed === null);
  const unitFiles = scanner.parseSystemdUnitFileList('UNIT FILE                  STATE           PRESET\nssh.service               enabled         enabled\nexample.service           disabled        enabled\n');
  check('systemd parser distinguishes enabled and disabled service files', unitFiles.length === 2 && unitFiles[0].name === 'ssh.service' && unitFiles[0].state === 'enabled' && unitFiles[1].state === 'disabled');
  const systemdUnits = scanner.parseSystemctlListUnits('ssh.service loaded active running OpenBSD Secure Shell server\nexample.service loaded inactive dead Example service\n');
  check('systemd runtime parser retains active state without splitting descriptions', systemdUnits.length === 2 && systemdUnits[0].activeState === 'active' && systemdUnits[0].subState === 'running');
  const systemdDetails = scanner.parseSystemctlShow('Id=ssh.service\nMainPID=812\nActiveState=active\nId=example.service\nMainPID=0\nActiveState=inactive\n');
  check('systemd detail parser separates multiple unit records', systemdDetails.length === 2 && systemdDetails[0].name === 'ssh.service' && systemdDetails[0].MainPID === '812' && systemdDetails[1].name === 'example.service');
  const desktopEntry = scanner.parseXdgDesktopEntry('[Desktop Entry]\nType=Application\nName=Updater\nExec=\"/tmp/maintainer tool\" --background %U\nX-GNOME-Autostart-enabled=false\n');
  check('XDG autostart parser extracts quoted executables and disabled state', desktopEntry && desktopEntry.name === 'Updater' && desktopEntry.executable === '/tmp/maintainer tool' && desktopEntry.enabled === false);
  const hiddenDesktop = scanner.parseXdgDesktopEntry('[Desktop Entry]\nType=Application\nName=Disabled app\nExec=/opt/app\nHidden=true\n');
  check('XDG autostart parser respects Hidden tombstones', hiddenDesktop && hiddenDesktop.enabled === false);
  const launchJobs = scanner.parseLaunchctlList('PID\tStatus\tLabel\n-\t0\tcom.example.configured\n4242\t0\tcom.example.running\n');
  check('launchctl parser distinguishes loaded jobs from running PID owners', launchJobs.length === 2 && launchJobs[0].pid === null && launchJobs[1].pid === 4242 && launchJobs[1].label === 'com.example.running');
  const persistenceAssessment = scanner.correlatePersistenceItems({ available: true, items: [
    { kind: 'service', source: 'test', scope: 'system', name: 'Suspicious service', command: '/tmp/xmrig --service', executable: '/tmp/xmrig', enabled: true, state: 'Running', pid: 812 },
    { kind: 'startup', source: 'test', scope: 'user', name: 'Known app', command: '/usr/bin/firefox', executable: '/usr/bin/firefox', enabled: true, state: 'Configured', pid: null },
    { kind: 'startup', source: 'test', scope: 'user', name: 'Miner autostart definition', command: '/tmp/xmrig --service', executable: '/tmp/xmrig', enabled: true, state: 'Configured', pid: null },
  ] }, { available: true, items: [riskOwner, { pid: 920, name: 'firefox', path: '/usr/bin/firefox', suspicion: 0, suspicionLevel: 'clean', flags: [] }] }, {
    available: true, listening: [{ pid: 812, local: '0.0.0.0:3333' }],
  });
  check('persistence assessment separates same-PID listeners from executable-path candidates', persistenceAssessment.summary.totalItems === 3 && persistenceAssessment.summary.riskItems === 2 && persistenceAssessment.summary.riskItemsWithListeners === 1 && persistenceAssessment.items[0].processMatchType === 'pid' && persistenceAssessment.items[0].processMatched && persistenceAssessment.items[0].riskSignal && persistenceAssessment.items[0].listenerCount === 1 && persistenceAssessment.summary.riskItemsWithListenerCandidates === 1 && persistenceAssessment.items[1].processMatchType === 'executable-path-candidate' && persistenceAssessment.items[1].listenerCount === null && persistenceAssessment.items[2].processMatchType === 'executable-path-candidate' && persistenceAssessment.items[2].listenerCandidateCount === 1);
  const riskyPathCandidate = scanner.correlatePersistenceItems({ available: true, items: [{ kind: 'startup', name: 'Trusted launcher', command: '/opt/app', executable: '/opt/app', enabled: true, pid: null }] }, { available: true, items: [{ pid: 913, name: 'xmrig', path: '/opt/app', suspicion: 91, suspicionLevel: 'critical', flags: ['Risk heuristic'] }] }, { available: true, listening: [{ pid: 913, local: '0.0.0.0:8080' }] });
  check('risky executable-path match stays a candidate and is not counted as a PID-owned listener', riskyPathCandidate.items[0].processMatchType === 'executable-path-candidate' && riskyPathCandidate.items[0].riskSignal && riskyPathCandidate.items[0].riskOrigin === 'executable-path-candidate' && riskyPathCandidate.items[0].listenerCount === null && riskyPathCandidate.items[0].listenerCandidateCount === 1 && riskyPathCandidate.summary.riskItemsWithListeners === 0 && riskyPathCandidate.summary.riskItemsWithListenerCandidates === 1);
  const unavailablePersistence = scanner.correlatePersistenceItems({ available: true, partial: false, items: [{ name: 'Service', executable: '/usr/bin/service', pid: null }] }, { available: false, items: [] }, { available: false, listening: [] });
  check('persistence assessment preserves unknown process/listener joins instead of reporting no listeners', unavailablePersistence.partial && !unavailablePersistence.processAvailable && !unavailablePersistence.networkAvailable && unavailablePersistence.items[0].listenerCount === null && unavailablePersistence.items[0].listenerCandidateCount === null);
  const winArgs = scanner.parseWindowsCommandLine('\"C:\\Program Files\\Example\\uninstall.exe\" /quiet /log \"C:\\Program Files\\Example\\uninstall.log\"');
  check('Windows uninstall command parsing preserves quoted paths as arguments', winArgs.length === 4 && winArgs[0] === 'C:\\Program Files\\Example\\uninstall.exe' && winArgs[3] === 'C:\\Program Files\\Example\\uninstall.log');
  check('Windows uninstall command parser rejects unbalanced quotes', scanner.parseWindowsCommandLine('\"C:\\broken\\uninstall.exe /quiet').length === 0);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-smoke-'));
  try {
    fs.mkdirSync(path.join(tmp, 'nested'));
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const topJunk = path.join(tmp, 'top.tmp');
    const nestedJunk = path.join(tmp, 'nested', 'nested.tmp');
    fs.writeFileSync(topJunk, 'top junk');
    fs.writeFileSync(nestedJunk, 'nested junk');
    fs.utimesSync(topJunk, old, old);
    fs.utimesSync(nestedJunk, old, old);

    const depthScan = await scanner.scanFiles({ mode: 'junk', roots: [tmp], maxDepth: 0, maxMs: 1 });
    check('scan maxDepth=0 does not descend into child directories', depthScan.scanned === 1 && depthScan.results.some((item) => item.path === topJunk));
    check('scan limits are clamped to safe engine bounds', depthScan.maxDepth === 0 && depthScan.maxMs === 1000);
    const fullScan = await scanner.scanFiles({ mode: 'junk', roots: [tmp], maxDepth: 1, maxMs: 5000 });
    check('junk scan detects old files at permitted depth', fullScan.count === 2 && fullScan.results.every((item) => item.mtimeMs));
    check('accessible scan roots are explicitly marked complete', fullScan.available === true && fullScan.incomplete === false && fullScan.skipped === 0);
    const validated = await scanner.validateCleanCandidates([topJunk], fullScan.results, fullScan.roots);
    check('cleanup accepts a candidate from the matching scan', validated.length === 1 && validated[0] === topJunk);
    let rejected = false;
    try { await scanner.validateCleanCandidates([path.join(tmp, 'nested', 'not-scanned.tmp')], fullScan.results, fullScan.roots); }
    catch { rejected = true; }
    check('cleanup rejects a path that was not scanned', rejected);

    const duplicateA = path.join(tmp, 'same-a.bin');
    const duplicateB = path.join(tmp, 'same-b.bin');
    fs.writeFileSync(duplicateA, 'same-content');
    fs.writeFileSync(duplicateB, 'same-content');
    const crowdedDuplicateContent = 'many-identical-files-content';
    for (let i = 0; i < 25; i++) fs.writeFileSync(path.join(tmp, 'same-large-group-' + i + '.bin'), crowdedDuplicateContent);
    const duplicateScan = await scanner.scanFiles({ mode: 'duplicates', roots: [tmp], maxDepth: 1, maxMs: 5000 });
    check('duplicate scan groups identical content using a full hash', duplicateScan.results.some((group) => group.files && group.files.length === 2 && group.wasted === Buffer.byteLength('same-content')));
    check('large duplicate groups bound the displayed path list but preserve copy and space counts', duplicateScan.results.some((group) => group.count === 25 && group.files.length === 20 && group.omitted === 5 && group.wasted === Buffer.byteLength(crowdedDuplicateContent) * 24));

    fs.writeFileSync(topJunk, 'changed after scan');
    let changedRejected = false;
    try { await scanner.validateCleanCandidates([topJunk], fullScan.results, fullScan.roots); }
    catch { changedRejected = true; }
    check('cleanup rejects a candidate changed since scanning', changedRejected);

    const bulk = path.join(tmp, 'bulk');
    fs.mkdirSync(bulk);
    const bulkOld = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    for (let i = 0; i < 2001; i++) {
      const file = path.join(bulk, 'candidate-' + i + '.tmp');
      fs.writeFileSync(file, 'x');
      fs.utimesSync(file, bulkOld, bulkOld);
    }
    const limited = await scanner.scanFiles({ mode: 'junk', roots: [bulk], maxDepth: 0, maxMs: 60000 });
    check('file result cap reports partial coverage instead of implying a complete empty/short list', limited.count === 2001 && limited.results.length === 2000 && limited.truncated && limited.incomplete);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const unknownScore = scanner.computeHealthScore({ system: {}, disks: [], processes: [], firewall: { enabled: null }, encryption: { enabled: null }, updates: { checkStatus: 'error' }, errors: { available: false } });
  check('unknown security signals reduce score and include a heuristic disclaimer', unknownScore.score < 100 && /not an antivirus/i.test(unknownScore.disclaimer));
  check('health-score findings do not claim malware detection', !unknownScore.findings.some((finding) => /malware found|virus detected/i.test(finding.msg)));
  const correlationPosture = {
    system: { totalRam: 8 * 1024 ** 3, freeRam: 4 * 1024 ** 3 }, disks: [{ mount: '/', size: 100, used: 30 }],
    processes: [], processesAvailable: true, firewall: { enabled: true, verified: true }, encryption: { enabled: true },
    updates: { checkStatus: 'ok', items: [], rebootRequired: false }, errors: { available: true, count24h: 0 },
    networkSummary: { available: true, exposed: 1 },
  };
  const baselineCorrelationScore = scanner.computeHealthScore(correlationPosture);
  const correlationScore = scanner.computeHealthScore({ ...correlationPosture, networkCorrelation: { available: true, flagged: 2 } });
  check('health score separately penalizes risk-correlated listeners by a bounded amount', correlationScore.score === baselineCorrelationScore.score - 12);
  check('health-score correlation finding explains risk as a heuristic', correlationScore.findings.some((finding) => /listener\(s\).*high-risk heuristics/.test(finding.msg)));
  const persistencePosture = { available: true, partial: false, processAvailable: true, networkAvailable: true, summary: { riskItems: 1, riskItemsWithListeners: 1, riskItemsWithListenerCandidates: 0 } };
  const cleanPersistencePosture = { available: true, partial: false, processAvailable: true, networkAvailable: true, summary: { riskItems: 0, riskItemsWithListeners: 0, riskItemsWithListenerCandidates: 0 } };
  const persistenceScore = scanner.computeHealthScore({ ...correlationPosture, persistence: persistencePosture });
  const cleanPersistenceScore = scanner.computeHealthScore({ ...correlationPosture, persistence: cleanPersistencePosture });
  check('health score separately accounts for startup risk and a same-PID listener', persistenceScore.score === cleanPersistenceScore.score - 9 && persistenceScore.findings.some((finding) => /startup\/service item\(s\).*risk heuristics/.test(finding.msg)));
  const candidatePersistenceScore = scanner.computeHealthScore({ ...correlationPosture, persistence: { ...persistencePosture, summary: { riskItems: 1, riskItemsWithListeners: 0, riskItemsWithListenerCandidates: 1 } } });
  check('health score keeps executable-path listener matches distinct and unconfirmed', candidatePersistenceScore.score === cleanPersistenceScore.score - 7 && candidatePersistenceScore.findings.some((finding) => /ownership is unconfirmed/.test(finding.msg)));
  const processUnknownScore = scanner.computeHealthScore({
    system: { totalRam: 8 * 1024 ** 3, freeRam: 4 * 1024 ** 3 }, disks: [{ mount: '/', size: 100, used: 30 }],
    processes: [], processesAvailable: false, firewall: { enabled: true, verified: true }, encryption: { enabled: true },
    updates: { checkStatus: 'ok', items: [], rebootRequired: false }, errors: { available: true, count24h: 0 },
    networkSummary: { available: true, exposed: 0 },
  });
  check('unavailable process inventory is an explicit posture finding', processUnknownScore.findings.some((finding) => /Process inventory could not be read/.test(finding.msg)));
  let liveSnapshot = null;
  try { liveSnapshot = await scanner.getProcessSnapshot(); } catch { /* an OS collector failure still must not produce an empty clean result */ }
  check('live process collector always returns an explicit availability snapshot', !!liveSnapshot && typeof liveSnapshot.available === 'boolean' && Array.isArray(liveSnapshot.items));
  let livePersistence = null;
  try { livePersistence = await scanner.getPersistenceInventory(); } catch { /* an OS collector failure must remain explicit */ }
  check('live startup/service collector reports bounded source coverage and availability', !!livePersistence && typeof livePersistence.available === 'boolean' && typeof livePersistence.partial === 'boolean' && Array.isArray(livePersistence.sources) && Array.isArray(livePersistence.items) && Number.isSafeInteger(livePersistence.count) && livePersistence.count >= livePersistence.items.length && livePersistence.partial === (livePersistence.sources.some((source) => !source.complete) || livePersistence.truncated));
  if (scanner.IS_LINUX && liveSnapshot && liveSnapshot.available) {
    check('Linux process snapshots include stable start identities for PID reuse checks', liveSnapshot.items.some((process) => /^\d+$/.test(process.startId || '')));
  }
}

async function rendererTests() {
  console.log('== renderer smoke checks ==');
  const GiB = 1024 ** 3;
  const sysInfo = {
    hostname: 'testbox', platform: 'linux', platformLabel: 'Linux', arch: 'x64', release: '6.1.0',
    cpus: 8, cpuModel: 'Test CPU x8', totalRam: 16 * GiB, freeRam: 8 * GiB,
    uptimeSec: 3600, user: 'tester', homedir: '/home/tester', osCaption: 'Debian GNU/Linux 13',
    osBuild: '1', machineModel: 'TestBox', gpu: 'Test GPU',
  };
  const clean = { pid: 1, name: 'init', cpu: 0.2, memBytes: 2048, path: '/sbin/init', company: 'systemd', product: '', suspicion: 0, suspicionLevel: 'clean', flags: [], canStop: false };
  const flagged = { pid: 99, name: 'xmrig', cpu: 95, memBytes: 500 * 1024 ** 2, path: '/tmp/xmrig', company: '', product: '', suspicion: 95, suspicionLevel: 'critical', flags: ['Cryptominer keyword heuristic', 'Temporary-directory execution heuristic'], canStop: true };
  const processes = [clean, flagged];
  const disks = [{ device: '/dev/sda', mount: '/', label: '/', size: 100 * GiB, used: 40 * GiB, free: 60 * GiB, isSystem: true }];
  const firewall = { enabled: true, verified: true, profiles: [{ name: 'ufw', enabled: true }], details: 'Firewall active; default inbound policy verified' };
  const encryption = { enabled: true, details: 'LUKS encrypted volume detected' };
  const updates = { items: [{ name: 'openssl', version: '3.0.15', source: 'apt (stable)' }], history: [], lastInstalled: '2026-10-01', daysSinceLastUpdate: 8, rebootRequired: false, checkStatus: 'ok', note: '1 package update available' };
  const errorItems = [{ time: '2026-10-09 10:00', source: 'kernel', id: '', message: 'test error event' }];
  const errorsData = { items: errorItems, count24h: 1, available: true, window: '24h' };
  const connections = [
    { proto: 'TCP', local: '0.0.0.0:22', remote: '0.0.0.0:*', state: 'LISTEN', pid: 99, process: 'xmrig' },
    { proto: 'TCP', local: '127.0.0.1:5432', remote: '0.0.0.0:*', state: 'LISTEN', pid: 901, process: 'postgres' },
    { proto: 'TCP', local: '10.0.0.2:51234', remote: '1.2.3.4:443', state: 'ESTABLISHED', pid: 902, process: 'firefox' },
  ];
  const networkCorrelation = {
    available: true, reason: null, assessed: 1, flagged: 1, unattributed: 0,
    items: [{ proto: 'TCP', local: '0.0.0.0:22', pid: 99, process: 'xmrig', suspicion: 95, flags: flagged.flags }],
  };
  const network = { connections, listening: connections.slice(0, 2), exposed: [connections[0]], available: true, error: null, correlation: networkCorrelation };
  const persistence = {
    available: true, complete: false, partial: true, truncated: false, count: 2,
    sources: [
      { id: 'test-source', label: 'Test startup source', available: true, complete: true, count: 2, error: null },
      { id: 'unavailable-source', label: 'Optional source', available: false, complete: false, count: 0, error: 'permission denied' },
    ],
    items: [
      { kind: 'service', source: 'Test Service', scope: 'system', name: 'Suspicious Service', command: '/tmp/xmrig --service', executable: '/tmp/xmrig', sourcePath: '/etc/test.service', enabled: true, state: 'Running', pid: 99, processName: 'xmrig', processMatched: true, processMatchType: 'pid', matchedPid: 99, processRiskScore: 95, riskScore: 95, riskLevel: 'critical', riskSignal: true, riskOrigin: 'startup-and-running-process', riskFlags: flagged.flags, listenerCount: 1, listenerCandidateCount: 1 },
      { kind: 'startup', source: 'Test Startup', scope: 'user', name: 'Firefox', command: '/usr/bin/firefox %U', executable: '/usr/bin/firefox', sourcePath: '/home/tester/.config/autostart/firefox.desktop', enabled: true, state: 'Configured', pid: null, matchedPid: 902, processName: 'firefox', processMatched: true, processMatchType: 'executable-path-candidate', processRiskScore: 0, riskScore: 0, riskLevel: 'clean', riskSignal: false, riskOrigin: null, riskFlags: [], listenerCount: null, listenerCandidateCount: 0 },
    ],
    summary: { totalItems: 2, enabledItems: 2, runningItems: 1, riskItems: 1, riskItemsWithListeners: 1, riskItemsWithListenerCandidates: 0, pidMatchedItems: 1, executableMatchedItems: 1, unattributedRunningItems: 0 },
    processAvailable: true, networkAvailable: true,
  };
  const junkRows = Array.from({ length: 12 }, (_, index) => ({ path: '/tmp/old-junk-' + index + '.tmp', size: 100 + index, kind: 'Temporary / backup file', mtimeMs: Date.now() - 3 * 86400000 }));
  const filesPayloads = [];
  const cleanPayloads = [];
  const uninstallPayloads = [];
  const reportPayloads = [];
  const scanQuick = {
    system: sysInfo, systemDisk: disks[0], disks, processesAvailable: true, processError: null, processes, suspicious: [flagged],
    firewall, encryption, updates, errors: errorsData,
    networkSummary: { connections: 3, listening: 2, exposed: 1, available: true }, networkCorrelation,
    persistenceAvailable: true, persistencePartial: true, persistenceSummary: persistence.summary,
    junk: { available: true, incomplete: false, skipped: 0, error: null, scanned: 1000, reclaimable: 5 * GiB, count: 42, truncated: false },
    score: { score: 88, grade: 'A', findings: [{ sev: 'warning', msg: 'One process matched heuristic risk indicators', pts: 1 }], disclaimer: 'Heuristic posture indicator only; not an antivirus or a guarantee of security.' },
    durationMs: 1200,
  };
  const apps = [
    { id: 'app-firefox', name: 'Firefox', version: '130.0', publisher: 'Mozilla', size: 200 * 1024 ** 2, flags: [], package: 'firefox', path: '', uninstallMethod: 'apt', canUninstall: true },
    { id: 'app-toolbar', name: 'Super Toolbar Free', version: '1.0', publisher: '', size: 0, flags: [{ label: 'Possible bloatware (heuristic)', sev: 'high' }], package: '', path: '', canUninstall: false },
  ];
  const scanFiles = (payload) => {
    filesPayloads.push(payload);
    const mode = payload.mode || 'junk';
    const results = mode === 'junk' ? junkRows : mode === 'large'
      ? [{ path: '/home/tester/large.iso', size: 900 * 1024 ** 2, kind: 'Large file (>= 100 MB)' }]
      : [{ kind: 'Duplicate group x2', size: 500, wasted: 500, count: 2, files: ['/home/tester/a.bin', '/home/tester/b.bin'] }];
    return { available: true, incomplete: false, skipped: 0, error: null, mode, roots: payload.roots || ['/tmp'], scanned: 10, bytes: 4096, truncated: false, durationMs: 50, count: results.length, reclaimable: mode === 'junk' ? 2048 : 0, minJunkAgeMs: 86400000, scanToken: mode === 'junk' ? 'smoke-session-token' : undefined, results };
  };
  const canned = {
    'sys:info': sysInfo,
    'disk:usage': disks,
    'scan:quick': scanQuick,
    'scan:files': scanFiles,
    'files:clean': (payload) => { cleanPayloads.push(payload); return { removed: payload.paths.length, failed: 0, bytes: 300 }; },
    'proc:list': { available: true, items: processes, error: null },
    'proc:kill': { ok: true, error: null },
    'apps:list': apps,
    'apps:uninstall': (payload) => { uninstallPayloads.push(payload); return { ok: true, error: null }; },
    'net:list': network,
    'persist:list': persistence,
    'fw:status': firewall,
    'fw:enable': { ok: true, error: null },
    'enc:status': encryption,
    'updates:check': updates,
    'updates:install': { ok: true, note: 'Mock update action completed' },
    'errors:list': errorsData,
    'dialog:pickDir': null,
    'report:save': (payload) => { reportPayloads.push(payload); return '/tmp/aegis-report.json'; },
    'win:minimize': null, 'win:toggleMax': null, 'win:close': null,
  };
  const calls = [];
  const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8').replace('<script src="./renderer.js"></script>', '');
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push('jsdomError: ' + error.message));
  virtualConsole.on('error', (message) => errors.push('console.error: ' + message));
  const dom = new JSDOM(html, {
    url: 'file://' + path.join(ROOT, 'src', 'index.html'), runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.addEventListener('error', (event) => errors.push('window.onerror: ' + event.message));
  window.aegis = makeBridge(canned, calls);
  window.eval(fs.readFileSync(path.join(ROOT, 'src', 'renderer.js'), 'utf8'));
  const $ = (selector) => window.document.querySelector(selector);
  const $$ = (selector) => [...window.document.querySelectorAll(selector)];
  const click = (element) => { if (element) element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); };
  const navTo = async (route) => { click($(`.nav-item[data-route="${route}"]`)); await sleep(350); };

  await sleep(1400);
  check('dashboard loads the system overview', $('#view').innerHTML.includes('System Overview'));
  check('health score and grade display', $('#view').innerHTML.includes('88') && $('#view').innerHTML.includes('GRADE A'));
  check('heuristic risk signal is displayed without malware verdict language', $('#view').innerHTML.includes('xmrig') && $('#view').innerHTML.includes('Heuristic posture indicator'));
  check('dashboard exposes risk-correlated listener count without presenting it as a malware verdict', $('#view').innerHTML.includes('RISKY LISTENERS 1') && $('#view').innerHTML.includes('1 non-loopback listener(s) owned by risk-flagged process(es)'));
  check('dashboard includes read-only startup risk summary and partial-coverage status', $('#view').innerHTML.includes('STARTUP RISKS 1') && $('#view').innerHTML.includes('1 startup/service risk item(s) matched') && $('#view').innerHTML.includes('partial coverage'));
  check('first-version sidebar has no paid edition, license or upgrade item', !$('.nav-item[data-route="pro"]') && !$('.lic-chip') && !$('#view').innerHTML.includes('Unlock PRO'));
  check('renderer receives a named method surface, not generic invoke IPC', typeof window.aegis.invoke === 'undefined' && calls.some((call) => call.channel === 'scan:quick'));

  await navTo('files');
  click($('#f-scan'));
  await sleep(150);
  check('file scan shows all 12 cleanup candidates without an artificial row cap', $$('#view table.data tbody tr').length === 12 && !$('#view').innerHTML.includes('locked'));
  check('cleanup candidates require selection before use', !!$('#btn-clean') && $('#btn-clean').disabled);
  click($('#sel-all'));
  check('select-all enables move-to-Trash action', !$('#btn-clean').disabled);
  click($('#btn-clean'));
  await sleep(80);
  check('cleanup passes only selected paths and the scan-session token', cleanPayloads.length === 1 && cleanPayloads[0].scanToken === 'smoke-session-token' && cleanPayloads[0].paths.length === 12);
  check('cleanup clears its prior result after completion', !$('#btn-clean'));

  $('#f-mode').value = 'large';
  click($('#f-scan'));
  await sleep(100);
  check('large-file mode is informational and cannot be cleaned', $('#view').innerHTML.includes('large.iso') && !$('#btn-clean'));
  $('#f-mode').value = 'duplicates';
  click($('#f-scan'));
  await sleep(100);
  check('duplicate mode renders a grouped full-hash result without destructive controls', $('#view').innerHTML.includes('Duplicate group x2') && !$('#btn-clean'));

  await navTo('processes');
  check('process inventory table renders', $$('#view table.data tbody tr').length === 2 && $('#view').innerHTML.includes('HEURISTIC SNAPSHOT'));
  const goodProcessSnapshot = canned['proc:list'];
  canned['proc:list'] = { available: false, items: [], error: 'permission denied' };
  click($('#p-refresh'));
  await sleep(80);
  check('process read failure is shown as unavailable, not as a clean empty list', $('#view').innerHTML.includes('PROCESS INVENTORY UNAVAILABLE'));
  canned['proc:list'] = goodProcessSnapshot;
  click($('#p-refresh'));
  await sleep(80);
  check('process inventory can be refreshed after an unavailable result', $$('#view table.data tbody tr').length === 2);
  await navTo('apps');
  check('application inventory renders and unsupported removals are disabled', $$('#view table.data tbody tr').length === 2 && $('button[data-uninstall="app-toolbar"]').disabled);
  click($('button[data-uninstall="app-firefox"]'));
  await sleep(80);
  check('application removal uses an opaque catalog id', uninstallPayloads.length === 1 && uninstallPayloads[0].id === 'app-firefox');
  $('#a-filter').value = 'no-such-application';
  $('#a-filter').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  check('application search reports an empty filter result instead of an empty inventory', $('#view').innerHTML.includes('NO APPLICATIONS MATCH THE FILTER'));
  $('#a-filter').value = '';
  $('#a-filter').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  const goodApps = canned['apps:list'];
  const appCallsBeforeEmpty = calls.filter((entry) => entry.channel === 'apps:list').length;
  canned['apps:list'] = [];
  click($('#a-refresh'));
  await sleep(80);
  const appCallsAfterEmpty = calls.filter((entry) => entry.channel === 'apps:list').length;
  check('an empty application inventory settles without recursively reloading forever', appCallsAfterEmpty === appCallsBeforeEmpty + 1 && $('#view').innerHTML.includes('NO APPLICATIONS REPORTED'));
  canned['apps:list'] = goodApps;
  click($('#a-refresh'));
  await sleep(80);
  check('application inventory can refresh from an empty result', $$('#view table.data tbody tr').length === 2);

  await navTo('persistence');
  check('startup/service view renders source coverage and configured entries', $('#view').innerHTML.includes('Startup &amp; Services') && $('#view').innerHTML.includes('Suspicious Service') && $('#view').innerHTML.includes('Coverage is partial'));
  check('startup/service view links a risky persistent item to its current listener', $('#view').innerHTML.includes('1 PID-LINKED') && $('#view').innerHTML.includes('CRITICAL'));
  check('startup/service filter handles a no-match query', ($('#persist-filter').value = 'no-such-entry', $('#persist-filter').dispatchEvent(new dom.window.Event('input', { bubbles: true })), $('#persist-tbody').innerHTML.includes('NO STARTUP/SERVICE ITEMS MATCH THE FILTER')));
  const goodPersistence = canned['persist:list'];
  canned['persist:list'] = { available: false, complete: false, partial: true, error: 'permission denied', sources: [], items: [], summary: {} };
  click($('#persist-refresh'));
  await sleep(80);
  check('unavailable startup sources show unknown counts instead of a clean empty inventory', $('#view').innerHTML.includes('STATUS UNKNOWN') && $('#view').innerHTML.includes('NO SOURCE DATA') && $$('#view .stat-value').slice(0, 2).every((node) => node.textContent === '—'));
  canned['persist:list'] = goodPersistence;
  click($('#persist-refresh'));
  await sleep(80);

  await navTo('network');
  check('network view shows firewall verification caveat', $('#view').innerHTML.includes('Firewall Status') && $('#view').innerHTML.includes('default inbound policy verified'));
  check('network view distinguishes non-loopback listeners', $('#view').innerHTML.includes('1 bound to a non-loopback address') && $$('#n-tbody tr').length === 3);
  check('network view attributes a risky listener to the process-risk inventory', $('#view').innerHTML.includes('Cross-sensor listener correlation') && $('#view').innerHTML.includes('1 matched a process with high-risk heuristics') && $('#view').innerHTML.includes('xmrig'));
  const goodNetworkSnapshot = canned['net:list'];
  canned['net:list'] = { ...goodNetworkSnapshot, correlation: { available: true, assessed: 1, flagged: 1 } };
  click($('#n-refresh'));
  await sleep(80);
  check('network view treats incomplete correlation counts as unknown, not zero or clean', $('#view').innerHTML.includes('unavailable or incomplete') && !$('#view').innerHTML.includes('0 non-loopback listener(s) assessed'));
  canned['net:list'] = goodNetworkSnapshot;
  click($('#n-refresh'));
  await sleep(80);
  canned['net:list'] = null;
  click($('#n-refresh'));
  await sleep(80);
  check('network query failures render an explicit unavailable state instead of an endless spinner', $('#view').innerHTML.includes('Network endpoint query failed') && !$('#view').innerHTML.includes('Mapping network connections'));
  canned['net:list'] = goodNetworkSnapshot;
  click($('#n-refresh'));
  await sleep(80);

  await navTo('updates');
  check('updates view renders pending OS update and installation is available', $('#view').innerHTML.includes('openssl') && !$('#u-install').disabled);
  click($('#u-install'));
  await sleep(80);
  check('updates action goes through the named preload method', calls.some((call) => call.channel === 'updates:install'));

  await navTo('audit');
  click($('#au-run'));
  await sleep(100);
  check('audit yields nine local checks with heuristic disclaimer', $$('.audit-item').length === 9 && $('#view').innerHTML.includes('not an antivirus'));
  check('audit includes the new persistence check status', $$('.audit-item').length === 9 && $$('.audit-item').some((row) => row.innerHTML.includes('Startup and service persistence')));
  check('audit surfaces risk-correlated listener outcome as heuristic only', $('#view').innerHTML.includes('Cross-sensor listener risk correlation') && $('#view').innerHTML.includes('1 listener(s) matched process risk heuristics'));
  check('audit includes startup/service risk and partial-source coverage', $('#view').innerHTML.includes('Startup and service persistence') && $('#view').innerHTML.includes('1 startup/service item(s) matched risk heuristics'));
  check('audit process-risk finding is explicitly heuristic', $('#view').innerHTML.includes('matched simple name/path/resource heuristics'));
  click($('#au-export'));
  await sleep(80);
  const report = reportPayloads[0];
  check('exported audit summary contains the new persistence check status', !!report && report.checks.length === 9 && report.checks.some((item) => item.title === 'Startup and service persistence'));
  check('exported report omits raw host/user/path/process/log/network details', !!report && !JSON.stringify(report).includes('tester') && !JSON.stringify(report).includes('/home/') && !JSON.stringify(report).includes('xmrig') && !JSON.stringify(report).includes('1.2.3.4') && !JSON.stringify(report).includes('test error event'));
  check('audit report documents its privacy limitation', !!report && /omits hostname/.test(report.privacyNote));
  check('exported report includes aggregate correlation counts without process identities', !!report && report.counts.correlatedRiskListeners === 1 && report.counts.unattributedListeners === 0 && !JSON.stringify(report).includes('xmrig'));
  check('exported report includes aggregate startup-risk counts and completeness only', !!report && report.counts.startupItems === 2 && report.counts.riskStartupItems === 1 && report.counts.riskStartupItemsWithListeners === 1 && report.counts.riskStartupItemsWithListenerCandidates === 0 && report.counts.startupInventoryPartial === true && !JSON.stringify(report).includes('Suspicious Service'));

  canned['proc:list'] = { available: false, items: [], error: 'permission denied' };
  canned['net:list'] = { available: false, connections: [], listening: [], exposed: [], error: 'query denied' };
  canned['persist:list'] = { available: false, partial: true, complete: false, error: 'Startup source access denied', sources: [], items: [], summary: {} };
  canned['updates:check'] = { items: [], history: [], checkStatus: 'error', note: 'Update service unavailable', rebootRequired: null };
  click($('#au-again'));
  await sleep(100);
  click($('#au-export'));
  await sleep(80);
  const unknownReport = reportPayloads[1];
  check('audit export preserves unavailable counts as unknown instead of zero', !!unknownReport && unknownReport.counts.pendingUpdates === null && unknownReport.counts.processRiskSignals === null && unknownReport.counts.externallyBoundEndpoints === null && unknownReport.counts.listeningEndpoints === null);
  check('audit export preserves unavailable correlation counts as unknown', !!unknownReport && unknownReport.counts.correlatedRiskListeners === null && unknownReport.counts.unattributedListeners === null);
  check('audit export preserves unavailable startup inventory counts as unknown', !!unknownReport && unknownReport.counts.startupItems === null && unknownReport.counts.riskStartupItems === null && unknownReport.counts.riskStartupItemsWithListeners === null && unknownReport.counts.riskStartupItemsWithListenerCandidates === null && unknownReport.counts.startupInventoryPartial === null);
  const persistenceAuditRow = $$('.audit-item').find((row) => row.innerHTML.includes('Startup and service persistence'));
  check('audit marks unavailable startup inventory as unknown rather than healthy', !!persistenceAuditRow && persistenceAuditRow.classList.contains('warn'));
  const correlationAuditRow = $$('.audit-item').find((row) => row.innerHTML.includes('Cross-sensor listener risk correlation'));
  check('audit marks unavailable correlation as unknown rather than healthy', !!correlationAuditRow && correlationAuditRow.classList.contains('warn'));
  canned['proc:list'] = goodProcessSnapshot;
  canned['net:list'] = goodNetworkSnapshot;
  canned['persist:list'] = persistence;
  canned['updates:check'] = updates;

  const forbiddenRoutes = ['pro', 'license', 'checkout'];
  check('no paid-edition routes remain registered in navigation', forbiddenRoutes.every((route) => !$('.nav-item[data-route="' + route + '"]')));

  dom.window.close();
}

(async () => {
  await scannerTests();
  await rendererTests();
  if (errors.length) {
    console.log('RUNTIME ERRORS (' + errors.length + '):');
    errors.slice(0, 15).forEach((error) => console.log('  ! ' + error));
  }
  console.log('');
  console.log(failures === 0 && errors.length === 0
    ? 'SMOKE TEST: ALL CHECKS PASSED'
    : `SMOKE TEST: ${failures} check(s) failed, ${errors.length} runtime error(s)`);
  process.exit(failures === 0 && errors.length === 0 ? 0 : 1);
})().catch((error) => {
  console.error('SMOKE TEST CRASHED:', error && error.stack || error);
  process.exit(1);
});
