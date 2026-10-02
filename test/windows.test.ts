import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowsPowerShellEnvironment, windowsPowerShellExecutable } from "../src/windows.ts";

test("lets Windows PowerShell rebuild its module paths after a PowerShell 7 parent", () => {
  const environment = {
    PSModulePath: "C:\\Program Files\\PowerShell\\7\\Modules",
    PATH: "C:\\Windows\\System32",
    LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
  };
  const result = windowsPowerShellEnvironment(environment, { OCGW_APP_DIR: "C:\\gateway" });
  assert.equal(result.PSModulePath, undefined);
  assert.equal(result.PATH, environment.PATH);
  assert.equal(result.LOCALAPPDATA, environment.LOCALAPPDATA);
  assert.equal(result.OCGW_APP_DIR, "C:\\gateway");
  assert.equal(environment.PSModulePath, "C:\\Program Files\\PowerShell\\7\\Modules");
});

test("removes case variants from both inherited and extra Windows environment variables", () => {
  const result = windowsPowerShellEnvironment(
    { psmodulepath: "inherited", PSModulePath: "inherited duplicate", KEEP: "old" },
    { PsModulePath: "extra", KEEP: "new" },
  );
  assert.deepEqual(result, { KEEP: "new" });
});

test("preserves normal environments when no module path was inherited", () => {
  assert.deepEqual(windowsPowerShellEnvironment({ PATH: "system" }), { PATH: "system" });
});

test("uses the installed PowerShell 7 host from Program Files with spaces", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway Program Files "));
  try {
    const executable = join(directory, "PowerShell", "7", "pwsh.exe");
    await mkdir(join(directory, "PowerShell", "7"), { recursive: true });
    await writeFile(executable, "");
    assert.equal(windowsPowerShellExecutable(directory), executable);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps Windows PowerShell support when PowerShell 7 is absent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-no-pwsh-"));
  try {
    assert.equal(windowsPowerShellExecutable(directory), "powershell.exe");
    assert.equal(windowsPowerShellExecutable(""), "powershell.exe");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows DPAPI keys decrypt across installed and legacy PowerShell hosts", {
  skip: process.platform !== "win32",
  timeout: 120_000,
}, async () => {
  const { spawnSync } = await import("node:child_process");
  const hosts = [...new Set([windowsPowerShellExecutable(), "powershell.exe"])];
  const key = "gateway-regression-dummy-key";
  function invoke(host: string, script: string, cipher = ""): string {
    const result = spawnSync(host, ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      env: windowsPowerShellEnvironment(process.env, { OCGW_TEST_CIPHER: cipher }),
      windowsHide: true,
      timeout: 45_000,
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    return result.stdout.trim();
  }
  for (const encryptHost of hosts) {
    const cipher = invoke(encryptHost, [
      "$ErrorActionPreference='Stop'",
      `$secure=ConvertTo-SecureString '${key}' -AsPlainText -Force`,
      "[Console]::Out.Write(($secure | ConvertFrom-SecureString))",
    ].join(";"));
    for (const decryptHost of hosts) {
      const actual = invoke(decryptHost, [
        "$ErrorActionPreference='Stop'",
        "$secure=$env:OCGW_TEST_CIPHER | ConvertTo-SecureString",
        "$credential=[PSCredential]::new('opencode',$secure)",
        "[Console]::Out.Write($credential.GetNetworkCredential().Password)",
      ].join(";"), cipher);
      assert.equal(actual, key);
    }
  }
});
