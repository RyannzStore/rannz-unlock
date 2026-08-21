// ─────────────────────────────────────────────
// RANNZ UNLOCK — shared utilities
// ─────────────────────────────────────────────

export function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Content-Type", "application/json; charset=utf-8");
  applySecurityHeaders(headers);
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function errorResponse(message, status = 400, extra = {}) {
  return json({ ok: false, error: message, ...extra }, { status });
}

export function applySecurityHeaders(headers) {
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("X-Frame-Options", "DENY");
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; script-src 'self'; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'none'"
  );
  headers.set(
    "Permissions-Policy",
    "geolocation=(), microphone=(), camera=()"
  );
}

export function newId() {
  return crypto.randomUUID();
}

export function newToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bufferToHex(bytes.buffer);
}

export function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bufferToHex(digest);
}

// ── Password hashing (PBKDF2-SHA256 via Web Crypto — no native
// bcrypt is available in the Workers runtime, so PBKDF2 with a
// high iteration count is the standard alternative). ──
const PBKDF2_ITERATIONS = 100000;

export async function hashPassword(password, pepper) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hashBuffer = await pbkdf2(password, pepper, salt);
  const saltHex = bufferToHex(salt.buffer);
  const hashHex = bufferToHex(hashBuffer);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${saltHex}$${hashHex}`;
}

export async function verifyPassword(password, pepper, stored) {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = parseInt(parts[1], 10);
  const salt = hexToBuffer(parts[2]);
  const expectedHex = parts[3];
  const hashBuffer = await pbkdf2(password, pepper, salt, iterations);
  const actualHex = bufferToHex(hashBuffer);
  return timingSafeEqual(actualHex, expectedHex);
}

async function pbkdf2(password, pepper, salt, iterations = PBKDF2_ITERATIONS) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password + pepper),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    256
  );
}

function hexToBuffer(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes.buffer;
}

export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// ── Cookies ──
export function serializeCookie(name, value, opts = {}) {
  const parts = [`${name}=${value}`];
  parts.push(`Path=${opts.path || "/"}`);
  parts.push(`HttpOnly`);
  parts.push(`Secure`);
  parts.push(`SameSite=${opts.sameSite || "Strict"}`);
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  return parts.join("; ");
}

export function clearCookie(name) {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function parseCookies(request) {
  const header = request.headers.get("Cookie") || "";
  const cookies = {};
  header.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) cookies[key] = value;
  });
  return cookies;
}

export function getClientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

// ── Validation ──
export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function isValidUsername(username) {
  return /^[a-zA-Z0-9_.-]{3,32}$/.test(username);
}
