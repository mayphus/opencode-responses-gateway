OpenCode Responses Gateway
==========================

Run this once after installing the executable:

  opencode-gateway setup

The command asks for the OpenCode key, configures a dedicated ChatGPT/Codex
profile, installs per-user automatic startup, starts the local gateway, and
checks its health.

Credential storage:

  Windows  Windows DPAPI for the current user
  macOS    Login Keychain
  Linux    Secret Service via secret-tool/libsecret

The provider key is never written to the settings or Codex configuration.
The gateway listens only on 127.0.0.1:8080 and requires a random local bearer
token that Codex obtains through the CLI's command-backed authentication.

Useful commands:

  opencode-gateway status
  opencode-gateway configure luna
  opencode-gateway configure deepseek
  opencode-gateway restart
  opencode-gateway stop
  opencode-gateway startup remove
