import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type RecordJson = Record<string, any>;

export interface GatewayConfig {
  upstreamUrl: string;
  upstreamApiKey?: string;
  gatewayApiKey?: string;
  requestTimeoutMs: number;
}

export function loadConfig(env = process.env): GatewayConfig {
  return {
    upstreamUrl: env.OPENCODE_CHAT_COMPLETIONS_URL ?? "https://opencode.ai/zen/v1/chat/completions",
    upstreamApiKey: env.OPENCODE_API_KEY,
    gatewayApiKey: env.GATEWAY_API_KEY,
    requestTimeoutMs: Number(env.REQUEST_TIMEOUT_MS ?? 300_000),
  };
}

function safeEqual(left: string, right: string): boolean {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    const p = part as RecordJson;
    if (["input_text", "output_text", "text"].includes(p.type) && typeof p.text === "string") return p.text;
    return "";
  }).join("");
}

function containsImageContent(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsImageContent);
  if (!value || typeof value !== "object") return false;
  const record = value as RecordJson;
  if (["input_image", "image_url"].includes(record.type)) return true;
  return Object.values(record).some(containsImageContent);
}

const REASONING_PREFIX = "opencode-reasoning-v1:";

function encodeReasoning(content: string): string {
  return REASONING_PREFIX + Buffer.from(content, "utf8").toString("base64");
}

function decodeReasoning(content: unknown): string | undefined {
  if (typeof content !== "string" || !content.startsWith(REASONING_PREFIX)) return undefined;
  try { return Buffer.from(content.slice(REASONING_PREFIX.length), "base64").toString("utf8"); }
  catch { return undefined; }
}

export function toChatRequest(body: RecordJson): RecordJson {
  if (!body || typeof body !== "object") throw new Error("Request body must be a JSON object");
  if (body.previous_response_id) throw new Error("previous_response_id is not supported; send full conversation input");
  if (typeof body.model !== "string" || !body.model) throw new Error("model is required");
  if (containsImageContent(body.input)) {
    throw new Error("Image input is disabled: configure and verify a trusted vision-capable upstream before enabling image forwarding");
  }

  const messages: RecordJson[] = [];
  if (typeof body.instructions === "string" && body.instructions) {
    messages.push({ role: "system", content: body.instructions });
  }
  const input = typeof body.input === "string"
    ? [{ type: "message", role: "user", content: body.input }]
    : Array.isArray(body.input) ? body.input : [];

  let pendingAssistant: RecordJson | undefined;
  const flushAssistant = () => {
    if (pendingAssistant) messages.push(pendingAssistant);
    pendingAssistant = undefined;
  };

  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as RecordJson;
    if (item.type === "reasoning") {
      const reasoningContent = decodeReasoning(item.encrypted_content);
      if (reasoningContent) {
        if (!pendingAssistant) pendingAssistant = { role: "assistant", content: null };
        pendingAssistant.reasoning_content = reasoningContent;
      }
      continue;
    }
    if (item.type === "function_call") {
      if (!pendingAssistant) pendingAssistant = { role: "assistant", content: null };
      if (!pendingAssistant.tool_calls) pendingAssistant.tool_calls = [];
      pendingAssistant.tool_calls.push({
        id: item.call_id ?? item.id,
        type: "function",
        function: { name: item.name, arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}) },
      });
      continue;
    }
    flushAssistant();
    if (item.type === "function_call_output") {
      messages.push({ role: "tool", tool_call_id: item.call_id, content: textFromContent(item.output) || String(item.output ?? "") });
    } else if (item.type === "message" || item.role) {
      const role = item.role === "developer" ? "system" : item.role;
      if (["system", "user", "assistant"].includes(role)) messages.push({ role, content: textFromContent(item.content) });
    }
  }
  flushAssistant();

  const request: RecordJson = { model: body.model, messages, stream: Boolean(body.stream) };
  if (body.max_output_tokens != null) request.max_tokens = body.max_output_tokens;
  for (const field of ["temperature", "top_p", "parallel_tool_calls", "seed"]) {
    if (body[field] != null) request[field] = body[field];
  }
  if (Array.isArray(body.tools)) {
    request.tools = body.tools.filter((t: RecordJson) => t?.type === "function").map((tool: RecordJson) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ?? { type: "object", properties: {} },
        ...(tool.strict == null ? {} : { strict: tool.strict }),
      },
    }));
  }
  if (body.tool_choice != null) {
    request.tool_choice = body.tool_choice?.type === "function" && body.tool_choice.name
      ? { type: "function", function: { name: body.tool_choice.name } }
      : body.tool_choice;
  }
  return request;
}

function usageFrom(chat: RecordJson | undefined): RecordJson | null {
  if (!chat) return null;
  const input = Number(chat.prompt_tokens ?? 0);
  const output = Number(chat.completion_tokens ?? 0);
  return { input_tokens: input, input_tokens_details: { cached_tokens: 0 }, output_tokens: output, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: Number(chat.total_tokens ?? input + output) };
}

function baseResponse(id: string, createdAt: number, body: RecordJson, status: string, output: RecordJson[], usage: RecordJson | null): RecordJson {
  return {
    id, object: "response", created_at: createdAt, status, error: null, incomplete_details: null,
    instructions: body.instructions ?? null, max_output_tokens: body.max_output_tokens ?? null, model: body.model,
    output, parallel_tool_calls: body.parallel_tool_calls ?? true, previous_response_id: null,
    reasoning: body.reasoning ?? { effort: null, summary: null }, store: false,
    temperature: body.temperature ?? null, text: body.text ?? { format: { type: "text" } },
    tool_choice: body.tool_choice ?? "auto", tools: body.tools ?? [], top_p: body.top_p ?? null,
    truncation: body.truncation ?? "disabled", usage,
  };
}

function outputFromChoice(choice: RecordJson): RecordJson[] {
  const message = choice?.message ?? {};
  const output: RecordJson[] = [];
  if (typeof message.reasoning_content === "string" && message.reasoning_content) {
    output.push({
      id: `rs_${randomUUID().replaceAll("-", "")}`,
      type: "reasoning", summary: [], encrypted_content: encodeReasoning(message.reasoning_content),
    });
  }
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
    output.push(...message.tool_calls.map((call: RecordJson) => ({
      id: `fc_${randomUUID().replaceAll("-", "")}`,
      type: "function_call", status: "completed", call_id: call.id,
      name: call.function?.name ?? "", arguments: call.function?.arguments ?? "{}",
    })));
  }
  const text = textFromContent(message.content);
  if (text || output.length === 0) {
    output.push({
      id: `msg_${randomUUID().replaceAll("-", "")}`, type: "message", status: "completed", role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }
  return output;
}

function json(res: ServerResponse, status: number, value: Json | RecordJson): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

function apiError(res: ServerResponse, status: number, message: string, type = "invalid_request_error"): void {
  json(res, status, { error: { message, type, param: null, code: null } });
}

async function readBody(req: IncomingMessage): Promise<RecordJson> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 4 * 1024 * 1024) throw new Error("Request body is too large");
  }
  try { return JSON.parse(raw || "{}"); } catch { throw new Error("Request body is not valid JSON"); }
}

function sse(res: ServerResponse, event: RecordJson): void {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<RecordJson> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (!data || data === "[DONE]") continue;
      try { yield JSON.parse(data); } catch { /* ignore provider comments or malformed optional chunks */ }
    }
    if (done) break;
  }
}

async function proxyStream(upstream: Response, res: ServerResponse, body: RecordJson): Promise<void> {
  if (!upstream.body) throw new Error("Upstream returned no stream");
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
  const id = `resp_${randomUUID().replaceAll("-", "")}`;
  const createdAt = Math.floor(Date.now() / 1000);
  let sequence = 0;
  const emit = (event: RecordJson) => sse(res, { ...event, sequence_number: sequence++ });
  emit({ type: "response.created", response: baseResponse(id, createdAt, body, "in_progress", [], null) });
  emit({ type: "response.in_progress", response: baseResponse(id, createdAt, body, "in_progress", [], null) });

  let messageId = "";
  let messageOutputIndex = -1;
  let text = "";
  let reasoningId = "";
  let reasoningOutputIndex = -1;
  let reasoningContent = "";
  let usage: RecordJson | null = null;
  const calls = new Map<number, { id: string; itemId: string; name: string; arguments: string; outputIndex: number }>();
  let nextOutput = 0;
  const ensureMessage = () => {
    if (messageId) return;
    messageId = `msg_${randomUUID().replaceAll("-", "")}`;
    const outputIndex = nextOutput++; messageOutputIndex = outputIndex;
    emit({ type: "response.output_item.added", output_index: outputIndex, item: { id: messageId, type: "message", status: "in_progress", role: "assistant", content: [] } });
    emit({ type: "response.content_part.added", item_id: messageId, output_index: outputIndex, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
  };

  for await (const chunk of parseSse(upstream.body)) {
    if (chunk.usage) usage = usageFrom(chunk.usage);
    const delta = chunk.choices?.[0]?.delta ?? {};
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
      if (!reasoningId) {
        reasoningId = `rs_${randomUUID().replaceAll("-", "")}`;
        reasoningOutputIndex = nextOutput++;
        emit({ type: "response.output_item.added", output_index: reasoningOutputIndex, item: { id: reasoningId, type: "reasoning", summary: [] } });
      }
      reasoningContent += delta.reasoning_content;
    }
    if (typeof delta.content === "string" && delta.content) {
      ensureMessage(); text += delta.content;
      emit({ type: "response.output_text.delta", item_id: messageId, output_index: messageOutputIndex, content_index: 0, delta: delta.content, logprobs: [] });
    }
    for (const rawCall of delta.tool_calls ?? []) {
      const index = Number(rawCall.index ?? 0);
      let call = calls.get(index);
      if (!call) {
        call = { id: rawCall.id ?? `call_${randomUUID().replaceAll("-", "")}`, itemId: `fc_${randomUUID().replaceAll("-", "")}`, name: rawCall.function?.name ?? "", arguments: "", outputIndex: nextOutput++ };
        calls.set(index, call);
        emit({ type: "response.output_item.added", output_index: call.outputIndex, item: { id: call.itemId, type: "function_call", status: "in_progress", call_id: call.id, name: call.name, arguments: "" } });
      }
      if (rawCall.function?.name) call.name = rawCall.function.name;
      if (rawCall.function?.arguments) {
        call.arguments += rawCall.function.arguments;
        emit({ type: "response.function_call_arguments.delta", item_id: call.itemId, output_index: call.outputIndex, delta: rawCall.function.arguments });
      }
    }
  }

  const indexedOutput: Array<{ outputIndex: number; item: RecordJson }> = [];
  if (reasoningId) {
    const item = { id: reasoningId, type: "reasoning", summary: [], encrypted_content: encodeReasoning(reasoningContent) };
    indexedOutput.push({ outputIndex: reasoningOutputIndex, item });
    emit({ type: "response.output_item.done", output_index: reasoningOutputIndex, item });
  }
  if (messageId) {
    emit({ type: "response.output_text.done", item_id: messageId, output_index: messageOutputIndex, content_index: 0, text, logprobs: [] });
    emit({ type: "response.content_part.done", item_id: messageId, output_index: messageOutputIndex, content_index: 0, part: { type: "output_text", text, annotations: [] } });
    const item = { id: messageId, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] };
    indexedOutput.push({ outputIndex: messageOutputIndex, item }); emit({ type: "response.output_item.done", output_index: messageOutputIndex, item });
  }
  for (const call of [...calls.values()].sort((a, b) => a.outputIndex - b.outputIndex)) {
    emit({ type: "response.function_call_arguments.done", item_id: call.itemId, output_index: call.outputIndex, arguments: call.arguments });
    const item = { id: call.itemId, type: "function_call", status: "completed", call_id: call.id, name: call.name, arguments: call.arguments };
    indexedOutput.push({ outputIndex: call.outputIndex, item }); emit({ type: "response.output_item.done", output_index: call.outputIndex, item });
  }
  const output = indexedOutput.sort((a, b) => a.outputIndex - b.outputIndex).map(({ item }) => item);
  emit({ type: "response.completed", response: baseResponse(id, createdAt, body, "completed", output, usage) });
  res.end();
}

export function createHandler(config: GatewayConfig) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === "/healthz") return json(res, 200, { status: "ok" });
    if (req.method !== "POST" || !["/v1/responses", "/responses"].includes(req.url ?? "")) return apiError(res, 404, "Not found", "not_found_error");
    if (config.gatewayApiKey) {
      const presented = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      if (!presented || !safeEqual(presented, config.gatewayApiKey)) return apiError(res, 401, "Invalid gateway API key", "authentication_error");
    }
    let body: RecordJson;
    let chat: RecordJson;
    try { body = await readBody(req); chat = toChatRequest(body); }
    catch (error) { return apiError(res, 400, error instanceof Error ? error.message : "Invalid request"); }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
      const headers: Record<string, string> = { "content-type": "application/json", accept: body.stream ? "text/event-stream" : "application/json" };
      if (config.upstreamApiKey) headers.authorization = `Bearer ${config.upstreamApiKey}`;
      const upstream = await fetch(config.upstreamUrl, { method: "POST", headers, body: JSON.stringify(chat), signal: controller.signal });
      if (!upstream.ok) {
        const detail = await upstream.text();
        return apiError(res, upstream.status, `Upstream error (${upstream.status}): ${detail.slice(0, 500)}`, "upstream_error");
      }
      if (body.stream) return await proxyStream(upstream, res, body);
      const result = await upstream.json() as RecordJson;
      const id = `resp_${randomUUID().replaceAll("-", "")}`;
      return json(res, 200, baseResponse(id, Math.floor(Date.now() / 1000), body, "completed", outputFromChoice(result.choices?.[0] ?? {}), usageFrom(result.usage)));
    } catch (error) {
      if (!res.headersSent) return apiError(res, 502, error instanceof Error ? error.message : "Upstream request failed", "upstream_error");
      res.destroy(error instanceof Error ? error : undefined);
    } finally { clearTimeout(timeout); }
  };
}
