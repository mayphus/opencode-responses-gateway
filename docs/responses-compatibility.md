# Responses API compatibility

This gateway has two deliberately different modes:

- **DeepSeek mode** translates Responses requests to Chat Completions. It is the
  small compatibility layer needed for `deepseek-v4-flash`.
- **Luna mode** transparently proxies the native OpenCode Go Responses endpoint.
  It does not reinterpret image, PDF, hosted-tool, or state fields.

`Forwarded` means the gateway preserves the official request and response. It
does not promise that OpenCode Go has enabled the corresponding hosted OpenAI
service for Luna. Those capabilities require a live OpenCode Go key to verify.

| Responses capability | Official API | DeepSeek V4 Flash | GPT 5.6 Luna | Gateway note |
|---|---:|---:|---:|---|
| Text input/output | Yes | Yes | Forwarded | Covered by automated tests |
| SSE streaming | Yes | Yes | Forwarded | Common Responses events are translated for DeepSeek |
| Function tools | Yes | Yes | Forwarded | Full call/output round trips tested |
| Free-form custom tools / `apply_patch` | Yes | Yes | Forwarded | Encoded as one-string Chat function only in DeepSeek mode |
| Parallel tool calls | Yes | Yes | Forwarded | Depends on the selected model |
| Reasoning effort | Yes | Yes | Forwarded | DeepSeek receives `reasoning_effort` |
| Stateless encrypted reasoning replay | Yes | Yes | Forwarded | DeepSeek uses a gateway-private opaque envelope |
| Structured JSON output (`text.format`) | Yes | No | Forwarded | Luna registry declares structured output support |
| Image input by URL or data URL | Yes | No, rejected | Forwarded | Luna registry declares image input support |
| PDF input | Yes | No | Forwarded | Luna registry declares PDF input support |
| File input by Files API ID | Yes | No | Partial | Responses field forwards, but this gateway does not expose `/v1/files` |
| Web search hosted tool | Yes | No | Forwarded, unverified | Requires a live Luna/OpenCode Go capability probe |
| File search hosted tool | Yes | No | Forwarded, unverified | Files/vector-store APIs are not proxied here |
| Code interpreter | Yes | No | Forwarded, unverified | Hosted execution must exist upstream |
| Computer use | Yes | No | Forwarded, unverified | Hosted execution must exist upstream |
| Image generation tool | Yes | No | Forwarded, unverified | Different from image input |
| Remote MCP/connectors | Yes | No | Forwarded, unverified | Hosted connection must exist upstream |
| Full-history multi-turn input | Yes | Yes | Forwarded | Recommended for DeepSeek |
| `previous_response_id` | Yes | No, rejected | Forwarded | Requires upstream response storage |
| `conversation` request field | Yes | No | Forwarded | Conversation management endpoints are not exposed |
| Store/background response | Yes | No | Forwarded | Upstream must support storage/background processing |
| Retrieve/delete/cancel a response | Yes | No | Forwarded | Luna mode proxies `/v1/responses/{id}` and `/cancel` |
| Prompt templates | Yes | No | Forwarded | Upstream availability unverified |
| Metadata, safety ID, service tier | Yes | No | Forwarded | Upstream availability unverified |
| Prompt-cache controls | Yes | No | Forwarded | Luna registry declares cache pricing, not every cache control |
| `include` extras, citations, annotations, logprobs | Yes | No | Forwarded | DeepSeek translation returns empty annotations/logprobs |
| WebSocket Responses transport | Yes | No | No | Gateway is HTTP/SSE only |
| `/v1/models` | Separate Models API | Local configured model | Local configured model | Added for client discovery; Codex does not require it |

## Deliberate boundary

The gateway will not bolt a separate image or search service onto a model. For
DeepSeek, unsupported features fail or remain unavailable. For Luna, native
Responses features pass through unchanged. This keeps tool semantics and
security ownership with the upstream provider instead of creating a second,
incompatible agent platform inside the gateway.

