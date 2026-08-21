# RANNZ UNLOCK

> Unlock. Resolve. Download.

A secure resolver for **publicly accessible** download links — paste a URL, RANNZ UNLOCK validates it, checks the source, and hands you back a clean result card with file name, type, size, and a direct download button.

Built for **Cloudflare Pages + Cloudflare Workers + Cloudflare D1**. No Express, no heavy frameworks — plain HTML/CSS/JS on the frontend, a plain `fetch`-handler Worker on the backend.

## What this is (and isn't)

RANNZ UNLOCK only resolves resources that are **already public** — direct file URLs, or pages that legitimately expose a public download link. It will refuse to touch anything behind authentication, a paywall, DRM, a CAPTCHA, or an access control the source put there on purpose. It never becomes an open proxy: every request is validated (protocol, hostname, IP range) before the Worker fetches anything, and results aren't stored permanently.

---

## 1. Project structure

```
rannz-unlock/
├── public/              # Frontend — served as static assets by the Worker
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   └── assets/
├── worker/               # Backend — Cloudflare Worker
│   ├── index.js          # Router / entry point
│   ├── auth.js            # Register / login / logout / session handling
│   ├── resolver.js        # URL resolution + streaming download proxy
│   ├── security.js        # SSRF checks + rate limiting
│   └── utils.js           # Crypto, cookies, validation, response helpers
├── migrations/
│   └── 001_init.sql       # D1 schema: users, sessions, download_history, rate_limits
├── wrangler.toml
├── package.json
└── README.md
```

This project uses **Workers Assets** (the `[assets]` block in `wrangler.toml`) so a single `wrangler deploy` serves both the frontend and the `/api/*` routes from one Worker — no separate Cloudflare Pages project is required. If you'd rather split them (frontend on Pages, API on a Worker), see [section 9](#9-alternative-split-hosting-pages--worker).

---

## 2. Prerequisites

- A Cloudflare account
- Node.js 18+
- The Wrangler CLI (installed via `npm install`, or globally with `npm install -g wrangler`)

## 3. Install dependencies

```bash
cd rannz-unlock
npm install
```

## 4. Login to Cloudflare

```bash
npx wrangler login
```

This opens a browser window to authorize Wrangler against your Cloudflare account.

## 5. Create the D1 database

```bash
npm run db:create
# or: npx wrangler d1 create rannz-unlock-db
```

Wrangler prints a `database_id`. Copy it into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "rannz-unlock-db"
database_id = "PASTE_THE_ID_HERE"
```

## 6. Run the migration

Local (for `wrangler dev`):

```bash
npm run db:migrate:local
```

Remote (production database):

```bash
npm run db:migrate:remote
```

This creates the `users`, `sessions`, `download_history`, and `rate_limits` tables from `migrations/001_init.sql`.

## 7. Configure bindings & secrets

The D1 binding (`DB`) and the static-assets binding (`ASSETS`) are already declared in `wrangler.toml` — no extra setup needed for those once the `database_id` is filled in.

Two secrets are required. **Never put these in `wrangler.toml` or commit them** — set them with Wrangler, which stores them encrypted:

```bash
npx wrangler secret put SESSION_SECRET
# paste a long random string when prompted (e.g. `openssl rand -hex 32`)

npx wrangler secret put PASSWORD_PEPPER
# paste a different long random string
```

- `SESSION_SECRET` is reserved for future use if you extend session handling (e.g. signed tokens); the current implementation authenticates sessions by looking up a hashed token in D1, so no signing key is strictly required today, but setting it now keeps the door open without a redeploy later.
- `PASSWORD_PEPPER` is mixed into every password hash (PBKDF2-SHA256, 150,000 iterations) in addition to a random per-user salt. Losing this value doesn't lock out existing users by itself, but rotating it does invalidate all stored password hashes, so back it up somewhere safe (e.g. your password manager), not in source control.

Non-secret runtime config (timeouts, size limits, rate-limit thresholds) lives in the `[vars]` block in `wrangler.toml` and can be edited directly.

## 8. Deploy

```bash
npm run dev       # local dev server at http://localhost:8787
npm run deploy    # deploys the Worker (serving both API + frontend)
```

After `deploy`, Wrangler prints your live URL (`https://rannz-unlock.<your-subdomain>.workers.dev`, or a custom domain if you've configured one in the Cloudflare dashboard).

## 9. Alternative: split hosting (Pages + Worker)

If you'd rather host the frontend on Cloudflare Pages and the API on a separate Worker:

1. Deploy `worker/` as its own Worker (`wrangler deploy`) and note its URL.
2. Deploy the `public/` folder to Cloudflare Pages (`npx wrangler pages deploy public`).
3. In `public/app.js`, change the relative `/api/...` paths to the full Worker URL, and add the Pages domain to `CORS`-related handling in `worker/index.js` (the current setup assumes same-origin, so you'll need to add `Access-Control-Allow-Origin` headers scoped to your Pages domain, and switch cookies' `SameSite` from `Strict` to `None; Secure` since they'd now be cross-site).

The combined single-Worker setup in section 8 avoids all of this and is the recommended path.

---

## 10. Testing

### Test register
1. Open the deployed URL → **Login / Register** → **Register** tab.
2. Fill in a username (3+ chars), a valid email, and a password (8+ chars) that matches the confirm field.
3. Submit — you should land on the dashboard, logged in, with a session cookie set (check DevTools → Application → Cookies → `rannz_session`, flagged `HttpOnly` + `Secure`).

### Test login
1. Log out (button in the navbar).
2. Go to **Login**, use the same email/username + password.
3. Confirm you're redirected to the dashboard and `GET /api/auth/me` returns your user.

### Test resolver
1. From the dashboard (or the homepage, without logging in), paste a known-public direct-download URL (e.g. a sample file from a public CDN).
2. Watch the four-step animation (`VALIDATING URL → CHECKING SOURCE → RESOLVING RESOURCE → READY`) and confirm the result card shows a real file name, type, and size.
3. Try an unsupported URL (e.g. `http://localhost/`, `http://169.254.169.254/`, or a private IP like `http://10.0.0.1/`) and confirm you get **"This link cannot be resolved safely."** — this proves the SSRF guard is active.

### Test download
1. From a successful result card, click **DOWNLOAD FILE**.
2. It opens the source URL directly in a new tab (the resolver prefers direct-from-source downloads). If the source doesn't support that well, the Worker also exposes `GET /api/download/:historyId` as a streaming fallback for logged-in users, which re-validates the URL and streams the file through the Worker without buffering it in memory.

---

## 11. API reference

| Method | Path                  | Auth required | Description |
|--------|------------------------|:---:|---|
| POST   | `/api/auth/register`   | – | Create an account. Body: `{ username, email, password, confirmPassword }` |
| POST   | `/api/auth/login`      | – | Log in. Body: `{ identifier, password }` (identifier = email or username) |
| POST   | `/api/auth/logout`     | – | Clear the current session |
| GET    | `/api/auth/me`         | ✔ | Current user info |
| POST   | `/api/resolve`         | – (optional) | Body: `{ url }`. Works anonymously; logged-in requests are saved to history |
| GET    | `/api/history`         | ✔ | Last 50 resolve attempts for the current user |
| GET    | `/api/download/:id`    | ✔ | Streaming download proxy fallback for a past successful resolve |

All responses are JSON: `{ ok: true, ... }` on success, `{ ok: false, error, reason? }` on failure. No stack traces or internals are ever returned to the client.

## 12. Security notes & known limitations

- **Passwords**: hashed with PBKDF2-SHA256 (150,000 iterations) + per-user random salt + a server-side pepper. Never stored in plaintext.
- **Sessions**: random 256-bit tokens; only the SHA-256 hash of the token is stored in D1. Cookies are `HttpOnly`, `Secure`, `SameSite=Strict`.
- **CSRF**: covered by `SameSite=Strict` cookies for the combined single-origin deployment (section 8) — cross-site requests never carry the session cookie. If you switch to split hosting (section 9) with `SameSite=None`, add an explicit CSRF token, since the cookie-based protection no longer applies.
- **SSRF protection**: the resolver rejects non-http(s) protocols, `localhost`/loopback, link-local (including the `169.254.169.254` cloud metadata address), RFC 1918 private ranges, and IPv6 unique-local/link-local addresses, checking both the requested URL and the final URL after redirects. This is a literal-hostname/IP filter, not a DNS-resolution-time check — Cloudflare Workers doesn't expose the resolved IP before `fetch()` runs, so a DNS name that only resolves to a private IP at request time is a known gap. For stronger guarantees, consider pairing this with a Cloudflare-side network policy (e.g. restricting the Worker's egress) if that risk matters for your deployment.
- **Rate limiting**: a simple D1-backed fixed-window limiter on `/api/auth/*` and `/api/resolve`, keyed by IP (or user ID when logged in). It isn't perfectly precise under high concurrency (no distributed locking) — good enough to blunt casual abuse, not a substitute for Cloudflare's own WAF/rate-limiting rules if you need stronger guarantees at scale.
- **File handling**: nothing is stored permanently. The resolve step only reads headers (HEAD, falling back to GET) to report metadata. The download proxy streams the response body straight through instead of buffering it in Worker memory, so large files don't hit memory limits — but very large files may still hit the Workers CPU/subrequest duration limits on some plans, in which case the direct-source download link (returned alongside the proxy link) is the better path.
- **Never bypasses protections**: the resolver deliberately does not attempt to defeat authentication, DRM, paywalls, CAPTCHAs, signed URLs, or any other access control. Unsupported/protected links return `"This link cannot be resolved safely."`

## 13. Errors you'll see

| Situation | Message |
|---|---|
| Malformed or non-http(s) URL | Invalid URL |
| Private/internal/metadata address | This link cannot be resolved safely. |
| Source returns an error status | This link cannot be resolved safely. |
| Source takes too long | The source took too long to respond. |
| File exceeds size limit | File exceeds the configured size limit. |
| Too many requests | Rate limit exceeded / Too many attempts |
| Not logged in on a protected route | Authentication required. |
| Resolver can't classify the resource | This link cannot be resolved safely. |

---

Built with plain HTML/CSS/JS, Cloudflare Workers, and Cloudflare D1 — no Express, no unnecessary frameworks.
