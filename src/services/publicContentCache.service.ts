export const PUBLIC_CONTENT_PATHS = [
  "/api/public/content",
  "/api/public/members",
  "/api/public/events",
  "/api/public/settings",
  "/api/public/announcements",
  "/api/public/social-work",
] as const;

const PUBLIC_CONTENT_CACHE_VERSION = "v2";
const NO_ORIGIN_CACHE_PARTITION = "__no_origin__";

export interface PublicContentCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
  delete(request: Request): Promise<boolean>;
}

export interface PublicContentCacheOptions {
  cache: PublicContentCache;
  namespace: string;
  ttlSeconds: number;
}

export interface PublicContentCachePurgeOptions {
  cache: PublicContentCache;
  namespace: string;
  origins?: readonly string[];
}

export function isPublicContentRequest(request: Request): boolean {
  if (request.method !== "GET") return false;
  const path = new URL(request.url).pathname.replace(/\/$/, "");
  return (PUBLIC_CONTENT_PATHS as readonly string[]).includes(path);
}

function normalizeOrigin(origin: string | null | undefined): string {
  const trimmedOrigin = origin?.trim();
  if (!trimmedOrigin) return NO_ORIGIN_CACHE_PARTITION;

  try {
    return new URL(trimmedOrigin).origin;
  } catch {
    // Origin headers should be valid serialized origins. Keep malformed values
    // isolated instead of letting them share another request's cache entry.
    return trimmedOrigin;
  }
}

export function createPublicContentCacheKey(
  requestOrPath: Request | string,
  namespace: string,
  origin?: string | null,
): Request {
  const isRequest = typeof requestOrPath !== "string";
  const path = isRequest
    ? new URL(requestOrPath.url).pathname.replace(/\/$/, "")
    : requestOrPath;
  const requestOrigin = isRequest ? requestOrPath.headers.get("Origin") : origin;
  const encodedNamespace = encodeURIComponent(namespace || "default");
  const encodedOrigin = encodeURIComponent(normalizeOrigin(requestOrigin));

  return new Request(
    `https://public-content-cache.asrgh.internal/${PUBLIC_CONTENT_CACHE_VERSION}/${encodedNamespace}/${encodedOrigin}${path}`,
    { method: "GET" },
  );
}

export async function serveWithPublicContentCache(
  request: Request,
  fetchFromOrigin: () => Promise<Response>,
  options: PublicContentCacheOptions,
): Promise<Response> {
  if (!isPublicContentRequest(request)) return fetchFromOrigin();
  // A zero TTL intentionally disables the custom Cache API. Production uses
  // this mode for reliability; caching can be reintroduced later without
  // changing browser routing or CORS behavior.
  if (options.ttlSeconds === 0) return fetchFromOrigin();
  if (!Number.isFinite(options.ttlSeconds) || options.ttlSeconds < 0) {
    console.error("PUBLIC_CONTENT_CACHE_CONFIG_ERROR: PUBLIC_CACHE_TTL_SECONDS must be zero or a positive number");
    return fetchFromOrigin();
  }

  const key = createPublicContentCacheKey(request, options.namespace);
  try {
    const hit = await options.cache.match(key);
    if (hit) return hit;
  } catch (error) {
    console.error("PUBLIC_CONTENT_CACHE_READ_ERROR:", error);
  }

  const response = await fetchFromOrigin();
  if (!response.ok) return response;

  const cachedResponse = new Response(response.clone().body, response);
  cachedResponse.headers.set(
    "Cache-Control",
    `public, max-age=${Math.floor(options.ttlSeconds)}`,
  );
  cachedResponse.headers.set("X-ASRGH-Cache-Namespace", "public-content-v2");

  try {
    await options.cache.put(key, cachedResponse);
  } catch (error) {
    console.error("PUBLIC_CONTENT_CACHE_WRITE_ERROR:", error);
  }

  return response;
}

export async function purgePublicContentCache(
  options: PublicContentCachePurgeOptions,
): Promise<void> {
  const origins = [
    undefined,
    ...new Set((options.origins ?? []).map((origin) => origin.trim()).filter(Boolean)),
  ];

  const results = await Promise.allSettled(
    origins.flatMap((origin) =>
      PUBLIC_CONTENT_PATHS.map((path) =>
        options.cache.delete(
          createPublicContentCacheKey(path, options.namespace, origin),
        ),
      ),
    ),
  );
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    throw new Error(`Failed to invalidate ${failures.length} public cache entries`);
  }
}
