import assert from "node:assert/strict";
import test from "node:test";
import { windowsPowerShellEnvironment } from "../src/windows.ts";

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
