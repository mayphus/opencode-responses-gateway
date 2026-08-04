import { randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createHandler } from "./gateway.ts";

const VERSION = "0.3.1";
const APP_NAME = "OpenCodeResponsesGateway";
const KEY_SERVICE = "org.mayphus.opencode-responses-gateway";
const KEY_ACCOUNT = userInfo().username;
const defaultAppDir = process.platform === "win32"
  ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), APP_NAME)
  : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode-responses-gateway");
const appDir = process.env.OPENCODE_GATEWAY_HOME ?? defaultAppDir;
const settingsPath = join(appDir, "settings.json");
const windowsKeyPath = join(appDir, "opencode-key.dpapi");
const pidPath = join(appDir, "gateway.pid.json");

type ProviderName = "deepseek" | "luna";
type Settings = {
  provider: ProviderName;
  upstreamUrl: string;
  wireApi: "chat_completions" | "responses";
  model: string;
  host: string;
  port: number;
  gatewayToken: string;
};
type PidRecord = { pid: number; instanceId: string };

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

function atomicWrite(path: string, content: string, mode = 0o600): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content, { encoding: "utf8", mode, flag: "wx" });
  renameSync(temporary, path);
  if (process.platform !== "win32") chmodSync(path, mode);
}

function powershell(script: string, extraEnv: Record<string, string> = {}, input?: string): string {
  if (process.platform !== "win32") throw new Error("PowerShell credential operation is available only on Windows");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
    input,
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || "PowerShell failed").trim());
  return result.stdout.trim();
}

function secureWindowsDirectory(): void {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$acl=New-Object System.Security.AccessControl.DirectorySecurity",
    "$acl.SetOwner($sid)",
    "$acl.SetAccessRuleProtection($true,$false)",
    "$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')",
    "$acl.AddAccessRule($rule)",
    "Set-Acl -LiteralPath $env:OCGW_APP_DIR -AclObject $acl",
  ].join(";");
  powershell(script, { OCGW_APP_DIR: appDir });
}

function ensureAppDir(): void {
  mkdirSync(appDir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") secureWindowsDirectory();
  else chmodSync(appDir, 0o700);
}

function readSettings(): Settings {
  if (!existsSync(settingsPath)) throw new Error("Gateway is not set up. Run: opencode-gateway setup");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  if (!settings.gatewayToken) throw new Error("Gateway configuration predates local authentication. Run setup again.");
  return settings;
}

function writeSettings(provider: ProviderName): Settings {
  ensureAppDir();
  let gatewayToken: string | undefined;
  try { gatewayToken = readSettings().gatewayToken; } catch { /* first setup */ }
  const settings: Settings = {
    provider,
    ...providers[provider],
    host: "127.0.0.1",
    port: 8080,
    gatewayToken: gatewayToken ?? randomBytes(32).toString("base64url"),
  };
  atomicWrite(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return settings;
}

function requireCommand(command: string, installHint: string): void {
  const probe = spawnSync(command, ["--version"], { stdio: "ignore" });
  if (probe.error && (probe.error as NodeJS.ErrnoException).code === "ENOENT") {
    throw new Error(`${command} is required. ${installHint}`);
  }
}

async function promptHidden(prompt: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error("A terminal is required for secure key entry");
  }
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  let value = "";
  try {
    return await new Promise<string>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        for (const byte of chunk) {
          if (byte === 3) { stdin.off("data", onData); reject(new Error("Cancelled")); return; }
          if (byte === 13 || byte === 10) { stdin.off("data", onData); stdout.write("\n"); resolve(value); return; }
          if (byte === 8 || byte === 127) { value = value.slice(0, -1); continue; }
          if (byte >= 32) value += String.fromCharCode(byte);
        }
      };
      stdin.on("data", onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
}

async function saveProviderKey(): Promise<void> {
  ensureAppDir();
  if (process.platform === "win32") {
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", [
      "$ErrorActionPreference='Stop'",
      "$key=Read-Host 'Paste the OpenCode API key' -AsSecureString",
      "if($key.Length -eq 0){throw 'The OpenCode API key cannot be empty.'}",
      "$key | ConvertFrom-SecureString | Set-Content -LiteralPath $env:OCGW_KEY_PATH -Encoding UTF8",
    ].join(";")], { env: { ...process.env, OCGW_KEY_PATH: windowsKeyPath }, stdio: "inherit" });
    if (result.status !== 0) throw new Error("Could not save the OpenCode API key with Windows DPAPI");
    return;
  }
  if (process.platform === "darwin") {
    const result = spawnSync("/usr/bin/security", [
      "add-generic-password", "-U", "-a", KEY_ACCOUNT, "-s", KEY_SERVICE, "-w",
    ], { stdio: "inherit" });
    if (result.status !== 0) throw new Error("Could not save the OpenCode API key in macOS Keychain");
    return;
  }
  requireCommand("secret-tool", "Install libsecret-tools (or your distribution's secret-tool package).");
  const key = await promptHidden("Paste the OpenCode API key: ");
  if (!key) throw new Error("The OpenCode API key cannot be empty");
  const result = spawnSync("secret-tool", [
    "store", `--label=${APP_NAME}`, "service", KEY_SERVICE, "account", KEY_ACCOUNT,
  ], { encoding: "utf8", input: key });
  if (result.status !== 0) throw new Error((result.stderr || "Could not save the key in Linux Secret Service").trim());
}

function loadProviderKey(): string {
  if (process.env.OPENCODE_API_KEY) return process.env.OPENCODE_API_KEY;
  if (process.platform === "win32") {
    if (!existsSync(windowsKeyPath)) throw new Error("OpenCode key is missing. Run setup again.");
    return powershell([
      "$ErrorActionPreference='Stop'",
      "$secure=Get-Content -LiteralPath $env:OCGW_KEY_PATH -Raw | ConvertTo-SecureString",
      "$credential=[PSCredential]::new('opencode',$secure)",
      "[Console]::Out.Write($credential.GetNetworkCredential().Password)",
    ].join(";"), { OCGW_KEY_PATH: windowsKeyPath });
  }
  if (process.platform === "darwin") {
    const result = spawnSync("/usr/bin/security", [
      "find-generic-password", "-w", "-a", KEY_ACCOUNT, "-s", KEY_SERVICE,
    ], { encoding: "utf8" });
    if (result.status !== 0) throw new Error("OpenCode key is missing from macOS Keychain. Run setup again.");
    return result.stdout.trim();
  }
  requireCommand("secret-tool", "Install libsecret-tools (or set OPENCODE_API_KEY for this process).");
  const result = spawnSync("secret-tool", ["lookup", "service", KEY_SERVICE, "account", KEY_ACCOUNT], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error("OpenCode key is missing from Linux Secret Service. Run setup again.");
  return result.stdout.trim();
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

function selfInvocation(command: string): { executable: string; args: string[] } {
  const script = process.argv[1];
  const embedded = basename(script ?? "").toLowerCase() === basename(process.execPath).toLowerCase();
  if (!embedded && !script) throw new Error("Cannot determine the CLI entry point");
  return { executable: process.execPath, args: embedded ? [command] : [script as string, command] };
}

function tomlStringArray(values: string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

function configureCodex(settings: Settings): void {
  const directory = codexDir();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(directory, 0o700);
  const configPath = join(directory, "config.toml");
  const profilePath = join(directory, "opencode-gateway.config.toml");
  const current = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const backupPath = configPath + ".before-opencode-gateway";
  if (current && !existsSync(backupPath)) copyFileSync(configPath, backupPath);
  atomicWrite(configPath, setTopLevelTomlValue(current, "profile", "opencode-gateway"));
  const auth = selfInvocation("local-token");
  atomicWrite(profilePath, [
    `model = ${JSON.stringify(settings.model)}`,
    'model_provider = "opencode_gateway"',
    "",
    "[model_providers.opencode_gateway]",
    'name = "Local OpenCode Responses Gateway"',
    `base_url = ${JSON.stringify(`http://${settings.host}:${settings.port}/v1`)}`,
    'wire_api = "responses"',
    "request_max_retries = 1",
    "stream_max_retries = 1",
    "",
    "[model_providers.opencode_gateway.auth]",
    `command = ${JSON.stringify(auth.executable)}`,
    `args = ${tomlStringArray(auth.args)}`,
    "timeout_ms = 5000",
    "refresh_interval_ms = 300000",
    "",
  ].join("\n"));
  if (process.platform === "win32") {
    powershell("if([Environment]::GetEnvironmentVariable('OPENAI_API_KEY','User') -eq 'local-opencode-gateway'){[Environment]::SetEnvironmentVariable('OPENAI_API_KEY',$null,'User')}");
  }
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function systemdQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function installStartup(): void {
  const invocation = selfInvocation("serve");
  if (process.platform === "win32") {
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
    return;
  }
  if (process.platform === "darwin") {
    const directory = join(homedir(), "Library", "LaunchAgents");
    const path = join(directory, "org.mayphus.opencode-responses-gateway.plist");
    mkdirSync(directory, { recursive: true });
    const args = [invocation.executable, ...invocation.args].map((arg) => `      <string>${xmlEscape(arg)}</string>`).join("\n");
    atomicWrite(path, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>org.mayphus.opencode-responses-gateway</string>
  <key>ProgramArguments</key><array>
${args}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Background</string>
</dict></plist>
`);
    spawnSync("launchctl", ["bootout", `gui/${process.getuid?.()}`, path], { stdio: "ignore" });
    const result = spawnSync("launchctl", ["bootstrap", `gui/${process.getuid?.()}`, path], { encoding: "utf8" });
    if (result.status !== 0) throw new Error((result.stderr || "launchctl bootstrap failed").trim());
    return;
  }
  requireCommand("systemctl", "A systemd user session is required for automatic startup.");
  const directory = join(homedir(), ".config", "systemd", "user");
  const path = join(directory, "opencode-gateway.service");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  atomicWrite(path, `[Unit]
Description=OpenCode Responses Gateway
After=network-online.target

[Service]
Type=simple
ExecStart=${[invocation.executable, ...invocation.args].map(systemdQuote).join(" ")}
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${systemdQuote(appDir)}

[Install]
WantedBy=default.target
`);
  let result = spawnSync("systemctl", ["--user", "daemon-reload"], { encoding: "utf8" });
  if (result.status === 0) result = spawnSync("systemctl", ["--user", "enable", "--now", "opencode-gateway.service"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error((result.stderr || "systemd user-service installation failed").trim());
}

function removeStartup(): void {
  if (process.platform === "win32") {
    powershell("$p=Join-Path ([Environment]::GetFolderPath('Startup')) 'OpenCode Responses Gateway.lnk'; if(Test-Path -LiteralPath $p){Remove-Item -LiteralPath $p -Force}");
    return;
  }
  if (process.platform === "darwin") {
    const path = join(homedir(), "Library", "LaunchAgents", "org.mayphus.opencode-responses-gateway.plist");
    spawnSync("launchctl", ["bootout", `gui/${process.getuid?.()}`, path], { stdio: "ignore" });
    if (existsSync(path)) unlinkSync(path);
    return;
  }
  spawnSync("systemctl", ["--user", "disable", "--now", "opencode-gateway.service"], { stdio: "ignore" });
  const path = join(homedir(), ".config", "systemd", "user", "opencode-gateway.service");
  if (existsSync(path)) unlinkSync(path);
  spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
}

function startupInstalled(): boolean {
  if (process.platform === "win32") {
    return powershell("$p=Join-Path ([Environment]::GetFolderPath('Startup')) 'OpenCode Responses Gateway.lnk'; [Console]::Out.Write((Test-Path -LiteralPath $p).ToString().ToLower())") === "true";
  }
  if (process.platform === "darwin") return existsSync(join(homedir(), "Library", "LaunchAgents", "org.mayphus.opencode-responses-gateway.plist"));
  return existsSync(join(homedir(), ".config", "systemd", "user", "opencode-gateway.service"));
}

function readPidRecord(): PidRecord | undefined {
  if (!existsSync(pidPath)) return undefined;
  try {
    const record = JSON.parse(readFileSync(pidPath, "utf8"));
    return Number.isInteger(record.pid) && record.pid > 0 && typeof record.instanceId === "string" ? record : undefined;
  } catch { return undefined; }
}

async function runningRecord(settings = readSettings()): Promise<PidRecord | undefined> {
  const record = readPidRecord();
  if (!record) return undefined;
  try {
    process.kill(record.pid, 0);
    const response = await fetch(`http://${settings.host}:${settings.port}/healthz`, { signal: AbortSignal.timeout(1000) });
    const health: any = await response.json();
    return response.ok && health.instance_id === record.instanceId ? record : undefined;
  } catch { return undefined; }
}

async function stop(): Promise<void> {
  const settings = readSettings();
  const record = await runningRecord(settings);
  if (!record) {
    if (existsSync(pidPath)) unlinkSync(pidPath);
    console.log("Gateway is not running.");
    return;
  }
  process.kill(record.pid, "SIGTERM");
  if (existsSync(pidPath)) unlinkSync(pidPath);
  console.log(`Stopped gateway (PID ${record.pid}).`);
}

async function serve(): Promise<void> {
  const settings = readSettings();
  const current = await runningRecord(settings);
  if (current) throw new Error(`Gateway is already running (PID ${current.pid})`);
  ensureAppDir();
  const instanceId = randomUUID();
  const server = createServer(createHandler({
    upstreamUrl: settings.upstreamUrl,
    upstreamWireApi: settings.wireApi,
    upstreamApiKey: loadProviderKey(),
    gatewayApiKey: settings.gatewayToken,
    configuredModel: settings.model,
    instanceId,
    requestTimeoutMs: 300_000,
  }));
  const cleanup = () => {
    try { if (readPidRecord()?.instanceId === instanceId) unlinkSync(pidPath); } catch { /* already gone */ }
  };
  process.once("exit", cleanup);
  const shutdown = () => server.close(() => { cleanup(); process.exit(0); });
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(settings.port, settings.host, resolve);
  });
  atomicWrite(pidPath, JSON.stringify({ pid: process.pid, instanceId }) + "\n");
  console.log(`OpenCode gateway ${VERSION} listening on http://${settings.host}:${settings.port} (${settings.model}, ${settings.wireApi})`);
}

async function waitUntilHealthy(settings: Settings, expectedInstance?: string): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(`http://${settings.host}:${settings.port}/healthz`, { signal: AbortSignal.timeout(1000) });
      const health: any = await response.json();
      if (response.ok && (!expectedInstance || health.instance_id === expectedInstance)) return true;
    } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function startBackground(): Promise<void> {
  const settings = readSettings();
  const current = await runningRecord(settings);
  if (current) { console.log(`Gateway is already running (PID ${current.pid}).`); return; }
  const invocation = selfInvocation("serve");
  const child = spawn(invocation.executable, invocation.args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  for (let attempt = 0; attempt < 30; attempt++) {
    const record = readPidRecord();
    if (record && await waitUntilHealthy(settings, record.instanceId)) {
      console.log(`Gateway is running at http://${settings.host}:${settings.port}.`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Gateway did not become healthy. Run 'opencode-gateway serve' to see the error.");
}

async function status(): Promise<void> {
  const settings = readSettings();
  const record = await runningRecord(settings);
  console.log(record ? `Status: running (PID ${record.pid})` : "Status: stopped");
  console.log(`Model: ${settings.model}`);
  console.log(`Upstream API: ${settings.wireApi}`);
  console.log(`Local endpoint: http://${settings.host}:${settings.port}/v1`);
  console.log(`Local authentication: enabled`);
  console.log(`Credential store: ${process.platform === "win32" ? "Windows DPAPI" : process.platform === "darwin" ? "macOS Keychain" : "Linux Secret Service"}`);
  console.log(`Startup: ${startupInstalled() ? "installed" : "not installed"}`);
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
  const provider = await chooseProvider(requested);
  console.log(`Setting up ${providers[provider].model}...`);
  await saveProviderKey();
  const settings = writeSettings(provider);
  configureCodex(settings);
  if (await runningRecord(settings)) await stop();
  installStartup();
  if (!await runningRecord(settings)) await startBackground();
  console.log("Setup complete. Fully quit and reopen ChatGPT Desktop once.");
}

async function configure(providerArg?: string): Promise<void> {
  const provider = await chooseProvider(providerArg);
  loadProviderKey();
  const settings = writeSettings(provider);
  configureCodex(settings);
  if (await runningRecord(settings)) await stop();
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
  if (command === "restart") { await stop(); return startBackground(); }
  if (command === "status" || command === "doctor") return status();
  if (command === "startup" && arg === "install") { installStartup(); console.log("Startup installed."); return; }
  if (command === "startup" && arg === "remove") { removeStartup(); console.log("Startup removed."); return; }
  if (command === "local-token") { stdout.write(readSettings().gatewayToken); return; }
  if (command === "version" || command === "--version" || command === "-v") { console.log(VERSION); return; }
  help();
}

main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
