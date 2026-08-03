OpenCode Responses Gateway for Windows
======================================

1. Double-click setup-gateway.cmd.
2. Paste the OpenCode API key. Windows encrypts it for the current user.
3. Accept the default Zen URL for deepseek-v4-flash-free.
4. Double-click start-gateway.cmd and keep its window open.
5. Open http://127.0.0.1:8080/healthz in a browser. It should show {"status":"ok"}.
6. In ChatGPT Desktop, open Settings > Configuration > Open config.toml.
7. Copy the contents of config-snippet.toml into config.toml.
8. Fully quit and reopen ChatGPT Desktop, then create a new task.

Start automatically with Windows
--------------------------------

After setup, double-click install-startup.cmd. It creates a shortcut in the
current user's Windows Startup folder and launches the gateway hidden at sign-in.
No administrator permission is required.

- stop-gateway.cmd stops the background gateway.
- uninstall-startup.cmd removes it from Windows Startup.
- start-gateway.cmd starts it visibly for troubleshooting.

The gateway listens only on this PC. The real OpenCode key is never placed in
ChatGPT config.toml and is never forwarded back to ChatGPT Desktop.

To switch to OpenCode Go later:
- Run setup-gateway.cmd again.
- Enter https://opencode.ai/zen/go/v1/chat/completions as the URL.
- Change model in config.toml to the OpenCode Go model name.

Stop the gateway by closing its window or pressing Ctrl+C.
