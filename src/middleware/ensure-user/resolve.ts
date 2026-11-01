import { env } from "cloudflare:workers";
import { getAuthMode, isHostedAuthMode } from "@/lib/auth-mode";
import { AppError } from "@/server/lib/errors";
import { resolveCloudflareAccessContext } from "./cloudflareAccess";
import { resolveLocalNoAuthContext } from "./delegated";
import { resolveHostedContext } from "./hosted";
import type { EnsuredUserContext } from "./types";

// Resolves the authenticated user for a request's headers across every auth
// mode. Shared by ensureUserMiddleware (server functions) and raw API routes,
// which can't use function middleware.
export async function resolveUserContextFromHeaders(
  headers: Headers,
): Promise<EnsuredUserContext> {
  const authMode = getAuthMode(env.AUTH_MODE);
  if (authMode === "local_noauth") {
    return resolveLocalNoAuthContext();
  }
  if (isHostedAuthMode(authMode)) {
    return resolveHostedContext(headers);
  }
  const context = await resolveCloudflareAccessContext(headers);
  // Service tokens are only accepted on /mcp. Every other route still
  // requires a human Access identity.
  if (!context) {
    throw new AppError("FORBIDDEN");
  }
  return context;
}
