# WinGet publication

The x64 and arm64 release assets must have public, immutable HTTPS URLs. Replace
the version, URL, and SHA-256 placeholders in the manifest template, validate it
with `winget validate`, and submit the rendered manifest to
`microsoft/winget-pkgs`.

WinGet owns installation, PATH alias creation, upgrades, and uninstall. The
gateway CLI owns per-user configuration, DPAPI key storage, startup, and health.
An upgrade does not need to touch the saved key or ChatGPT configuration.
