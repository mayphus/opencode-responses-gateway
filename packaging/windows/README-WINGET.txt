OpenCode Responses Gateway
==========================

After WinGet installs this package, open Windows Terminal and run:

  opencode-gateway setup

That one command asks for the OpenCode key, lets you choose DeepSeek V4 Flash
or GPT 5.6 Luna, configures ChatGPT Desktop, installs per-user automatic
startup, starts the local gateway, and checks its health.

Useful commands:

  opencode-gateway status
  opencode-gateway configure luna
  opencode-gateway configure deepseek
  opencode-gateway restart
  opencode-gateway stop
  opencode-gateway startup remove

The provider key is protected with Windows DPAPI for the current Windows user.
The gateway listens only on 127.0.0.1:8080.

