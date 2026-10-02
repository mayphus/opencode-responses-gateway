import { existsSync } from "node:fs";
import { join } from "node:path";

// PowerShell 7 only adjusts PSModulePath when it launches Windows PowerShell
// directly. Through Node it is inherited unchanged, breaking built-in modules.
export function windowsPowerShellEnvironment(
  environment: NodeJS.ProcessEnv,
  extraEnvironment: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries({ ...environment, ...extraEnvironment })
      .filter(([key]) => key.toUpperCase() !== "PSMODULEPATH"),
  );
}

// Prefer the installed PowerShell 7 host, including its native ARM64 build.
// Keep Windows PowerShell available when PowerShell 7 is not installed.
export function windowsPowerShellExecutable(programFiles = process.env.ProgramFiles): string {
  if (programFiles) {
    const executable = join(programFiles, "PowerShell", "7", "pwsh.exe");
    if (existsSync(executable)) return executable;
  }
  return "powershell.exe";
}
