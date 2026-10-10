# Security policy

AEGIS Sentinel is a local inventory and heuristic posture tool. It is not an antivirus, malware scanner, vulnerability scanner or security guarantee. Please do not use its score as the only basis for an incident-response or safety decision.

## Reporting a vulnerability

Please report suspected vulnerabilities privately using GitHub's **Report a vulnerability** option for this repository, if enabled. If private vulnerability reporting is unavailable, contact the repository maintainers through a private channel rather than opening a public issue. Do not include passwords, tokens, full logs, hostnames, usernames, process lists or other personal data in a report unless strictly necessary; redact them first.

Include the affected version/commit, operating system, impact, and concise reproduction steps. Avoid destructive testing on systems you do not own or administer. Please allow maintainers time to investigate and prepare a fix before public disclosure.

## Current assurance status

- CI checks JavaScript syntax, renderer/scanner regressions, demo freshness and dependency advisories on Linux, Windows and macOS.
- This CI does not yet build/install/test signed Electron packages or prove platform-specific GUI behavior.
- The project has not yet configured Windows code signing, macOS signing/notarization, a signed update channel, or a formal release provenance/SBOM process.

See [the architecture and trust-boundary notes](docs/ARCHITECTURE.md) and the [security improvement roadmap](docs/SECURITY_ROADMAP.md) for scope, residual risks and planned work.
