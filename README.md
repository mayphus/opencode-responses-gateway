# OpenCode Responses compatibility gateway

A narrow gateway that gives ChatGPT Desktop one local OpenAI Responses endpoint
for two OpenCode paths:

- `deepseek-v4-flash`: translate Responses to Chat Completions.
- `gpt-5.6-luna`: transparently forward OpenCode Go's native Responses API,
  including image and PDF input fields.

The gateway never forwards the ChatGPT client credential upstream. The provider
key is configured separately and, on Windows, encrypted for the current user
with DPAPI. The server binds to `127.0.0.1` in the CLI setup.

See [the feature matrix](docs/responses-compatibility.md) for the exact current
coverage and the difference between translated and native modes.

## Windows CLI and WinGet

The intended user experience is:

```powershell
winget install Mayphus.OpenCodeResponsesGateway
opencode-gateway setup
```

`setup` asks for the key and model, writes an isolated Codex profile, selects
that profile without replacing the rest of `~/.codex/config.toml`, installs a
per-user startup shortcut, starts the gateway, and checks health.

Later, switching to Luna is one command:

```powershell
opencode-gateway configure luna
```

Other commands include `status`, `start`, `stop`, `restart`, and
`startup install|remove`.

Build the WinGet-ready Windows x64 archive:

```sh
npm install
npm run build:windows
```

The manifest template is under `packaging/winget`. Publication still requires a
public immutable release URL and submission to the WinGet community repository.

## Translation-mode limits

- Text, reasoning effort, function tools, and free-form custom tools such as Codex `apply_patch` are supported. Custom tools are represented upstream as functions with one string `input`, then restored to native `custom_tool_call` items and streaming events. The gateway does not rewrite or repair tool input.
- Images are explicitly rejected in DeepSeek mode instead of silently discarded
  or routed through a sidecar. Files, audio, hosted tools, and structured-output
  translation are not supported in that mode.
- Stateless: `previous_response_id` is rejected. Clients must send full conversation input, including prior function/custom calls and outputs.
- Native Responses models use transparent pass-through; the gateway remains
  useful for local key protection, stable ChatGPT configuration, startup, and
  switching between providers.

## Test

```sh
npm test
```

The Kubernetes manifests expose PB62 NodePort `32094` only to the `192.168.36.0/24` LAN and to in-cluster client pods labeled `access: gateway`. LAN clients do not need a bearer token. The real provider credential is loaded only from Kubernetes Secret `opencode-credentials`; it is never placed in a manifest.

`k8s/real-zen-smoke.yaml` and `k8s/real-zen-inspect.yaml` are direct-provider probes. `k8s/real-gateway-e2e.yaml` verifies non-streaming text, Responses SSE events, and a complete function-call/output round trip through the gateway.
