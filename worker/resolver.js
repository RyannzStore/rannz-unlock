// ─────────────────────────────────────────────
// RANNZ UNLOCK — resolver handlers
// Resolves public download URLs into clean metadata + a safe
// download path. Never bypasses auth, DRM, paywalls, or CAPTCHAs —
// it only fetches resources that are already publicly accessible.
// ─────────────────────────────────────────────
import { json, errorResponse, newId, getClientIp } from "./utils.js";
import { isUrlSafeToFetch, checkRateLimit } from "./security.js";

const UNSUPPORTED_MESSAGE = "This link cannot be resolved safely.";

export async function handleResolve(request, env, user) {
  const ip = getClientIp(request);
  const limit = await checkRateLimit(env, "resolve", user ? user.id : ip);
  if (!limit.allowed) {
    return errorResponse("Rate limit exceeded. Please slow down.", 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid request body.", 400);
  }

  const rawUrl = (body && body.url ? String(body.url) : "").trim();
  if (!rawUrl) {
    return errorResponse("Please provide a URL.", 400);
  }

  const safety = isUrlSafeToFetch(rawUrl);
  if (!safety.safe) {
    if (user) await recordHistory(env, user.id, rawUrl, "failed", null, safety.reason);
    return errorResponse(UNSUPPORTED_MESSAGE, 422, { reason: safety.reason });
  }

  const timeoutMs = parseInt(env.RESOLVER_TIMEOUT_MS || "10000", 10);
  const maxBytes = parseInt(env.RESOLVER_MAX_BYTES || "104857600", 10);

  let meta;
  try {
    meta = await probeResource(rawUrl, timeoutMs);
  } catch (err) {
    const reason = err && err.name === "AbortError" ? "The source took too long to respond." : "The resource is unavailable or unsupported.";
    if (user) await recordHistory(env, user.id, rawUrl, "failed", null, reason);
    return errorResponse(UNSUPPORTED_MESSAGE, 422, { reason });
  }

  if (!meta.ok) {
    if (user) await recordHistory(env, user.id, rawUrl, "failed", null, meta.reason);
    return errorResponse(UNSUPPORTED_MESSAGE, 422, { reason: meta.reason });
  }

  if (meta.size !== null && meta.size > maxBytes) {
    const reason = `File exceeds the ${(maxBytes / (1024 * 1024)).toFixed(0)} MB size limit.`;
    if (user) await recordHistory(env, user.id, rawUrl, "failed", null, reason);
    return errorResponse(reason, 413);
  }

  const historyId = user
    ? await recordHistory(env, user.id, rawUrl, "success", meta, null)
    : null;

  return json({
    ok: true,
    result: {
      fileName: meta.fileName,
      fileType: meta.fileType,
      fileSize: meta.size,
      // Prefer sending the client straight to the source (it's already
      // public); the proxy endpoint below is only a fallback when the
      // source doesn't support direct browser download (e.g. missing
      // CORS or requires specific headers we already validated here).
      downloadUrl: rawUrl,
      proxyDownloadUrl: historyId ? `/api/download/${historyId}` : null,
    },
  });
}

export async function handleDownloadProxy(request, env, user, historyId) {
  if (!user) return errorResponse("Authentication required.", 401);

  const record = await env.DB.prepare(
    "SELECT * FROM download_history WHERE id = ? AND user_id = ?"
  )
    .bind(historyId, user.id)
    .first();

  if (!record || record.status !== "success") {
    return errorResponse("This download link is no longer available.", 404);
  }

  const safety = isUrlSafeToFetch(record.url);
  if (!safety.safe) {
    return errorResponse(UNSUPPORTED_MESSAGE, 422);
  }

  const timeoutMs = parseInt(env.RESOLVER_TIMEOUT_MS || "10000", 10);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let upstream;
  try {
    upstream = await fetch(record.url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "RannzUnlock/1.0 (+resolver)" },
    });
  } catch {
    clearTimeout(timer);
    return errorResponse("Network error while contacting the source.", 502);
  }
  clearTimeout(timer);

  if (!upstream.ok) {
    return errorResponse("The resource is unavailable or unsupported.", 502);
  }

  const headers = new Headers();
  headers.set("Content-Type", upstream.headers.get("Content-Type") || "application/octet-stream");
  const contentLength = upstream.headers.get("Content-Length");
  if (contentLength) headers.set("Content-Length", contentLength);
  headers.set(
    "Content-Disposition",
    `attachment; filename="${(record.file_name || "download").replace(/["\\]/g, "")}"`
  );
  headers.set("X-Content-Type-Options", "nosniff");

  // Stream the body straight through rather than buffering it in
  // memory, so large files don't blow the Worker's memory limit.
  return new Response(upstream.body, { status: 200, headers });
}

export async function handleHistory(request, env, user) {
  if (!user) return errorResponse("Authentication required.", 401);

  const rows = await env.DB.prepare(
    `SELECT id, url, file_name, file_type, file_size, status, reason, created_at
     FROM download_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`
  )
    .bind(user.id)
    .all();

  return json({ ok: true, history: rows.results || [] });
}

// ── internals ──

async function probeResource(rawUrl, timeoutMs) {
  const attempt = async (method) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(rawUrl, {
        method,
        redirect: "follow",
        signal: controller.signal,
        headers: { "User-Agent": "RannzUnlock/1.0 (+resolver)" },
      });
      return res;
    } finally {
      clearTimeout(timer);
    }
  };

  let res;
  try {
    res = await attempt("HEAD");
    if (!res.ok || res.status === 405) {
      res = await attempt("GET");
    }
  } catch {
    res = await attempt("GET");
  }

  if (!res.ok) {
    return { ok: false, reason: `Source returned status ${res.status}.` };
  }

  // Re-check the final URL after redirects for SSRF safety.
  const finalSafety = isUrlSafeToFetch(res.url || rawUrl);
  if (!finalSafety.safe) {
    return { ok: false, reason: finalSafety.reason };
  }

  const contentType = res.headers.get("Content-Type") || "application/octet-stream";
  const contentLengthHeader = res.headers.get("Content-Length");
  const size = contentLengthHeader ? parseInt(contentLengthHeader, 10) : null;
  const disposition = res.headers.get("Content-Disposition") || "";

  let fileName = extractFileNameFromDisposition(disposition);
  if (!fileName) {
    try {
      const pathname = new URL(res.url || rawUrl).pathname;
      fileName = decodeURIComponent(pathname.split("/").filter(Boolean).pop() || "download");
    } catch {
      fileName = "download";
    }
  }

  return {
    ok: true,
    fileName,
    fileType: contentType.split(";")[0].trim(),
    size,
  };
}

function extractFileNameFromDisposition(disposition) {
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

async function recordHistory(env, userId, url, status, meta, reason) {
  const id = newId();
  await env.DB.prepare(
    `INSERT INTO download_history (id, user_id, url, file_name, file_type, file_size, status, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      userId,
      url,
      meta ? meta.fileName : null,
      meta ? meta.fileType : null,
      meta ? meta.size : null,
      status,
      reason
    )
    .run();
  return id;
}
