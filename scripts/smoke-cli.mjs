import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { windowsPowerShellEnvironment } from "../src/windows.ts";

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
let childOutput = "";
let spawnError;
child.stdout.on("data", (chunk) => { childOutput += chunk; });
child.once("error", (error) => { spawnError = error; });
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
  assert.equal(health?.model, "smoke-model", `CLI did not become healthy; exit=${child.exitCode}; signal=${child.signalCode}; spawn=${spawnError ?? "none"}; stdout=${childOutput}; stderr=${childError}`);
  assert.equal(typeof health?.instance_id, "string");
  if (process.platform === "win32") {
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", [
      "$ErrorActionPreference='Stop'",
      "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User",
      "$acl=Get-Acl -LiteralPath $env:OCGW_TEST_DIRECTORY",
      "if(-not $acl.AreAccessRulesProtected){throw 'Directory ACL still inherits access rules'}",
      "if($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'Directory owner is not the current user'}",
      "$secure=ConvertTo-SecureString 'gateway-smoke-dummy-key' -AsPlainText -Force",
      "$cipher=$secure | ConvertFrom-SecureString",
      "$decoded=[PSCredential]::new('opencode',($cipher | ConvertTo-SecureString))",
      "if($decoded.GetNetworkCredential().Password -ne 'gateway-smoke-dummy-key'){throw 'DPAPI key round trip failed'}",
      "$rules=$acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])",
      "if($rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne 'Allow' -or $rules[0].FileSystemRights -ne 'FullControl'){throw 'Directory ACL is not restricted to the current user'}",
    ].join(";")], {
      encoding: "utf8",
      env: windowsPowerShellEnvironment(process.env, { OCGW_TEST_DIRECTORY: directory }),
      windowsHide: true,
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  }
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
