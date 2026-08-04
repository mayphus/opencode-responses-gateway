import { packageManifest, packageMetadata, searchResult } from "./package.ts";

const sourceIdentifier = "80f17ed5-4759-4d0f-a2b8-4d0d3ec6c422";
const supportedVersions = [
  "1.0.0",
  "1.1.0",
  "1.4.0",
  "1.5.0",
  "1.6.0",
  "1.7.0",
  "1.9.0",
  "1.10.0",
] as const;

type SearchMatch = {
  PackageMatchField?: unknown;
  RequestMatch?: {
    KeyWord?: unknown;
    MatchType?: unknown;
  };
};

type SearchRequest = {
  MaximumResults?: unknown;
  Query?: SearchMatch["RequestMatch"];
  Inclusions?: unknown;
  Filters?: unknown;
};

const responseHeaders = {
  "cache-control": "public, max-age=300",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
} as const;

function json(data: unknown, status = 200): Response {
  const headers = status < 400 ? responseHeaders : { ...responseHeaders, "cache-control": "no-store" };
  return new Response(JSON.stringify(data), { status, headers });
}

function noContent(): Response {
  return new Response(null, {
    status: 204,
    headers: { "cache-control": responseHeaders["cache-control"] },
  });
}

function normalizePath(pathname: string): string {
  const withoutTrailingSlash = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  return withoutTrailingSlash.replace(/^\/api(?=\/|$)/, "") || "/";
}

function asMatches(value: unknown): SearchMatch[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is SearchMatch => typeof entry === "object" && entry !== null)
    : [];
}

function fieldValues(field: unknown): readonly string[] {
  switch (typeof field === "string" ? field.toLowerCase() : "") {
    case "packageidentifier":
      return [packageMetadata.identifier];
    case "packagename":
      return [packageMetadata.name];
    case "publisher":
      return [packageMetadata.publisher];
    case "moniker":
      return [packageMetadata.moniker];
    case "tag":
      return ["ai", "gateway", "opencode", "responses-api"];
    case "command":
      return ["opencode-gateway"];
    default:
      return [packageMetadata.identifier, packageMetadata.name, packageMetadata.publisher, packageMetadata.moniker];
  }
}

function textMatches(value: string, keyword: string, matchType: unknown): boolean {
  const candidate = value.toLocaleLowerCase("en-US");
  const query = keyword.toLocaleLowerCase("en-US");
  switch (typeof matchType === "string" ? matchType.toLowerCase() : "substring") {
    case "exact":
    case "caseinsensitive":
      return candidate === query;
    case "startswith":
      return candidate.startsWith(query);
    case "wildcard":
      return candidate.includes(query.replaceAll("*", "").replaceAll("?", ""));
    case "substring":
    case "fuzzy":
    case "fuzzysubstring":
    default:
      return candidate.includes(query);
  }
}

function requestMatchMatches(match: SearchMatch): boolean {
  const keyword = match.RequestMatch?.KeyWord;
  if (typeof keyword !== "string" || keyword.length === 0) return true;
  return fieldValues(match.PackageMatchField).some((value) =>
    textMatches(value, keyword, match.RequestMatch?.MatchType),
  );
}

function searchMatches(request: SearchRequest): boolean {
  const filters = asMatches(request.Filters);
  if (!filters.every(requestMatchMatches)) return false;

  const inclusions = asMatches(request.Inclusions);
  if (inclusions.length > 0 && !inclusions.some(requestMatchMatches)) return false;

  return request.Query ? requestMatchMatches({ RequestMatch: request.Query }) : true;
}

async function handleSearch(request: Request): Promise<Response> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > 65_536) {
    return json({ error: { code: "RequestTooLarge", message: "The request body is too large." } }, 413);
  }

  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > 65_536) {
      return json({ error: { code: "RequestTooLarge", message: "The request body is too large." } }, 413);
    }
    body = JSON.parse(text);
  } catch {
    return json({ error: { code: "InvalidRequest", message: "The request body must be valid JSON." } }, 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return json({ error: { code: "InvalidRequest", message: "The request body must be a JSON object." } }, 400);
  }

  const searchRequest = body as SearchRequest;
  const maximumResults = typeof searchRequest.MaximumResults === "number" ? searchRequest.MaximumResults : 1;
  const Data = maximumResults === 0 || !searchMatches(searchRequest) ? [] : [searchResult];
  return json({ Data });
}

function handleManifest(url: URL, path: string): Response {
  const encodedIdentifier = path.slice("/packageManifests/".length);
  let identifier: string;
  try {
    identifier = decodeURIComponent(encodedIdentifier);
  } catch {
    return json({ error: { code: "InvalidRequest", message: "The package identifier is invalid." } }, 400);
  }

  if (identifier.toLocaleLowerCase("en-US") !== packageMetadata.identifier.toLocaleLowerCase("en-US")) {
    return noContent();
  }
  const version = url.searchParams.get("Version");
  const channel = url.searchParams.get("Channel");
  if ((version && version !== packageMetadata.version) || (channel && channel.length > 0)) return noContent();
  return json({ Data: packageManifest });
}

export async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = normalizePath(url.pathname);

  if (request.method === "GET" && path === "/") {
    return json({
      status: "ok",
      service: "Mayphus WinGet source",
      sourceUrl: "https://winget.mayphus.org/api/",
      packageIdentifier: packageMetadata.identifier,
      packageVersion: packageMetadata.version,
    });
  }
  if (request.method === "GET" && path === "/healthz") {
    return json({ status: "ok", packageVersion: packageMetadata.version });
  }
  if (request.method === "GET" && path === "/information") {
    return json({
      Data: {
        SourceIdentifier: sourceIdentifier,
        ServerSupportedVersions: supportedVersions,
      },
    });
  }
  if (request.method === "POST" && path === "/manifestSearch") return handleSearch(request);
  if (request.method === "GET" && path.startsWith("/packageManifests/")) return handleManifest(url, path);

  if (path === "/manifestSearch" || path.startsWith("/packageManifests/") || path === "/information") {
    return json({ error: { code: "MethodNotAllowed", message: "The HTTP method is not supported." } }, 405);
  }
  return json({ error: { code: "NotFound", message: "The requested endpoint does not exist." } }, 404);
}

export default {
  fetch(request: Request): Promise<Response> {
    return handleRequest(request);
  },
};
