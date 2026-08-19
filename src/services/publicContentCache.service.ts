export const PUBLIC_CONTENT_PATHS = [
  "/api/public/content",
  "/api/public/members",
  "/api/public/events",
  "/api/public/settings",
  "/api/public/announcements",
  "/api/public/social-work",
] as const;

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

export function isPublicContentRequest(request: Request): boolean {
  if (request.method !== "GET") return false;
  const path = new URL(request.url).pathname.replace(/\/$/, "");
  return (PUBLIC_CONTENT_PATHS as readonly string[]).includes(path);
}

export function createPublicContentCacheKey(
  requestOrPath: Request | string,
  namespace: string,
): Request {
  const path = typeof requestOrPath === "string"
    ? requestOrPath
    : new URL(requestOrPath.url).pathname.replace(/\/$/, "");
  const encodedNamespace = encodeURIComponent(namespace || "default");
  return new Request(
    `https://public-content-cache.asrgh.internal/v1/${encodedNamespace}${path}`,
    { method: "GET" },
  );
}

export async function serveWithPublicContentCache(
  request: Request,
  fetchFromOrigin: () => Promise<Response>,
  options: PublicContentCacheOptions,
): Promise<Response> {
  if (!isPublicContentRequest(request)) return fetchFromOrigin();
  if (!Number.isFinite(options.ttlSeconds) || options.ttlSeconds <= 0) {
    console.error("PUBLIC_CONTENT_CACHE_CONFIG_ERROR: PUBLIC_CACHE_TTL_SECONDS must be a positive number");
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
  cachedResponse.headers.set("X-ASRGH-Cache-Namespace", "public-content-v1");

  try {
    await options.cache.put(key, cachedResponse);
  } catch (error) {
    console.error("PUBLIC_CONTENT_CACHE_WRITE_ERROR:", error);
  }

  return response;
}

export async function purgePublicContentCache(
  options: Pick<PublicContentCacheOptions, "cache" | "namespace">,
): Promise<void> {
  const results = await Promise.allSettled(
    PUBLIC_CONTENT_PATHS.map((path) =>
      options.cache.delete(createPublicContentCacheKey(path, options.namespace)),
    ),
  );
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    throw new Error(`Failed to invalidate ${failures.length} public cache entries`);
  }
}
