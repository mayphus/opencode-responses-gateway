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
