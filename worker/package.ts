export const packageMetadata = {
  identifier: "Mayphus.OpenCodeResponsesGateway",
  version: "0.3.2",
  name: "OpenCode Responses Gateway",
  publisher: "Mayphus",
  moniker: "opencode-gateway",
  description: "Local OpenAI Responses compatibility gateway for OpenCode models",
  installers: [
    {
      Architecture: "x64",
      InstallerIdentifier: "Mayphus.OpenCodeResponsesGateway_0.3.2_en-US_x64",
      InstallerUrl:
        "https://github.com/mayphus/opencode-responses-gateway/releases/download/v0.3.2/opencode-gateway-0.3.2-windows-x64.zip",
      InstallerSha256: "7B14B9B2E3878B1B70A4B01EB109539C8B68BA5FB926594B39EF8A0F4D16052F",
    },
    {
      Architecture: "arm64",
      InstallerIdentifier: "Mayphus.OpenCodeResponsesGateway_0.3.2_en-US_arm64",
      InstallerUrl:
        "https://github.com/mayphus/opencode-responses-gateway/releases/download/v0.3.2/opencode-gateway-0.3.2-windows-arm64.zip",
      InstallerSha256: "1581696561884D092A45D391266ECCAE3AF969BABBB770B46791ADACB7E109A5",
    },
  ],
} as const;

const nestedInstaller = {
  InstallerType: "zip",
  NestedInstallerType: "portable",
  NestedInstallerFiles: [
    {
      RelativeFilePath: "opencode-gateway.exe",
      PortableCommandAlias: "opencode-gateway",
    },
  ],
  Scope: "user",
  UpgradeBehavior: "install",
  Commands: ["opencode-gateway"],
  ArchiveBinariesDependOnPath: false,
} as const;

export const packageManifest = {
  PackageIdentifier: packageMetadata.identifier,
  Versions: [
    {
      PackageVersion: packageMetadata.version,
      DefaultLocale: {
        PackageIdentifier: packageMetadata.identifier,
        PackageVersion: packageMetadata.version,
        PackageLocale: "en-US",
        Publisher: packageMetadata.publisher,
        PackageName: packageMetadata.name,
        License: "Proprietary",
        ShortDescription: packageMetadata.description,
        Moniker: packageMetadata.moniker,
        Tags: ["ai", "gateway", "opencode", "responses-api"],
        ManifestType: "merged",
        ManifestVersion: "1.9.0",
      },
      Installers: packageMetadata.installers.map((installer) => ({
        ...installer,
        ...nestedInstaller,
      })),
    },
  ],
} as const;

export const searchResult = {
  PackageIdentifier: packageMetadata.identifier,
  PackageName: packageMetadata.name,
  Publisher: packageMetadata.publisher,
  Versions: [{ PackageVersion: packageMetadata.version }],
} as const;
