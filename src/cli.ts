import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createHandler } from "./gateway.ts";

const VERSION = "0.2.0";
const APP_NAME = "OpenCodeResponsesGateway";
const appDir = process.platform === "win32"
  ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), APP_NAME)
  : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode-responses-gateway");
const settingsPath = join(appDir, "settings.json");
const keyPath = join(appDir, "opencode-key.dpapi");
const pidPath = join(appDir, "gateway.pid");

type ProviderName = "deepseek" | "luna";
type Settings = {
  provider: ProviderName;
  upstreamUrl: string;
  wireApi: "chat_completions" | "responses";
  model: string;
  host: string;
  port: number;
};

const providers: Record<ProviderName, Pick<Settings, "upstreamUrl" | "wireApi" | "model">> = {
  deepseek: {
    upstreamUrl: "https://opencode.ai/zen/v1/chat/completions",
    wireApi: "chat_completions",
    model: "deepseek-v4-flash",
  },
  luna: {
    upstreamUrl: "https://opencode.ai/zen/go/v1/responses",
    wireApi: "responses",
    model: "gpt-5.6-luna",
  },
};

function ensureAppDir(): void { mkdirSync(appDir, { recursive: true }); }

function readSettings(): Settings {
  if (!existsSync(settingsPath)) throw new Error("Gateway is not set up. Run: opencode-gateway setup");
  return JSON.parse(readFileSync(settingsPath, "utf8"));
}

function writeSettings(provider: ProviderName): Settings {
  ensureAppDir();
  const settings: Settings = { provider, ...providers[provider], host: "127.0.0.1", port: 8080 };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  return settings;
}

function powershell(script: string, extraEnv: Record<string, string> = {}): string {
  if (process.platform !== "win32") throw new Error("This setup command currently supports Windows only");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || "PowerShell failed").trim());
  return result.stdout.trim();
}

function saveKeyWithDpapi(): void {
  ensureAppDir();
  if (process.platform !== "win32") throw new Error("This setup command currently supports Windows only");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", [
    "$ErrorActionPreference='Stop'",
    "$key=Read-Host 'Paste the OpenCode API key' -AsSecureString",
    "if($key.Length -eq 0){throw 'The OpenCode API key cannot be empty.'}",
    "$key | ConvertFrom-SecureString | Set-Content -LiteralPath $env:OCGW_KEY_PATH -Encoding UTF8",
  ].join(";")], {
    env: { ...process.env, OCGW_KEY_PATH: keyPath },
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error("Could not save the OpenCode API key");
}

function loadKeyWithDpapi(): string {
  if (!existsSync(keyPath)) throw new Error("OpenCode key is missing. Run: opencode-gateway setup");
  return powershell([
    "$ErrorActionPreference='Stop'",
    "$secure=Get-Content -LiteralPath $env:OCGW_KEY_PATH -Raw | ConvertTo-SecureString",
    "$credential=[PSCredential]::new('opencode',$secure)",
    "[Console]::Out.Write($credential.GetNetworkCredential().Password)",
  ].join(";"), { OCGW_KEY_PATH: keyPath });
}

function codexDir(): string { return join(homedir(), ".codex"); }

function setTopLevelTomlValue(source: string, key: string, value: string): string {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const tableIndex = lines.findIndex((line) => /^\s*\[/.test(line));
  const end = tableIndex < 0 ? lines.length : tableIndex;
  const pattern = new RegExp(`^\\s*${key}\\s*=`);
  const existing = lines.slice(0, end).findIndex((line) => pattern.test(line));
  const assignment = `${key} = ${JSON.stringify(value)}`;
  if (existing >= 0) lines[existing] = assignment;
  else lines.splice(end, 0, assignment);
  return lines.join("\n").replace(/\n*$/, "\n");
}

function configureCodex(settings: Settings): void {
  const directory = codexDir();
  mkdirSync(directory, { recursive: true });
  const configPath = join(directory, "config.toml");
  const profilePath = join(directory, "opencode-gateway.config.toml");
  const current = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const backupPath = configPath + ".before-opencode-gateway";
  if (current && !existsSync(backupPath)) copyFileSync(configPath, backupPath);
  writeFileSync(configPath, setTopLevelTomlValue(current, "profile", "opencode-gateway"));
  writeFileSync(profilePath, [
    `model = ${JSON.stringify(settings.model)}`,
    'model_provider = "opencode_gateway"',
    "",
    "[model_providers.opencode_gateway]",
    'name = "Local OpenCode Responses Gateway"',
    `base_url = ${JSON.stringify(`http://${settings.host}:${settings.port}/v1`)}`,
    'env_key = "OPENAI_API_KEY"',
    'wire_api = "responses"',
    "request_max_retries = 1",
    "stream_max_retries = 1",
    "",
  ].join("\n"));
  powershell("[Environment]::SetEnvironmentVariable('OPENAI_API_KEY','local-opencode-gateway','User')");
}

function selfInvocation(command: string): { executable: string; args: string[] } {
  const embedded = basename(process.argv[1] ?? "").toLowerCase() === basename(process.execPath).toLowerCase();
  return { executable: process.execPath, args: embedded ? [command] : [process.argv[1], command] };
}

function installStartup(): void {
  const invocation = selfInvocation("serve");
  powershell([
    "$ErrorActionPreference='Stop'",
    "$startup=[Environment]::GetFolderPath('Startup')",
    "$shortcut=Join-Path $startup 'OpenCode Responses Gateway.lnk'",
    "$shell=New-Object -ComObject WScript.Shell",
    "$link=$shell.CreateShortcut($shortcut)",
    "$link.TargetPath=$env:OCGW_EXE",
    "$link.Arguments=$env:OCGW_ARGS",
    "$link.WorkingDirectory=(Split-Path -Parent $env:OCGW_EXE)",
    "$link.WindowStyle=7",
    "$link.Description='Start the local OpenCode Responses Gateway'",
    "$link.Save()",
  ].join(";"), { OCGW_EXE: invocation.executable, OCGW_ARGS: invocation.args.map((x) => `\"${x}\"`).join(" ") });
}

function removeStartup(): void {
  powershell("$p=Join-Path ([Environment]::GetFolderPath('Startup')) 'OpenCode Responses Gateway.lnk'; if(Test-Path -LiteralPath $p){Remove-Item -LiteralPath $p -Force}");
}

function readPid(): number | undefined {
  if (!existsSync(pidPath)) return undefined;
  const pid = Number(readFileSync(pidPath, "utf8").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function isRunning(pid = readPid()): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function stop(): void {
  const pid = readPid();
  if (!pid || !isRunning(pid)) {
    if (existsSync(pidPath)) unlinkSync(pidPath);
    console.log("Gateway is not running.");
    return;
  }
  process.kill(pid, "SIGTERM");
  if (existsSync(pidPath)) unlinkSync(pidPath);
  console.log(`Stopped gateway (PID ${pid}).`);
}

async function serve(): Promise<void> {
  const settings = readSettings();
  if (isRunning() && readPid() !== process.pid) throw new Error(`Gateway is already running (PID ${readPid()})`);
  ensureAppDir();
  writeFileSync(pidPath, String(process.pid));
  const server = createServer(createHandler({
    upstreamUrl: settings.upstreamUrl,
    upstreamWireApi: settings.wireApi,
    upstreamApiKey: loadKeyWithDpapi(),
    configuredModel: settings.model,
    requestTimeoutMs: 300_000,
  }));
  const cleanup = () => {
    try { if (readPid() === process.pid) unlinkSync(pidPath); } catch { /* already gone */ }
  };
  process.once("exit", cleanup);
  const shutdown = () => server.close(() => { cleanup(); process.exit(0); });
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(settings.port, settings.host, resolve);
  });
  console.log(`OpenCode gateway ${VERSION} listening on http://${settings.host}:${settings.port} (${settings.model}, ${settings.wireApi})`);
}

async function waitUntilHealthy(settings: Settings): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(`http://${settings.host}:${settings.port}/healthz`);
      if (response.ok) return true;
    } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function startBackground(): Promise<void> {
  if (isRunning()) { console.log(`Gateway is already running (PID ${readPid()}).`); return; }
  const invocation = selfInvocation("serve");
  const child = spawn(invocation.executable, invocation.args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  const settings = readSettings();
  if (!await waitUntilHealthy(settings)) throw new Error("Gateway did not become healthy. Run 'opencode-gateway serve' to see the error.");
  console.log(`Gateway is running at http://${settings.host}:${settings.port}.`);
}

async function status(): Promise<void> {
  const settings = readSettings();
  let healthy = false;
  try { healthy = (await fetch(`http://${settings.host}:${settings.port}/healthz`)).ok; } catch { /* offline */ }
  console.log(healthy ? "Status: running" : "Status: stopped");
  console.log(`Model: ${settings.model}`);
  console.log(`Upstream API: ${settings.wireApi}`);
  console.log(`Local endpoint: http://${settings.host}:${settings.port}/v1`);
  console.log(`Startup: ${process.platform === "win32" ? "per-user shortcut" : "not installed"}`);
}

async function chooseProvider(requested?: string): Promise<ProviderName> {
  if (requested === "deepseek" || requested === "luna") return requested;
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    console.log("1. DeepSeek V4 Flash (free, text only)");
    console.log("2. GPT 5.6 Luna via OpenCode Go (text, image, PDF)");
    const answer = (await rl.question("Choose provider [1]: ")).trim();
    return answer === "2" ? "luna" : "deepseek";
  } finally { rl.close(); }
}

async function setup(requested?: string): Promise<void> {
  if (process.platform !== "win32") throw new Error("The automatic desktop setup currently supports Windows only");
  const provider = await chooseProvider(requested);
  console.log(`Setting up ${providers[provider].model}...`);
  saveKeyWithDpapi();
  const settings = writeSettings(provider);
  configureCodex(settings);
  installStartup();
  if (isRunning()) stop();
  await startBackground();
  console.log("Setup complete. Fully quit and reopen ChatGPT Desktop once.");
}

async function configure(providerArg?: string): Promise<void> {
  const provider = await chooseProvider(providerArg);
  if (!existsSync(keyPath)) throw new Error("No saved key. Run setup first.");
  const settings = writeSettings(provider);
  configureCodex(settings);
  if (isRunning()) stop();
  await startBackground();
  console.log(`Switched to ${settings.model}. Fully quit and reopen ChatGPT Desktop.`);
}

function help(): void {
  console.log(`OpenCode Responses Gateway ${VERSION}

Usage: opencode-gateway <command>

  setup [deepseek|luna]      Save the key, configure ChatGPT, add startup, and start
  configure <deepseek|luna>  Switch model using the saved key
  start                      Start in the background
  serve                      Run in the foreground
  stop                       Stop the gateway
  restart                    Restart the gateway
  status                     Show current configuration and health
  startup install|remove     Manage automatic startup
  version                    Print the version
  help                       Show this help`);
}

async function main(): Promise<void> {
  const [command = "help", arg] = process.argv.slice(2);
  if (command === "setup") return setup(arg);
  if (command === "configure") return configure(arg);
  if (command === "start") return startBackground();
  if (command === "serve") return serve();
  if (command === "stop") return stop();
  if (command === "restart") { stop(); return startBackground(); }
  if (command === "status" || command === "doctor") return status();
  if (command === "startup" && arg === "install") { installStartup(); console.log("Startup installed."); return; }
  if (command === "startup" && arg === "remove") { removeStartup(); console.log("Startup removed."); return; }
  if (command === "version" || command === "--version" || command === "-v") { console.log(VERSION); return; }
  help();
}

main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
