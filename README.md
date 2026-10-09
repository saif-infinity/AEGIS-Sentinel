# AEGIS Sentinel

**System security, health & optimization platform** for Windows, macOS and Linux.
One codebase, three desktop targets, a freemium business model.

![design](https://img.shields.io/badge/design-angular%20SOC-1FE0FF) ![platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-3BE081) ![stack](https://img.shields.io/badge/stack-Electron%20%2B%20vanilla%20JS-FFB224)

---

## What it does

| Module | Capability |
|---|---|
| **Dashboard** | Live health score (0–100, grade S–D), CPU / RAM / disk / network telemetry, suspicious-process feed, findings, live event ticker |
| **File Scanner** | Junk & temp sweep, large-file finder, duplicate detection (size + MD5 grouping), safe deletion with reclaimable-space total |
| **Process Monitor** | Live process table with two-pass CPU sampling, memory, executable path, per-process **risk scoring** (temp-dir execution, cryptominer signatures, CPU/memory anomalies, spoofed system names), force-stop |
| **Applications** | Full installed-software inventory (registry on Windows, `/Applications` + Homebrew on macOS, `.desktop` + apt on Linux), publisher/version/size, **bloatware flags** |
| **Network** | Active TCP/UDP connection mapping with owning process, listening-port exposure list, per-profile firewall status, one-click firewall repair |
| **Security Audit** | 7-point automated audit (firewall, encryption, updates, 24h error logs, suspicious processes, disk pressure, exposed ports) with guided fixes and JSON report export |
| **Updates** | Missing OS updates (Windows Update history + PSWindowsUpdate, `softwareupdate -l`, `apt list --upgradable`), restart-required detection, install-all |

The **engine** (`lib/scanner.js`) is pure Node.js — no Electron dependency — and auto-detects the OS to run the right commands (PowerShell on Windows, `ps`/`ss`/`journalctl`/`apt` on Linux, `lsof`/`sw_vers`/`softwareupdate` on macOS).

## Design system — "Angular SOC"

- **Zero rounded corners** — enforced globally (`border-radius: 0 !important`)
- HUD corner brackets on cards, **clipped-corner** primary buttons (`clip-path`), **skewed** gauge segments
- Dark ops-center palette: near-black panels, electric-cyan accents, mono telemetry (`JetBrains Mono`) + `Chakra Petch` UI type
- Grid backdrop, CRT scanline overlay, hatch textures, live clock, event ticker
- Custom frameless titlebar, toast system, modal system, square checkboxes/scrollbars

## Run it

```bash
npm install
npm start          # launch the desktop app
npm run scan       # run the engine standalone (CLI health report)
npm test           # headless smoke test: boots the full UI in jsdom, walks every
                   # route, exercises gating + checkout (33 checks)
```

Open **`demo.html`** in any browser for a full mock-data preview of the UI — it is **self-contained**
(all CSS/JS/mock data inlined, so it also works in sandboxed preview iframes where external
files never load). After editing the UI, regenerate it with `npm run demo`.

## Build & sell it

```bash
npm run dist:win     # .exe installer (NSIS) + portable
npm run dist:mac     # .dmg + .zip
npm run dist:linux   # AppImage + .deb + .rpm
```

Artifacts land in `release/`. Code-signing and notarization configs slot into `package.json → build` (`signingCustomizationOptions` / `notarization` credentials) — required for store distribution and to avoid "unknown publisher" warnings.

## Business model (freemium, wired in the UI)

- **FREE** — full scans and inventory, but results are capped (8 rows), and these are locked behind the PRO modal:
  one-click junk cleaning, application uninstall, install-all updates, automatic firewall repair, report export
- **PRO — $29.99 one-time** (1 device) / **PRO Team — $79.99** (5 devices)
  Checkout is implemented end-to-end (plan picker, card form with live formatting + validation, license-key activation, persistence in `userData/license.json`, deactivate). It is a **demo checkout** — plug in Stripe/Lemon Squeezy/Paddle and call their API from `activateLicense()` to go live.

Suggested retail positioning: *"The system command center for people who refuse to install three sketchy 'PC optimizers'."*

## Project structure

```
aegis-sentinel/
├── main.js            # Electron main: frameless window, IPC API, license store
├── preload.js         # contextBridge (contextIsolation ON)
├── lib/scanner.js     # cross-platform system engine (pure Node, CLI-testable)
├── src/
│   ├── index.html     # app shell (sidebar / titlebar / view / statusbar)
│   ├── styles.css     # angular SOC design system
│   └── renderer.js    # SPA: 7 modules + PRO upsell/checkout
├── test/smoke.js      # jsdom end-to-end smoke test (33 checks)
├── demo.html          # browser preview with mock IPC data
└── assets/icon.png    # app icon (used by electron-builder for all targets)
```

## Roadmap to v1.1 (sellable deltas)

1. **Real-time shield** — tray icon + watcher on processes/ports/startup items
2. **Auto-update** — `electron-updater` with a release server
3. **Code signing** — Windows EV cert + Apple Developer notarization
4. **Localization** — FR/AR/DE packs (the UI strings are centralized in `renderer.js`)
5. **White-label** — themable accent color + product name via config
6. **Store listings** — Microsoft Store / Mac App Store / Snapcraft ready targets

## License

Proprietary — © 2026 AEGIS Labs. All rights reserved.
