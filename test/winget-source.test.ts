import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { handleRequest } from "../worker/index.ts";
import { packageMetadata } from "../worker/package.ts";

async function jsonResponse(path: string, init?: RequestInit): Promise<{ response: Response; body: unknown }> {
  const response = await handleRequest(new Request(`https://source.example/api${path}`, init));
  return { response, body: response.status === 204 ? undefined : await response.json() };
}

test("reports a WinGet REST source information envelope", async () => {
  const { response, body } = await jsonResponse("/information");
  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    Data: {
      SourceIdentifier: "80f17ed5-4759-4d0f-a2b8-4d0d3ec6c422",
      ServerSupportedVersions: ["1.0.0", "1.1.0", "1.4.0", "1.5.0", "1.6.0", "1.7.0", "1.9.0", "1.10.0"],
    },
  });
});

test("shows a useful status at the browser-facing root", async () => {
  const response = await handleRequest(new Request("https://winget.mayphus.org/"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok",
    service: "Mayphus WinGet source",
    sourceUrl: "https://winget.mayphus.org/api/",
    packageIdentifier: packageMetadata.identifier,
    packageVersion: packageMetadata.version,
  });
});

test("keeps source metadata synchronized with the CLI release", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  assert.equal(packageMetadata.version, packageJson.version);
  for (const installer of packageMetadata.installers) {
    assert.match(installer.InstallerUrl, new RegExp(`/v${packageJson.version}/`));
    assert.match(installer.InstallerSha256, /^[A-F0-9]{64}$/u);
  }
});

test("finds the package using WinGet's exact identifier filter", async () => {
  const { response, body } = await jsonResponse("/manifestSearch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      MaximumResults: 50,
      Filters: [
        {
          PackageMatchField: "PackageIdentifier",
          RequestMatch: { KeyWord: packageMetadata.identifier, MatchType: "Exact" },
        },
      ],
    }),
  });
  assert.equal(response.status, 200);
  assert.equal((body as { Data: unknown[] }).Data.length, 1);
});

test("supports name and moniker searches and rejects a mismatch", async () => {
  for (const [field, keyword, matchType] of [
    ["PackageName", "OpenCode", "StartsWith"],
    ["Moniker", "gateway", "Substring"],
  ]) {
    const { body } = await jsonResponse("/manifestSearch", {
      method: "POST",
      body: JSON.stringify({
        Inclusions: [{ PackageMatchField: field, RequestMatch: { KeyWord: keyword, MatchType: matchType } }],
      }),
    });
    assert.equal((body as { Data: unknown[] }).Data.length, 1);
  }

  const { body } = await jsonResponse("/manifestSearch", {
    method: "POST",
    body: JSON.stringify({ Query: { KeyWord: "does-not-exist", MatchType: "Exact" } }),
  });
  assert.deepEqual(body, { Data: [] });
});

test("returns a merged portable manifest for x64 and arm64", async () => {
  const { response, body } = await jsonResponse(
    `/packageManifests/${encodeURIComponent(packageMetadata.identifier)}?Version=0.3.2`,
  );
  assert.equal(response.status, 200);
  const manifest = (body as { Data: { Versions: Array<{ Installers: Array<Record<string, unknown>> }> } }).Data;
  assert.deepEqual(
    manifest.Versions[0]?.Installers.map((installer) => installer.Architecture),
    ["x64", "arm64"],
  );
  assert.ok(manifest.Versions[0]?.Installers.every((installer) => installer.NestedInstallerType === "portable"));
});

test("returns no content for an unknown version or package", async () => {
  for (const path of [
    `/packageManifests/${packageMetadata.identifier}?Version=9.9.9`,
    "/packageManifests/Unknown.Package",
  ]) {
    const { response, body } = await jsonResponse(path);
    assert.equal(response.status, 204);
    assert.equal(body, undefined);
  }
});

test("rejects invalid JSON and unsupported methods", async () => {
  const invalid = await jsonResponse("/manifestSearch", { method: "POST", body: "{" });
  assert.equal(invalid.response.status, 400);
  const method = await jsonResponse("/information", { method: "DELETE" });
  assert.equal(method.response.status, 405);
  const oversized = await jsonResponse("/manifestSearch", {
    method: "POST",
    headers: { "content-length": "65537" },
    body: "{}",
  });
  assert.equal(oversized.response.status, 413);
});
