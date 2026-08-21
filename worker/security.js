// ─────────────────────────────────────────────
// RANNZ UNLOCK — security helpers
// SSRF protection + basic rate limiting
// ─────────────────────────────────────────────

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "0.0.0.0",
  "metadata.google.internal",
]);

// Hostnames/suffixes commonly used for cloud metadata endpoints or
// internal-only access, blocked regardless of literal IP form.
const BLOCKED_SUFFIXES = [".local", ".internal", ".localhost"];

/**
 * Validates that a URL is safe to fetch server-side:
 * - http/https only
 * - not localhost / loopback / link-local / private / metadata ranges
 * - not an IP-literal in a blocked range
 * Note: this checks the literal hostname/IP in the URL. It does not
 * perform DNS resolution before the check (Workers' fetch resolves
 * DNS internally and doesn't expose the resolved IP beforehand), so
 * this is a best-effort filter against obvious SSRF targets — it is
 * not a substitute for network-level egress controls. This is
 * documented as a known limitation in the README.
 */
export function isUrlSafeToFetch(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { safe: false, reason: "Malformed URL." };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { safe: false, reason: "Only http and https URLs are supported." };
  }

  const hostname = url.hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { safe: false, reason: "This host is not allowed." };
  }

  for (const suffix of BLOCKED_SUFFIXES) {
    if (hostname.endsWith(suffix)) {
      return { safe: false, reason: "This host is not allowed." };
    }
  }

  const ipCheck = checkIpLiteral(hostname);
  if (ipCheck.isIp && !ipCheck.allowed) {
    return { safe: false, reason: "This host resolves to a blocked network range." };
  }

  if (url.username || url.password) {
    return { safe: false, reason: "URLs with embedded credentials are not allowed." };
  }

  return { safe: true };
}

function checkIpLiteral(hostname) {
  // IPv4
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const octets = ipv4Match.slice(1, 5).map(Number);
    if (octets.some((o) => o > 255)) return { isIp: true, allowed: false };
    const [a, b] = octets;
    const isPrivate =
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a === 127 || // loopback
      (a === 169 && b === 254) || // link-local / cloud metadata (169.254.169.254)
      a === 0;
    return { isIp: true, allowed: !isPrivate };
  }

  // IPv6 (loopback ::1, link-local fe80::/10, unique local fc00::/7)
  if (hostname.includes(":")) {
    const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (normalized === "::1") return { isIp: true, allowed: false };
    if (normalized.startsWith("fe80:") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) {
      return { isIp: true, allowed: false };
    }
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) {
      return { isIp: true, allowed: false };
    }
    return { isIp: true, allowed: true };
  }

  return { isIp: false, allowed: true };
}

/**
 * D1-backed fixed-window rate limiter.
 * Not perfectly precise under concurrency (no locking), but sufficient
 * to blunt casual abuse without requiring a Durable Object or KV binding.
 */
export async function checkRateLimit(env, bucket, key) {
  const windowSeconds = parseInt(env.RATE_LIMIT_WINDOW_SECONDS || "60", 10);
  const maxRequests = parseInt(env.RATE_LIMIT_MAX_REQUESTS || "20", 10);
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % windowSeconds);
  const bucketKey = `${bucket}:${key}`;

  const existing = await env.DB.prepare(
    "SELECT request_count FROM rate_limits WHERE bucket_key = ? AND window_start = ?"
  )
    .bind(bucketKey, windowStart)
    .first();

  if (existing) {
    if (existing.request_count >= maxRequests) {
      return { allowed: false };
    }
    await env.DB.prepare(
      "UPDATE rate_limits SET request_count = request_count + 1 WHERE bucket_key = ? AND window_start = ?"
    )
      .bind(bucketKey, windowStart)
      .run();
  } else {
    await env.DB.prepare(
      "INSERT INTO rate_limits (bucket_key, window_start, request_count) VALUES (?, ?, 1)"
    )
      .bind(bucketKey, windowStart)
      .run();
    // Opportunistically clean up old windows for this bucket prefix.
    await env.DB.prepare(
      "DELETE FROM rate_limits WHERE bucket_key = ? AND window_start < ?"
    )
      .bind(bucketKey, windowStart)
      .run();
  }

  return { allowed: true };
}
