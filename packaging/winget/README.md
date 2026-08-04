# Custom WinGet source

This repository uses a small, stateless `Microsoft.Rest` source instead of
submitting to `microsoft/winget-pkgs`. It publishes only immutable GitHub release
URLs and their SHA-256 hashes. The source runs at:

```text
https://opencode-gateway-winget-source.mayphus.workers.dev/api/
```

Add it once from an Administrator terminal:

```powershell
winget source add --name mayphus --arg https://opencode-gateway-winget-source.mayphus.workers.dev/api/ --type Microsoft.Rest --explicit --accept-source-agreements
```

Install and upgrade from a normal terminal:

```powershell
winget install Mayphus.OpenCodeResponsesGateway --source mayphus
winget upgrade Mayphus.OpenCodeResponsesGateway --source mayphus
```

For a new release, update the version, URLs, and hashes in
`worker/package.ts`, run `npm run check`, and deploy with
`npm run deploy:winget-source`. The tracked singleton manifest remains useful
for local `winget validate` checks, but it is not submitted to Microsoft.

WinGet owns installation, PATH alias creation, upgrades, and uninstall. The
gateway CLI owns per-user configuration, DPAPI key storage, startup, and health.
An upgrade does not need to touch the saved key or ChatGPT configuration.
