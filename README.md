# OpenCode Responses Gateway

A small local CLI that lets ChatGPT Desktop or Codex use OpenCode models through
an OpenAI Responses-compatible endpoint.

- `deepseek-v4-flash`: translates Responses requests to Chat Completions.
- `gpt-5.6-luna`: transparently forwards OpenCode Go's native Responses API,
  including image and PDF inputs.

The gateway listens only on `127.0.0.1`, requires a generated local bearer
token, and keeps the provider key in the operating system's credential store.

## Install and set up

Download the archive for your OS and architecture from GitHub Actions or a
tagged release, put `opencode-gateway` on `PATH`, then run:

```sh
opencode-gateway setup
```

Setup selects a model, saves the provider key securely, creates an isolated
Codex profile, installs per-user startup, starts the service, and checks health.

Credential backends:

| Platform | Architectures | Provider-key storage | Startup |
|---|---|---|---|
| Windows | x64, arm64 | DPAPI | Per-user Startup shortcut |
| macOS | x64, arm64 | Login Keychain | LaunchAgent |
| Linux (glibc) | x64, arm64 | Secret Service (`secret-tool`) | systemd user service |

On Windows, add the small read-only Mayphus source once, then install:

```powershell
winget source add --name mayphus --arg https://winget.mayphus.org/api/ --type Microsoft.Rest --explicit --accept-source-agreements
winget install Mayphus.OpenCodeResponsesGateway --source mayphus
opencode-gateway setup
```

The source-add command needs Administrator approval. Later releases use the
normal command `winget upgrade Mayphus.OpenCodeResponsesGateway --source mayphus`.
The package is not submitted to Microsoft's community repository.

## Commands

```text
opencode-gateway setup [deepseek|luna]
opencode-gateway configure <deepseek|luna>
opencode-gateway status
opencode-gateway start
opencode-gateway stop
opencode-gateway restart
opencode-gateway startup install|remove
```

## Build and test

Node.js 24.14.1 is used for release builds.

```sh
npm ci --ignore-scripts
npm test
npm run build
npm run build:winget-source
```

The build produces a native single-executable archive and SHA-256 checksum in
`dist/`. GitHub Actions repeats the tests and native smoke test on six runners:
Linux, macOS, and Windows, each on x64 and arm64.
The Windows CI job also installs the published release through the live custom
WinGet source and verifies the installed CLI version.

## Compatibility and security

- [Responses API feature matrix](docs/responses-compatibility.md)
- [Security review](docs/security-review.md)
- [Security policy](SECURITY.md)

DeepSeek mode rejects images rather than discarding or routing them through a
sidecar. Luna mode forwards native Responses fields unchanged. The gateway does
not add separate image or web-search providers.
