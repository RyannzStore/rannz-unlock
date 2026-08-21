// ─────────────────────────────────────────────
// RANNZ UNLOCK — Worker entry point
// Routes /api/* to handlers. Static assets (public/) are served
// automatically by the Workers Assets binding for every other path.
// ─────────────────────────────────────────────
import { errorResponse, applySecurityHeaders } from "./utils.js";
import {
  handleRegister,
  handleLogin,
  handleLogout,
  handleMe,
  getAuthenticatedUser,
} from "./auth.js";
import { handleResolve, handleDownloadProxy, handleHistory } from "./resolver.js";

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const { pathname } = url;

      if (pathname.startsWith("/api/")) {
        return await routeApi(request, env, pathname);
      }

      // Not an API route — let the Assets binding serve the frontend.
      return env.ASSETS.fetch(request);
    } catch (err) {
      // Never leak stack traces or internals to the client.
      console.error("Unhandled error:", err);
      return errorResponse("Internal server error.", 500);
    }
  },
};

async function routeApi(request, env, pathname) {
  const method = request.method;

  if (pathname === "/api/auth/register" && method === "POST") {
    return handleRegister(request, env);
  }
  if (pathname === "/api/auth/login" && method === "POST") {
    return handleLogin(request, env);
  }
  if (pathname === "/api/auth/logout" && method === "POST") {
    return handleLogout(request, env);
  }
  if (pathname === "/api/auth/me" && method === "GET") {
    return handleMe(request, env);
  }

  if (pathname === "/api/resolve" && method === "POST") {
    const user = await getAuthenticatedUser(request, env);
    return handleResolve(request, env, user);
  }

  if (pathname === "/api/history" && method === "GET") {
    const user = await getAuthenticatedUser(request, env);
    return handleHistory(request, env, user);
  }

  const downloadMatch = pathname.match(/^\/api\/download\/([a-zA-Z0-9-]+)$/);
  if (downloadMatch && method === "GET") {
    const user = await getAuthenticatedUser(request, env);
    return handleDownloadProxy(request, env, user, downloadMatch[1]);
  }

  const headers = new Headers();
  applySecurityHeaders(headers);
  return new Response(JSON.stringify({ ok: false, error: "Not found." }), {
    status: 404,
    headers: { ...Object.fromEntries(headers), "Content-Type": "application/json" },
  });
}
