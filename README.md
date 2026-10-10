# AEGIS Sentinel

**First public edition (V1)** — a local desktop utility for system inventory and security-posture checks on Windows, macOS and Linux. Every feature included in this edition is available without paid tiers, license keys, checkout or feature gating.

![design](https://img.shields.io/badge/design-angular%20SOC-1FE0FF) ![platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-3BE081) ![stack](https://img.shields.io/badge/stack-Electron%20%2B%20vanilla%20JS-FFB224)

## Capabilities

| Module | What it does |
|---|---|
| **Dashboard** | System telemetry, disk and memory pressure, process-risk indicators, scan findings and a heuristic posture score |
| **File Scanner** | Bounded scans for old temporary/cache candidates, large files and duplicate content (SHA-256); partial coverage is reported, and only old junk candidates can be selected for cleanup and sent to the system Trash |
| **Processes** | Process inventory, short CPU sampling, memory usage and transparent name/path/resource heuristics; optional process stop with a native confirmation |
| **Applications** | Installed-software inventory and heuristic flags; only applications with a supported, validated OS uninstall method can be uninstalled |
| **Network** | TCP/UDP endpoints and owning-process data where the OS permits, non-loopback listeners, and firewall-service/policy status |
| **Security Audit** | Seven local posture checks and a privacy-limited JSON summary export |
| **Updates** | Status from the operating-system update service and an OS-native install action where available |

## Important limitations

AEGIS Sentinel is **not an antivirus, malware scanner, vulnerability scanner, firewall replacement or security guarantee**. Process labels and the 0–100 posture score are simple heuristics; investigate any signal independently. “No findings” does not mean a device is secure.

The app queries local operating-system tools. A command may be unavailable, return partial information or require permissions; unknown status is reported as unknown rather than treated as a clean result. File scans are streamed and bounded by time, depth and file-count limits, and report skipped paths or partial coverage. Update installation and firewall changes can require administrator approval and may be unsupported on a given machine.

File cleanup is deliberately conservative: the app accepts only candidates from a recent junk scan, revalidates them before acting, rejects symbolic links or changed files, and moves selected files to the system Trash after a native confirmation. Large-file and duplicate scans are informational and have no delete action. Review candidates before moving them.

The security report contains a small summary, not raw logs, usernames, hostnames, executable paths, process names or remote addresses. The application shell currently loads its interface fonts from Google Fonts when available; the scanner itself does not upload scan results or connect to a service operated by AEGIS.

## Run and test

Requirements: Node.js `>=22.12.0` and npm.

```bash
npm ci
npm start          # launch the desktop app
npm run scan       # standalone local scan (may take up to around two minutes)
npm test           # headless renderer and scanner regression tests
npm run check      # JavaScript syntax checks
npm run demo       # rebuild the self-contained browser demo
```

`demo.html` is a browser-only mock preview. It never changes real files, stops processes or installs software. Regenerate it after UI changes with `npm run demo`.

## Package builds

Run the appropriate build on the target platform:

```bash
npm run dist:win     # NSIS installer + portable package
npm run dist:mac     # DMG + ZIP
npm run dist:linux   # AppImage + DEB + RPM
```

Build artifacts are written to `release/`. The repository does not yet configure code signing, macOS notarization or an update-distribution service. Before distributing releases, test installation and security dialogs on each target OS and configure platform signing/notarization as required.

## Security implementation notes

- Electron uses context isolation, renderer sandboxing, disabled Node integration, a restrictive Content Security Policy, blocked navigation/popups/embedded webviews and a method-specific preload bridge (no generic renderer IPC channel).
- IPC handlers require the expected local app frame. Privileged changes use native confirmation dialogs. App removals use opaque IDs from a fresh inventory rather than accepting uninstall commands from the renderer.
- External commands use argument arrays rather than shell interpolation. Destructive filesystem actions are restricted to revalidated scan-session candidates and use the OS Trash.
- The check is useful as a local inventory aid, not as a substitute for an independently maintained endpoint-protection product or professional security review.

## Project structure

```text
aegis-sentinel/
├── main.js             # Electron window, hardened IPC handlers and confirmations
├── preload.js          # fixed, named contextBridge methods
├── lib/scanner.js      # cross-platform local system engine
├── src/
│   ├── index.html       # app shell
│   ├── styles.css       # Angular SOC design system
│   └── renderer.js      # seven V1 modules
├── test/smoke.js        # jsdom UI and scanner regression checks
├── demo.template.html   # mock browser preview template
├── demo.html            # generated, self-contained demo
└── assets/icon.png      # app icon
```

## Legal

The repository's software license remains **Proprietary — © 2026 AEGIS Labs**. This legal notice is separate from in-app licensing: the V1 application has no license-key, subscription, checkout or paid-feature mechanism.
