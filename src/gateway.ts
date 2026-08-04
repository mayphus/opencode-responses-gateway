import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type RecordJson = Record<string, any>;

export interface GatewayConfig {
  upstreamUrl: string;
  upstreamWireApi?: "chat_completions" | "responses";
  upstreamApiKey?: string;
  gatewayApiKey?: string;
  configuredModel?: string;
  instanceId?: string;
  requestTimeoutMs: number;
}

export function loadConfig(env = process.env): GatewayConfig {
  return {
    upstreamUrl: env.OPENCODE_UPSTREAM_URL ?? env.OPENCODE_CHAT_COMPLETIONS_URL ?? "https://opencode.ai/zen/v1/chat/completions",
    upstreamWireApi: env.OPENCODE_UPSTREAM_WIRE_API === "responses" ? "responses" : "chat_completions",
    upstreamApiKey: env.OPENCODE_API_KEY,
    gatewayApiKey: env.GATEWAY_API_KEY,
    configuredModel: env.OPENCODE_MODEL,
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

function customToolNames(body: RecordJson): Set<string> {
  return new Set((Array.isArray(body.tools) ? body.tools : [])
    .filter((tool: RecordJson) => tool?.type === "custom" && typeof tool.name === "string")
    .map((tool: RecordJson) => tool.name));
}

function customToolInput(argumentsJson: unknown): string {
  if (typeof argumentsJson !== "string") return "";
  try {
    const parsed = JSON.parse(argumentsJson);
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object" && typeof parsed.input === "string") return parsed.input;
  } catch { /* Some compatible providers return the free-form input directly. */ }
  return argumentsJson;
}

function customToolParameters(): RecordJson {
  return {
    type: "object",
    properties: {
      input: { type: "string", description: "The complete raw input for this free-form tool." },
    },
    required: ["input"],
    additionalProperties: false,
  };
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
    if (pendingAssistant) {
      const hasContent = typeof pendingAssistant.content === "string" && pendingAssistant.content.length > 0;
      const hasToolCalls = Array.isArray(pendingAssistant.tool_calls) && pendingAssistant.tool_calls.length > 0;
      if (hasContent || hasToolCalls) messages.push(pendingAssistant);
    }
    pendingAssistant = undefined;
  };

  let activeReasoningContent: string | undefined;
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as RecordJson;
    if (item.type === "reasoning") {
      const reasoningContent = decodeReasoning(item.encrypted_content);
      if (reasoningContent) {
        activeReasoningContent = reasoningContent;
        if (!pendingAssistant) pendingAssistant = { role: "assistant", content: null };
        pendingAssistant.reasoning_content = reasoningContent;
      }
      continue;
    }
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      if (!pendingAssistant) pendingAssistant = { role: "assistant", content: null };
      if (!pendingAssistant.reasoning_content && activeReasoningContent) {
        pendingAssistant.reasoning_content = activeReasoningContent;
      }
      if (!pendingAssistant.tool_calls) pendingAssistant.tool_calls = [];
      pendingAssistant.tool_calls.push({
        id: item.call_id ?? item.id,
        type: "function",
        function: {
          name: item.name,
          arguments: item.type === "custom_tool_call"
            ? JSON.stringify({ input: typeof item.input === "string" ? item.input : "" })
            : typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
        },
      });
      continue;
    }
    if ((item.type === "message" || item.role) && item.role === "assistant") {
      if (!pendingAssistant) pendingAssistant = { role: "assistant", content: null };
      const content = textFromContent(item.content);
      if (content) pendingAssistant.content = `${pendingAssistant.content ?? ""}${content}`;
      continue;
    }
    flushAssistant();
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      messages.push({ role: "tool", tool_call_id: item.call_id, content: textFromContent(item.output) || String(item.output ?? "") });
    } else if (item.type === "message" || item.role) {
      const role = item.role === "developer" ? "system" : item.role;
      if (["system", "user"].includes(role)) {
        activeReasoningContent = undefined;
        messages.push({ role, content: textFromContent(item.content) });
      }
    }
  }
  flushAssistant();

  const request: RecordJson = { model: body.model, messages, stream: Boolean(body.stream) };
  if (body.max_output_tokens != null) request.max_tokens = body.max_output_tokens;
  if (typeof body.reasoning?.effort === "string" && body.reasoning.effort) {
    request.reasoning_effort = body.reasoning.effort;
  }
  for (const field of ["temperature", "top_p", "seed"]) {
    if (body[field] != null) request[field] = body[field];
  }
  if (Array.isArray(body.tools)) {
    const tools = body.tools.flatMap((tool: RecordJson) => {
      if (tool?.type === "function") return [{
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters ?? { type: "object", properties: {} },
          ...(tool.strict == null ? {} : { strict: tool.strict }),
        },
      }];
      if (tool?.type === "custom" && typeof tool.name === "string") return [{
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: customToolParameters(),
        },
      }];
      return [];
    });
    if (tools.length) {
      request.tools = tools;
      if (body.parallel_tool_calls != null) request.parallel_tool_calls = body.parallel_tool_calls;
    }
  }
  if (body.tool_choice != null && request.tools) {
    request.tool_choice = ["function", "custom"].includes(body.tool_choice?.type) && body.tool_choice.name
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

function outputFromChoice(choice: RecordJson, body: RecordJson): RecordJson[] {
  const message = choice?.message ?? {};
  const output: RecordJson[] = [];
  const customNames = customToolNames(body);
  if (typeof message.reasoning_content === "string" && message.reasoning_content) {
    output.push({
      id: `rs_${randomUUID().replaceAll("-", "")}`,
      type: "reasoning", summary: [], encrypted_content: encodeReasoning(message.reasoning_content),
    });
  }
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
    output.push(...message.tool_calls.map((call: RecordJson) => {
      const name = call.function?.name ?? "";
      if (customNames.has(name)) return {
        id: `ctc_${randomUUID().replaceAll("-", "")}`,
        type: "custom_tool_call", status: "completed", call_id: call.id,
        name, input: customToolInput(call.function?.arguments),
      };
      return {
        id: `fc_${randomUUID().replaceAll("-", "")}`,
        type: "function_call", status: "completed", call_id: call.id,
        name, arguments: call.function?.arguments ?? "{}",
      };
    }));
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

async function readRawBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += value.length;
    if (length > 16 * 1024 * 1024) throw new Error("Request body is too large");
    chunks.push(value);
  }
  return chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined;
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
  const customNames = customToolNames(body);
  const calls = new Map<number, { id: string; itemId: string; name: string; arguments: string; outputIndex: number; started: boolean; emittedArguments: number }>();
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
        call = { id: rawCall.id ?? `call_${randomUUID().replaceAll("-", "")}`, itemId: "", name: "", arguments: "", outputIndex: nextOutput++, started: false, emittedArguments: 0 };
        calls.set(index, call);
      }
      if (rawCall.function?.name) call.name = rawCall.function.name;
      if (rawCall.function?.arguments) call.arguments += rawCall.function.arguments;
      if (!call.started && call.name) {
        const custom = customNames.has(call.name);
        call.itemId = `${custom ? "ctc" : "fc"}_${randomUUID().replaceAll("-", "")}`;
        call.started = true;
        emit({
          type: "response.output_item.added", output_index: call.outputIndex,
          item: custom
            ? { id: call.itemId, type: "custom_tool_call", status: "in_progress", call_id: call.id, name: call.name, input: "" }
            : { id: call.itemId, type: "function_call", status: "in_progress", call_id: call.id, name: call.name, arguments: "" },
        });
      }
      if (call.started && !customNames.has(call.name) && call.arguments.length > call.emittedArguments) {
        const argumentDelta = call.arguments.slice(call.emittedArguments);
        call.emittedArguments = call.arguments.length;
        emit({ type: "response.function_call_arguments.delta", item_id: call.itemId, output_index: call.outputIndex, delta: argumentDelta });
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
    const custom = customNames.has(call.name);
    if (!call.started) {
      call.itemId = `${custom ? "ctc" : "fc"}_${randomUUID().replaceAll("-", "")}`;
      emit({
        type: "response.output_item.added", output_index: call.outputIndex,
        item: custom
          ? { id: call.itemId, type: "custom_tool_call", status: "in_progress", call_id: call.id, name: call.name, input: "" }
          : { id: call.itemId, type: "function_call", status: "in_progress", call_id: call.id, name: call.name, arguments: "" },
      });
    }
    let item: RecordJson;
    if (custom) {
      const input = customToolInput(call.arguments);
      if (input) emit({ type: "response.custom_tool_call_input.delta", item_id: call.itemId, output_index: call.outputIndex, delta: input });
      emit({ type: "response.custom_tool_call_input.done", item_id: call.itemId, output_index: call.outputIndex, input });
      item = { id: call.itemId, type: "custom_tool_call", status: "completed", call_id: call.id, name: call.name, input };
    } else {
      if (call.arguments.length > call.emittedArguments) {
        emit({ type: "response.function_call_arguments.delta", item_id: call.itemId, output_index: call.outputIndex, delta: call.arguments.slice(call.emittedArguments) });
      }
      emit({ type: "response.function_call_arguments.done", item_id: call.itemId, output_index: call.outputIndex, arguments: call.arguments });
      item = { id: call.itemId, type: "function_call", status: "completed", call_id: call.id, name: call.name, arguments: call.arguments };
    }
    indexedOutput.push({ outputIndex: call.outputIndex, item }); emit({ type: "response.output_item.done", output_index: call.outputIndex, item });
  }
  const output = indexedOutput.sort((a, b) => a.outputIndex - b.outputIndex).map(({ item }) => item);
  emit({ type: "response.completed", response: baseResponse(id, createdAt, body, "completed", output, usage) });
  res.end();
}

export function createHandler(config: GatewayConfig) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const requestUrl = new URL(req.url ?? "/", "http://gateway.local");
    if (req.method === "GET" && requestUrl.pathname === "/healthz") {
      return json(res, 200, {
        status: "ok",
        wire_api: config.upstreamWireApi ?? "chat_completions",
        model: config.configuredModel ?? null,
        instance_id: config.instanceId ?? null,
      });
    }
    if (config.gatewayApiKey) {
      const presented = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      if (!presented || !safeEqual(presented, config.gatewayApiKey)) return apiError(res, 401, "Invalid gateway API key", "authentication_error");
    }
    if (req.method === "GET" && requestUrl.pathname === "/v1/models") {
      const data = config.configuredModel
        ? [{ id: config.configuredModel, object: "model", created: 0, owned_by: "opencode" }]
        : [];
      return json(res, 200, { object: "list", data });
    }
    const responsePath = requestUrl.pathname === "/responses"
      ? ""
      : requestUrl.pathname.startsWith("/v1/responses")
        ? requestUrl.pathname.slice("/v1/responses".length)
        : undefined;
    if (config.upstreamWireApi === "responses" && responsePath !== undefined && ["GET", "POST", "DELETE"].includes(req.method ?? "")) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
      try {
        const upstreamUrl = new URL(config.upstreamUrl);
        upstreamUrl.pathname = upstreamUrl.pathname.replace(/\/$/, "") + responsePath;
        upstreamUrl.search = requestUrl.search;
        const headers: Record<string, string> = {};
        for (const name of ["accept", "content-type", "idempotency-key", "openai-beta"]) {
          const value = req.headers[name];
          if (typeof value === "string") headers[name] = value;
        }
        if (config.upstreamApiKey) headers.authorization = `Bearer ${config.upstreamApiKey}`;
        const rawBody = ["GET", "DELETE"].includes(req.method ?? "") ? undefined : await readRawBody(req);
        const upstream = await fetch(upstreamUrl, {
          method: req.method,
          headers,
          body: rawBody,
          signal: controller.signal,
        });
        const responseHeaders: Record<string, string> = {};
        for (const name of ["content-type", "cache-control", "x-request-id", "openai-processing-ms"]) {
          const value = upstream.headers.get(name);
          if (value) responseHeaders[name] = value;
        }
        res.writeHead(upstream.status, responseHeaders);
        if (!upstream.body) return res.end();
        const reader = upstream.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        return res.end();
      } catch (error) {
        if (!res.headersSent) return apiError(res, 502, error instanceof Error ? error.message : "Upstream request failed", "upstream_error");
        res.destroy(error instanceof Error ? error : undefined);
        return;
      } finally {
        clearTimeout(timeout);
      }
    }
    if (req.method !== "POST" || !["/v1/responses", "/responses"].includes(requestUrl.pathname)) return apiError(res, 404, "Not found", "not_found_error");
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
      return json(res, 200, baseResponse(id, Math.floor(Date.now() / 1000), body, "completed", outputFromChoice(result.choices?.[0] ?? {}, body), usageFrom(result.usage)));
    } catch (error) {
      if (!res.headersSent) return apiError(res, 502, error instanceof Error ? error.message : "Upstream request failed", "upstream_error");
      res.destroy(error instanceof Error ? error : undefined);
    } finally { clearTimeout(timeout); }
  };
}
