# Security review

Review date: 2026-08-04

Scope: gateway request handling, provider credentials, local authentication,
configuration writes, process lifecycle, build dependencies, release artifacts,
GitHub Actions, the custom WinGet source, and files intended for public
publication.

## Threat model

The gateway protects a provider API key from accidental disclosure and prevents
other local users, browser-origin requests, or LAN clients from using it without
the generated local bearer token. It does not attempt to isolate mutually
untrusted processes running as the same OS user, because those processes can
read that user's configuration and invoke their credential store.

## Findings and remediation

| Severity | Finding | Resolution |
|---|---|---|
| High | Response and model endpoints accepted unauthenticated local/LAN requests, allowing unauthorized provider usage. | Setup now generates a 256-bit local bearer token. Codex obtains it through command-backed provider authentication, and the gateway verifies it with constant-time comparison. |
| Medium | A stale PID file could refer to a reused PID and stop an unrelated process. | PID records now include a random instance ID and are accepted only when `/healthz` returns the matching instance. |
| Medium | Credential handling and setup were Windows-only. | Provider keys now use DPAPI on Windows, Keychain on macOS, and Secret Service on Linux. No plaintext fallback is provided. |
| Medium | The portable build depended on semver ranges and a mutable local build environment. | Build dependencies are exactly pinned with an npm lockfile; CI uses an exact Node version and full action commit SHAs. |
| Low | Historical Kubernetes files disclosed personal LAN topology and included mutable runtime installation probes. | Personal deployment and probe manifests were removed from the public CLI repository. |
| Low | Settings and PID writes were not atomic, and Unix directory permissions were implicit. | Configuration writes use same-directory atomic replacement with mode `0600`; private directories use `0700`; Windows setup installs a user-only ACL. |
| Low | A custom package source could add a mutable service, secret, or unrelated package surface. | The WinGet source is a stateless 8 KiB Worker with no bindings or secrets, exposes one package, and points only to immutable release URLs with verified SHA-256 hashes. |

## Verification

- Automated tests cover bearer rejection/acceptance, instance identity, request
  translation, native Responses forwarding, reasoning replay, streaming, and
  function/custom-tool round trips.
- CI runs tests and builds/smoke-tests native executables on Linux, macOS, and
  Windows, for x64 and arm64.
- WinGet contract tests cover source discovery, exact/search matching, manifest
  selection, portable installers, invalid input, and unsupported methods. A
  Windows Actions job installs the release from the deployed source and checks
  the installed CLI version.
- `npm audit` reports no known vulnerabilities. CI also checks npm registry
  signatures, CodeQL, and pull-request dependency changes.
- The complete local Git history was scanned for common provider, GitHub, AWS,
  and private-key patterns; no credential material or oversized hidden blobs
  were found before publication.
- Release jobs grant write permissions only to the jobs that attest or publish
  artifacts. All referenced GitHub actions are pinned to full commit SHAs.
- The WinGet service has no credential or storage bindings. Its published x64
  and arm64 hashes were compared directly with GitHub Release asset digests.

## Residual risks

- Executables are not Authenticode-signed or Developer-ID-notarized. GitHub
  attestations and SHA-256 checksums establish provenance but do not suppress OS
  trust prompts.
- Linux setup requires a functioning Secret Service and `secret-tool`; headless
  servers can supply `OPENCODE_API_KEY` to the `serve` process instead.
- Native Luna features are forwarded unchanged. Their data retention and hosted
  tool behavior remain governed by OpenCode Go and the upstream model provider.
- Updating the custom WinGet source is an explicit release step; a forgotten
  source deployment delays `winget upgrade` but cannot change an installed
  binary or silently select an unverified archive.
