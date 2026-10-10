# AEGIS Sentinel V1 — architecture and trust boundaries

## Runtime shape

AEGIS Sentinel is a local Electron desktop application with four layers:

1. **Renderer (`src/renderer.js`)** — presents dashboard, file, process, application, network, startup/service, audit and update views. It treats sensor output as descriptive/heuristic, not as an antivirus verdict.
2. **Preload (`preload.js`)** — exposes a frozen, method-specific API through `contextBridge`. The renderer does not receive Node.js or a generic `invoke(channel, payload)` method.
3. **Main process (`main.js`)** — owns the window, checks that IPC came from the expected main frame and exact local app document, validates identifiers, keeps short-lived scan sessions, applies report allowlists and requests native confirmation before sensitive actions.
4. **Scanner (`lib/scanner.js`)** — collects local OS data using Node APIs and fixed OS commands. External commands use `execFile` argument arrays; the scanner does not upload results to an AEGIS service.

`demo.html` is a generated browser mock. Its bridge is simulated and cannot perform real cleanup, process termination or system changes.

## Trust boundaries

```text
OS / local files / command output
              │
              ▼
       scanner (main only)
              │ bounded data
              ▼
main process ── fixed IPC methods ── preload ── renderer
     │                                         │
     ├── native confirmation dialogs           └── untrusted display/input
     ├── report allowlist
     └── opaque app IDs and expiring scan tokens
```

The renderer is treated as potentially compromised. Electron is configured with context isolation, sandboxing, disabled Node integration, restrictive CSP, blocked popups/navigation/webviews and denied permission requests. Main-process handlers also check the IPC sender; renderer-side restrictions alone are not considered an authorization boundary.

The network assessment joins the OS-reported non-loopback listening endpoints to a fresh process inventory by PID. It separately counts listeners whose owner has a process-risk heuristic and listeners that could not be attributed. This is best-effort correlation across independently sampled OS sources—not a stable socket/process identity guarantee or a malware verdict. The posture score applies separate, bounded warnings for process-risk listeners and risk-marked startup/service entries; incomplete source or attribution coverage is also recorded as an informational finding. These weights are heuristics, not probabilities or malware verdicts.

The startup/service collector is read-only: it inspects Windows services, startup commands and logon/boot tasks; macOS launchd jobs and property lists; and Linux systemd units plus XDG autostart entries. Source coverage is recorded individually, with unavailable sources treated as unknown. Running service PIDs can be linked directly to process and listener snapshots. A configured command that merely matches a process executable path is labeled a candidate and is not treated as proof of ownership. These independently sampled sources can race or be permission-limited; the collector never disables, removes or launches an entry.

The main process owns destructive or system-changing operations:

- **File cleanup:** a recent, expiring junk-scan token; only scanned old temporary/cache candidates; path/root, age, type, size and modification-time revalidation; per-file revalidation; a native confirmation; move to the OS Trash. Large-file and duplicate scans are informational only.
- **Process stop:** numeric PID validation, protected-process checks, fresh inventory, native confirmation and identity revalidation (name/path and a start identity where the OS exposes one). Linux/macOS use a termination signal; Windows uses `taskkill` for the selected PID.
- **Application removal:** opaque inventory IDs and a fresh OS-derived record; only supported uninstall methods are enabled; native confirmation.
- **Firewall/update actions:** explicit native confirmation; commands run with the current app user's privileges. Linux administrator commands are non-interactive (`sudo -n`); the app does not silently elevate itself.
- **Audit export:** the main process reconstructs a small allowlisted JSON summary rather than serializing renderer-provided raw scan objects.

## Data and privacy

Process names, executable paths, local addresses, OS error messages and filesystem paths may be shown locally because they are needed for review. They are not included in the exported audit summary. The report drops hostname, username, process/service/startup names, command lines, paths, remote addresses and raw log messages, includes aggregate counts for correlated-risk/unattributed listeners and startup-risk items, and keeps unavailable counts as `null` rather than presenting them as zero.

The application shell can request interface fonts from Google Fonts. This may disclose normal web-request metadata to Google; it is not scan-result telemetry. The Content Security Policy disallows renderer connections to application APIs (`connect-src 'none'`). The scanner itself has no AEGIS telemetry endpoint.

## Security scope and assumptions

- This is a local inventory and heuristic posture tool, **not** an antivirus, malware scanner, vulnerability scanner, firewall replacement or security certification.
- A local administrator, malware already running as the same user, a modified installation, compromised build dependency or compromised operating system is outside the protection boundary. The app inherits the user's permissions and cannot provide trustworthy measurements against an attacker who controls the host.
- OS commands may be missing, permission-limited or return partial data. Unknown and partial states should remain visible; they must not be converted into clean findings.
- The application currently has no signed auto-update channel. Obtain builds only from a trusted distribution path and verify release checksums/signatures when those are introduced.

## Maintainer invariants

When changing this architecture, preserve these invariants:

1. No generic renderer IPC, Node integration, remote navigation or remotely loaded executable code.
2. Validate every IPC payload in the main process; do not trust renderer-hidden buttons or client-side checks.
3. Keep destructive actions opt-in, bounded, identity/path revalidated and backed by native confirmation.
4. Treat missing/denied sensor data as unknown; never infer “safe” from an empty response.
5. Export only allowlisted summary fields; never serialize raw scan results by default.
6. Keep the demo inert and regenerate it from the committed template and UI sources.
