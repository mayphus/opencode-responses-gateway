import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { createHandler, toChatRequest } from "../src/gateway.ts";

let upstream: ReturnType<typeof createServer>;
let gateway: ReturnType<typeof createServer>;
let upstreamUrl = "";
let gatewayUrl = "";
let lastRequest: any;

before(async () => {
  upstream = createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c; lastRequest = JSON.parse(raw);
    if (lastRequest.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (lastRequest.tools && !lastRequest.messages.some((m: any) => m.role === "tool")) {
        res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_weather","type":"function","function":{"name":"weather","arguments":"{\\"city\\":"}}]}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Boston\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}}\n\n');
      } else {
        res.write('data: {"choices":[{"delta":{"role":"assistant","content":"hello "}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":"world"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n');
      }
      res.end('data: [DONE]\n\n'); return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    if (lastRequest.tools && !lastRequest.messages.some((m: any) => m.role === "tool")) {
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call_weather", type: "function", function: { name: "weather", arguments: "{\"city\":\"Boston\"}" } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }));
    } else res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "hello world" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as any).port}/v1/chat/completions`;
  gateway = createServer(createHandler({ upstreamUrl, requestTimeoutMs: 5000 }));
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  gatewayUrl = `http://127.0.0.1:${(gateway.address() as any).port}`;
});

after(async () => {
  gateway.closeAllConnections();
  upstream.closeAllConnections();
  await Promise.all([
    new Promise<void>((resolve, reject) => gateway.close((error) => error ? reject(error) : resolve())),
    new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve())),
  ]);
});

test("translates Responses messages, tools, and tool outputs", () => {
  const chat = toChatRequest({ model: "test", instructions: "be brief", input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "weather?" }] },
    { type: "function_call", call_id: "call_1", name: "weather", arguments: "{\"city\":\"Boston\"}" },
    { type: "function_call_output", call_id: "call_1", output: "sunny" },
  ], tools: [{ type: "function", name: "weather", description: "Weather", parameters: { type: "object" } }] });
  assert.deepEqual(chat.messages.map((m: any) => m.role), ["system", "user", "assistant", "tool"]);
  assert.equal(chat.messages[2].tool_calls[0].id, "call_1");
  assert.equal(chat.tools[0].function.name, "weather");
});

test("preserves opaque reasoning state for multi-step tool calls", () => {
  const encoded = "opencode-reasoning-v1:" + Buffer.from("provider-thought-state").toString("base64");
  const chat = toChatRequest({ model: "test", input: [
    { type: "reasoning", id: "rs_1", summary: [], encrypted_content: encoded },
    { type: "function_call", call_id: "call_1", name: "shell", arguments: "{}" },
    { type: "function_call_output", call_id: "call_1", output: "ok" },
  ] });
  assert.equal(chat.messages[0].reasoning_content, "provider-thought-state");
  assert.equal(chat.messages[0].tool_calls[0].id, "call_1");
});

test("rejects images instead of silently dropping them", () => {
  assert.throws(() => toChatRequest({ model: "test", input: [{
    type: "message", role: "user", content: [
      { type: "input_text", text: "describe this" },
      { type: "input_image", image_url: "data:image/png;base64,AA==" },
    ],
  }] }), /Image input is disabled/);
});

test("non-streaming text response", async () => {
  const response = await fetch(`${gatewayUrl}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "test", input: "hi" }) });
  const body: any = await response.json();
  assert.equal(response.status, 200); assert.equal(body.output[0].content[0].text, "hello world"); assert.equal(body.usage.total_tokens, 5);
  assert.equal(lastRequest.messages[0].content, "hi");
});

test("streaming text response uses Responses events", async () => {
  const response = await fetch(`${gatewayUrl}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "test", input: "hi", stream: true }) });
  const text = await response.text();
  assert.match(text, /event: response\.created/); assert.match(text, /event: response\.output_text\.delta/); assert.match(text, /hello /); assert.match(text, /event: response\.completed/);
});

test("tool-call round trip", async () => {
  const tools = [{ type: "function", name: "weather", parameters: { type: "object", properties: { city: { type: "string" } } } }];
  const first: any = await (await fetch(`${gatewayUrl}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "test", input: "weather?", tools }) })).json();
  assert.equal(first.output[0].type, "function_call"); assert.equal(first.output[0].call_id, "call_weather");
  const second: any = await (await fetch(`${gatewayUrl}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "test", input: [{ type: "message", role: "user", content: "weather?" }, first.output[0], { type: "function_call_output", call_id: first.output[0].call_id, output: "sunny" }], tools }) })).json();
  assert.equal(second.output[0].content[0].text, "hello world");
  assert.deepEqual(lastRequest.messages.map((m: any) => m.role), ["user", "assistant", "tool"]);
});

test("streaming tool call response", async () => {
  const response = await fetch(`${gatewayUrl}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "test", input: "weather?", stream: true, tools: [{ type: "function", name: "weather", parameters: { type: "object" } }] }) });
  const text = await response.text();
  assert.match(text, /response\.function_call_arguments\.delta/); assert.match(text, /call_weather/); assert.match(text, /Boston/); assert.match(text, /response\.completed/);
});
