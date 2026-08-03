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
    const requestedTool = lastRequest.tools?.[0]?.function?.name;
    const hasToolOutput = lastRequest.messages.some((m: any) => m.role === "tool");
    if (lastRequest.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (requestedTool && !hasToolOutput) {
        if (requestedTool === "apply_patch") {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_patch", type: "function", function: { name: "apply_patch", arguments: JSON.stringify({ input: "*** Begin Patch\n*** End Patch" }) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\n`);
        } else {
          res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_weather","type":"function","function":{"name":"weather","arguments":"{\\"city\\":"}}]}}]}\n\n');
          res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Boston\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}}\n\n');
        }
      } else {
        res.write('data: {"choices":[{"delta":{"role":"assistant","content":"hello "}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":"world"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n');
      }
      res.end('data: [DONE]\n\n'); return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    if (requestedTool && !hasToolOutput) {
      const call = requestedTool === "apply_patch"
        ? { id: "call_patch", type: "function", function: { name: "apply_patch", arguments: JSON.stringify({ input: "*** Begin Patch\n*** End Patch" }) } }
        : { id: "call_weather", type: "function", function: { name: "weather", arguments: "{\"city\":\"Boston\"}" } };
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: [call] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }));
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

test("carries reasoning across sequential tool calls in one user turn", () => {
  const encoded = "opencode-reasoning-v1:" + Buffer.from("provider-thought-state").toString("base64");
  const chat = toChatRequest({ model: "test", input: [
    { type: "message", role: "user", content: "run several checks" },
    { type: "reasoning", id: "rs_1", summary: [], encrypted_content: encoded },
    { type: "function_call", call_id: "call_1", name: "shell", arguments: "{}" },
    { type: "function_call_output", call_id: "call_1", output: "one" },
    { type: "function_call", call_id: "call_2", name: "shell", arguments: "{}" },
    { type: "function_call_output", call_id: "call_2", output: "two" },
    { type: "function_call", call_id: "call_3", name: "shell", arguments: "{}" },
    { type: "function_call_output", call_id: "call_3", output: "three" },
  ] });
  const assistants = chat.messages.filter((message: any) => message.role === "assistant");
  assert.equal(assistants.length, 3);
  assert.deepEqual(assistants.map((message: any) => message.reasoning_content), [
    "provider-thought-state", "provider-thought-state", "provider-thought-state",
  ]);
});

test("does not carry reasoning into a new user turn", () => {
  const encoded = "opencode-reasoning-v1:" + Buffer.from("provider-thought-state").toString("base64");
  const chat = toChatRequest({ model: "test", input: [
    { type: "message", role: "user", content: "first turn" },
    { type: "reasoning", id: "rs_1", summary: [], encrypted_content: encoded },
    { type: "function_call", call_id: "call_1", name: "shell", arguments: "{}" },
    { type: "function_call_output", call_id: "call_1", output: "one" },
    { type: "message", role: "assistant", content: "done" },
    { type: "message", role: "user", content: "second turn" },
    { type: "function_call", call_id: "call_2", name: "shell", arguments: "{}" },
  ] });
  const assistants = chat.messages.filter((message: any) => message.role === "assistant");
  assert.equal(assistants.at(-1).reasoning_content, undefined);
});

test("merges replayed reasoning with its assistant text", () => {
  const encoded = "opencode-reasoning-v1:" + Buffer.from("provider-thought-state").toString("base64");
  const chat = toChatRequest({ model: "test", input: [
    { type: "message", role: "user", content: "first question" },
    { type: "reasoning", id: "rs_1", summary: [], encrypted_content: encoded },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "first answer" }] },
    { type: "message", role: "user", content: "follow up" },
  ] });
  assert.deepEqual(chat.messages.map((m: any) => m.role), ["user", "assistant", "user"]);
  assert.equal(chat.messages[1].content, "first answer");
  assert.equal(chat.messages[1].reasoning_content, "provider-thought-state");
});

test("omits empty assistant records rejected by Chat APIs", () => {
  const chat = toChatRequest({ model: "test", input: [
    { type: "message", role: "user", content: "first question" },
    { type: "message", role: "assistant", content: [] },
    { type: "message", role: "user", content: "follow up" },
  ] });
  assert.deepEqual(chat.messages.map((m: any) => m.role), ["user", "user"]);
});

test("translates free-form custom tools and their history through Chat functions", () => {
  const chat = toChatRequest({ model: "test", input: [
    { type: "message", role: "user", content: "edit it" },
    { type: "custom_tool_call", call_id: "call_patch", name: "apply_patch", input: "*** Begin Patch\n*** End Patch" },
    { type: "custom_tool_call_output", call_id: "call_patch", output: "Done!" },
  ], tools: [{ type: "custom", name: "apply_patch", description: "Apply a patch", format: { type: "grammar", syntax: "lark", definition: "..." } }], tool_choice: { type: "custom", name: "apply_patch" } });
  assert.deepEqual(chat.messages.map((m: any) => m.role), ["user", "assistant", "tool"]);
  assert.deepEqual(JSON.parse(chat.messages[1].tool_calls[0].function.arguments), { input: "*** Begin Patch\n*** End Patch" });
  assert.equal(chat.tools[0].function.name, "apply_patch");
  assert.deepEqual(chat.tools[0].function.parameters.required, ["input"]);
  assert.equal(chat.tool_choice.function.name, "apply_patch");
});

test("omits Chat tool controls when no client-executable tools remain", () => {
  const chat = toChatRequest({ model: "test", input: "hi", tools: [{ type: "web_search" }], tool_choice: "auto", parallel_tool_calls: true });
  assert.equal(chat.tools, undefined);
  assert.equal(chat.tool_choice, undefined);
  assert.equal(chat.parallel_tool_calls, undefined);
});

test("forwards Responses reasoning effort to Chat completions", () => {
  const chat = toChatRequest({ model: "test", input: "think", reasoning: { effort: "medium" } });
  assert.equal(chat.reasoning_effort, "medium");
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

test("custom tool-call round trip", async () => {
  const tools = [{ type: "custom", name: "apply_patch", description: "Apply a patch", format: { type: "grammar", syntax: "lark", definition: "..." } }];
  const first: any = await (await fetch(`${gatewayUrl}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "test", input: "edit it", tools }) })).json();
  assert.equal(first.output[0].type, "custom_tool_call");
  assert.equal(first.output[0].call_id, "call_patch");
  assert.equal(first.output[0].input, "*** Begin Patch\n*** End Patch");
  const second: any = await (await fetch(`${gatewayUrl}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "test", input: [{ type: "message", role: "user", content: "edit it" }, first.output[0], { type: "custom_tool_call_output", call_id: first.output[0].call_id, output: "Done!" }], tools }) })).json();
  assert.equal(second.output[0].content[0].text, "hello world");
  assert.deepEqual(lastRequest.messages.map((m: any) => m.role), ["user", "assistant", "tool"]);
});

test("streaming custom tool call uses native Responses events", async () => {
  const response = await fetch(`${gatewayUrl}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "test", input: "edit it", stream: true, tools: [{ type: "custom", name: "apply_patch", description: "Apply a patch" }] }) });
  const text = await response.text();
  assert.match(text, /"type":"custom_tool_call"/);
  assert.match(text, /response\.custom_tool_call_input\.delta/);
  assert.match(text, /response\.custom_tool_call_input\.done/);
  assert.match(text, /\*\*\* Begin Patch/);
  assert.doesNotMatch(text, /response\.function_call_arguments\.delta/);
  assert.match(text, /response\.completed/);
});

test("native Responses mode passes multimodal requests and SSE through unchanged", async () => {
  let received: any;
  const receivedPaths: string[] = [];
  const nativeUpstream = createServer(async (req, res) => {
    receivedPaths.push(`${req.method} ${req.url}`);
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "resp_123", object: "response" }));
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    received = JSON.parse(raw);
    res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "req_native" });
    res.end("event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_native\"}}\n\n");
  });
  await new Promise<void>((resolve) => nativeUpstream.listen(0, "127.0.0.1", resolve));
  const nativeGateway = createServer(createHandler({
    upstreamUrl: `http://127.0.0.1:${(nativeUpstream.address() as any).port}/v1/responses`,
    upstreamWireApi: "responses",
    upstreamApiKey: "secret",
    configuredModel: "gpt-5.6-luna",
    requestTimeoutMs: 5000,
  }));
  await new Promise<void>((resolve) => nativeGateway.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(nativeGateway.address() as any).port}`;
  try {
    const request = {
      model: "gpt-5.6-luna",
      stream: true,
      input: [{ role: "user", content: [
        { type: "input_text", text: "describe" },
        { type: "input_image", image_url: "data:image/png;base64,AA==" },
      ] }],
      tools: [{ type: "web_search" }],
    };
    const response = await fetch(`${url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-request-id"), "req_native");
    assert.match(await response.text(), /resp_native/);
    assert.deepEqual(received, request);

    const stored: any = await (await fetch(`${url}/v1/responses/resp_123`)).json();
    assert.equal(stored.id, "resp_123");
    assert.deepEqual(receivedPaths, ["POST /v1/responses", "GET /v1/responses/resp_123"]);

    const models: any = await (await fetch(`${url}/v1/models`)).json();
    assert.equal(models.data[0].id, "gpt-5.6-luna");
  } finally {
    nativeGateway.closeAllConnections();
    nativeUpstream.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => nativeGateway.close(() => resolve())),
      new Promise<void>((resolve) => nativeUpstream.close(() => resolve())),
    ]);
  }
});
