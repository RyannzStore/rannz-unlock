// ─────────────────────────────────────────────
// RANNZ UNLOCK — frontend application
// ─────────────────────────────────────────────

const state = {
  user: null,
  routes: ["/", "/how-it-works", "/auth", "/dashboard"],
};

// ── API helper ──
async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    credentials: "same-origin",
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const message = (data && data.error) || `Request failed (${res.status}).`;
    const err = new Error(message);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ── Toasts ──
function toast(message, type = "info") {
  const stack = document.getElementById("toastStack");
  const el = document.createElement("div");
  el.className = `toast ${type === "error" ? "toast-error" : type === "success" ? "toast-success" : ""}`;
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

// ── Routing ──
function currentRoute() {
  const hash = window.location.hash.replace(/^#/, "") || "/";
  return hash.split("?")[0];
}

function navigate(path) {
  window.location.hash = `#${path}`;
}

function renderRoute() {
  let path = currentRoute();

  if (path === "/how-it-works") {
    // "How It Works" is a section on the home view, not a separate page.
    showView("/");
    document.getElementById("how-it-works")?.scrollIntoView({ behavior: "smooth" });
  } else if (path === "/dashboard" && !state.user) {
    navigate("/auth");
    return;
  } else if (path === "/auth" && state.user) {
    navigate("/dashboard");
    return;
  } else {
    if (!state.routes.includes(path)) path = "/";
    showView(path);
  }

  updateNavActive(path);
  if (path === "/dashboard") loadDashboard();
  window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
}

function showView(path) {
  document.querySelectorAll(".view").forEach((el) => {
    el.classList.toggle("hidden", el.dataset.view !== path);
  });
}

function updateNavActive(path) {
  document.querySelectorAll(".navbar-links a[data-nav]").forEach((a) => {
    a.classList.toggle("active", a.dataset.nav === path);
  });
}

window.addEventListener("hashchange", renderRoute);

// ── Auth state (nav visibility) ──
function applyAuthUI() {
  const authed = !!state.user;
  document.querySelectorAll("[data-auth-show]").forEach((el) => {
    el.hidden = !authed;
    el.classList.toggle("hidden", !authed);
  });
  document.querySelectorAll("[data-auth-hide]").forEach((el) => {
    el.classList.toggle("hidden", authed);
  });
}

async function refreshSession() {
  try {
    const data = await api("/api/auth/me");
    state.user = data.user;
  } catch {
    state.user = null;
  }
  applyAuthUI();
}

// ── Mobile nav toggle ──
document.getElementById("navbarToggle").addEventListener("click", () => {
  const links = document.getElementById("navbarLinks");
  const btn = document.getElementById("navbarToggle");
  const open = links.classList.toggle("open");
  btn.setAttribute("aria-expanded", String(open));
});
document.querySelectorAll(".navbar-links a").forEach((a) => {
  a.addEventListener("click", () => {
    document.getElementById("navbarLinks").classList.remove("open");
  });
});

// ── Auth tabs ──
document.querySelectorAll("[data-auth-tab]").forEach((tab) => {
  tab.addEventListener("click", () => {
    const target = tab.dataset.authTab;
    document.querySelectorAll("[data-auth-tab]").forEach((t) => t.classList.toggle("active", t === tab));
    document.querySelectorAll("[data-auth-panel]").forEach((p) => {
      p.classList.toggle("hidden", p.dataset.authPanel !== target);
    });
  });
});

// ── Password show/hide ──
document.querySelectorAll(".toggle-password").forEach((btn) => {
  btn.addEventListener("click", () => {
    const input = btn.previousElementSibling;
    input.type = input.type === "password" ? "text" : "password";
  });
});

// ── Login form ──
const loginForm = document.getElementById("loginForm");
loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = loginForm.querySelector('[data-error="login"]');
  errEl.hidden = true;
  setFormLoading(loginForm, true);

  const fd = new FormData(loginForm);
  try {
    const data = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        identifier: fd.get("identifier"),
        password: fd.get("password"),
      }),
    });
    state.user = data.user;
    applyAuthUI();
    toast(`Welcome back, ${data.user.username}!`, "success");
    navigate("/dashboard");
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  } finally {
    setFormLoading(loginForm, false);
  }
});

// ── Register form ──
const registerForm = document.getElementById("registerForm");
registerForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = registerForm.querySelector('[data-error="register"]');
  errEl.hidden = true;

  const fd = new FormData(registerForm);
  const password = fd.get("password");
  const confirmPassword = fd.get("confirmPassword");

  if (password !== confirmPassword) {
    errEl.textContent = "Passwords do not match.";
    errEl.hidden = false;
    return;
  }

  setFormLoading(registerForm, true);
  try {
    const data = await api("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        username: fd.get("username"),
        email: fd.get("email"),
        password,
        confirmPassword,
      }),
    });
    state.user = data.user;
    applyAuthUI();
    toast(`Account created — welcome, ${data.user.username}!`, "success");
    navigate("/dashboard");
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  } finally {
    setFormLoading(registerForm, false);
  }
});

function setFormLoading(form, loading) {
  const btn = form.querySelector('button[type="submit"]');
  const label = btn.querySelector(".btn-label");
  const spinner = btn.querySelector(".btn-spinner");
  btn.disabled = loading;
  if (label) label.style.opacity = loading ? "0" : "1";
  if (spinner) spinner.hidden = !loading;
}

// ── Logout ──
document.getElementById("logoutBtn").addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {
    /* best-effort */
  }
  state.user = null;
  applyAuthUI();
  toast("Logged out.");
  navigate("/");
});

// ── Resolver: shared processing animation driver ──
async function runProcessingAnimation(stepsEl, lockEl, progressFillEl) {
  const steps = ["validating", "checking", "resolving", "ready"];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    stepsEl.querySelectorAll("li").forEach((li) => {
      const s = li.dataset.step;
      li.classList.toggle("active", s === step);
      li.classList.toggle("done", steps.indexOf(s) < i);
    });
    if (progressFillEl) progressFillEl.style.width = `${((i + 1) / steps.length) * 100}%`;
    if (step === "ready" && lockEl) lockEl.classList.add("is-ready");
    // Purely visual pacing — this reflects the actual request lifecycle
    // (validate -> check source -> resolve), not a fake extra delay
    // beyond what's needed for the animation to read clearly.
    await sleep(i === steps.length - 1 ? 150 : 380);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return "Unknown";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = -1;
  do {
    value /= 1024;
    unitIndex++;
  } while (value >= 1024 && unitIndex < units.length - 1);
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[unitIndex]}`;
}

async function resolveUrl(rawUrl) {
  return api("/api/resolve", { method: "POST", body: JSON.stringify({ url: rawUrl }) });
}

// ── Hero (anonymous / landing) resolver ──
const heroForm = document.getElementById("heroResolverForm");
heroForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = document.getElementById("heroUrlInput").value.trim();
  if (!url) return;

  const resultWrap = document.getElementById("heroResult");
  const processing = document.getElementById("heroProcessing");
  const successCard = document.getElementById("heroResultSuccess");
  const errorCard = document.getElementById("heroResultError");
  resultWrap.classList.remove("hidden");
  processing.classList.remove("hidden");
  successCard.classList.add("hidden");
  errorCard.classList.add("hidden");
  document.getElementById("heroLockAnim").classList.remove("is-ready");

  const stepsEl = document.getElementById("heroProcessSteps");
  const lockEl = document.getElementById("heroLockAnim");

  const [outcome] = await Promise.all([
    resolveUrl(url).then(
      (data) => ({ ok: true, data }),
      (err) => ({ ok: false, err })
    ),
    runProcessingAnimation(stepsEl, lockEl, null),
  ]);

  processing.classList.add("hidden");

  if (outcome.ok) {
    const result = outcome.data.result;
    document.getElementById("heroFileName").textContent = result.fileName || "download";
    document.getElementById("heroFileType").textContent = result.fileType || "Unknown";
    document.getElementById("heroFileSize").textContent = formatBytes(result.fileSize);
    document.getElementById("heroDownloadBtn").href = result.downloadUrl;
    successCard.classList.remove("hidden");
  } else {
    const reason = (outcome.err.data && outcome.err.data.reason) || outcome.err.message;
    document.getElementById("heroErrReason").textContent = reason;
    errorCard.classList.remove("hidden");
  }
});

// ── Dashboard resolver ──
const dashForm = document.getElementById("dashResolverForm");
dashForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = document.getElementById("dashUrlInput").value.trim();
  if (!url) return;
  await runDashboardResolve(url);
});

async function runDashboardResolve(url) {
  const processing = document.getElementById("processingPanel");
  const successCard = document.getElementById("resultSuccess");
  const errorCard = document.getElementById("resultError");
  processing.classList.remove("hidden");
  successCard.classList.add("hidden");
  errorCard.classList.add("hidden");
  document.getElementById("lockAnim").classList.remove("is-ready");

  const stepsEl = document.getElementById("processSteps");
  const lockEl = document.getElementById("lockAnim");
  const progressFillEl = document.getElementById("progressFill");
  progressFillEl.style.width = "0%";

  const [outcome] = await Promise.all([
    resolveUrl(url).then(
      (data) => ({ ok: true, data }),
      (err) => ({ ok: false, err })
    ),
    runProcessingAnimation(stepsEl, lockEl, progressFillEl),
  ]);

  processing.classList.add("hidden");

  if (outcome.ok) {
    const result = outcome.data.result;
    document.getElementById("resFileName").textContent = result.fileName || "download";
    document.getElementById("resFileType").textContent = result.fileType || "Unknown";
    document.getElementById("resFileSize").textContent = formatBytes(result.fileSize);
    document.getElementById("downloadBtn").href = result.downloadUrl;
    successCard.classList.remove("hidden");
    toast("Link resolved successfully.", "success");
  } else {
    const reason = (outcome.err.data && outcome.err.data.reason) || outcome.err.message;
    document.getElementById("errReason").textContent = reason;
    errorCard.classList.remove("hidden");
    toast("Could not resolve that link.", "error");
  }

  loadHistoryAndStats();
}

// ── Dashboard: stats + history ──
async function loadDashboard() {
  if (!state.user) return;
  document.getElementById("dashUsername").textContent = state.user.username;
  document.getElementById("statCreated").textContent = state.user.createdAt
    ? new Date(state.user.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
    : "—";
  await loadHistoryAndStats();
}

async function loadHistoryAndStats() {
  try {
    const data = await api("/api/history");
    const history = data.history || [];
    document.getElementById("statLinks").textContent = String(history.length);
    document.getElementById("statDownloads").textContent = String(
      history.filter((h) => h.status === "success").length
    );
    renderHistory(history);
  } catch {
    /* silently ignore — dashboard still usable without history */
  }
}

function renderHistory(history) {
  const list = document.getElementById("historyList");
  const empty = document.getElementById("historyEmpty");
  list.querySelectorAll(".history-item").forEach((el) => el.remove());

  if (!history.length) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  history.forEach((item) => {
    const row = document.createElement("div");
    row.className = "history-item";
    const date = new Date(item.created_at).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    row.innerHTML = `
      <span class="h-url" title="${escapeHtml(item.url)}">${escapeHtml(item.url)}</span>
      <span class="muted" style="font-size:12px;white-space:nowrap;">${date}</span>
      <span class="h-status ${item.status}">${item.status}</span>
    `;
    list.appendChild(row);
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ── Init ──
(async function init() {
  await refreshSession();
  renderRoute();
})();
