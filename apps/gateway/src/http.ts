import { join } from "node:path";

import { Result } from "effect";

export const NO_WEB_ROOT_TEXT =
  "No browser client is being served. Build it with `bun run web:build` and start the gateway with --web-root apps/web/dist.";

const INDEX = "/index.html";

const NOT_FOUND = 404;

const UNAVAILABLE = 503;

export function isAllowedOrigin(origin: string | null, host: string | null): boolean {
  if (origin === null) return true;

  if (host === null) return false;

  return Result.match(
    Result.try(() => new URL(origin)),
    {
      onSuccess: (url) => url.host === host,
      onFailure: () => false,
    },
  );
}

export function safePathname(pathname: string): string | undefined {
  const decoded = Result.getOrUndefined(Result.try(() => decodeURIComponent(pathname)));

  if (decoded === undefined || !decoded.startsWith("/") || decoded.includes("\0")) {
    return undefined;
  }

  if (decoded.split("/").includes("..")) return undefined;

  return decoded === "/" ? INDEX : decoded;
}

export async function staticResponse(
  webRoot: string | undefined,
  pathname: string,
): Promise<Response> {
  if (webRoot === undefined) {
    return new Response(NO_WEB_ROOT_TEXT, { status: UNAVAILABLE });
  }

  const safe = safePathname(pathname);

  if (safe === undefined) return new Response("not found", { status: NOT_FOUND });

  const requested = Bun.file(join(webRoot, safe));

  if (await requested.exists()) return new Response(requested);

  const index = Bun.file(join(webRoot, INDEX));

  if (await index.exists()) return new Response(index);

  return new Response(NO_WEB_ROOT_TEXT, { status: UNAVAILABLE });
}
