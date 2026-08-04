# Security policy

## Supported versions

Only the latest release is supported with security fixes.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository. Do not
open a public issue containing provider keys, local bearer tokens, private
network details, or a working exploit.

## Security boundaries

- The provider key is stored with Windows DPAPI, macOS Keychain, or Linux
  Secret Service. It is not written to gateway settings or Codex configuration.
- The local listener binds to `127.0.0.1` and requires a random bearer token.
- The gateway is not an authorization boundary between mutually untrusted
  processes running as the same operating-system user.
- Release archives are unsigned at the platform level. Tagged releases include
  SHA-256 checksums and GitHub artifact attestations; verify both before use.
