# WinGet publication

The release asset must have a public, immutable HTTPS URL. Build it with
`npm run build:windows`, replace the three placeholders in the manifest
template, validate it with `winget validate`, and submit the resulting manifest
to `microsoft/winget-pkgs`.

WinGet owns installation, PATH alias creation, upgrades, and uninstall. The
gateway CLI owns per-user configuration, DPAPI key storage, startup, and health.
An upgrade does not need to touch the saved key or ChatGPT configuration.
