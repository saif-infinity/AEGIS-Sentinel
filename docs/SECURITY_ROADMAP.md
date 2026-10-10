# Security and architecture improvement plan

This is a prioritized engineering backlog, not a claim that the product is already secure. V1 is a local heuristic inventory tool. The highest-risk gap before broad distribution is still the lack of target-OS release validation and signed binaries.

## P0 — before a public binary release

1. **Validate native builds on all targets.** Run unsigned packaging on clean Windows, macOS and Linux runners; install and launch the artifacts; exercise firewall/update prompts, Trash behavior, process stop, uninstall, sleep/resume and upgrades. The repository CI now tests the scanner and renderer on three OSes, but it is not a substitute for an Electron GUI/artifact test.
2. **Sign what users install.** Configure Windows Authenticode and macOS Developer ID signing, hardened runtime and notarization. Publish Linux package checksums. Do not distribute release artifacts from an unsigned development build.
3. **Protect the release path.** Require CI and at least one human review for changes to `main`, `main.js`, `preload.js`, `lib/scanner.js`, workflows and dependency locks. Restrict release/tag creation and keep signing credentials in protected CI secrets.
4. **Publish provenance.** Generate an SBOM for each release, attach SHA-256 checksums, record the source commit and build environment, and retain build logs/artifacts. Make a release reproducible enough that an independent maintainer can compare outputs.

## P1 — next engineering increment

1. **Add Electron integration tests.** Launch a real sandboxed `BrowserWindow` on each OS; verify the preload surface, CSP, sender rejection, blocked navigation/popups, confirmation cancellation, and the actual packaged file paths. The current jsdom test exercises renderer behavior but cannot prove Electron's runtime security settings.
2. **Add negative IPC tests.** Cover untrusted frame, wrong document URL, malformed payloads, stale scan token, expired token, more than 200 paths, path outside the scan roots, symlink replacement, changed file, PID reuse and stale application ID. Assert rejected requests cause no OS side effect.
3. **Inject the OS command runner.** Wrap `execFile` behind a small interface and unit-test each platform parser with captured Windows/macOS/Linux fixtures. This makes unavailable, malformed and partial command output deterministic to test without having every OS command available on the test host.
4. **Keep sensor status explicit.** Extend the `{available, error, items}` pattern to remaining inventories (notably installed applications and disk enumeration), with a visible distinction between “empty” and “query failed.” Include source and freshness for update metadata so stale local package indexes are not confused with a recent update check.

## P2 — resilience and maintainability

1. **Separate scanner domains.** As the scanner grows, split process, network/firewall, update/log, application and file collectors into focused modules, keeping shared command execution, path validation and result schemas centralized. Do this with contract tests to avoid behavior drift across platforms.
2. **Add resource and cancellation budgets.** Keep output byte limits, command timeouts, scan limits and per-operation concurrency caps in one documented policy. Add cancellation for long-running GUI scans and an explicit partial-result state when work is cancelled.
3. **Improve score explainability.** Version the heuristic weights, expose every input as verified/unknown/not-applicable, and test representative synthetic cases. Keep score changes informational; never market it as a security grade or malware verdict.
4. **Reduce external requests.** Consider bundling licensed fonts locally or use system-font fallbacks only. This removes a third-party request from the desktop UI and makes offline behavior deterministic.
5. **Plan updates safely.** Define a signed update feed and rollback policy before adding auto-update. Verify update signatures and channel policy in the main process; never execute update instructions received from the renderer.

## P3 — continuous assurance

- Add static analysis (for example, CodeQL) once repository permissions and alert ownership are configured; triage findings rather than suppressing them broadly.
- Keep Dependabot and `npm audit` active; review Electron, `electron-builder`, the `@electron/get` override and transitive build tools before each release.
- Run periodic threat-model reviews after changing IPC methods, process control, cleanup, application uninstall, update installation or the release workflow.
- Maintain a tested support matrix: exact OS versions, architectures, command availability, privilege behavior and known unknown/unavailable states.

## Exit criteria for calling V1 release-ready

- Three OS smoke/collector jobs pass, and separate clean-machine install/launch checks pass for each packaged target.
- No known high/critical dependency advisories remain; a reviewed SBOM and checksums are attached to release artifacts.
- Windows and macOS artifacts are signed/notarized; Linux packages have published checksums.
- Destructive-action negative tests prove that rejected or stale requests produce no file, process, package, firewall or update changes.
- User-facing documentation states the product's heuristic scope, permissions, network/font behavior, data handling and recovery/rollback steps.
