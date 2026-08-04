import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [executable, expectedVersion] = process.argv.slice(2);
if (!executable || !expectedVersion) throw new Error("Usage: smoke-cli.mjs <executable> <version>");

function run(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || `CLI exited ${code}`)));
  });
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

assert.equal(await run(["version"]), expectedVersion);
assert.match(await run(["help"]), /OpenCode Responses Gateway/);

const directory = await mkdtemp(join(tmpdir(), "opencode-gateway-smoke-"));
const port = await freePort();
const gatewayToken = "smoke-local-token";
await writeFile(join(directory, "settings.json"), JSON.stringify({
  provider: "deepseek",
  upstreamUrl: "https://example.invalid/v1/chat/completions",
  wireApi: "chat_completions",
  model: "smoke-model",
  host: "127.0.0.1",
  port,
  gatewayToken,
}));

const child = spawn(executable, ["serve"], {
  env: { ...process.env, OPENCODE_GATEWAY_HOME: directory, OPENCODE_API_KEY: "smoke-provider-key" },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let childError = "";
child.stderr.on("data", (chunk) => { childError += chunk; });
try {
  let health;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) { health = await response.json(); break; }
    } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(health?.model, "smoke-model", childError || "CLI did not become healthy");
  assert.equal(typeof health?.instance_id, "string");
  assert.equal((await fetch(`http://127.0.0.1:${port}/v1/models`)).status, 401);
  const models = await fetch(`http://127.0.0.1:${port}/v1/models`, {
    headers: { authorization: `Bearer ${gatewayToken}` },
  });
  assert.equal(models.status, 200);
  assert.equal((await models.json()).data[0].id, "smoke-model");
} finally {
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  if (child.exitCode == null) child.kill("SIGKILL");
  await rm(directory, { recursive: true, force: true });
}

console.log("native CLI smoke test passed");
