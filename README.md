# OpenCode Responses compatibility gateway

A narrow, stateless TypeScript gateway that accepts `POST /v1/responses` (or `/responses`), translates text, messages, function tools, and free-form custom tools to OpenAI-compatible chat completions, and translates JSON or SSE results back to Responses objects/events.

The default upstream is OpenCode Zen's chat-completions endpoint. Set `OPENCODE_CHAT_COMPLETIONS_URL=https://opencode.ai/zen/go/v1/chat/completions` for OpenCode Go. The gateway never forwards the client credential upstream: place the provider key only in `OPENCODE_API_KEY`. Optionally protect the private gateway with `GATEWAY_API_KEY`.

## Limits

- Text, reasoning effort, function tools, and free-form custom tools such as Codex `apply_patch` are supported. Custom tools are represented upstream as functions with one string `input`, then restored to native `custom_tool_call` items and streaming events. The gateway does not rewrite or repair tool input.
- Images are explicitly rejected instead of silently discarded or routed through a sidecar. Files, audio, reasoning summaries, hosted tools, tool search, namespace tools, and structured-output translation are not supported.
- Stateless: `previous_response_id` is rejected. Clients must send full conversation input, including prior function/custom calls and outputs.
- Only models served through OpenCode's chat-completions endpoint are compatible. Some Zen models already use Responses natively and do not need this gateway.

## Test

```sh
npm test
```

The Kubernetes manifests expose PB62 NodePort `32094` only to the `192.168.36.0/24` LAN and to in-cluster client pods labeled `access: gateway`. LAN clients do not need a bearer token. The real provider credential is loaded only from Kubernetes Secret `opencode-credentials`; it is never placed in a manifest.

`k8s/real-zen-smoke.yaml` and `k8s/real-zen-inspect.yaml` are direct-provider probes. `k8s/real-gateway-e2e.yaml` verifies non-streaming text, Responses SSE events, and a complete function-call/output round trip through the gateway.
