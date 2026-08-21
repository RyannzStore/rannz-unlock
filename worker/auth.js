// ─────────────────────────────────────────────
// RANNZ UNLOCK — authentication handlers
// ─────────────────────────────────────────────
import {
  json,
  errorResponse,
  newId,
  newToken,
  sha256Hex,
  hashPassword,
  verifyPassword,
  serializeCookie,
  clearCookie,
  parseCookies,
  getClientIp,
  isValidEmail,
  isValidUsername,
} from "./utils.js";
import { checkRateLimit } from "./security.js";

const SESSION_COOKIE = "rannz_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export async function handleRegister(request, env) {
  const ip = getClientIp(request);
  const limit = await checkRateLimit(env, "auth", ip);
  if (!limit.allowed) {
    return errorResponse("Too many attempts. Please try again shortly.", 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid request body.", 400);
  }

  const { username, email, password, confirmPassword } = body || {};

  if (!username || !isValidUsername(username)) {
    return errorResponse(
      "Username must be at least 3 characters and contain only letters, numbers, dots, dashes or underscores.",
      400
    );
  }
  if (!email || !isValidEmail(email)) {
    return errorResponse("Please provide a valid email address.", 400);
  }
  if (!password || password.length < 8) {
    return errorResponse("Password must be at least 8 characters.", 400);
  }
  if (password !== confirmPassword) {
    return errorResponse("Passwords do not match.", 400);
  }

  const normalizedEmail = email.trim().toLowerCase();
  const normalizedUsername = username.trim();

  const existing = await env.DB.prepare(
    "SELECT id FROM users WHERE email = ? OR username = ?"
  )
    .bind(normalizedEmail, normalizedUsername)
    .first();

  if (existing) {
    return errorResponse("Username or email is already registered.", 409);
  }

let passwordHash;

try {
  passwordHash = await hashPassword(
    password,
    env.PASSWORD_PEPPER || ""
  );
} catch (err) {
  console.error("HASH ERROR:", err);
  return errorResponse(
    "Password hashing failed.",
    500,
    { debug: err?.message || String(err) }
  );
}
  await env.DB.prepare(
    "INSERT INTO users (id, username, email, password_hash) VALUES (?, ?, ?, ?)"
  )
    .bind(userId, normalizedUsername, normalizedEmail, passwordHash)
    .run();

  const session = await createSession(env, userId);

  return json(
    { ok: true, user: { id: userId, username: normalizedUsername, email: normalizedEmail } },
    {
      status: 201,
      headers: { "Set-Cookie": serializeCookie(SESSION_COOKIE, session.token, { maxAge: SESSION_TTL_SECONDS }) },
    }
  );
}

export async function handleLogin(request, env) {
  const ip = getClientIp(request);
  const limit = await checkRateLimit(env, "auth", ip);
  if (!limit.allowed) {
    return errorResponse("Too many attempts. Please try again shortly.", 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid request body.", 400);
  }

  const { identifier, password } = body || {};
  if (!identifier || !password) {
    return errorResponse("Email/username and password are required.", 400);
  }

  const normalized = identifier.trim().toLowerCase();
  const user = await env.DB.prepare(
    "SELECT id, username, email, password_hash FROM users WHERE email = ? OR username = ?"
  )
    .bind(normalized, identifier.trim())
    .first();

  // Generic error message on purpose — do not reveal which field was wrong,
  // and always run verifyPassword (even against a dummy hash) to avoid
  // leaking account existence via response timing.
  const dummyHash = "pbkdf2$150000$00$00";
  const isValid = await verifyPassword(
    password,
    env.PASSWORD_PEPPER || "",
    user ? user.password_hash : dummyHash
  );

  if (!user || !isValid) {
    return errorResponse("Invalid credentials.", 401);
  }

  const session = await createSession(env, user.id);

  return json(
    { ok: true, user: { id: user.id, username: user.username, email: user.email } },
    {
      headers: { "Set-Cookie": serializeCookie(SESSION_COOKIE, session.token, { maxAge: SESSION_TTL_SECONDS }) },
    }
  );
}

export async function handleLogout(request, env) {
  const cookies = parseCookies(request);
  const token = cookies[SESSION_COOKIE];
  if (token) {
    const tokenHash = await sha256Hex(token);
    await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(tokenHash).run();
  }
  return json(
    { ok: true },
    { headers: { "Set-Cookie": clearCookie(SESSION_COOKIE) } }
  );
}

export async function handleMe(request, env) {
  const user = await getAuthenticatedUser(request, env);
  if (!user) return errorResponse("Not authenticated.", 401);
  return json({ ok: true, user });
}

export async function createSession(env, userId) {
  const token = newToken();
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();

  await env.DB.prepare(
    "INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)"
  )
    .bind(tokenHash, userId, expiresAt)
    .run();

  return { token, expiresAt };
}

/**
 * Resolves the authenticated user from the session cookie, or null.
 * Also enforces basic CSRF hardening for state-changing requests: since
 * cookies are SameSite=Strict, cross-site requests never carry the
 * session cookie in the first place, which covers the standard CSRF
 * threat model for this app without needing a separate token.
 */
export async function getAuthenticatedUser(request, env) {
  const cookies = parseCookies(request);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;

  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT users.id as id, users.username as username, users.email as email,
            users.created_at as created_at, sessions.expires_at as expires_at
     FROM sessions
     JOIN users ON users.id = sessions.user_id
     WHERE sessions.id = ?`
  )
    .bind(tokenHash)
    .first();

  if (!row) return null;

  if (new Date(row.expires_at).getTime() < Date.now()) {
    await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(tokenHash).run();
    return null;
  }

  return {
    id: row.id,
    username: row.username,
    email: row.email,
    createdAt: row.created_at,
  };
}
