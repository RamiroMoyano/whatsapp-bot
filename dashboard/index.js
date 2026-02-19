import express from "express";
import dotenv from "dotenv";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import * as XLSX from "xlsx";

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: false }));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, "public")));

// ===== Compat: alias legado (/c) al panel cliente real (/panel) =====
app.get("/c", (req, res) => res.redirect("/panel"));
app.get("/c/logout", (req, res) => res.redirect("/panel/logout"));
app.get("/c/catalogo", (req, res) => res.redirect("/panel/catalogo"));
app.get("/c/pedidos", (req, res) => res.redirect("/panel/pedidos"));
app.get("/c/pedidos/export", (req, res) => res.redirect("/panel/pedidos/export"));
app.get("/c/soporte", (req, res) => res.redirect("/panel/soporte"));
app.get("/c/suscripcion", (req, res) => res.redirect("/panel/suscripcion"));
app.get("/c/cuenta", (req, res) => res.redirect("/panel/cuenta"));

const DASH_USER = (process.env.DASH_USER || "").trim();
const DASH_PASS = (process.env.DASH_PASS || "").trim();
const DASH_COOKIE_SECRET = (process.env.DASH_COOKIE_SECRET || "").trim();

const API_BASE_URL = (process.env.API_BASE_URL || "").trim();
const API_TOKEN = (process.env.API_TOKEN || "").trim();
const BOT_CATALOG_PROVIDER_ID = (process.env.BOT_CATALOG_PROVIDER_ID || "babystepsbots").trim().toLowerCase();
const ADMIN_INBOX_MAX_ITEMS = 300;

function signToken(token) {
  const h = crypto.createHmac("sha256", DASH_COOKIE_SECRET || "dev");
  h.update(token);
  return h.digest("hex");
}

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  const out = {};
  raw.split(";").forEach((p) => {
    const [k, ...rest] = p.trim().split("=");
    if (!k) return;
    out[k] = decodeURIComponent(rest.join("=") || "");
  });
  return out;
}

function setCookie(res, name, value) {
  res.setHeader("Set-Cookie", `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`);
}
function clearCookie(res, name) {
  res.setHeader("Set-Cookie", `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
}

function requireDashboardAuth(req, res, next) {
  if (!DASH_USER || !DASH_PASS || !DASH_COOKIE_SECRET) {
    return res.status(500).send("Faltan env: DASH_USER, DASH_PASS, DASH_COOKIE_SECRET");
  }
  const cookie = parseCookies(req)["dash"];
  if (!cookie) return res.redirect("/admin/login");

  const [token, sig] = cookie.split(".");
  if (!token || !sig) return res.redirect("/admin/login");
  if (signToken(token) !== sig) return res.redirect("/admin/login");
  next();
}

// ====================== CLIENT AUTH (empresas) ======================
function signClient(companyId) {
  return signToken(`client:${companyId}`);
}

async function requireClientAuth(req, res, next) {
  if (!DASH_COOKIE_SECRET) {
    return res.status(500).send("Falta env: DASH_COOKIE_SECRET");
  }

  const cookie = parseCookies(req)["client"];
  if (!cookie) return res.redirect("/panel/login");

  const [companyId, sig] = cookie.split(".");
  if (!companyId || !sig) return res.redirect("/panel/login");

  if (signClient(companyId) !== sig) return res.redirect("/panel/login");

  // Cargamos la empresa para usar en el panel cliente
  try {
    const company = await api(`/api/companies/${encodeURIComponent(companyId)}`);
    req.company = company;
    req.companyId = companyId;
    next();
  } catch (e) {
    return res.redirect("/panel/login");
  }
}

async function api(pathname, { method = "GET", body } = {}) {
  if (!API_BASE_URL || !API_TOKEN) throw new Error("API_BASE_URL/API_TOKEN faltan en dashboard");
  const r = await fetch(`${API_BASE_URL}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || `API error ${r.status}`);
  return data;
}

async function getBotCatalogProviderCompany(currentCompany) {
  const currentId = String(currentCompany?.id || "").trim().toLowerCase();
  if (currentCompany && currentId === BOT_CATALOG_PROVIDER_ID) {
    return currentCompany;
  }
  try {
    return await api(`/api/companies/${encodeURIComponent(BOT_CATALOG_PROVIDER_ID)}`);
  } catch {
    return currentCompany || null;
  }
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function createInboxMessageId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

function normalizeInboxMessage(item, index = 0) {
  if (!item || typeof item !== "object") return null;
  const senderRaw = String(item.sender || item.from || "").trim().toLowerCase();
  const sender = senderRaw === "admin" ? "admin" : "client";
  const text = String(item.text || item.message || "").trim();
  if (!text) return null;
  const createdAt = String(item.createdAt || item.at || new Date().toISOString());
  const statusRaw = String(item.status || "").trim().toLowerCase();
  const status = statusRaw === "resolved" ? "resolved" : "open";
  return {
    id: String(item.id || `msg_${index + 1}`),
    sender,
    text,
    orderId: String(item.orderId || "").trim(),
    createdAt,
    status,
    readByAdmin: sender === "admin" ? true : !!item.readByAdmin,
    readByClient: sender === "client" ? true : !!item.readByClient,
  };
}

function extractAdminInbox(rules) {
  const source = Array.isArray(rules?.adminInbox)
    ? rules.adminInbox
    : Array.isArray(rules?.messagesInbox)
      ? rules.messagesInbox
      : [];
  return source
    .map((item, idx) => normalizeInboxMessage(item, idx))
    .filter(Boolean)
    .slice(-ADMIN_INBOX_MAX_ITEMS);
}

function setAdminInbox(rules, inbox) {
  if (!rules || typeof rules !== "object") return;
  const normalized = (Array.isArray(inbox) ? inbox : [])
    .map((item, idx) => normalizeInboxMessage(item, idx))
    .filter(Boolean)
    .slice(-ADMIN_INBOX_MAX_ITEMS);
  rules.adminInbox = normalized;
}

function countAdminUnreadMessages(inbox) {
  return (Array.isArray(inbox) ? inbox : [])
    .filter((msg) => msg.sender === "client" && !msg.readByAdmin)
    .length;
}

function countClientUnreadMessages(inbox) {
  return (Array.isArray(inbox) ? inbox : [])
    .filter((msg) => msg.sender === "admin" && !msg.readByClient)
    .length;
}

function getClientUnreadNotificationCount(company) {
  const rulesRaw = parseJsonSafe(company?.rulesJson || "{}", {});
  const rules = rulesRaw && typeof rulesRaw === "object" ? rulesRaw : {};
  const inbox = extractAdminInbox(rules);
  return countClientUnreadMessages(inbox);
}

async function getAdminUnreadNotificationsTotal() {
  try {
    const companies = await api("/api/companies");
    const list = Array.isArray(companies) ? companies : [];
    return list.reduce((acc, company) => {
      const rulesRaw = parseJsonSafe(company?.rulesJson || "{}", {});
      const rules = rulesRaw && typeof rulesRaw === "object" ? rulesRaw : {};
      const inbox = extractAdminInbox(rules);
      return acc + countAdminUnreadMessages(inbox);
    }, 0);
  } catch {
    return 0;
  }
}

function renderNotificationBell({ href, count = 0, className = "", title = "Notificaciones" }) {
  const safeCount = Number.isFinite(Number(count)) ? Math.max(0, Number(count)) : 0;
  const classes = `notify-bell ${className}`.trim();
  const badge = safeCount > 0
    ? `<span class="notify-badge">${safeCount > 99 ? "99+" : safeCount}</span>`
    : "";
  return `<a class="${classes}" href="${href}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">🔔${badge}</a>`;
}

async function saveCompanyRules(company, rules) {
  await api(`/api/companies/${encodeURIComponent(company.id)}/save`, {
    method: "POST",
    body: {
      name: company.name || company.id,
      prompt: company.prompt || "",
      catalogJson: company.catalogJson || "[]",
      rulesJson: JSON.stringify(rules || {}),
    },
  });
}

function layout({ title, active, body, notifications = 0 }) {
  const nav = `
    <a class="btn ${active === "companies" ? "primary" : "secondary"}" href="/admin">Empresas</a>
    <a class="btn ${active === "new-company" ? "primary" : "secondary"}" href="/admin/company/new">Nueva empresa</a>
    <a class="btn ${active === "messages" ? "primary" : "secondary"}" href="/admin/messages">Mensajes</a>
    <a class="btn ${active === "assign" ? "primary" : "secondary"}" href="/admin/assign">Asignar clientes</a>
  `;

  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <link rel="stylesheet" href="/dashboard.css" />
      <title>${escapeHtml(title)}</title>
    </head>
    <body class="dark">
      <div class="container">
        <header class="top">
          <div style="display:flex;flex-direction:column;gap:6px">
            <h2 style="margin:0">${escapeHtml(title)}</h2>
            <div style="display:flex;gap:10px;flex-wrap:wrap">${nav}</div>
          </div>
          <div style="display:flex;gap:10px;align-items:center">
            ${renderNotificationBell({ href: "/admin/messages", count: notifications, className: "admin-notify-bell", title: "Mensajes y notificaciones" })}
            <a class="btn secondary" href="/admin/logout">Logout</a>
          </div>
        </header>
        ${body}
      </div>
    </body>
  </html>`;
}

function toCsv(rows) {
  // CSV simple con comillas y escape
  const esc = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  const headers = [
    "id",
    "createdAt",
    "fromNumber",
    "companyId",
    "name",
    "contact",
    "total",
    "paymentStatus",
    "paymentMethod",
    "orderStatus",
    "deliveredAt",
  ];
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(
      headers.map((h) => esc(r[h])).join(",")
    );
  }
  return lines.join("\n");
}

function toCsvRows(headers, rows) {
  const esc = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  const out = [headers.map(esc).join(",")];
  for (const row of rows) {
    out.push((Array.isArray(row) ? row : []).map(esc).join(","));
  }
  return out.join("\n");
}

function parseClientOrdersFilters(query) {
  const selectedRangeRaw = String(query?.range || "month").trim().toLowerCase();
  const selectedStatusRaw = String(query?.status || "all").trim().toLowerCase();
  const selectedRange = ["today", "week", "month", "3months", "custom"].includes(selectedRangeRaw)
    ? selectedRangeRaw
    : "month";
  const selectedStatus = ["all", "completed", "pending", "rejected", "archived"].includes(selectedStatusRaw)
    ? selectedStatusRaw
    : "all";

  const dayStart = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
  const dayEnd = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
  const parseDateInput = (value) => {
    const raw = String(value || "").trim();
    if (!raw) return null;
    const date = new Date(`${raw}T00:00:00`);
    return Number.isNaN(date.getTime()) ? null : date;
  };
  const toYmd = (date) => {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
    const yy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    return `${yy}-${mm}-${dd}`;
  };

  const now = new Date();
  let filterFrom = null;
  let filterTo = null;

  if (selectedRange === "today") {
    filterFrom = dayStart(now);
    filterTo = dayEnd(now);
  } else if (selectedRange === "week") {
    const from = new Date(now);
    from.setDate(from.getDate() - 6);
    filterFrom = dayStart(from);
    filterTo = dayEnd(now);
  } else if (selectedRange === "month") {
    const from = new Date(now);
    from.setMonth(from.getMonth() - 1);
    filterFrom = dayStart(from);
    filterTo = dayEnd(now);
  } else if (selectedRange === "3months") {
    const from = new Date(now);
    from.setMonth(from.getMonth() - 3);
    filterFrom = dayStart(from);
    filterTo = dayEnd(now);
  } else {
    const rawFrom = parseDateInput(query?.from);
    const rawTo = parseDateInput(query?.to);
    if (rawFrom) filterFrom = dayStart(rawFrom);
    if (rawTo) filterTo = dayEnd(rawTo);
    if (filterFrom && filterTo && filterFrom.getTime() > filterTo.getTime()) {
      const tmp = filterFrom;
      filterFrom = filterTo;
      filterTo = tmp;
    }
  }

  const rangeLabel = (() => {
    if (selectedRange === "today") return "hoy";
    if (selectedRange === "week") return "ultimos 7 dias";
    if (selectedRange === "3months") return "ultimos 3 meses";
    if (selectedRange === "custom") return "rango personalizado";
    return "ultimo mes";
  })();

  const fromInput = String(query?.from || "").trim() || (selectedRange !== "custom" ? toYmd(filterFrom) : "");
  const toInput = String(query?.to || "").trim() || (selectedRange !== "custom" ? toYmd(filterTo) : "");

  return { selectedRange, selectedStatus, filterFrom, filterTo, rangeLabel, fromInput, toInput };
}

async function fetchCompanyOrders(companyId, filterFrom, filterTo, limit = 500) {
  const params = new URLSearchParams();
  params.set("companyId", String(companyId));
  params.set("limit", String(Math.max(1, Math.min(5000, Number(limit) || 500))));
  if (filterFrom) params.set("from", filterFrom.toISOString());
  if (filterTo) params.set("to", filterTo.toISOString());
  const data = await api(`/api/orders?${params.toString()}`);
  return Array.isArray(data) ? data : [];
}

function normalizeClientOrderState(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.includes("reject") || raw.includes("rechaz") || raw.includes("cancel") || raw.includes("anul")) return "rejected";
  if (raw.includes("complet") || raw.includes("entreg") || raw.includes("finaliz") || raw.includes("cerrad")) return "completed";
  if (raw.includes("pend")) return "pending";
  return "";
}

function inferClientOrderState(order) {
  const orderStatus = String(order?.orderStatus || "").trim().toLowerCase();
  const paymentStatus = String(order?.paymentStatus || "").trim().toLowerCase();
  if (
    ["rejected", "rechazado", "cancelled", "canceled", "cancelado", "anulado"].some((v) => orderStatus.includes(v)) ||
    ["failed", "voided", "refunded", "chargeback"].some((v) => paymentStatus.includes(v))
  ) {
    return "rejected";
  }
  if (["delivered", "completed", "done", "entregado", "finalizado", "cerrado"].some((v) => orderStatus.includes(v))) {
    return "completed";
  }
  return "pending";
}

function extractClientOrderWorkflow(order) {
  const explicitState = normalizeClientOrderState(order?.workflowState || order?.state);
  const explicitArchived = order?.archived === true || order?.archived === 1 || String(order?.archived || "").trim() === "1";
  if (explicitState) {
    return { state: explicitState, archived: explicitArchived };
  }

  const rawCategory = String(order?.category || order?.orderCategory || "").trim().toLowerCase();
  let archived = false;
  let state = "";
  if (rawCategory) {
    if (rawCategory.includes("archiv")) {
      archived = true;
      const stripped = rawCategory
        .replaceAll("archived", "")
        .replaceAll("archivado", "")
        .replaceAll(":", " ")
        .replaceAll("|", " ")
        .replaceAll("-", " ")
        .trim();
      state = normalizeClientOrderState(stripped);
    } else {
      state = normalizeClientOrderState(rawCategory);
    }
  }

  if (!archived) {
    const orderStatus = String(order?.orderStatus || "").trim().toLowerCase();
    if (["archived", "archivado"].some((v) => orderStatus.includes(v))) {
      archived = true;
    }
  }

  if (!state) state = inferClientOrderState(order);
  return { state, archived };
}

function clientOrderCategoryLabel(category) {
  if (category === "completed") return "Completado";
  if (category === "rejected") return "Rechazado";
  return "Pendiente";
}

function isOrderPaid(order) {
  const raw = String(order?.paymentStatus || "").trim().toLowerCase();
  return ["paid", "pagado", "approved", "aprobado", "settled", "cobrado"].some((v) => raw.includes(v));
}

function clientPaymentLabel(order) {
  return isOrderPaid(order) ? "Pagado" : "No pagado";
}

function clientPaymentMethodLabel(order) {
  const raw = String(order?.paymentMethod || "").trim().toLowerCase();
  if (!raw || raw === "-" || raw === "null" || raw === "undefined") return "-";
  if (raw.includes("efectivo") || raw.includes("cash")) return "Efectivo";
  if (raw.includes("debito") || raw.includes("débito") || raw.includes("debit")) return "Debito";
  if (raw.includes("transfer") || raw.includes("bank")) return "Transferencia";
  if (raw.includes("credito") || raw.includes("crédito") || raw.includes("credit") || raw.includes("tarjeta")) {
    return "Tarjeta de credito";
  }
  return raw
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

// ================= LOGIN =================
app.get("/admin/login", (req, res) => {
  res.type("text/html").send(`
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <link rel="stylesheet" href="/dashboard.css" />
    <title>Login</title>
  </head>

  <body>
    <div class="bs-login">
      <!-- Imagen fondo full (robot). Cambia el nombre si tu archivo es otro -->
      <div class="bs-bg" style="background-image:url('/img/login-tech-bg.png')"></div>
      <div class="bs-vignette"></div>

      <div class="bs-card">
        <div class="admin-login-avatar">
          <img src="/img/admin-login-avatar.jpeg" alt="Admin avatar" onerror="this.style.display='none'" />
        </div>

        <div class="bs-brand">
          <div class="bs-dot"></div>
          <div>
            <div class="bs-title">BabySteps</div>
            <div class="bs-subtitle">Console</div>
          </div>
        </div>

        <h2 class="bs-h2">Entrar</h2>

        <form method="POST" action="/admin/login" class="form">
          <label>Usuario</label>
          <input name="user" placeholder="Usuario" autocomplete="username" />

          <label>Contrasena</label>
          <div class="pw-row">
            <input id="pass" name="pass" type="password" placeholder="Contrasena" autocomplete="current-password" />
            <button type="button" class="icon-btn" id="togglePass" aria-label="Mostrar contrasena">🙈</button>
          </div>

          <div class="login-actions">
            <button class="btn primary">Entrar</button>
            <a class="btn secondary" href="/admin/forgot">Olvide mi contrasena</a>
          </div>
        </form>
      </div>
    </div>

    <script>
      const btn = document.getElementById("togglePass");
      const pass = document.getElementById("pass");
      if (btn && pass) {
        const syncEye = () => {
          const hidden = pass.type === "password";
          btn.textContent = hidden ? "🙈" : "👁️";
          btn.setAttribute("aria-label", hidden ? "Mostrar contrasena" : "Ocultar contrasena");
        };
        btn.addEventListener("click", () => {
          pass.type = pass.type === "password" ? "text" : "password";
          syncEye();
        });
        syncEye();
      }
    </script>
  </body>
</html>
  `);
});

app.post("/admin/login", (req, res) => {
  const user = (req.body.user || "").trim();
  const pass = (req.body.pass || "").trim();

  if (user !== DASH_USER || pass !== DASH_PASS) {
    return res.status(401).send("Credenciales incorrectas");
  }

  const token = crypto.randomBytes(24).toString("hex");
  setCookie(res, "dash", `${token}.${signToken(token)}`);
  return res.redirect("/admin");
});

// Logout
app.get("/admin/logout", (req, res) => {
  clearCookie(res, "dash");
  res.redirect("/admin/login");
});

// ================= EMPRESAS =================
app.get("/admin", requireDashboardAuth, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim().toLowerCase();
    const viewRaw = String(req.query.view || "all").trim().toLowerCase();
    const view = ["all", "full", "limited", "inactive"].includes(viewRaw) ? viewRaw : "all";
    const companies = await api("/api/companies");
    const flashCompany = String(req.query.company || "").trim();
    const dashboardSaved = String(req.query.dashboardSaved || "") === "1";
    const deleted = String(req.query.deleted || "") === "1";
    const dashboardError = String(req.query.dashboardError || "").trim();
    const deleteError = String(req.query.deleteError || "").trim();
    const flashHtml = [
      dashboardSaved ? `<div class="card"><b>Dashboard actualizado:</b> ${escapeHtml(flashCompany || "empresa")}</div>` : "",
      deleted ? `<div class="card"><b>Empresa eliminada:</b> ${escapeHtml(flashCompany || "empresa")}</div>` : "",
      dashboardError ? `<div class="card"><b>Error guardando dashboard:</b> ${escapeHtml(dashboardError)}</div>` : "",
      deleteError ? `<div class="card"><b>Error eliminando empresa:</b> ${escapeHtml(deleteError)}</div>` : "",
    ].join("");

    const rowsData = companies.map((c) => {
      const rules = parseJsonSafe(c.rulesJson || "{}", {});
      const plan = extractPlanInfo(c, rules);
      const profile = extractCompanyProfile(rules);
      const inbox = extractAdminInbox(rules);
      const unreadAdminMessages = countAdminUnreadMessages(inbox);
      const dashboardAccess = extractDashboardAccessFromRules(rules);
      const accessLabel = !dashboardAccess.enabled
        ? "Desactivado"
        : dashboardAccess.mode === "limited"
          ? "Limitado"
          : "Completo";
      const searchText = [
        c.id,
        c.name,
        c.createdAt,
        profile.ownerName,
        profile.ownerEmail,
        profile.ownerPhone,
        plan.botClass,
        plan.fullLabel,
        accessLabel,
      ].map((value) => String(value || "").toLowerCase()).join(" ");
      const html = `
      <div class="company-item">
        <div class="admin-company-meta">
          <div><b>${c.id}</b> - ${c.name || ""}</div>
          <div class="muted">Creada: ${c.createdAt || "-"}</div>
          <div class="muted">Dueno: ${escapeHtml(profile.ownerName || "-")} | Email: ${escapeHtml(profile.ownerEmail || "-")}</div>
          <div class="muted">Bot: ${escapeHtml(plan.botClass)} | Plan: ${escapeHtml(plan.fullLabel)} | Dashboard: ${accessLabel}</div>
        </div>
        <div class="admin-company-actions">
          <form method="POST" action="/admin/company/${encodeURIComponent(c.id)}/dashboard/save" class="admin-company-access-form">
            <input type="hidden" name="q" value="${escapeHtml(String(req.query.q || ""))}" />
            <input type="hidden" name="view" value="${escapeHtml(view)}" />
            <div class="admin-company-access-grid">
              <div>
                <label>Dashboard</label>
                <select name="dashboardEnabled">
                  <option value="1" ${dashboardAccess.enabled ? "selected" : ""}>Activo</option>
                  <option value="0" ${dashboardAccess.enabled ? "" : "selected"}>Inactivo</option>
                </select>
              </div>
              <div>
                <label>Visualizacion</label>
                <select name="dashboardMode">
                  <option value="full" ${dashboardAccess.mode === "full" ? "selected" : ""}>Completo</option>
                  <option value="limited" ${dashboardAccess.mode === "limited" ? "selected" : ""}>Limitado</option>
                </select>
              </div>
              <button class="btn secondary small" type="submit">Guardar</button>
            </div>
          </form>
          <div class="admin-company-inline-actions">
            <a class="btn secondary small" href="/admin/company/${encodeURIComponent(c.id)}">Editar</a>
            <form method="POST" action="/admin/company/${encodeURIComponent(c.id)}/delete" onsubmit="return confirm('Se eliminara la empresa y su configuracion. Continuar?')">
              <input type="hidden" name="q" value="${escapeHtml(String(req.query.q || ""))}" />
              <input type="hidden" name="view" value="${escapeHtml(view)}" />
              <button class="btn danger small" type="submit">Eliminar</button>
            </form>
          </div>
        </div>
      </div>
    `;
      return { html, searchText, dashboardAccess, unreadAdminMessages };
    });

    const byView = rowsData.filter((row) => {
      if (view === "full") return row.dashboardAccess.enabled && row.dashboardAccess.mode === "full";
      if (view === "limited") return row.dashboardAccess.enabled && row.dashboardAccess.mode === "limited";
      if (view === "inactive") return !row.dashboardAccess.enabled;
      return true;
    });
    const filtered = q
      ? byView.filter((row) => row.searchText.includes(q))
      : byView;
    const rows = filtered.map((row) => row.html).join("");
    const enabledCompanies = rowsData.filter((row) => row.dashboardAccess.enabled);
    const fullCount = enabledCompanies.filter((row) => row.dashboardAccess.mode === "full").length;
    const limitedCount = enabledCompanies.filter((row) => row.dashboardAccess.mode === "limited").length;
    const disabledCount = rowsData.length - enabledCompanies.length;
    const unreadAdminNotifications = rowsData.reduce((acc, row) => acc + Number(row.unreadAdminMessages || 0), 0);
    const buildAdminHref = (nextView) => {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (nextView && nextView !== "all") params.set("view", nextView);
      const query = params.toString();
      return query ? `/admin?${query}` : "/admin";
    };
    const kpiClass = (key) => `kpi kpi-filter ${view === key ? "active" : ""}`;
    const clearSearchHref = view !== "all" ? `/admin?view=${encodeURIComponent(view)}` : "/admin";

    res.type("text/html").send(`
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <link rel="stylesheet" href="/dashboard.css" />
    <title>BabySteps - Admin</title>
  </head>
  <body class="admin-home-page">
    <div class="container">

      <div class="admin-header admin-home-header">
        <div class="brand">
          <div>
            <div class="title">BabySteps</div>
            <div class="subtitle">Admin Console</div>
          </div>
        </div>
        <div class="admin-header-actions">
          ${renderNotificationBell({ href: "/admin/messages", count: unreadAdminNotifications, className: "admin-notify-bell", title: "Mensajes del buzon" })}
          <a class="btn secondary" href="/admin/logout">Logout</a>
        </div>
      </div>

      <div class="admin-home-shell">
        <aside class="card admin-side-menu">
          <h3 style="margin:0">Menu</h3>
          <a class="btn primary" href="/admin/company/new">Agregar +</a>
          <a class="btn secondary" href="/admin/messages">Mensajes</a>
          <a class="btn secondary" href="#admin-company-list">Eliminar</a>
          <a class="btn secondary" href="/admin/assign">Asignar clientes</a>
        </aside>

        <section class="admin-home-main">
          ${flashHtml}

          <div class="kpis">
            <a class="${kpiClass("all")}" href="${buildAdminHref("all")}">
              <div class="label">Empresas</div>
              <div class="value">${rowsData.length}</div>
              <div class="hint">de ${companies.length} registradas</div>
            </a>
            <a class="${kpiClass("full")}" href="${buildAdminHref("full")}">
              <div class="label">Dashboard completo</div>
              <div class="value">${fullCount}</div>
              <div class="hint">acceso total</div>
            </a>
            <a class="${kpiClass("limited")}" href="${buildAdminHref("limited")}">
              <div class="label">Dashboard limitado</div>
              <div class="value">${limitedCount}</div>
              <div class="hint">solo catalogo/suscripcion/cuenta</div>
            </a>
            <a class="${kpiClass("inactive")}" href="${buildAdminHref("inactive")}">
              <div class="label">Dashboard inactivo</div>
              <div class="value">${disabledCount}</div>
              <div class="hint">sin acceso</div>
            </a>
          </div>

          <div class="card" id="admin-company-list">
            <form method="GET" action="/admin" class="form" style="margin-bottom:12px">
              <label>Buscar empresa</label>
              <input type="hidden" name="view" value="${escapeHtml(view)}" />
              <div class="actions">
                <input name="q" value="${escapeHtml(String(req.query.q || ""))}" placeholder="ID, nombre, dueno, mail, bot..." />
                <button class="btn primary" type="submit">Buscar</button>
                <a class="btn secondary" href="${clearSearchHref}">Limpiar</a>
              </div>
            </form>
            <h3 style="margin:0 0 12px;">Listado ${view !== "all" ? `(${escapeHtml(view)})` : ""}</h3>
            <div class="company-list">${rows || `<div class="muted">Aun no hay empresas.</div>`}</div>
          </div>
        </section>
      </div>

    </div>
  </body>
</html>
    `);
  } catch (e) {
    res.status(500).type("text/html").send(`
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <link rel="stylesheet" href="/dashboard.css" />
    <title>Error</title>
  </head>
  <body>
    <div class="container">
      <div class="card">
        <h3 style="margin:0 0 10px;">Error cargando /admin</h3>
        <div class="muted">Esto es lo que esta fallando:</div>
        <pre style="white-space:pre-wrap; margin-top:10px;">${String(e?.message || e)}</pre>
        <div style="margin-top:12px;">
          <a class="btn secondary" href="/admin/logout">Volver al login</a>
        </div>
      </div>
    </div>
  </body>
</html>
    `);
  }
});

app.get("/admin/company/new", requireDashboardAuth, (req, res) => {
  const body = `
    <div class="card">
      <h3 style="margin-top:0">Nueva empresa</h3>
      <form method="POST" action="/admin/company/new" class="form">
        <label>ID empresa (slug)</label>
        <input name="id" placeholder="ej: miempresa" />

        <label>Nombre visible</label>
        <input name="name" placeholder="Mi Empresa" />

        <div class="grid2">
          <div>
            <label>Nombre dueno / CEO</label>
            <input name="ownerName" placeholder="Nombre y apellido" />
          </div>
          <div>
            <label>Cargo</label>
            <input name="ownerRole" value="Dueno/CEO" />
          </div>
        </div>

        <div class="grid2">
          <div>
            <label>Email contacto</label>
            <input name="ownerEmail" placeholder="mail@empresa.com" />
          </div>
          <div>
            <label>Telefono</label>
            <input name="ownerPhone" placeholder="+549..." />
          </div>
        </div>

        <label>Direccion</label>
        <input name="companyAddress" placeholder="Calle y numero" />

        <div class="grid2">
          <div>
            <label>Ciudad</label>
            <input name="companyCity" />
          </div>
          <div>
            <label>Pais</label>
            <input name="companyCountry" />
          </div>
        </div>

        <div class="grid2">
          <div>
            <label>Plan bot</label>
            <select name="planTier">
              <option value="BASICO">Basico (sin AI)</option>
              <option value="LITE">Con AI LITE</option>
              <option value="PRO">Con AI PRO</option>
            </select>
          </div>
          <div>
            <label>Canal</label>
            <select name="channelMode">
              <option value="whatsapp">WhatsApp</option>
              <option value="instagram">Instagram</option>
              <option value="combinado">Combinado</option>
            </select>
          </div>
        </div>

        <label>Password acceso cliente</label>
        <input name="clientPassword" placeholder="Si vacio, se genera automatica" />

        <label>Prompt inicial (opcional)</label>
        <textarea name="prompt" rows="4" placeholder="Prompt del bot"></textarea>

        <div class="actions">
          <button class="btn primary" type="submit">Crear empresa</button>
          <a class="btn secondary" href="/admin">Cancelar</a>
        </div>
      </form>
    </div>
  `;

  res.type("text/html").send(layout({
    title: "Nueva empresa",
    active: "companies",
    body,
  }));
});

app.post("/admin/company/new", requireDashboardAuth, async (req, res) => {
  const id = String(req.body.id || "").trim().toLowerCase();
  const name = String(req.body.name || "").trim();

  if (!id || !name) {
    return res.status(400).type("text/html").send(layout({
      title: "Nueva empresa",
      active: "companies",
      body: `<div class="card"><b>Error:</b> id y nombre son obligatorios.</div><div class="card"><a class="btn secondary" href="/admin/company/new">Volver</a></div>`,
    }));
  }

  try {
    await api("/api/companies", {
      method: "POST",
      body: { id, name },
    });

    const company = await api(`/api/companies/${encodeURIComponent(id)}`);
    const rulesRaw = parseJsonSafe(company.rulesJson || "{}", {});
    const rules = rulesRaw && typeof rulesRaw === "object" ? rulesRaw : {};

    const planTier = normalizePlanTier(req.body.planTier) || "BASICO";
    const channelMode = normalizeChannelMode(req.body.channelMode) || "whatsapp";

    rules.ownerName = String(req.body.ownerName || "").trim();
    rules.ownerRole = String(req.body.ownerRole || "Dueno/CEO").trim();
    rules.ownerEmail = String(req.body.ownerEmail || "").trim();
    rules.ownerPhone = String(req.body.ownerPhone || "").trim();
    rules.companyAddress = String(req.body.companyAddress || "").trim();
    rules.companyCity = String(req.body.companyCity || "").trim();
    rules.companyCountry = String(req.body.companyCountry || "").trim();
    rules.planTier = planTier;
    rules.aiEnabled = planTier !== "BASICO";
    rules.channelMode = channelMode;
    rules.channels = channelsFromMode(channelMode);
    if (!String(rules.botClass || "").trim()) {
      rules.botClass = defaultBotClassFromMode(channelMode);
    }

    const providedPassword = String(req.body.clientPassword || "").trim();
    const assignedPassword = providedPassword || resolveClientPassword(rules, company) || generateClientPassword();
    assignClientPassword(rules, assignedPassword);

    const prompt = String(req.body.prompt || "").trim() || company.prompt || "Sos el asistente de la empresa.";

    await api(`/api/companies/${encodeURIComponent(id)}/save`, {
      method: "POST",
      body: {
        name: name || id,
        prompt,
        catalogJson: company.catalogJson || "[]",
        rulesJson: JSON.stringify(rules),
      },
    });

    const flashPwd = providedPassword
      ? "manualPwd=1"
      : `generatedPwd=${encodeURIComponent(assignedPassword)}`;
    res.redirect(`/admin/company/${encodeURIComponent(id)}?created=1&${flashPwd}`);
  } catch (e) {
    res.status(500).type("text/html").send(layout({
      title: "Nueva empresa",
      active: "companies",
      body: `<div class="card"><b>Error:</b><pre>${escapeHtml(e?.message || e)}</pre></div><div class="card"><a class="btn secondary" href="/admin/company/new">Volver</a></div>`,
    }));
  }
});

// ===== ADMIN: Editar empresa =====
app.get("/admin/company/:id", requireDashboardAuth, async (req, res) => {
  const id = req.params.id;

  try {
    const c = await api(`/api/companies/${encodeURIComponent(id)}`);
    const adminUnreadNotifications = await getAdminUnreadNotificationsTotal();
    const providerCompany = await getBotCatalogProviderCompany(c);
    const providerForPricing = providerCompany || c;
    const state = extractClientState(c, {
      priceCatalog: extractCatalogEntriesForCompany(providerForPricing),
      pricingSourceCompanyId: providerForPricing?.id || c.id,
    });
    const profile = state.profile;
    const plan = state.plan;
    const brandManual = String(
      state.rules?.brandManual ||
      state.rules?.brandGuide ||
      state.rules?.manualMarca ||
      state.rules?.manualDeMarca ||
      ""
    ).trim();
    const companyPurpose = String(
      state.rules?.companyPurpose ||
      state.rules?.purpose ||
      state.rules?.objective ||
      state.rules?.objetivo ||
      state.rules?.goal ||
      ""
    ).trim();
    const botOptions = extractCatalogBotOptions(providerForPricing);
    const currentBotClass = String(plan.botClass || "").trim();
    const hasCurrentBotInCatalog = currentBotClass
      ? botOptions.some((item) => item.name.toLowerCase() === currentBotClass.toLowerCase())
      : false;
    const botOptionsHtml = [
      `<option value="">Seleccionar desde catalogo</option>`,
      ...(!hasCurrentBotInCatalog && currentBotClass
        ? [`<option value="${escapeHtml(currentBotClass)}" selected>Actual: ${escapeHtml(currentBotClass)}</option>`]
        : []),
      ...botOptions.map((item) => {
        const selected = item.name.toLowerCase() === currentBotClass.toLowerCase() ? "selected" : "";
        return `<option value="${escapeHtml(item.name)}" ${selected}>${escapeHtml(item.label)}</option>`;
      }),
    ].join("");

    const alerts = [
      String(req.query.created || "") === "1" ? `<div class="card"><b>Empresa creada correctamente.</b></div>` : "",
      String(req.query.updated || "") === "1" ? `<div class="card"><b>Datos actualizados.</b></div>` : "",
      String(req.query.botUpdated || "") === "1" ? `<div class="card"><b>Clase de bot actualizada.</b></div>` : "",
      String(req.query.manualPwd || "") === "1" ? `<div class="card"><b>Password actualizada manualmente.</b></div>` : "",
      String(req.query.generatedPwd || "") ? `<div class="card"><b>Nueva password generada:</b> <code>${escapeHtml(String(req.query.generatedPwd || ""))}</code></div>` : "",
      String(req.query.botError || "") ? `<div class="card"><b>Error al cambiar bot:</b> ${escapeHtml(String(req.query.botError || ""))}</div>` : "",
    ].join("");

    res.type("text/html").send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <link rel="stylesheet" href="/dashboard.css" />
    <title>Editar ${c.id}</title>
  </head>
  <body>
    <div class="container">
      <div class="app-header">
        <div class="brand">
          <img src="/img/logo.png" alt="BabySteps" onerror="this.style.display='none'"/>
          <div>
            <div class="title">Editar empresa</div>
            <div class="subtitle">${c.id}</div>
          </div>
        </div>
        <div class="nav admin-nav-actions">
          ${renderNotificationBell({ href: "/admin/messages", count: adminUnreadNotifications, className: "admin-notify-bell", title: "Mensajes del buzon" })}
          <a class="btn secondary" href="/admin"><- Volver</a>
          <span class="admin-nav-divider" aria-hidden="true"></span>
          <a class="btn secondary" href="/admin/logout">Logout</a>
        </div>
      </div>

      ${alerts}

      <div class="card admin-toggle-card" data-default-open="1">
        <h3 style="margin-top:0">Resumen importante</h3>
        <div class="grid2">
          <div>
            <div><b>Dueno/CEO:</b> ${escapeHtml(profile.ownerName || "-")}</div>
            <div><b>Cargo:</b> ${escapeHtml(profile.ownerRole || "-")}</div>
            <div><b>Email:</b> ${escapeHtml(profile.ownerEmail || "-")}</div>
            <div><b>Telefono:</b> ${escapeHtml(profile.ownerPhone || "-")}</div>
          </div>
          <div>
            <div><b>Direccion:</b> ${escapeHtml(profile.companyAddress || "-")}</div>
            <div><b>Ciudad:</b> ${escapeHtml(profile.companyCity || "-")}</div>
            <div><b>Pais:</b> ${escapeHtml(profile.companyCountry || "-")}</div>
            <div><b>Clase de bot:</b> ${escapeHtml(plan.botClass)}</div>
            <div><b>Plan activo:</b> ${escapeHtml(plan.fullLabel)}</div>
            <div><b>Catalogo precios:</b> ${escapeHtml(state.subscription.pricingSourceCompanyId || "-")}</div>
            <div><b>Monto mensual:</b> ${formatMoney(state.subscription.amount, state.subscription.currency)}</div>
            <div><b>Inicio ciclo actual:</b> ${escapeHtml(formatDateLabel(state.subscription.startAt))}</div>
            <div><b>Fin ciclo actual:</b> ${escapeHtml(formatDateLabel(state.subscription.endAt))}</div>
            <div><b>Cobro mes siguiente:</b> ${formatMoney(state.subscription.nextAmount, state.subscription.currency)}</div>
            <div><b>Prorrateo inmediato:</b> ${formatMoney(state.subscription.prorationDueNow, state.subscription.currency)}</div>
          </div>
        </div>
      </div>

      <div class="card admin-toggle-card" data-default-open="1">
        <h3 style="margin-top:0">Cambio de bot</h3>
        <form method="POST" action="/admin/company/${encodeURIComponent(c.id)}/bot/save" class="form">
          <label>Selecciona bot del catalogo</label>
          <select name="botClass">
            ${botOptionsHtml}
          </select>

          <label>O escribir clase personalizada</label>
          <input name="botClassCustom" placeholder="Ej: Bot Unificado PRO" />

          <label style="display:flex;align-items:center;gap:8px;margin-top:6px">
            <input type="checkbox" name="syncPlan" value="1" checked style="width:auto" />
            Sincronizar plan/canal automaticamente segun la clase de bot
          </label>

          <div class="muted">
            Actual: <b>${escapeHtml(plan.botClass)}</b> | ${escapeHtml(plan.fullLabel)}
          </div>
          <div class="muted">
            Opciones detectadas del catalogo: ${botOptions.length}
          </div>
          <div class="muted">
            Ciclo actual: ${escapeHtml(formatDateLabel(state.subscription.startAt))} a ${escapeHtml(formatDateLabel(state.subscription.endAt))}
          </div>
          <div class="muted">
            Proximo cobro: ${formatMoney(state.subscription.nextAmount, state.subscription.currency)} | Prorrateo ahora: ${formatMoney(state.subscription.prorationDueNow, state.subscription.currency)}
          </div>

          <div class="actions">
            <button class="btn primary" type="submit">Guardar clase de bot</button>
          </div>
        </form>
      </div>

      <div class="card admin-toggle-card">
        <h3 style="margin-top:0">Datos de empresa y solicitante</h3>
        <form method="POST" action="/admin/company/${encodeURIComponent(c.id)}/profile/save" class="form">
          <label>Nombre visible de la empresa</label>
          <input name="name" value="${escapeHtml(c.name || c.id)}" />

          <div class="grid2">
            <div>
              <label>Nombre dueno / CEO</label>
              <input name="ownerName" value="${escapeHtml(profile.ownerName)}" />
            </div>
            <div>
              <label>Cargo</label>
              <input name="ownerRole" value="${escapeHtml(profile.ownerRole)}" />
            </div>
          </div>

          <div class="grid2">
            <div>
              <label>Email</label>
              <input name="ownerEmail" value="${escapeHtml(profile.ownerEmail)}" />
            </div>
            <div>
              <label>Telefono</label>
              <input name="ownerPhone" value="${escapeHtml(profile.ownerPhone)}" />
            </div>
          </div>

          <label>Direccion</label>
          <input name="companyAddress" value="${escapeHtml(profile.companyAddress)}" />

          <div class="grid2">
            <div>
              <label>Ciudad</label>
              <input name="companyCity" value="${escapeHtml(profile.companyCity)}" />
            </div>
            <div>
              <label>Pais</label>
              <input name="companyCountry" value="${escapeHtml(profile.companyCountry)}" />
            </div>
          </div>

          <label>Manual de marca</label>
          <textarea name="brandManual" rows="4" placeholder="Tono, estilo, palabras permitidas/prohibidas, lineamientos...">${escapeHtml(brandManual)}</textarea>

          <label>Objetivo o proposito</label>
          <textarea name="companyPurpose" rows="3" placeholder="Que busca lograr la empresa con el bot">${escapeHtml(companyPurpose)}</textarea>

          <div class="grid2">
            <div>
              <label>Plan activo</label>
              <select name="planTier">
                <option value="BASICO" ${plan.tier === "BASICO" ? "selected" : ""}>Basico (sin AI)</option>
                <option value="LITE" ${plan.tier === "LITE" ? "selected" : ""}>Con AI LITE</option>
                <option value="PRO" ${plan.tier === "PRO" ? "selected" : ""}>Con AI PRO</option>
              </select>
            </div>
            <div>
              <label>Canal</label>
              <select name="channelMode">
                <option value="whatsapp" ${plan.channelMode === "whatsapp" ? "selected" : ""}>WhatsApp</option>
                <option value="instagram" ${plan.channelMode === "instagram" ? "selected" : ""}>Instagram</option>
                <option value="combinado" ${plan.channelMode === "combinado" ? "selected" : ""}>Combinado</option>
              </select>
            </div>
          </div>

          <label>Password cliente (opcional, para cambiar manualmente)</label>
          <input name="clientPassword" placeholder="Dejar vacio para mantener" />

          <div class="actions">
            <button class="btn primary" type="submit">Guardar datos</button>
          </div>
        </form>
      </div>

      <div class="card admin-toggle-card">
        <h3 style="margin-top:0">Acceso del cliente</h3>
        <form method="POST" action="/admin/company/${encodeURIComponent(c.id)}/reset-password" class="form">
          <label>Restablecer password (opcional manual)</label>
          <input name="newPassword" placeholder="Vacio = generar automatica" />
          <div class="actions">
            <button class="btn secondary" type="submit">Restablecer password</button>
          </div>
        </form>
      </div>

      <div class="card admin-toggle-card">
        <h3 style="margin-top:0">Edicion avanzada</h3>
        <form method="POST" action="/admin/company/${encodeURIComponent(c.id)}/save" class="form">
          <input type="hidden" name="name" value="${escapeHtml(c.name || c.id)}" />
          <label>Prompt</label>
          <textarea name="prompt" rows="6">${escapeHtml(c.prompt || "")}</textarea>

          <label>Catalog JSON</label>
          <textarea name="catalogJson" rows="8">${escapeHtml(c.catalogJson || "[]")}</textarea>

          <label>Rules JSON</label>
          <textarea name="rulesJson" rows="8">${escapeHtml(c.rulesJson || "{}")}</textarea>

          <div class="actions">
            <button class="btn primary" type="submit">Guardar JSON</button>
          </div>
        </form>
      </div>
    </div>
    <script>
      (() => {
        const cards = Array.from(document.querySelectorAll(".admin-toggle-card"));
        cards.forEach((card, idx) => {
          const title = card.querySelector("h3");
          if (!title) return;

          const body = document.createElement("div");
          body.className = "admin-toggle-body";
          while (card.firstChild) {
            if (card.firstChild === title) {
              card.removeChild(title);
              continue;
            }
            body.appendChild(card.firstChild);
          }

          const head = document.createElement("button");
          head.type = "button";
          head.className = "admin-toggle-head";
          head.innerHTML = '<span>' + title.textContent + '</span><span class="admin-toggle-caret" aria-hidden="true">&#9662;</span>';

          const openByDefault = card.dataset.defaultOpen === "1" || idx === 0;
          if (!openByDefault) {
            body.style.display = "none";
            card.classList.add("collapsed");
          }

          head.addEventListener("click", () => {
            const isCollapsed = card.classList.toggle("collapsed");
            body.style.display = isCollapsed ? "none" : "";
          });

          card.appendChild(head);
          card.appendChild(body);
        });
      })();
    </script>
  </body>
</html>`);
  } catch (e) {
    res.status(500).type("text/html").send(layout({
      title: "Empresa",
      active: "companies",
      body: `<div class="card"><b>Error:</b><pre>${escapeHtml(e?.message || e)}</pre></div><div class="card"><a class="btn secondary" href="/admin">Volver</a></div>`,
    }));
  }
});

app.post("/admin/company/:id/save", requireDashboardAuth, async (req, res) => {
  const id = req.params.id;

  await api(`/api/companies/${encodeURIComponent(id)}/save`, {
    method: "POST",
    body: {
      name: req.body.name,
      prompt: req.body.prompt,
      catalogJson: req.body.catalogJson,
      rulesJson: req.body.rulesJson,
    },
  });

  res.redirect(`/admin/company/${encodeURIComponent(id)}`);
});

app.post("/admin/company/:id/dashboard/save", requireDashboardAuth, async (req, res) => {
  const id = req.params.id;
  const q = String(req.body.q || "").trim();
  const view = String(req.body.view || "").trim().toLowerCase();
  const dashboardEnabled = String(req.body.dashboardEnabled || "1") === "1";
  const dashboardMode = normalizeDashboardMode(req.body.dashboardMode);
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (["full", "limited", "inactive"].includes(view)) params.set("view", view);
  params.set("company", id);

  try {
    const company = await api(`/api/companies/${encodeURIComponent(id)}`);
    const rulesRaw = parseJsonSafe(company.rulesJson || "{}", {});
    const rules = rulesRaw && typeof rulesRaw === "object" ? rulesRaw : {};
    rules.dashboardEnabled = dashboardEnabled;
    rules.dashboardMode = dashboardMode;

    await api(`/api/companies/${encodeURIComponent(id)}/save`, {
      method: "POST",
      body: {
        name: company.name || id,
        prompt: company.prompt || "",
        catalogJson: company.catalogJson || "[]",
        rulesJson: JSON.stringify(rules),
      },
    });

    params.set("dashboardSaved", "1");
    return res.redirect(`/admin?${params.toString()}`);
  } catch (e) {
    params.set("dashboardError", String(e?.message || e));
    return res.redirect(`/admin?${params.toString()}`);
  }
});

app.post("/admin/company/:id/delete", requireDashboardAuth, async (req, res) => {
  const id = req.params.id;
  const q = String(req.body.q || "").trim();
  const view = String(req.body.view || "").trim().toLowerCase();
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (["full", "limited", "inactive"].includes(view)) params.set("view", view);
  params.set("company", id);

  try {
    await api(`/api/companies/${encodeURIComponent(id)}/delete`, { method: "POST" });
    params.set("deleted", "1");
    return res.redirect(`/admin?${params.toString()}`);
  } catch (e) {
    params.set("deleteError", String(e?.message || e));
    return res.redirect(`/admin?${params.toString()}`);
  }
});

app.post("/admin/company/:id/profile/save", requireDashboardAuth, async (req, res) => {
  const id = req.params.id;

  try {
    const company = await api(`/api/companies/${encodeURIComponent(id)}`);
    const providerCompany = await getBotCatalogProviderCompany(company);
    const providerForPricing = providerCompany || company;
    const rulesRaw = parseJsonSafe(company.rulesJson || "{}", {});
    const rules = rulesRaw && typeof rulesRaw === "object" ? rulesRaw : {};

    const planTier = normalizePlanTier(req.body.planTier) || "BASICO";
    const channelMode = normalizeChannelMode(req.body.channelMode) || "whatsapp";

    rules.ownerName = String(req.body.ownerName || "").trim();
    rules.ownerRole = String(req.body.ownerRole || "").trim();
    rules.ownerEmail = String(req.body.ownerEmail || "").trim();
    rules.ownerPhone = String(req.body.ownerPhone || "").trim();
    rules.companyAddress = String(req.body.companyAddress || "").trim();
    rules.companyCity = String(req.body.companyCity || "").trim();
    rules.companyCountry = String(req.body.companyCountry || "").trim();
    rules.brandManual = String(req.body.brandManual || "").trim();
    rules.companyPurpose = String(req.body.companyPurpose || "").trim();
    rules.planTier = planTier;
    rules.aiEnabled = planTier !== "BASICO";
    rules.channelMode = channelMode;
    rules.channels = channelsFromMode(channelMode);
    rules.allowHuman = true;
    if (!String(rules.botClass || "").trim()) {
      rules.botClass = defaultBotClassFromMode(channelMode);
    }

    const manualPassword = String(req.body.clientPassword || "").trim();
    if (manualPassword) {
      assignClientPassword(rules, manualPassword);
    }

    const nextName = String(req.body.name || company.name || id).trim() || id;
    const nextPrompt = buildPromptFromBrandContext({
      companyName: nextName,
      brandManual: rules.brandManual,
      companyPurpose: rules.companyPurpose,
      fallbackPrompt: company.prompt || "",
    });

    await api(`/api/companies/${encodeURIComponent(id)}/save`, {
      method: "POST",
      body: {
        name: nextName,
        prompt: nextPrompt,
        catalogJson: company.catalogJson || "[]",
        rulesJson: JSON.stringify(rules),
      },
    });

    const passwordFlag = manualPassword ? "&manualPwd=1" : "";
    res.redirect(`/admin/company/${encodeURIComponent(id)}?updated=1${passwordFlag}`);
  } catch (e) {
    res.status(500).type("text/html").send(layout({
      title: "Empresa",
      active: "companies",
      body: `<div class="card"><b>Error guardando perfil:</b><pre>${escapeHtml(e?.message || e)}</pre></div><div class="card"><a class="btn secondary" href="/admin/company/${encodeURIComponent(id)}">Volver</a></div>`,
    }));
  }
});

app.post("/admin/company/:id/bot/save", requireDashboardAuth, async (req, res) => {
  const id = req.params.id;

  try {
    const company = await api(`/api/companies/${encodeURIComponent(id)}`);
    const providerCompany = await getBotCatalogProviderCompany(company);
    const providerForPricing = providerCompany || company;
    const rulesRaw = parseJsonSafe(company.rulesJson || "{}", {});
    const rules = rulesRaw && typeof rulesRaw === "object" ? rulesRaw : {};

    const fromSelect = String(req.body.botClass || "").trim();
    const fromCustom = String(req.body.botClassCustom || "").trim();
    const botClass = fromCustom || fromSelect;
    if (!botClass) {
      return res.redirect(`/admin/company/${encodeURIComponent(id)}?botError=${encodeURIComponent("Debes seleccionar o escribir una clase de bot")}`);
    }

    rules.botClass = botClass;
    rules.botClassUpdatedAt = new Date().toISOString();
    rules.botCatalogProviderId = providerForPricing?.id || company.id;
    rules.botCatalogProviderName = providerForPricing?.name || providerForPricing?.id || company.id;
    rules.allowHuman = true;

    const catalogOptions = extractCatalogBotOptions(providerForPricing);
    const selectedCatalog = catalogOptions.find((item) => item.name.toLowerCase() === botClass.toLowerCase());
    if (selectedCatalog?.id) {
      rules.botCatalogId = selectedCatalog.id;
    }

    const inferredTier = normalizePlanTier(botClass);
    const inferredChannel = normalizeChannelMode(botClass);
    if (inferredTier) {
      rules.planTier = inferredTier;
      rules.aiEnabled = inferredTier !== "BASICO";
    }
    if (inferredChannel) {
      rules.channelMode = inferredChannel;
      rules.channels = channelsFromMode(inferredChannel);
    }

    await api(`/api/companies/${encodeURIComponent(id)}/save`, {
      method: "POST",
      body: {
        name: company.name || id,
        prompt: company.prompt || "",
        catalogJson: company.catalogJson || "[]",
        rulesJson: JSON.stringify(rules),
      },
    });

    res.redirect(`/admin/company/${encodeURIComponent(id)}?botUpdated=1`);
  } catch (e) {
    res.redirect(`/admin/company/${encodeURIComponent(id)}?botError=${encodeURIComponent(e?.message || e)}`);
  }
});

app.post("/admin/company/:id/reset-password", requireDashboardAuth, async (req, res) => {
  const id = req.params.id;
  const requested = String(req.body.newPassword || "").trim();
  const nextPassword = requested || generateClientPassword(10);

  try {
    const company = await api(`/api/companies/${encodeURIComponent(id)}`);
    const rulesRaw = parseJsonSafe(company.rulesJson || "{}", {});
    const rules = rulesRaw && typeof rulesRaw === "object" ? rulesRaw : {};
    assignClientPassword(rules, nextPassword);

    await api(`/api/companies/${encodeURIComponent(id)}/save`, {
      method: "POST",
      body: {
        name: company.name || id,
        prompt: company.prompt || "",
        catalogJson: company.catalogJson || "[]",
        rulesJson: JSON.stringify(rules),
      },
    });

    res.redirect(`/admin/company/${encodeURIComponent(id)}?generatedPwd=${encodeURIComponent(nextPassword)}`);
  } catch (e) {
    res.status(500).type("text/html").send(layout({
      title: "Empresa",
      active: "companies",
      body: `<div class="card"><b>Error restableciendo password:</b><pre>${escapeHtml(e?.message || e)}</pre></div><div class="card"><a class="btn secondary" href="/admin/company/${encodeURIComponent(id)}">Volver</a></div>`,
    }));
  }
});

// ================= ASIGNAR CLIENTES =================
app.get("/admin/assign", requireDashboardAuth, async (req, res) => {
  try {
    const companies = await api("/api/companies");
    const mappings = await api("/api/assignments");

    const options = companies.map((c) =>
      `<option value="${escapeHtml(c.id)}">${escapeHtml(c.id)} - ${escapeHtml(c.name || "")}</option>`
    ).join("");

    const list = mappings.map((m) => `
      <tr>
        <td><code>${escapeHtml(m.fromNumber)}</code></td>
        <td><code>${escapeHtml(m.companyId)}</code></td>
        <td class="muted">${escapeHtml(m.updatedAt || "")}</td>
        <td>
          <form method="POST" action="/admin/assign/delete" style="margin:0">
            <input type="hidden" name="fromNumber" value="${escapeHtml(m.fromNumber)}" />
            <button class="btn secondary" type="submit">Quitar</button>
          </form>
        </td>
      </tr>
    `).join("");

    const body = `
      <div class="card">
        <form method="POST" action="/admin/assign" class="form">
          <label>Asignar empresa a cliente</label>
          <div class="grid2">
            <input name="fromNumber" placeholder="whatsapp:+549381..." />
            <select name="companyId">${options}</select>
          </div>
          <div class="actions">
            <button class="btn primary">Asignar</button>
          </div>
        </form>
      </div>

      <div class="card">
        <h3 style="margin-top:0">Ultimas asignaciones</h3>
        <table class="table">
          <thead>
            <tr><th>Cliente</th><th>Empresa</th><th>Actualizado</th><th></th></tr>
          </thead>
          <tbody>
            ${list || `<tr><td colspan="4" class="muted">Sin asignaciones.</td></tr>`}
          </tbody>
        </table>
      </div>
    `;

    res.type("text/html").send(layout({ title: "Asignar clientes", active: "assign", body }));
  } catch (e) {
    res.status(500).type("text/html").send(layout({
      title: "Asignar clientes",
      active: "assign",
      body: `<div class="card"><b>Error:</b><pre>${escapeHtml(e?.message || e)}</pre></div>`
    }));
  }
});

app.post("/admin/assign", requireDashboardAuth, async (req, res) => {
  try {
    await api("/api/assignments", {
      method: "POST",
      body: {
        fromNumber: req.body.fromNumber,
        companyId: req.body.companyId,
      }
    });
    res.redirect("/admin/assign");
  } catch (e) {
    res.status(500).type("text/html").send(layout({
      title: "Asignar clientes",
      active: "assign",
      body: `<div class="card"><b>Error:</b><pre>${escapeHtml(e?.message || e)}</pre></div>
             <div class="card"><a class="btn secondary" href="/admin/assign">Volver</a></div>`
    }));
  }
});

app.post("/admin/assign/delete", requireDashboardAuth, async (req, res) => {
  try {
    await api("/api/assignments/delete", { method: "POST", body: { fromNumber: req.body.fromNumber } });
    res.redirect("/admin/assign");
  } catch (e) {
    res.status(500).type("text/html").send(layout({
      title: "Asignar clientes",
      active: "assign",
      body: `<div class="card"><b>Error:</b><pre>${escapeHtml(e?.message || e)}</pre></div>
             <div class="card"><a class="btn secondary" href="/admin/assign">Volver</a></div>`
    }));
  }
});

app.get("/admin/messages", requireDashboardAuth, async (req, res) => {
  try {
    const companyFilter = String(req.query.companyId || "").trim().toLowerCase();
    const senderFilterRaw = String(req.query.sender || "all").trim().toLowerCase();
    const statusFilterRaw = String(req.query.status || "all").trim().toLowerCase();
    const readFilterRaw = String(req.query.read || "all").trim().toLowerCase();
    const q = String(req.query.q || "").trim().toLowerCase();
    const senderFilter = ["all", "client", "admin"].includes(senderFilterRaw) ? senderFilterRaw : "all";
    const statusFilter = ["all", "open", "resolved"].includes(statusFilterRaw) ? statusFilterRaw : "all";
    const readFilter = ["all", "unread", "read"].includes(readFilterRaw) ? readFilterRaw : "all";

    const companies = await api("/api/companies");
    const companyList = Array.isArray(companies) ? companies : [];
    const messages = [];

    for (const company of companyList) {
      const rulesRaw = parseJsonSafe(company?.rulesJson || "{}", {});
      const rules = rulesRaw && typeof rulesRaw === "object" ? rulesRaw : {};
      const inbox = extractAdminInbox(rules);
      for (const item of inbox) {
        messages.push({
          ...item,
          companyId: String(company?.id || ""),
          companyName: String(company?.name || company?.id || ""),
        });
      }
    }

    messages.sort((a, b) => {
      const at = new Date(a.createdAt || 0).getTime();
      const bt = new Date(b.createdAt || 0).getTime();
      return bt - at;
    });

    const filtered = messages.filter((msg) => {
      if (companyFilter && msg.companyId.toLowerCase() !== companyFilter) return false;
      if (senderFilter !== "all" && msg.sender !== senderFilter) return false;
      if (statusFilter !== "all" && msg.status !== statusFilter) return false;
      if (readFilter !== "all") {
        const isRead = msg.sender === "client" ? !!msg.readByAdmin : !!msg.readByClient;
        if (readFilter === "unread" && isRead) return false;
        if (readFilter === "read" && !isRead) return false;
      }
      if (q) {
        const searchText = [
          msg.companyId,
          msg.companyName,
          msg.text,
          msg.orderId,
          msg.sender,
        ].join(" ").toLowerCase();
        if (!searchText.includes(q)) return false;
      }
      return true;
    });

    const unreadTotal = messages.filter((msg) => msg.sender === "client" && !msg.readByAdmin).length;
    const openCount = messages.filter((msg) => msg.status === "open").length;
    const resolvedCount = messages.filter((msg) => msg.status === "resolved").length;
    const returnQuery = new URLSearchParams(req.query).toString();
    const toHtmlText = (value) => escapeHtml(value || "").replace(/\r?\n/g, "<br/>");

    const rows = filtered.map((msg) => {
      const readByAdmin = msg.sender === "client" ? !!msg.readByAdmin : !!msg.readByClient;
      return `
        <article class="admin-msg-item ${msg.sender === "admin" ? "from-admin" : "from-client"}">
          <div class="admin-msg-meta">
            <b>${escapeHtml(msg.companyName || msg.companyId)}</b>
            <span>${escapeHtml(msg.companyId)}</span>
            <span>${escapeHtml(formatDateLabel(msg.createdAt))}</span>
            <span class="admin-msg-pill ${msg.sender === "admin" ? "admin" : "client"}">${msg.sender === "admin" ? "Admin" : "Cliente"}</span>
            <span class="admin-msg-pill ${msg.status === "resolved" ? "resolved" : "open"}">${msg.status === "resolved" ? "Resuelto" : "Abierto"}</span>
            <span class="admin-msg-pill ${readByAdmin ? "read" : "unread"}">${readByAdmin ? "Leido" : "Sin leer"}</span>
            ${msg.orderId ? `<span class="admin-msg-pill order">Pedido ${escapeHtml(msg.orderId)}</span>` : ""}
          </div>
          <div class="admin-msg-text">${toHtmlText(msg.text)}</div>
          <div class="admin-msg-actions">
            <form method="POST" action="/admin/messages/state" class="admin-msg-action-form">
              <input type="hidden" name="companyId" value="${escapeHtml(msg.companyId)}" />
              <input type="hidden" name="messageId" value="${escapeHtml(msg.id)}" />
              <input type="hidden" name="returnQuery" value="${escapeHtml(returnQuery)}" />
              <input type="hidden" name="actionType" value="toggleRead" />
              <button class="btn secondary small" type="submit">${readByAdmin ? "Marcar sin leer" : "Marcar leido"}</button>
            </form>

            <form method="POST" action="/admin/messages/state" class="admin-msg-action-form">
              <input type="hidden" name="companyId" value="${escapeHtml(msg.companyId)}" />
              <input type="hidden" name="messageId" value="${escapeHtml(msg.id)}" />
              <input type="hidden" name="returnQuery" value="${escapeHtml(returnQuery)}" />
              <input type="hidden" name="actionType" value="toggleStatus" />
              <button class="btn secondary small" type="submit">${msg.status === "resolved" ? "Reabrir" : "Resolver"}</button>
            </form>

            <form method="POST" action="/admin/messages/reply" class="admin-msg-reply-form">
              <input type="hidden" name="companyId" value="${escapeHtml(msg.companyId)}" />
              <input type="hidden" name="replyToId" value="${escapeHtml(msg.id)}" />
              <input type="hidden" name="orderId" value="${escapeHtml(msg.orderId || "")}" />
              <input type="hidden" name="returnQuery" value="${escapeHtml(returnQuery)}" />
              <input name="replyText" maxlength="1000" placeholder="Responder..." />
              <button class="btn primary small" type="submit">Responder</button>
            </form>
          </div>
        </article>
      `;
    }).join("");

    const infoSaved = String(req.query.saved || "") === "1";
    const infoReplied = String(req.query.replied || "") === "1";
    const errorMsg = String(req.query.error || "").trim();

    const body = `
      ${infoSaved ? `<div class="card"><b>Mensaje actualizado.</b></div>` : ""}
      ${infoReplied ? `<div class="card"><b>Respuesta enviada a la empresa.</b></div>` : ""}
      ${errorMsg ? `<div class="card"><b>Error:</b> ${escapeHtml(errorMsg)}</div>` : ""}
      <div class="kpis">
        <div class="kpi"><div class="label">Mensajes</div><div class="value">${messages.length}</div><div class="hint">buzon total</div></div>
        <div class="kpi"><div class="label">Sin leer</div><div class="value">${unreadTotal}</div><div class="hint">pendientes de admin</div></div>
        <div class="kpi"><div class="label">Abiertos</div><div class="value">${openCount}</div><div class="hint">en curso</div></div>
        <div class="kpi"><div class="label">Resueltos</div><div class="value">${resolvedCount}</div><div class="hint">cerrados</div></div>
      </div>

      <div class="card">
        <h3 style="margin-top:0">Filtros del buzon</h3>
        <form method="GET" action="/admin/messages" class="form">
          <div class="grid2">
            <div>
              <label>Empresa</label>
              <select name="companyId">
                <option value="">Todas</option>
                ${companyList.map((c) => {
                  const id = String(c?.id || "");
                  const selected = id.toLowerCase() === companyFilter ? "selected" : "";
                  return `<option value="${escapeHtml(id)}" ${selected}>${escapeHtml(c?.name || id)} (${escapeHtml(id)})</option>`;
                }).join("")}
              </select>
            </div>
            <div>
              <label>Remitente</label>
              <select name="sender">
                <option value="all" ${senderFilter === "all" ? "selected" : ""}>Todos</option>
                <option value="client" ${senderFilter === "client" ? "selected" : ""}>Cliente</option>
                <option value="admin" ${senderFilter === "admin" ? "selected" : ""}>Admin</option>
              </select>
            </div>
          </div>
          <div class="grid2">
            <div>
              <label>Estado</label>
              <select name="status">
                <option value="all" ${statusFilter === "all" ? "selected" : ""}>Todos</option>
                <option value="open" ${statusFilter === "open" ? "selected" : ""}>Abiertos</option>
                <option value="resolved" ${statusFilter === "resolved" ? "selected" : ""}>Resueltos</option>
              </select>
            </div>
            <div>
              <label>Lectura</label>
              <select name="read">
                <option value="all" ${readFilter === "all" ? "selected" : ""}>Todos</option>
                <option value="unread" ${readFilter === "unread" ? "selected" : ""}>Sin leer</option>
                <option value="read" ${readFilter === "read" ? "selected" : ""}>Leidos</option>
              </select>
            </div>
          </div>
          <label>Buscar texto</label>
          <input name="q" value="${escapeHtml(String(req.query.q || ""))}" placeholder="Empresa, pedido o contenido del mensaje" />
          <div class="actions">
            <button class="btn primary" type="submit">Aplicar</button>
            <a class="btn secondary" href="/admin/messages">Limpiar</a>
          </div>
        </form>
      </div>

      <div class="card">
        <h3 style="margin-top:0">Buzon</h3>
        <div class="admin-msg-list">${rows || `<div class="muted">Sin mensajes para este filtro.</div>`}</div>
      </div>
    `;

    res.type("text/html").send(layout({
      title: "Mensajes",
      active: "messages",
      body,
      notifications: unreadTotal,
    }));
  } catch (e) {
    res.status(500).type("text/html").send(layout({
      title: "Mensajes",
      active: "messages",
      body: `<div class="card"><b>Error cargando buzon:</b><pre>${escapeHtml(e?.message || e)}</pre></div>`,
    }));
  }
});

app.post("/admin/messages/state", requireDashboardAuth, async (req, res) => {
  const companyId = String(req.body.companyId || "").trim();
  const messageId = String(req.body.messageId || "").trim();
  const actionType = String(req.body.actionType || "").trim().toLowerCase();
  const returnQuery = String(req.body.returnQuery || "").trim();

  const redirectBase = () => {
    const query = returnQuery ? `?${returnQuery}` : "";
    return `/admin/messages${query}`;
  };

  if (!companyId || !messageId || !["toggleread", "togglestatus"].includes(actionType)) {
    const next = redirectBase();
    return res.redirect(`${next}${next.includes("?") ? "&" : "?"}error=${encodeURIComponent("Datos invalidos para actualizar mensaje")}`);
  }

  try {
    const company = await api(`/api/companies/${encodeURIComponent(companyId)}`);
    const rulesRaw = parseJsonSafe(company.rulesJson || "{}", {});
    const rules = rulesRaw && typeof rulesRaw === "object" ? rulesRaw : {};
    const inbox = extractAdminInbox(rules);
    const idx = inbox.findIndex((item) => String(item.id || "") === messageId);
    if (idx < 0) throw new Error("No se encontro el mensaje en el buzon");

    if (actionType === "toggleread") {
      if (inbox[idx].sender === "client") inbox[idx].readByAdmin = !inbox[idx].readByAdmin;
      else inbox[idx].readByClient = !inbox[idx].readByClient;
    } else if (actionType === "togglestatus") {
      inbox[idx].status = inbox[idx].status === "resolved" ? "open" : "resolved";
    }

    setAdminInbox(rules, inbox);
    await saveCompanyRules(company, rules);

    const next = redirectBase();
    return res.redirect(`${next}${next.includes("?") ? "&" : "?"}saved=1`);
  } catch (e) {
    const next = redirectBase();
    return res.redirect(`${next}${next.includes("?") ? "&" : "?"}error=${encodeURIComponent(e?.message || e)}`);
  }
});

app.post("/admin/messages/reply", requireDashboardAuth, async (req, res) => {
  const companyId = String(req.body.companyId || "").trim();
  const replyToId = String(req.body.replyToId || "").trim();
  const orderId = String(req.body.orderId || "").trim();
  const replyText = String(req.body.replyText || "").trim();
  const returnQuery = String(req.body.returnQuery || "").trim();

  const redirectBase = () => {
    const query = returnQuery ? `?${returnQuery}` : "";
    return `/admin/messages${query}`;
  };

  if (!companyId || !replyText) {
    const next = redirectBase();
    return res.redirect(`${next}${next.includes("?") ? "&" : "?"}error=${encodeURIComponent("Debes indicar empresa y texto de respuesta")}`);
  }

  if (replyText.length > 1000) {
    const next = redirectBase();
    return res.redirect(`${next}${next.includes("?") ? "&" : "?"}error=${encodeURIComponent("La respuesta supera 1000 caracteres")}`);
  }

  try {
    const company = await api(`/api/companies/${encodeURIComponent(companyId)}`);
    const rulesRaw = parseJsonSafe(company.rulesJson || "{}", {});
    const rules = rulesRaw && typeof rulesRaw === "object" ? rulesRaw : {};
    const inbox = extractAdminInbox(rules);

    if (replyToId) {
      const idx = inbox.findIndex((item) => String(item.id || "") === replyToId);
      if (idx >= 0 && inbox[idx].sender === "client") {
        inbox[idx].readByAdmin = true;
      }
    }

    inbox.push({
      id: createInboxMessageId(),
      sender: "admin",
      text: replyText,
      orderId,
      createdAt: new Date().toISOString(),
      status: "open",
      readByAdmin: true,
      readByClient: false,
    });

    setAdminInbox(rules, inbox);
    await saveCompanyRules(company, rules);

    const next = redirectBase();
    return res.redirect(`${next}${next.includes("?") ? "&" : "?"}replied=1`);
  } catch (e) {
    const next = redirectBase();
    return res.redirect(`${next}${next.includes("?") ? "&" : "?"}error=${encodeURIComponent(e?.message || e)}`);
  }
});

// ================= PEDIDOS + ESTADISTICAS + BUSCADOR + CSV =================
app.get("/admin/orders", requireDashboardAuth, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const limit = Math.min(Math.max(Number(req.query.limit || 50), 10), 200);

    // requiere backend /api/orders
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    params.set("limit", String(limit));

    const orders = await api(`/api/orders?${params.toString()}`);

    const totalOrders = orders.length;
    const totalRevenue = orders.reduce((acc, o) => acc + Number(o.total || 0), 0);
    const avgTicket = totalOrders ? (totalRevenue / totalOrders) : 0;

    const cards = `
      <div class="grid3">
        <div class="card"><div class="muted">Pedidos</div><div style="font-size:24px;font-weight:700">${totalOrders}</div></div>
        <div class="card"><div class="muted">Ventas</div><div style="font-size:24px;font-weight:700">$${Math.round(totalRevenue)}</div></div>
        <div class="card"><div class="muted">Ticket prom.</div><div style="font-size:24px;font-weight:700">$${Math.round(avgTicket)}</div></div>
      </div>
    `;

    const rows = orders.map((o) => `
      <tr>
        <td><code>${escapeHtml(o.id)}</code></td>
        <td class="muted">${escapeHtml(o.createdAt || "")}</td>
        <td><code>${escapeHtml(o.fromNumber || "")}</code></td>
        <td><code>${escapeHtml(o.companyId || "")}</code></td>
        <td>${escapeHtml(o.name || "")}</td>
        <td>${escapeHtml(o.contact || "")}</td>
        <td><b>$${escapeHtml(o.total ?? 0)}</b></td>
        <td class="muted">${escapeHtml(o.orderStatus || "")}</td>
      </tr>
    `).join("");

    const body = `
      ${cards}

      <div class="card">
        <form method="GET" action="/admin/orders" class="form">
          <label>Buscar pedidos</label>
          <div class="grid2">
            <input name="q" value="${escapeHtml(q)}" placeholder="PED-XXXX, whatsapp:+54..., nombre, contacto..." />
            <select name="limit">
              ${[10,25,50,100,200].map(n => `<option value="${n}" ${n===limit?"selected":""}>${n} ultimos</option>`).join("")}
            </select>
          </div>
          <div class="actions" style="display:flex;gap:10px;flex-wrap:wrap">
            <button class="btn primary">Buscar</button>
            <a class="btn secondary" href="/admin/orders">Limpiar</a>
            <a class="btn secondary" href="/admin/orders/export.csv?${params.toString()}">Export CSV</a>
          </div>
        </form>
      </div>

      <div class="card">
        <h3 style="margin-top:0">Pedidos</h3>
        <table class="table">
          <thead>
            <tr>
              <th>ID</th><th>Fecha</th><th>Cliente</th><th>Empresa</th><th>Nombre</th><th>Contacto</th><th>Total</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${rows || `<tr><td colspan="8" class="muted">No hay pedidos para mostrar.</td></tr>`}
          </tbody>
        </table>
        <div class="muted" style="margin-top:10px">Tip: si no ves pedidos, asegurate de tener endpoint <code>/api/orders</code> en el backend.</div>
      </div>
    `;

    res.type("text/html").send(layout({ title: "Pedidos", active: "orders", body }));
  } catch (e) {
    res.status(500).type("text/html").send(layout({
      title: "Pedidos",
      active: "orders",
      body: `<div class="card"><b>Error:</b><pre>${escapeHtml(e?.message || e)}</pre></div>
             <div class="card"><div class="muted">Esto suele pasar si el backend todavia no tiene <code>/api/orders</code>.</div></div>`
    }));
  }
});

// Export CSV (server-side)
app.get("/admin/orders/export.csv", requireDashboardAuth, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const limit = Math.min(Math.max(Number(req.query.limit || 200), 10), 500);

    const params = new URLSearchParams();
    if (q) params.set("q", q);
    params.set("limit", String(limit));

    const orders = await api(`/api/orders?${params.toString()}`);
    const csv = toCsv(orders);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="orders_${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch (e) {
    res.status(500).send(`Error exportando CSV: ${e?.message || e}`);
  }
});

// ====================== CLIENT ROUTES (empresas) ======================

function parseJsonSafe(raw, fallback) {
  try {
    const parsed = JSON.parse(raw ?? "");
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function renderClientLoginPage() {
  return `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <link rel="stylesheet" href="/dashboard.css" />
    <title>Login cliente</title>
  </head>
  <body>
    <div class="bs-login">
      <div class="bs-bg" style="background-image:url('/img/login-tech-bg.png')"></div>
      <div class="bs-vignette"></div>

      <div class="bs-card">
        <div class="bs-brand">
          <div class="bs-dot"></div>
          <div>
            <div class="bs-title">BabySteps</div>
            <div class="bs-subtitle">Acceso clientes</div>
          </div>
        </div>

        <h2 class="bs-h2">Entrar</h2>

        <form method="POST" action="/panel/login" class="form">
          <label>Empresa (ID)</label>
          <input name="companyId" placeholder="ej: babystepsbots" autocomplete="username" />

          <label>Contrasena</label>
          <div class="pw-row">
            <input id="clientPass" name="pass" type="password" placeholder="Contrasena" autocomplete="current-password" />
            <button type="button" class="icon-btn" id="toggleClientPass" aria-label="Mostrar contrasena">🙈</button>
          </div>

          <div class="login-actions">
            <button class="btn primary">Entrar</button>
            <a class="btn secondary" href="/panel/forgot">Olvide mi contrasena</a>
          </div>
        </form>
      </div>
    </div>
    <script>
      const btn = document.getElementById("toggleClientPass");
      const pass = document.getElementById("clientPass");
      if (btn && pass) {
        const syncEye = () => {
          const hidden = pass.type === "password";
          btn.textContent = hidden ? "🙈" : "👁️";
          btn.setAttribute("aria-label", hidden ? "Mostrar contrasena" : "Ocultar contrasena");
        };
        btn.addEventListener("click", () => {
          pass.type = pass.type === "password" ? "text" : "password";
          syncEye();
        });
        syncEye();
      }
    </script>
  </body>
</html>`;
}

async function handleClientLogin(req, res) {
  try {
    const companyInput = (req.body.companyId || "").trim();
    const pass = (req.body.pass || "").trim();
    if (!companyInput || !pass) return res.status(400).send("Faltan datos");

    const allCompanies = await api("/api/companies");
    const companies = Array.isArray(allCompanies) ? allCompanies : [];
    const lookup = companyInput.toLowerCase();
    const matched = companies.find((c) =>
      String(c?.id || "").trim().toLowerCase() === lookup ||
      String(c?.name || "").trim().toLowerCase() === lookup
    );
    if (!matched?.id) {
      return res.status(401).send("Empresa no encontrada o credenciales incorrectas");
    }

    const companyId = String(matched.id).trim();
    const company = await api(`/api/companies/${encodeURIComponent(companyId)}`);
    const rules = parseJsonSafe(company.rulesJson || "{}", {});
    const expected = resolveClientPassword(rules, company);

    if (!expected) {
      return res.status(400).send("La empresa no tiene password de cliente configurada");
    }

    if (pass !== expected) {
      return res.status(401).send("Credenciales incorrectas");
    }

    const access = extractDashboardAccessFromRules(rules);
    const nextPath = canAccessClientSection(access, "inicio")
      ? "/panel"
      : canAccessClientSection(access, "catalogo")
        ? "/panel/catalogo"
        : "/panel";

    setCookie(res, "client", `${companyId}.${signClient(companyId)}`);
    return res.redirect(nextPath);
  } catch {
    return res.status(401).send("Credenciales incorrectas");
  }
}

function toNumber(value) {
  const n = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function formatMoney(value, currency = "USD") {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "-";
  try {
    return new Intl.NumberFormat("es-AR", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `$${Math.round(amount)}`;
  }
}

function formatDateLabel(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString("es-AR");
}

function normalizePlanTier(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.includes("pro")) return "PRO";
  if (raw.includes("lite")) return "LITE";
  if (raw.includes("basic") || raw.includes("basico") || raw.includes("sin ai") || raw.includes("base")) return "BASICO";
  return "";
}

function normalizeChannelMode(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.includes("unifi") || raw.includes("multi")) return "combinado";
  if (raw.includes("comb")) return "combinado";
  if (raw.includes("insta")) return "instagram";
  if (raw.includes("what")) return "whatsapp";
  return raw;
}

function channelsFromMode(mode) {
  if (mode === "combinado") return ["whatsapp", "instagram"];
  if (mode === "instagram") return ["instagram"];
  return ["whatsapp"];
}

function planLabelFromTier(tier) {
  if (tier === "PRO") return "Con AI PRO";
  if (tier === "LITE") return "Con AI LITE";
  return "Basico (sin AI)";
}

function channelLabelFromMode(mode) {
  if (mode === "instagram") return "Instagram";
  if (mode === "combinado") return "WhatsApp + Instagram";
  return "WhatsApp";
}

function defaultBotClassFromMode(mode) {
  if (mode === "instagram") return "Bot Instagram";
  if (mode === "combinado") return "Bot Unificado";
  return "Bot WhatsApp";
}

function tierRank(tier) {
  if (tier === "PRO") return 2;
  if (tier === "LITE") return 1;
  return 0;
}

function tierFromRank(rank) {
  if (rank >= 2) return "PRO";
  if (rank <= 0) return "BASICO";
  return "LITE";
}

function findCatalogItemForTierAndChannel(catalog, tier, channelMode) {
  if (!Array.isArray(catalog) || !catalog.length) return null;
  const normalize = (v) => String(v || "").toLowerCase();
  const hasAny = (value, tokens) => tokens.some((token) => value.includes(token));

  const byChannel = catalog.filter((item) => {
    const name = normalize(item?.name);
    if (!name) return false;
    if (channelMode === "instagram") {
      return hasAny(name, ["instagram", "insta"]);
    }
    if (channelMode === "combinado") {
      return hasAny(name, ["combinado", "unificado", "multi", "whatsapp + instagram"]);
    }
    return hasAny(name, ["whatsapp"]) || !hasAny(name, ["instagram", "insta", "combinado", "unificado", "multi"]);
  });

  const scoped = byChannel.length ? byChannel : catalog;
  const tierTokens = {
    PRO: ["pro"],
    LITE: ["lite"],
    BASICO: ["basico", "basic", "sin ai", "standard"],
  };
  const preferred = scoped.find((item) => hasAny(normalize(item?.name), tierTokens[tier] || []));
  if (preferred) return preferred;

  if (tier === "BASICO") {
    const withoutAi = scoped.find((item) => {
      const name = normalize(item?.name);
      return !name.includes("lite") && !name.includes("pro");
    });
    if (withoutAi) return withoutAi;
  }

  return scoped[0] || null;
}

function extractCatalogEntriesForCompany(company) {
  const catalogRaw = parseJsonSafe(company?.catalogJson || "[]", []);
  const catalogBase = Array.isArray(catalogRaw) ? catalogRaw : [];
  return catalogBase.map((item, idx) => ({
    id: String(item?.id ?? `P-${idx + 1}`),
    name: String(item?.name || item?.title || "Sin nombre"),
    price: toNumber(item?.price ?? item?.amount ?? 0),
    stock: item?.stock ?? item?.qty ?? "-",
    category: String(item?.category || item?.type || "-"),
  }));
}

function extractCatalogBotOptions(company) {
  const catalogRaw = extractCatalogEntriesForCompany(company);
  if (!Array.isArray(catalogRaw)) return [];
  const seen = new Set();

  return catalogRaw
    .map((item) => {
      const id = String(item?.id ?? "").trim();
      const name = String(item?.name || "").trim();
      if (!name) return null;
      const key = `${id.toLowerCase()}::${name.toLowerCase()}`;
      if (seen.has(key)) return null;
      seen.add(key);
      return { id, name, label: id ? `${id} - ${name}` : name };
    })
    .filter(Boolean);
}

function parseDateSafe(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function monthRefFromShift(year, month, shift) {
  const d = new Date(Date.UTC(year, month + shift, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() };
}

function clampDayOfMonth(year, month, day) {
  const maxDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Math.min(Math.max(1, day), maxDay);
}

function buildUtcDate(year, month, day) {
  return new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
}

function computeMonthlyCycle(anchorInput, nowInput = new Date()) {
  const now = parseDateSafe(nowInput) || new Date();
  const anchor = parseDateSafe(anchorInput) || now;
  const anchorDay = anchor.getUTCDate();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();

  let currentStart = buildUtcDate(year, month, clampDayOfMonth(year, month, anchorDay));
  if (now.getTime() < currentStart.getTime()) {
    const prevRef = monthRefFromShift(year, month, -1);
    currentStart = buildUtcDate(prevRef.year, prevRef.month, clampDayOfMonth(prevRef.year, prevRef.month, anchorDay));
  }

  const nextRef = monthRefFromShift(currentStart.getUTCFullYear(), currentStart.getUTCMonth(), 1);
  const renewal = buildUtcDate(nextRef.year, nextRef.month, clampDayOfMonth(nextRef.year, nextRef.month, anchorDay));
  const currentEnd = new Date(renewal.getTime() - 24 * 60 * 60 * 1000);
  const totalDays = Math.max(1, Math.ceil((renewal.getTime() - currentStart.getTime()) / (24 * 60 * 60 * 1000)));
  const remainingDays = Math.max(0, Math.ceil((renewal.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));

  return {
    anchorIso: anchor.toISOString(),
    startIso: currentStart.toISOString(),
    endIso: currentEnd.toISOString(),
    renewalIso: renewal.toISOString(),
    totalDays,
    remainingDays,
  };
}

function findCatalogItemForBot(catalog, botClass, botCatalogId) {
  const idRaw = String(botCatalogId || "").trim().toLowerCase();
  const nameRaw = String(botClass || "").trim().toLowerCase();
  if (!Array.isArray(catalog) || !catalog.length) return null;

  if (idRaw) {
    const byId = catalog.find((item) => String(item.id || "").trim().toLowerCase() === idRaw);
    if (byId) return byId;
  }
  if (nameRaw) {
    const exact = catalog.find((item) => String(item.name || "").trim().toLowerCase() === nameRaw);
    if (exact) return exact;
    const partial = catalog.find((item) => String(item.name || "").trim().toLowerCase().includes(nameRaw));
    if (partial) return partial;
  }
  return null;
}

function extractPlanInfo(company, rules) {
  const botClassRaw = String(
    rules?.botClass ||
    rules?.botType ||
    rules?.botName ||
    ""
  ).trim();

  const tierFromBotClass = normalizePlanTier(botClassRaw);
  const rawTier =
    tierFromBotClass ||
    normalizePlanTier(
      rules?.planTier ||
      rules?.botPlan ||
      rules?.aiPlan ||
      rules?.planType ||
      company?.subscriptionPlan ||
      rules?.subscriptionPlan
    ) ||
    normalizePlanTier(botClassRaw);

  let channelMode = normalizeChannelMode(
    rules?.channelMode ||
    rules?.channel ||
    rules?.platform
  );
  if (!channelMode && botClassRaw) {
    channelMode = normalizeChannelMode(botClassRaw);
  }

  const channelsRaw = Array.isArray(rules?.channels)
    ? rules.channels.map((v) => String(v || "").toLowerCase())
    : [];
  if (!channelMode) {
    const hasWa = channelsRaw.includes("whatsapp");
    const hasIg = channelsRaw.includes("instagram");
    if (hasWa && hasIg) channelMode = "combinado";
    else if (hasIg) channelMode = "instagram";
    else if (hasWa) channelMode = "whatsapp";
  }
  if (!channelMode) channelMode = "whatsapp";

  const aiEnabled = rules?.aiEnabled !== undefined ? !!rules.aiEnabled : rawTier !== "BASICO";
  const tier = rawTier || (aiEnabled ? "LITE" : "BASICO");
  const botClass = botClassRaw || defaultBotClassFromMode(channelMode);

  return {
    tier,
    aiEnabled: tier === "BASICO" ? false : aiEnabled,
    channelMode,
    channels: channelsFromMode(channelMode),
    botClass,
    planLabel: planLabelFromTier(tier),
    channelLabel: channelLabelFromMode(channelMode),
    fullLabel: `${planLabelFromTier(tier)} - ${channelLabelFromMode(channelMode)}`,
  };
}

function extractCompanyProfile(rules) {
  return {
    ownerName: String(rules?.ownerName || rules?.ceoName || ""),
    ownerRole: String(rules?.ownerRole || rules?.ceoRole || "Dueno/CEO"),
    ownerEmail: String(rules?.ownerEmail || rules?.email || ""),
    ownerPhone: String(rules?.ownerPhone || rules?.phone || ""),
    companyAddress: String(rules?.companyAddress || rules?.address || ""),
    companyCity: String(rules?.companyCity || rules?.city || ""),
    companyCountry: String(rules?.companyCountry || rules?.country || ""),
  };
}

function generateClientPassword(length = 10) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789@#$!";
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function resolveClientPassword(rules, company) {
  const candidates = [
    rules?.clientPassword,
    rules?.clientPass,
    rules?.password,
    rules?.pass,
    rules?.accessPassword,
    rules?.auth?.clientPassword,
    company?.clientPassword,
    company?.password,
  ];
  for (const value of candidates) {
    const normalized = String(value || "").trim();
    if (normalized) return normalized;
  }
  return "";
}

function assignClientPassword(rules, password) {
  const normalized = String(password || "").trim();
  if (!normalized || !rules || typeof rules !== "object") return;
  rules.clientPassword = normalized;
  rules.clientPass = normalized;
  rules.password = normalized;
}

function buildPromptFromBrandContext({ companyName, brandManual, companyPurpose, fallbackPrompt }) {
  const safeName = String(companyName || "").trim() || "la empresa";
  const manual = String(brandManual || "").trim();
  const purpose = String(companyPurpose || "").trim();
  const fallback = String(fallbackPrompt || "").trim();

  // If there is no brand context yet, keep current prompt behavior.
  if (!manual && !purpose) {
    return fallback || `Sos el asistente comercial de ${safeName}.`;
  }

  const lines = [
    `Sos el asistente comercial de ${safeName}.`,
    "Habla en espanol (Argentina), claro, directo y orientado a resolver.",
    "",
    "Manual de marca:",
    manual || "No definido.",
    "",
    "Objetivo de la empresa:",
    purpose || "No definido.",
    "",
    "Reglas:",
    "- No inventes datos que no esten en catalogo/politicas.",
    "- Mantene coherencia con el manual de marca.",
    "- Si falta informacion critica, pedila en una pregunta concreta.",
    "- Busca avanzar a una accion clara (compra, reserva, derivacion, etc.).",
  ];

  return lines.join("\n");
}

function extractClientState(company, options = {}) {
  const rulesRaw = parseJsonSafe(company?.rulesJson || "{}", {});
  const rules = rulesRaw && typeof rulesRaw === "object" ? { ...rulesRaw } : {};
  rules.allowHuman = true;
  const plan = extractPlanInfo(company, rules);
  const profile = extractCompanyProfile(rules);

  const catalog = extractCatalogEntriesForCompany(company);
  const priceCatalog = Array.isArray(options?.priceCatalog) && options.priceCatalog.length
    ? options.priceCatalog
    : catalog;

  const prices = catalog.map((item) => item.price).filter((p) => p > 0);
  const totalCatalogValue = prices.reduce((acc, p) => acc + p, 0);
  const avgPrice = prices.length ? totalCatalogValue / prices.length : 0;
  const maxPrice = prices.length ? Math.max(...prices) : 0;

  const activeCatalogItem = findCatalogItemForBot(priceCatalog, plan.botClass, rules?.botCatalogId);
  const activeBotAmount = activeCatalogItem ? toNumber(activeCatalogItem.price) : 0;
  const anchorSource =
    rules.subscriptionAnchorDate ||
    rules.subscriptionStartDate ||
    rules.botActivatedAt ||
    company?.createdAt ||
    new Date().toISOString();
  const cycle = computeMonthlyCycle(anchorSource);
  const computedAmount = activeBotAmount > 0
    ? activeBotAmount
    : toNumber(company?.subscriptionAmount ?? rules.subscriptionAmount ?? rules.monthlyPrice ?? 0);
  const computedNextAmount = activeBotAmount > 0
    ? activeBotAmount
    : toNumber(rules.subscriptionNextAmount ?? computedAmount);

  const subscription = {
    plan: String(rules.subscriptionPlan || company?.subscriptionPlan || rules.plan || plan.planLabel),
    status: String(company?.subscriptionStatus || rules.subscriptionStatus || "Activa"),
    cycle: String(company?.subscriptionCycle || rules.subscriptionCycle || "Mensual"),
    startAt: rules.subscriptionCurrentStart || rules.subscriptionStartDate || cycle.startIso,
    endAt: rules.subscriptionCurrentEnd || cycle.endIso,
    renewalAt: rules.subscriptionRenewal || company?.subscriptionRenewal || company?.nextBillingDate || rules.nextBillingDate || cycle.renewalIso,
    amount: computedAmount,
    nextAmount: computedNextAmount,
    prorationDueNow: toNumber(rules.subscriptionProrationDueNow ?? 0),
    prorationAt: rules.subscriptionProrationAt || "",
    currency: String(company?.subscriptionCurrency || rules.subscriptionCurrency || "USD"),
    autoRenew: rules.autoRenew ?? company?.autoRenew ?? true,
    activeBotName: activeCatalogItem?.name || plan.botClass,
    pricingSourceCompanyId: String(options?.pricingSourceCompanyId || rules?.botCatalogProviderId || company?.id || ""),
  };

  return { rules, plan, profile, catalog, prices, totalCatalogValue, avgPrice, maxPrice, subscription };
}

async function loadClientStateWithProvider(company) {
  const providerCompany = await getBotCatalogProviderCompany(company);
  const pricingSource = providerCompany || company;
  const priceCatalog = extractCatalogEntriesForCompany(pricingSource);
  return {
    state: extractClientState(company, {
      priceCatalog,
      pricingSourceCompanyId: pricingSource?.id || company?.id || "",
    }),
    pricingSourceCompany: pricingSource,
  };
}

function buildPriceChart(values) {
  const series = Array.isArray(values)
    ? values.filter((v) => Number.isFinite(v) && v > 0).slice(0, 8)
    : [];
  if (!series.length) {
    return `<div class="cp-empty">Sin datos de precios para graficar.</div>`;
  }

  const width = 680;
  const height = 220;
  const pad = 22;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const range = max - min || 1;
  const step = series.length === 1 ? 0 : (width - pad * 2) / (series.length - 1);

  const points = series.map((v, idx) => {
    const x = pad + step * idx;
    const y = height - pad - ((v - min) / range) * (height - pad * 2);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");

  const start = `${pad},${height - pad}`;
  const endX = (pad + step * (series.length - 1)).toFixed(2);
  const end = `${endX},${height - pad}`;
  const areaPoints = `${start} ${points} ${end}`;

  const grid = [0.2, 0.4, 0.6, 0.8].map((ratio) => {
    const y = (pad + (height - pad * 2) * ratio).toFixed(2);
    return `<line x1="${pad}" y1="${y}" x2="${width - pad}" y2="${y}" />`;
  }).join("");

  const labels = series.map((_, idx) => `<span>${idx + 1}</span>`).join("");

  return `
    <div class="cp-chart-wrap">
      <svg class="cp-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-label="Evolucion de precios">
        <g class="cp-chart-grid">${grid}</g>
        <polygon class="cp-chart-area" points="${areaPoints}" />
        <polyline class="cp-chart-line" points="${points}" />
      </svg>
      <div class="cp-chart-labels">${labels}</div>
    </div>
  `;
}

function renderClientPage({ company, active, title, subtitle, bodyHtml, dashboardAccess }) {
  const access = dashboardAccess || getDashboardAccessForCompany(company);
  const unreadNotifications = getClientUnreadNotificationCount(company);
  const rulesRaw = parseJsonSafe(company?.rulesJson || "{}", {});
  const rules = rulesRaw && typeof rulesRaw === "object" ? rulesRaw : {};
  const totalMessages = extractAdminInbox(rules).length;
  const messageCounterHtml = active === "inicio"
    ? `<div class="cp-msg-counter"><span>Contador de mensajes</span><b>${totalMessages}</b></div>`
    : "";
  const nav = [
    { key: "inicio", label: "Resumen", href: "/panel" },
    { key: "catalogo", label: "Catalogo", href: "/panel/catalogo" },
    { key: "pedidos", label: "Pedidos", href: "/panel/pedidos" },
    { key: "soporte", label: "Soporte", href: "/panel/soporte" },
    { key: "suscripcion", label: "Suscripcion", href: "/panel/suscripcion" },
    { key: "cuenta", label: "Cuenta", href: "/panel/cuenta" },
  ];

  const navHtml = nav.map((item) => {
    const allowed = canAccessClientSection(access, item.key);
    const classes = [
      "cp-nav-link",
      active === item.key ? "active" : "",
      allowed ? "" : "locked",
    ].filter(Boolean).join(" ");
    const lockHtml = allowed ? "" : `<span class="cp-nav-lock" aria-hidden="true">&#128274;</span>`;
    const href = allowed ? item.href : "#";
    const attrs = allowed ? "" : ` aria-disabled="true" tabindex="-1"`;
    return `
      <a class="${classes}" href="${href}"${attrs}>
        <span>${item.label}</span>
        ${lockHtml}
      </a>
    `;
  }).join("");

  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <link rel="stylesheet" href="/dashboard.css" />
      <title>${escapeHtml(title)}</title>
    </head>
    <body class="client-ui">
      <div class="cp-shell">
        <aside class="cp-sidebar">
          <div class="cp-brand">
            <img src="/img/logo.png" alt="BabySteps" onerror="this.style.display='none'" />
            <div>
              <div class="cp-brand-title">${escapeHtml(company?.name || company?.id || "Panel")}</div>
              <div class="cp-brand-sub">Panel de cliente</div>
            </div>
          </div>
          <nav class="cp-nav">${navHtml}</nav>
          <a class="cp-logout" href="/panel/logout">Salir</a>
        </aside>

        <main class="cp-main">
          <header class="cp-header">
            <div class="cp-header-copy">
              <h1>${escapeHtml(title)}</h1>
              <p>${escapeHtml(subtitle || "")}</p>
            </div>
            <div class="cp-header-actions">
              ${messageCounterHtml}
              ${renderNotificationBell({ href: "/panel/soporte#cp-inbox", count: unreadNotifications, className: "cp-notify-bell", title: "Mensajes y notificaciones" })}
              <div class="cp-header-visual" aria-hidden="true"></div>
            </div>
          </header>
          ${bodyHtml}
        </main>
      </div>
    </body>
  </html>`;
}

function normalizeDashboardMode(value) {
  const raw = String(value || "").trim().toLowerCase();
  return raw === "limited" ? "limited" : "full";
}

function extractDashboardAccessFromRules(rules) {
  const enabledRaw = rules?.dashboardEnabled;
  const mode = normalizeDashboardMode(rules?.dashboardMode);
  const enabled = enabledRaw === undefined ? true : !!enabledRaw;
  return { enabled, mode };
}

function getDashboardAccessForCompany(company) {
  const rulesRaw = parseJsonSafe(company?.rulesJson || "{}", {});
  const rules = rulesRaw && typeof rulesRaw === "object" ? rulesRaw : {};
  return extractDashboardAccessFromRules(rules);
}

function canAccessClientSection(dashboardAccess, sectionKey) {
  if (!dashboardAccess?.enabled) return false;
  if (dashboardAccess.mode !== "limited") return true;
  return ["catalogo", "suscripcion", "cuenta", "soporte"].includes(sectionKey);
}

function renderClientAccessDeniedPage({ company, sectionKey, dashboardAccess }) {
  const labelMap = {
    inicio: "Resumen",
    pedidos: "Pedidos",
    soporte: "Soporte",
    catalogo: "Catalogo",
    suscripcion: "Suscripcion",
    cuenta: "Cuenta",
  };
  const blockedLabel = labelMap[sectionKey] || "Esta seccion";
  const reason = dashboardAccess?.enabled
    ? "Esta cuenta tiene acceso limitado."
    : "El dashboard para esta empresa esta desactivado.";
  const bodyHtml = `
    <section class="cp-grid">
      <article class="cp-card cp-span-3">
        <h3>Acceso restringido</h3>
        <p class="cp-note">${escapeHtml(reason)}</p>
        <p class="cp-note">No puedes entrar a <b>${escapeHtml(blockedLabel)}</b> desde esta configuracion.</p>
      </article>
    </section>
  `;
  return renderClientPage({
    company,
    active: sectionKey,
    title: "Acceso restringido",
    subtitle: `${company?.name || company?.id || "Empresa"} - permisos del dashboard`,
    bodyHtml,
    dashboardAccess,
  });
}

function requireClientSectionAccess(sectionKey) {
  return (req, res, next) => {
    const dashboardAccess = getDashboardAccessForCompany(req.company);
    req.clientDashboardAccess = dashboardAccess;
    if (!canAccessClientSection(dashboardAccess, sectionKey)) {
      return res.status(403).type("text/html").send(
        renderClientAccessDeniedPage({ company: req.company, sectionKey, dashboardAccess })
      );
    }
    next();
  };
}

app.get("/panel/login", (req, res) => {
  res.type("text/html").send(renderClientLoginPage());
});
app.get("/c/login", (req, res) => {
  res.type("text/html").send(renderClientLoginPage());
});

app.get("/panel/forgot", (req, res) => {
  res.type("text/html").send(`
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <link rel="stylesheet" href="/dashboard.css" />
    <title>Recuperar acceso</title>
  </head>
  <body>
    <div class="bs-login">
      <div class="bs-bg" style="background-image:url('/img/login-tech-bg.png')"></div>
      <div class="bs-vignette"></div>
      <div class="bs-card">
        <div class="bs-brand">
          <div class="bs-dot"></div>
          <div>
            <div class="bs-title">BabySteps</div>
            <div class="bs-subtitle">Acceso clientes</div>
          </div>
        </div>
        <h2 class="bs-h2">Recuperar contrasena</h2>
        <p class="muted">Solicita restablecimiento al administrador desde el panel de admin o por soporte.</p>
        <div class="login-actions">
          <a class="btn secondary" href="/panel/login">Volver al login</a>
        </div>
      </div>
    </div>
  </body>
</html>
  `);
});
app.get("/c/forgot", (req, res) => res.redirect("/panel/forgot"));

app.post("/panel/login", handleClientLogin);
app.post("/c/login", handleClientLogin);

app.get("/panel", requireClientAuth, requireClientSectionAccess("inicio"), async (req, res) => {
  const company = req.company;
  const { state } = await loadClientStateWithProvider(company);
  const toHtmlText = (value) => escapeHtml(value).replace(/\r?\n/g, "<br/>");
  const profile = state.profile || {};
  const brandManual = String(
    state.rules?.brandManual ||
    state.rules?.brandGuide ||
    state.rules?.manualMarca ||
    state.rules?.manualDeMarca ||
    company.prompt ||
    ""
  ).trim();
  const companyPurpose = String(
    state.rules?.companyPurpose ||
    state.rules?.purpose ||
    state.rules?.objective ||
    state.rules?.objetivo ||
    state.rules?.goal ||
    ""
  ).trim();
  const bodyHtml = `
    <section class="cp-grid cp-overview-grid">
      <article class="cp-card cp-span-2">
        <details class="cp-company-details" open>
          <summary>
            <span>Informacion de la empresa</span>
            <span class="cp-details-hint">Click para expandir o contraer</span>
          </summary>
          <div class="cp-company-details-body">
            <div class="cp-info-grid">
              <div class="cp-mini-kv"><span>Empresa</span><b>${escapeHtml(company.name || company.id)}</b></div>
              <div class="cp-mini-kv"><span>ID</span><b>${escapeHtml(company.id)}</b></div>
              <div class="cp-mini-kv"><span>Responsable</span><b>${escapeHtml(profile.ownerName || "-")}</b></div>
              <div class="cp-mini-kv"><span>Email</span><b>${escapeHtml(profile.ownerEmail || "-")}</b></div>
              <div class="cp-mini-kv"><span>Telefono</span><b>${escapeHtml(profile.ownerPhone || "-")}</b></div>
              <div class="cp-mini-kv"><span>Ubicacion</span><b>${escapeHtml([profile.companyCity, profile.companyCountry].filter(Boolean).join(", ") || "-")}</b></div>
            </div>
            <div class="cp-info-stack">
              <div class="cp-info-block">
                <h4>Manual de marca</h4>
                <p>${brandManual ? toHtmlText(brandManual) : "No definido todavia."}</p>
              </div>
              <div class="cp-info-block">
                <h4>Objetivo / Proposito</h4>
                <p>${companyPurpose ? toHtmlText(companyPurpose) : "No definido todavia."}</p>
              </div>
            </div>
          </div>
        </details>
      </article>

      <article class="cp-card">
        <h3>Configuracion bot</h3>
        <div class="cp-bot-badges">
          <span class="cp-pill primary">${escapeHtml(state.plan.planLabel)}</span>
          <span class="cp-pill">${escapeHtml(state.plan.channelLabel)}</span>
          <span class="cp-pill">${escapeHtml(state.subscription.status)}</span>
        </div>
        <div class="cp-kv"><span>Empresa</span><b>${escapeHtml(company.id)}</b></div>
        <div class="cp-kv"><span>Clase bot</span><b>${escapeHtml(state.subscription.activeBotName || state.plan.botClass)}</b></div>
        <div class="cp-kv"><span>Canal principal</span><b>${escapeHtml(state.plan.channelLabel)}</b></div>
        <div class="cp-kv"><span>Precio</span><b>${formatMoney(state.subscription.amount, state.subscription.currency)}</b></div>
      </article>
    </section>
  `;

  res.type("text/html").send(renderClientPage({
    company,
    active: "inicio",
    title: "Overview",
    subtitle: `${company.name || company.id} - resumen operativo`,
    bodyHtml,
  }));
});

app.get("/panel/catalogo", requireClientAuth, requireClientSectionAccess("catalogo"), async (req, res) => {
  const company = req.company;
  const { state } = await loadClientStateWithProvider(company);
  const saved = String(req.query.saved || "") === "1";
  const errorMsg = String(req.query.error || "").trim();
  const rows = state.catalog.map((item) => `
    <tr>
      <td>${escapeHtml(item.id)}</td>
      <td>${escapeHtml(item.name)}</td>
      <td>${formatMoney(item.price, state.subscription.currency)}</td>
      <td>${escapeHtml(item.stock)}</td>
      <td>${escapeHtml(item.category)}</td>
    </tr>
  `).join("");
  const editorRows = state.catalog.map((item) => `
    <tr class="cp-edit-row">
      <td><input type="text" data-field="id" value="${escapeHtml(item.id)}" placeholder="ID" /></td>
      <td><input type="text" data-field="name" value="${escapeHtml(item.name)}" placeholder="Producto" /></td>
      <td><input type="number" step="0.01" min="0" data-field="price" value="${escapeHtml(String(item.price ?? 0))}" placeholder="0" /></td>
      <td><input type="text" data-field="stock" value="${escapeHtml(String(item.stock ?? "-"))}" placeholder="Stock" /></td>
      <td><input type="text" data-field="category" value="${escapeHtml(String(item.category ?? "-"))}" placeholder="Categoria" /></td>
      <td class="cp-edit-actions"><button class="cp-btn danger cp-row-remove" type="button">Quitar</button></td>
    </tr>
  `).join("");
  const initialCatalogJson = JSON.stringify(state.catalog.map((item, idx) => ({
    id: item.id || String(idx + 1),
    name: item.name || `Producto ${idx + 1}`,
    price: toNumber(item.price),
    stock: String(item.stock ?? "-"),
    category: String(item.category ?? "-"),
  })));

  const bodyHtml = `
    ${saved ? `<div class="cp-alert success">Catalogo actualizado correctamente.</div>` : ""}
    ${errorMsg ? `<div class="cp-alert error">${escapeHtml(errorMsg)}</div>` : ""}

    <section class="cp-stats">
      <article class="cp-stat"><div class="cp-stat-label">Productos</div><div class="cp-stat-value">${state.catalog.length}</div><div class="cp-stat-hint">registrados</div></article>
      <article class="cp-stat"><div class="cp-stat-label">Precio max</div><div class="cp-stat-value">${formatMoney(state.maxPrice, state.subscription.currency)}</div><div class="cp-stat-hint">tope actual</div></article>
      <article class="cp-stat"><div class="cp-stat-label">Precio promedio</div><div class="cp-stat-value">${formatMoney(state.avgPrice, state.subscription.currency)}</div><div class="cp-stat-hint">estimado</div></article>
      <article class="cp-stat"><div class="cp-stat-label">Valor total</div><div class="cp-stat-value">${formatMoney(state.totalCatalogValue, state.subscription.currency)}</div><div class="cp-stat-hint">sumatoria</div></article>
    </section>

    <section class="cp-grid">
      <article class="cp-card cp-span-3">
        <div class="cp-card-head">
          <h3>Catalogo completo</h3>
          <div class="cp-actions">
            <span>${state.catalog.length} filas</span>
            <a class="cp-btn" href="#editar-catalogo">Modificar catalogo</a>
          </div>
        </div>
        <table class="cp-table">
          <thead><tr><th>ID</th><th>Producto</th><th>Precio</th><th>Stock</th><th>Categoria</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="5">No hay productos cargados.</td></tr>`}</tbody>
        </table>
      </article>

      <article class="cp-card cp-span-3" id="editar-catalogo">
        <div class="cp-card-head"><h3>Editar catalogo (simple)</h3><span>Sin escribir JSON</span></div>
        <form id="catalogEditorForm" method="POST" action="/panel/catalogo/save" class="cp-form">
          <p class="cp-note">Edita los productos en tabla. Al guardar, el sistema lo convierte a JSON automaticamente.</p>
          <input id="catalogJsonInput" type="hidden" name="catalogJson" value="${escapeHtml(initialCatalogJson)}" />
          <div class="cp-table-wrap">
            <table class="cp-table cp-edit-table">
              <thead><tr><th>ID</th><th>Producto</th><th>Precio</th><th>Stock</th><th>Categoria</th><th>Accion</th></tr></thead>
              <tbody id="catalogEditorBody">${editorRows}</tbody>
            </table>
          </div>
          <div id="catalogEditorStatus" class="cp-note" aria-live="polite"></div>
          <div class="cp-actions">
            <button class="cp-btn" type="button" id="catalogAddRowBtn">Agregar producto</button>
            <span id="catalogEditorCount">${state.catalog.length} filas</span>
            <button class="cp-btn primary" type="submit">Guardar catalogo</button>
          </div>
          <noscript>
            <label>Modo sin JavaScript (Catalog JSON)</label>
            <textarea name="catalogJson" rows="10">${escapeHtml(company.catalogJson || "[]")}</textarea>
          </noscript>
        </form>
      </article>
    </section>

    <script>
      (function () {
        const form = document.getElementById("catalogEditorForm");
        const body = document.getElementById("catalogEditorBody");
        const hidden = document.getElementById("catalogJsonInput");
        const addBtn = document.getElementById("catalogAddRowBtn");
        const status = document.getElementById("catalogEditorStatus");
        const counter = document.getElementById("catalogEditorCount");
        if (!form || !body || !hidden || !addBtn || !status || !counter) return;

        function getRows() {
          return Array.from(body.querySelectorAll("tr"));
        }

        function setStatus(message, isError) {
          status.textContent = message || "";
          status.classList.toggle("error", !!isError);
        }

        function updateCount() {
          counter.textContent = getRows().length + " filas";
        }

        function addRow(data) {
          const row = document.createElement("tr");
          row.className = "cp-edit-row";
          row.innerHTML =
            '<td><input type="text" data-field="id" placeholder="ID" /></td>' +
            '<td><input type="text" data-field="name" placeholder="Producto" /></td>' +
            '<td><input type="number" step="0.01" min="0" data-field="price" placeholder="0" /></td>' +
            '<td><input type="text" data-field="stock" placeholder="Stock" /></td>' +
            '<td><input type="text" data-field="category" placeholder="Categoria" /></td>' +
            '<td class="cp-edit-actions"><button class="cp-btn danger cp-row-remove" type="button">Quitar</button></td>';
          body.appendChild(row);

          row.querySelector('[data-field="id"]').value = String(data?.id || "");
          row.querySelector('[data-field="name"]').value = String(data?.name || "");
          row.querySelector('[data-field="price"]').value = String(data?.price ?? "");
          row.querySelector('[data-field="stock"]').value = String(data?.stock || "");
          row.querySelector('[data-field="category"]').value = String(data?.category || "");
          updateCount();
        }

        function ensureAtLeastOneRow() {
          if (!getRows().length) {
            addRow({ id: "", name: "", price: "", stock: "", category: "" });
          }
        }

        function serializeRows() {
          const items = [];
          const rows = getRows();
          for (let idx = 0; idx < rows.length; idx += 1) {
            const row = rows[idx];
            const idRaw = String(row.querySelector('[data-field="id"]')?.value || "").trim();
            const nameRaw = String(row.querySelector('[data-field="name"]')?.value || "").trim();
            const priceRaw = String(row.querySelector('[data-field="price"]')?.value || "").trim();
            const stockRaw = String(row.querySelector('[data-field="stock"]')?.value || "").trim();
            const categoryRaw = String(row.querySelector('[data-field="category"]')?.value || "").trim();

            const hasData = idRaw || nameRaw || priceRaw || stockRaw || categoryRaw;
            if (!hasData) continue;

            const normalizedPrice = Number(priceRaw.replace(",", "."));
            if (!Number.isFinite(normalizedPrice) || normalizedPrice < 0) {
              throw new Error("Precio invalido en fila " + (idx + 1));
            }

            items.push({
              id: idRaw || String(items.length + 1),
              name: nameRaw || ("Producto " + (items.length + 1)),
              price: Math.round(normalizedPrice * 100) / 100,
              stock: stockRaw || "-",
              category: categoryRaw || "-",
            });
          }

          hidden.value = JSON.stringify(items);
          updateCount();
          return items;
        }

        function safeSerialize() {
          try {
            serializeRows();
            setStatus("", false);
          } catch (err) {
            setStatus(err?.message || String(err), true);
          }
        }

        body.addEventListener("click", (event) => {
          const target = event.target;
          if (!(target instanceof HTMLElement)) return;
          if (!target.classList.contains("cp-row-remove")) return;
          const row = target.closest("tr");
          if (row) row.remove();
          ensureAtLeastOneRow();
          safeSerialize();
        });

        body.addEventListener("input", () => {
          safeSerialize();
        });

        addBtn.addEventListener("click", () => {
          addRow({ id: "", name: "", price: "", stock: "", category: "" });
          safeSerialize();
        });

        form.addEventListener("submit", (event) => {
          try {
            const items = serializeRows();
            if (!items.length) setStatus("Se guardara un catalogo vacio.", false);
          } catch (err) {
            event.preventDefault();
            setStatus(err?.message || String(err), true);
          }
        });

        ensureAtLeastOneRow();
        safeSerialize();
      })();
    </script>
  `;

  res.type("text/html").send(renderClientPage({
    company,
    active: "catalogo",
    title: "Catalogo",
    subtitle: `${company.name || company.id} - gestion de productos`,
    bodyHtml,
  }));
});

app.post("/panel/catalogo/save", requireClientAuth, requireClientSectionAccess("catalogo"), async (req, res) => {
  const company = req.company;
  const id = company.id;
  const catalogJson = String(req.body.catalogJson || "[]");

  try {
    const parsed = JSON.parse(catalogJson);
    if (!Array.isArray(parsed)) throw new Error("catalogJson debe ser un array");

    await api(`/api/companies/${encodeURIComponent(id)}/save`, {
      method: "POST",
      body: {
        name: company.name || id,
        prompt: company.prompt || "",
        catalogJson,
        rulesJson: company.rulesJson || "{}",
      },
    });

    res.redirect("/panel/catalogo?saved=1");
  } catch (e) {
    res.redirect(`/panel/catalogo?error=${encodeURIComponent(e?.message || e)}`);
  }
});

app.get("/panel/pedidos", requireClientAuth, requireClientSectionAccess("pedidos"), async (req, res) => {
  const company = req.company;
  let orders = [];
  let fetchError = "";
  const updatedCategory = String(req.query.updatedCategory || "") === "1";
  const errorMsg = String(req.query.error || "").trim();
  const {
    selectedRange,
    selectedStatus,
    filterFrom,
    filterTo,
    rangeLabel,
    fromInput,
    toInput,
  } = parseClientOrdersFilters(req.query);

  try {
    orders = await fetchCompanyOrders(company.id, filterFrom, filterTo, 500);
  } catch (e) {
    fetchError = e?.message || String(e);
  }

  const ordersWithWorkflow = orders.map((order) => ({
    ...order,
    workflow: extractClientOrderWorkflow(order),
  }));

  const completedCount = ordersWithWorkflow.filter((order) => order.workflow.state === "completed").length;
  const pendingCount = ordersWithWorkflow.filter((order) => order.workflow.state === "pending").length;
  const rejectedCount = ordersWithWorkflow.filter((order) => order.workflow.state === "rejected").length;
  const archivedCount = ordersWithWorkflow.filter((order) => order.workflow.archived).length;

  const visibleOrders = selectedStatus === "all"
    ? ordersWithWorkflow.filter((order) => !order.workflow.archived)
    : selectedStatus === "archived"
      ? ordersWithWorkflow.filter((order) => order.workflow.archived)
      : ordersWithWorkflow.filter((order) => !order.workflow.archived && order.workflow.state === selectedStatus);

  const createdCount = ordersWithWorkflow.length;
  const closedCount = ordersWithWorkflow.filter((order) => ["completed", "rejected"].includes(order.workflow.state)).length;
  const closeRate = createdCount > 0 ? Math.round((closedCount / createdCount) * 100) : 0;
  const estimatedRevenue = ordersWithWorkflow.reduce((acc, order) => acc + toNumber(order.total), 0);
  const avgTicket = createdCount > 0 ? estimatedRevenue / createdCount : 0;

  const exportParams = new URLSearchParams();
  exportParams.set("range", selectedRange);
  exportParams.set("status", selectedStatus);
  if (fromInput) exportParams.set("from", fromInput);
  if (toInput) exportParams.set("to", toInput);
  const exportCsvHref = `/panel/pedidos/export?format=csv&${exportParams.toString()}`;
  const exportXlsxHref = `/panel/pedidos/export?format=xlsx&${exportParams.toString()}`;

  const rows = visibleOrders.map((order) => `
    <tr>
      <td>${escapeHtml(order.id || "-")}</td>
      <td>${escapeHtml(formatDateLabel(order.createdAt))}</td>
      <td>${escapeHtml(order.name || order.contact || "-")}</td>
      <td>${formatMoney(toNumber(order.total), "USD")}</td>
      <td>${escapeHtml(clientPaymentLabel(order))}</td>
      <td>${escapeHtml(clientPaymentMethodLabel(order))}</td>
      <td>
        <form method="POST" action="/panel/pedidos/category" class="cp-category-form">
          <input type="hidden" name="orderId" value="${escapeHtml(order.id || "")}" />
          <input type="hidden" name="range" value="${escapeHtml(selectedRange)}" />
          <input type="hidden" name="status" value="${escapeHtml(selectedStatus)}" />
          <input type="hidden" name="from" value="${escapeHtml(fromInput)}" />
          <input type="hidden" name="to" value="${escapeHtml(toInput)}" />
          <input type="hidden" name="archived" value="${order.workflow.archived ? "1" : "0"}" />
          <select name="state" class="cp-category-select cp-status-${escapeHtml(order.workflow.state)}" onchange="this.form.submit()">
            <option value="pending" ${order.workflow.state === "pending" ? "selected" : ""}>Pendiente</option>
            <option value="completed" ${order.workflow.state === "completed" ? "selected" : ""}>Completado</option>
            <option value="rejected" ${order.workflow.state === "rejected" ? "selected" : ""}>Rechazado</option>
          </select>
        </form>
      </td>
      <td>
        <form method="POST" action="/panel/pedidos/category" class="cp-archive-form">
          <input type="hidden" name="orderId" value="${escapeHtml(order.id || "")}" />
          <input type="hidden" name="range" value="${escapeHtml(selectedRange)}" />
          <input type="hidden" name="status" value="${escapeHtml(selectedStatus)}" />
          <input type="hidden" name="from" value="${escapeHtml(fromInput)}" />
          <input type="hidden" name="to" value="${escapeHtml(toInput)}" />
          <input type="hidden" name="state" value="${escapeHtml(order.workflow.state)}" />
          <input type="hidden" name="archived" value="${order.workflow.archived ? "1" : "0"}" class="cp-archive-hidden" />
          <label class="cp-archive-toggle">
            <input type="checkbox" class="cp-archive-checkbox" ${order.workflow.archived ? "checked" : ""} />
            <span>${order.workflow.archived ? "Si" : "No"}</span>
          </label>
        </form>
      </td>
    </tr>
  `).join("");

  const bodyHtml = `
    ${updatedCategory ? `<div class="cp-alert success">Estado de pedido actualizado.</div>` : ""}
    ${errorMsg ? `<div class="cp-alert error">${escapeHtml(errorMsg)}</div>` : ""}
    <section class="cp-stats">
      <article class="cp-stat"><div class="cp-stat-label">Pedidos creados</div><div class="cp-stat-value">${createdCount}</div><div class="cp-stat-hint">${escapeHtml(rangeLabel)}</div></article>
      <article class="cp-stat"><div class="cp-stat-label">Pedidos pendientes</div><div class="cp-stat-value">${pendingCount}</div><div class="cp-stat-hint">en proceso</div></article>
      <article class="cp-stat"><div class="cp-stat-label">Pedidos completados</div><div class="cp-stat-value">${completedCount}</div><div class="cp-stat-hint">entregados/finalizados</div></article>
      <article class="cp-stat"><div class="cp-stat-label">Pedidos cerrados</div><div class="cp-stat-value">${closedCount}</div><div class="cp-stat-hint">completados + rechazados</div></article>
      <article class="cp-stat"><div class="cp-stat-label">Pedidos rechazados</div><div class="cp-stat-value">${rejectedCount}</div><div class="cp-stat-hint">cancelados</div></article>
      <article class="cp-stat"><div class="cp-stat-label">Pedidos archivados</div><div class="cp-stat-value">${archivedCount}</div><div class="cp-stat-hint">fuera de gestion activa</div></article>
      <article class="cp-stat"><div class="cp-stat-label">Tasa de cierre</div><div class="cp-stat-value">${closeRate}%</div><div class="cp-stat-hint">sobre pedidos creados</div></article>
      <article class="cp-stat"><div class="cp-stat-label">Ticket promedio</div><div class="cp-stat-value">${formatMoney(avgTicket, "USD")}</div><div class="cp-stat-hint">valor medio por pedido</div></article>
    </section>

    <section class="cp-grid">
      <article class="cp-card cp-span-3">
        <div class="cp-card-head"><h3>Filtros</h3><span>${escapeHtml(rangeLabel)}</span></div>
        <form method="GET" action="/panel/pedidos" class="cp-form">
          <div class="cp-grid-2">
            <div>
              <label>Periodo</label>
              <select id="ordersRangeSelect" name="range">
                <option value="today" ${selectedRange === "today" ? "selected" : ""}>Del dia</option>
                <option value="week" ${selectedRange === "week" ? "selected" : ""}>De la semana</option>
                <option value="month" ${selectedRange === "month" ? "selected" : ""}>Ultimo mes</option>
                <option value="3months" ${selectedRange === "3months" ? "selected" : ""}>Ultimos 3 meses</option>
                <option value="custom" ${selectedRange === "custom" ? "selected" : ""}>Personalizado</option>
              </select>
            </div>
            <div>
              <label>Estado</label>
              <select name="status">
                <option value="all" ${selectedStatus === "all" ? "selected" : ""}>Todas</option>
                <option value="completed" ${selectedStatus === "completed" ? "selected" : ""}>Completados</option>
                <option value="pending" ${selectedStatus === "pending" ? "selected" : ""}>Pendientes</option>
                <option value="rejected" ${selectedStatus === "rejected" ? "selected" : ""}>Rechazados</option>
                <option value="archived" ${selectedStatus === "archived" ? "selected" : ""}>Archivados</option>
              </select>
            </div>
          </div>

          <div id="ordersCustomRange" class="cp-grid-2 ${selectedRange === "custom" ? "" : "cp-hidden"}">
            <div>
              <label>Desde</label>
              <input type="date" name="from" value="${escapeHtml(fromInput)}" />
            </div>
            <div>
              <label>Hasta</label>
              <input type="date" name="to" value="${escapeHtml(toInput)}" />
            </div>
          </div>

          <div class="cp-actions">
            <button class="cp-btn primary" type="submit">Aplicar filtros</button>
            <a class="cp-btn" href="/panel/pedidos">Limpiar</a>
            <a class="cp-btn" href="${exportCsvHref}">Exportar CSV</a>
            <a class="cp-btn" href="${exportXlsxHref}">Exportar XLSX</a>
          </div>
        </form>
      </article>

      <article class="cp-card cp-span-3">
        <div class="cp-card-head"><h3>Listado de pedidos</h3><span>${visibleOrders.length} resultados</span></div>
        ${fetchError ? `<div class="cp-empty">No se pudo cargar pedidos: ${escapeHtml(fetchError)}</div>` : ""}
        <table class="cp-table">
          <thead><tr><th>ID</th><th>Fecha</th><th>Cliente</th><th>Total</th><th>Pago</th><th>Medio de pago</th><th>Estado</th><th>Archivado</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="8">Sin pedidos para este filtro.</td></tr>`}</tbody>
        </table>
      </article>

    </section>
    <script>
      (() => {
        const range = document.getElementById("ordersRangeSelect");
        const custom = document.getElementById("ordersCustomRange");
        if (!range || !custom) return;
        const sync = () => {
          if (range.value === "custom") custom.classList.remove("cp-hidden");
          else custom.classList.add("cp-hidden");
        };
        range.addEventListener("change", sync);
        sync();

        const archiveForms = Array.from(document.querySelectorAll(".cp-archive-form"));
        archiveForms.forEach((form) => {
          const checkbox = form.querySelector(".cp-archive-checkbox");
          const hidden = form.querySelector(".cp-archive-hidden");
          const label = form.querySelector(".cp-archive-toggle span");
          if (!checkbox || !hidden || !label) return;
          checkbox.addEventListener("change", () => {
            hidden.value = checkbox.checked ? "1" : "0";
            label.textContent = checkbox.checked ? "Si" : "No";
            form.submit();
          });
        });
      })();
    </script>
  `;

  res.type("text/html").send(renderClientPage({
    company,
    active: "pedidos",
    title: "Pedidos",
    subtitle: `${company.name || company.id} - seguimiento operativo`,
    bodyHtml,
  }));
});

app.post("/panel/pedidos/category", requireClientAuth, requireClientSectionAccess("pedidos"), async (req, res) => {
  const company = req.company;
  const orderId = String(req.body.orderId || "").trim();
  const rawState = String(req.body.state || req.body.category || "").trim().toLowerCase();
  const normalizedState = normalizeClientOrderState(rawState);
  const state = ["pending", "completed", "rejected"].includes(normalizedState) ? normalizedState : "";
  const archived = String(req.body.archived || "").trim() === "1";
  const category = state ? (archived ? `archived:${state}` : state) : "";

  const redirectParams = new URLSearchParams();
  const range = String(req.body.range || "").trim();
  const status = String(req.body.status || "").trim();
  const from = String(req.body.from || "").trim();
  const to = String(req.body.to || "").trim();
  if (range) redirectParams.set("range", range);
  if (status) redirectParams.set("status", status);
  if (from) redirectParams.set("from", from);
  if (to) redirectParams.set("to", to);

  const redirectBase = () => {
    const query = redirectParams.toString();
    return query ? `/panel/pedidos?${query}` : "/panel/pedidos";
  };

  if (!orderId || !category) {
    const next = redirectBase();
    return res.redirect(`${next}${next.includes("?") ? "&" : "?"}error=${encodeURIComponent("Datos invalidos para actualizar pedido")}`);
  }

  try {
    const params = new URLSearchParams();
    params.set("companyId", String(company.id));
    params.set("q", orderId);
    params.set("limit", "25");
    const orders = await api(`/api/orders?${params.toString()}`);
    const match = (Array.isArray(orders) ? orders : []).find((item) => String(item.id || "") === orderId);
    if (!match) throw new Error("El pedido no pertenece a esta empresa");

    await api(`/api/orders/${encodeURIComponent(orderId)}/category`, {
      method: "POST",
      body: { state, archived: archived ? 1 : 0, category },
    });

    const next = redirectBase();
    return res.redirect(`${next}${next.includes("?") ? "&" : "?"}updatedCategory=1`);
  } catch (e) {
    const next = redirectBase();
    return res.redirect(`${next}${next.includes("?") ? "&" : "?"}error=${encodeURIComponent(e?.message || e)}`);
  }
});

app.get("/panel/soporte", requireClientAuth, requireClientSectionAccess("soporte"), async (req, res) => {
  const company = req.company;
  const messageSent = String(req.query.messageSent || "") === "1";
  const errorMsg = String(req.query.error || "").trim();
  const toHtmlText = (value) => escapeHtml(value || "").replace(/\r?\n/g, "<br/>");
  try {
    const currentCompany = await api(`/api/companies/${encodeURIComponent(company.id)}`);
    const rulesRaw = parseJsonSafe(currentCompany.rulesJson || "{}", {});
    const rules = rulesRaw && typeof rulesRaw === "object" ? rulesRaw : {};
    let inbox = extractAdminInbox(rules);

    const hasUnreadAdminMessages = inbox.some((item) => item.sender === "admin" && !item.readByClient);
    if (hasUnreadAdminMessages) {
      inbox = inbox.map((item) => (item.sender === "admin" ? { ...item, readByClient: true } : item));
      setAdminInbox(rules, inbox);
      try {
        await saveCompanyRules(currentCompany, rules);
        currentCompany.rulesJson = JSON.stringify(rules);
      } catch {
        // no-op: keep rendering support even if read tracking fails
      }
    }

    const openCount = inbox.filter((item) => item.status === "open").length;
    const resolvedCount = inbox.filter((item) => item.status === "resolved").length;
    const unreadCount = inbox.filter((item) => item.sender === "admin" && !item.readByClient).length;
    const inboxRows = inbox
      .slice()
      .reverse()
      .map((item) => `
        <article class="cp-msg-item ${item.sender === "admin" ? "from-admin" : "from-client"}">
          <div class="cp-msg-head">
            <span class="cp-msg-who">${item.sender === "admin" ? "Admin" : "Empresa"}</span>
            <span class="cp-msg-date">${escapeHtml(formatDateLabel(item.createdAt))}</span>
            <span class="cp-msg-state ${item.status === "resolved" ? "resolved" : "open"}">${item.status === "resolved" ? "Resuelto" : "Abierto"}</span>
            ${item.orderId ? `<span class="cp-msg-order">Pedido: ${escapeHtml(item.orderId)}</span>` : ""}
          </div>
          <p class="cp-msg-text">${toHtmlText(item.text)}</p>
        </article>
      `)
      .join("");

    const bodyHtml = `
      ${messageSent ? `<div class="cp-alert success">Mensaje enviado al admin.</div>` : ""}
      ${errorMsg ? `<div class="cp-alert error">${escapeHtml(errorMsg)}</div>` : ""}
      <section class="cp-stats">
        <article class="cp-stat"><div class="cp-stat-label">Mensajes</div><div class="cp-stat-value">${inbox.length}</div><div class="cp-stat-hint">total historial</div></article>
        <article class="cp-stat"><div class="cp-stat-label">Abiertos</div><div class="cp-stat-value">${openCount}</div><div class="cp-stat-hint">pendientes de gestion</div></article>
        <article class="cp-stat"><div class="cp-stat-label">Resueltos</div><div class="cp-stat-value">${resolvedCount}</div><div class="cp-stat-hint">cerrados</div></article>
        <article class="cp-stat"><div class="cp-stat-label">Sin leer</div><div class="cp-stat-value">${unreadCount}</div><div class="cp-stat-hint">respuestas del admin</div></article>
      </section>

      <section class="cp-grid">
        <article class="cp-card cp-span-3" id="cp-inbox">
          <div class="cp-card-head"><h3>Soporte con admin</h3><span>${inbox.length} mensajes</span></div>
          <form method="POST" action="/panel/soporte/messages" class="cp-form">
            <div class="cp-grid-2">
              <div>
                <label>Pedido relacionado (opcional)</label>
                <input name="orderId" placeholder="Ej: PED-123ABC" />
              </div>
              <div>
                <label>Estado del tema</label>
                <select name="statusMessage">
                  <option value="open">Abierto</option>
                  <option value="resolved">Resuelto</option>
                </select>
              </div>
            </div>
            <label>Mensaje para soporte</label>
            <textarea name="messageText" rows="3" maxlength="1000" placeholder="Describe tu consulta, incidencia o solicitud"></textarea>
            <div class="cp-actions">
              <button class="cp-btn primary" type="submit">Enviar a soporte</button>
            </div>
          </form>
          <div class="cp-msg-list">
            ${inboxRows || `<div class="cp-empty">Sin mensajes todavia.</div>`}
          </div>
        </article>
      </section>
    `;

    return res.type("text/html").send(renderClientPage({
      company: currentCompany,
      active: "soporte",
      title: "Soporte",
      subtitle: `${currentCompany.name || currentCompany.id} - comunicacion con admin`,
      bodyHtml,
    }));
  } catch (e) {
    return res.status(500).send(`No se pudo cargar soporte: ${escapeHtml(e?.message || e)}`);
  }
});

app.post("/panel/soporte/messages", requireClientAuth, requireClientSectionAccess("soporte"), async (req, res) => {
  const company = req.company;
  const id = String(company?.id || "").trim();
  const messageText = String(req.body.messageText || "").trim();
  const orderId = String(req.body.orderId || "").trim();
  const statusRaw = String(req.body.statusMessage || "").trim().toLowerCase();
  const status = statusRaw === "resolved" ? "resolved" : "open";

  if (!messageText) {
    return res.redirect(`/panel/soporte?error=${encodeURIComponent("Escribe un mensaje antes de enviar")}#cp-inbox`);
  }

  if (messageText.length > 1000) {
    return res.redirect(`/panel/soporte?error=${encodeURIComponent("El mensaje supera 1000 caracteres")}#cp-inbox`);
  }

  try {
    const currentCompany = await api(`/api/companies/${encodeURIComponent(id)}`);
    const rulesRaw = parseJsonSafe(currentCompany.rulesJson || "{}", {});
    const rules = rulesRaw && typeof rulesRaw === "object" ? rulesRaw : {};
    const inbox = extractAdminInbox(rules);

    inbox.push({
      id: createInboxMessageId(),
      sender: "client",
      text: messageText,
      orderId,
      createdAt: new Date().toISOString(),
      status,
      readByAdmin: false,
      readByClient: true,
    });

    setAdminInbox(rules, inbox);
    await saveCompanyRules(currentCompany, rules);

    return res.redirect("/panel/soporte?messageSent=1#cp-inbox");
  } catch (e) {
    return res.redirect(`/panel/soporte?error=${encodeURIComponent(e?.message || e)}#cp-inbox`);
  }
});

app.post("/panel/pedidos/messages", requireClientAuth, async (req, res) => {
  return res.redirect("/panel/soporte");
});

app.get("/panel/pedidos/export", requireClientAuth, requireClientSectionAccess("pedidos"), async (req, res) => {
  const company = req.company;
  const format = String(req.query.format || "csv").trim().toLowerCase();
  const {
    selectedStatus,
    filterFrom,
    filterTo,
  } = parseClientOrdersFilters(req.query);

  try {
    const orders = await fetchCompanyOrders(company.id, filterFrom, filterTo, 5000);
    const ordersWithWorkflow = orders.map((order) => ({
      ...order,
      workflow: extractClientOrderWorkflow(order),
    }));
    const visibleOrders = selectedStatus === "all"
      ? ordersWithWorkflow.filter((order) => !order.workflow.archived)
      : selectedStatus === "archived"
        ? ordersWithWorkflow.filter((order) => order.workflow.archived)
        : ordersWithWorkflow.filter((order) => !order.workflow.archived && order.workflow.state === selectedStatus);

    const exportRows = visibleOrders.map((order) => ({
      ID: String(order.id || ""),
      Fecha: formatDateLabel(order.createdAt),
      Cliente: String(order.name || order.contact || "-"),
      Total: toNumber(order.total),
      Pago: clientPaymentLabel(order),
      "Medio de pago": clientPaymentMethodLabel(order),
      Estado: clientOrderCategoryLabel(order.workflow.state),
      Archivado: order.workflow.archived ? "Si" : "No",
    }));

    const dateStamp = new Date().toISOString().slice(0, 10);
    if (format === "xlsx") {
      const sheet = XLSX.utils.json_to_sheet(exportRows);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, sheet, "Pedidos");
      const xlsxBuffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename=\"pedidos_${company.id}_${dateStamp}.xlsx\"`);
      return res.send(xlsxBuffer);
    }

    const csvHeaders = ["ID", "Fecha", "Cliente", "Total", "Pago", "Medio de pago", "Estado", "Archivado"];
    const csvRows = exportRows.map((row) => [
      row.ID,
      row.Fecha,
      row.Cliente,
      row.Total,
      row.Pago,
      row["Medio de pago"],
      row.Estado,
      row.Archivado,
    ]);
    const csv = toCsvRows(csvHeaders, csvRows);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=\"pedidos_${company.id}_${dateStamp}.csv\"`);
    return res.send(csv);
  } catch (e) {
    return res.status(500).send(`No se pudo exportar pedidos: ${escapeHtml(e?.message || e)}`);
  }
});

app.get("/panel/suscripcion", requireClientAuth, requireClientSectionAccess("suscripcion"), async (req, res) => {
  const company = req.company;
  const { state } = await loadClientStateWithProvider(company);
  const requested = String(req.query.requested || "") === "1";
  const errorMsg = String(req.query.error || "").trim();
  const action = String(req.query.action || "").trim().toLowerCase();
  const actionLabel = action === "upgrade"
    ? "Upgrade"
    : action === "downgrade"
      ? "Downgrade"
      : action === "cancel"
        ? "Cancelacion"
        : "Actualizacion";

  const bodyHtml = `
    ${requested ? `<div class="cp-alert success">Solicitud de ${escapeHtml(actionLabel)} enviada al admin para revision.</div>` : ""}
    ${errorMsg ? `<div class="cp-alert error">${escapeHtml(errorMsg)}</div>` : ""}
    <section class="cp-stats">
      <article class="cp-stat"><div class="cp-stat-label">Plan</div><div class="cp-stat-value">${escapeHtml(state.plan.planLabel)}</div><div class="cp-stat-hint">actual</div></article>
      <article class="cp-stat"><div class="cp-stat-label">Canales</div><div class="cp-stat-value">${escapeHtml(state.plan.channelLabel)}</div><div class="cp-stat-hint">activos</div></article>
      <article class="cp-stat"><div class="cp-stat-label">Clase bot</div><div class="cp-stat-value">${escapeHtml(state.plan.botClass)}</div><div class="cp-stat-hint">asignada</div></article>
      <article class="cp-stat"><div class="cp-stat-label">Estado</div><div class="cp-stat-value">${escapeHtml(state.subscription.status)}</div><div class="cp-stat-hint">cuenta</div></article>
      <article class="cp-stat"><div class="cp-stat-label">Monto actual</div><div class="cp-stat-value">${formatMoney(state.subscription.amount, state.subscription.currency)}</div><div class="cp-stat-hint">${escapeHtml(state.subscription.cycle)}</div></article>
      <article class="cp-stat"><div class="cp-stat-label">Cobro siguiente</div><div class="cp-stat-value">${formatMoney(state.subscription.nextAmount, state.subscription.currency)}</div><div class="cp-stat-hint">${escapeHtml(formatDateLabel(state.subscription.renewalAt))}</div></article>
    </section>

    <section class="cp-grid">
      <article class="cp-card cp-span-2">
        <h3>Detalle de suscripcion</h3>
        <div class="cp-kv"><span>Tipo de bot</span><b>${escapeHtml(state.plan.planLabel)}</b></div>
        <div class="cp-kv"><span>Canales</span><b>${escapeHtml(state.plan.channelLabel)}</b></div>
        <div class="cp-kv"><span>Clase asignada</span><b>${escapeHtml(state.plan.botClass)}</b></div>
        <div class="cp-kv"><span>Fuente de precios</span><b>${escapeHtml(state.subscription.pricingSourceCompanyId || "-")}</b></div>
        <div class="cp-kv"><span>Estado</span><b>${escapeHtml(state.subscription.status)}</b></div>
        <div class="cp-kv"><span>Inicio plan en curso</span><b>${escapeHtml(formatDateLabel(state.subscription.startAt))}</b></div>
        <div class="cp-kv"><span>Fin plan en curso</span><b>${escapeHtml(formatDateLabel(state.subscription.endAt))}</b></div>
        <div class="cp-kv"><span>Ciclo</span><b>${escapeHtml(state.subscription.cycle)}</b></div>
        <div class="cp-kv"><span>Monto</span><b>${formatMoney(state.subscription.amount, state.subscription.currency)}</b></div>
        <div class="cp-kv"><span>Cobro mes siguiente</span><b>${formatMoney(state.subscription.nextAmount, state.subscription.currency)}</b></div>
        <div class="cp-kv"><span>Prorrateo upgrade</span><b>${formatMoney(state.subscription.prorationDueNow, state.subscription.currency)}</b></div>
        <div class="cp-kv"><span>Proxima fecha</span><b>${escapeHtml(formatDateLabel(state.subscription.renewalAt))}</b></div>
        <div class="cp-kv"><span>Renovacion</span><b>${state.subscription.autoRenew ? "Automatica" : "Manual"}</b></div>
        <p class="cp-note" style="margin-top:10px">Los botones envian una solicitud al admin. El cambio se aplica cuando el admin lo confirme.</p>
        <div class="cp-actions" style="margin-top:12px">
          <form method="POST" action="/panel/suscripcion/action">
            <input type="hidden" name="action" value="downgrade" />
            <button class="cp-btn" type="submit">Downgrade</button>
          </form>
          <form method="POST" action="/panel/suscripcion/action">
            <input type="hidden" name="action" value="upgrade" />
            <button class="cp-btn primary" type="submit">Upgrade</button>
          </form>
          <form method="POST" action="/panel/suscripcion/action" onsubmit="return confirm('Se cancelara la suscripcion. Continuar?')">
            <input type="hidden" name="action" value="cancel" />
            <button class="cp-btn danger" type="submit">Cancelar suscripcion</button>
          </form>
        </div>
      </article>

      <article class="cp-card">
        <h3>Bot y servicio</h3>
        <div class="cp-kv"><span>Derivacion humana</span><b>${state.rules.allowHuman ? "Activa" : "Inactiva"}</b></div>
        <div class="cp-kv"><span>Tono</span><b>${escapeHtml(state.rules.tone || "No definido")}</b></div>
        <div class="cp-kv"><span>Productos</span><b>${state.catalog.length}</b></div>
        <div class="cp-kv"><span>Ultima actualizacion</span><b>${escapeHtml(formatDateLabel(company.updatedAt || company.createdAt))}</b></div>
      </article>
    </section>
  `;

  res.type("text/html").send(renderClientPage({
    company,
    active: "suscripcion",
    title: "Suscripcion",
    subtitle: `${company.name || company.id} - estado del plan`,
    bodyHtml,
  }));
});

app.post("/panel/suscripcion/action", requireClientAuth, requireClientSectionAccess("suscripcion"), async (req, res) => {
  const company = req.company;
  const action = String(req.body.action || "").trim().toLowerCase();
  if (!["upgrade", "downgrade", "cancel"].includes(action)) {
    return res.redirect("/panel/suscripcion");
  }

  try {
    const currentCompany = await api(`/api/companies/${encodeURIComponent(company.id)}`);
    const rulesRaw = parseJsonSafe(currentCompany.rulesJson || "{}", {});
    const rules = rulesRaw && typeof rulesRaw === "object" ? rulesRaw : {};
    const { state } = await loadClientStateWithProvider(currentCompany);
    const inbox = extractAdminInbox(rules);
    const actionLabel = action === "upgrade"
      ? "upgrade"
      : action === "downgrade"
        ? "downgrade"
        : "cancelacion";
    const supportText = [
      `[Solicitud de suscripcion]`,
      `Empresa: ${currentCompany.name || currentCompany.id} (${currentCompany.id})`,
      `Accion solicitada: ${actionLabel}`,
      `Plan actual: ${state.plan.fullLabel}`,
      `Clase bot actual: ${state.plan.botClass}`,
      `Monto actual: ${formatMoney(state.subscription.amount, state.subscription.currency)}`,
      `Cobro siguiente: ${formatMoney(state.subscription.nextAmount, state.subscription.currency)}`,
      `Fecha solicitud: ${new Date().toISOString()}`,
    ].join("\n");

    inbox.push({
      id: createInboxMessageId(),
      sender: "client",
      text: supportText,
      orderId: "subscription",
      createdAt: new Date().toISOString(),
      status: "open",
      readByAdmin: false,
      readByClient: true,
    });
    rules.lastSubscriptionRequestAt = new Date().toISOString();
    rules.lastSubscriptionRequestType = action;
    setAdminInbox(rules, inbox);
    await saveCompanyRules(currentCompany, rules);

    res.redirect(`/panel/suscripcion?requested=1&action=${encodeURIComponent(action)}`);
  } catch (e) {
    res.redirect(`/panel/suscripcion?error=${encodeURIComponent(e?.message || e)}`);
  }
});

app.get("/panel/cuenta", requireClientAuth, requireClientSectionAccess("cuenta"), async (req, res) => {
  const company = req.company;
  const { state } = await loadClientStateWithProvider(company);
  const saved = String(req.query.saved || "") === "1";
  const errorMsg = String(req.query.error || "").trim();

  const bodyHtml = `
    ${saved ? `<div class="cp-alert success">Datos de cuenta actualizados.</div>` : ""}
    ${errorMsg ? `<div class="cp-alert error">${escapeHtml(errorMsg)}</div>` : ""}

    <section class="cp-grid">
      <article class="cp-card cp-span-2">
        <div class="cp-card-head"><h3>Datos de cuenta</h3><span>${escapeHtml(company.id)}</span></div>
        <form method="POST" action="/panel/cuenta/save" class="cp-form">
          <label>Nombre del responsable</label>
          <input name="ownerName" value="${escapeHtml(state.profile.ownerName)}" />

          <label>Cargo</label>
          <input name="ownerRole" value="${escapeHtml(state.profile.ownerRole)}" />

          <div class="cp-grid-2">
            <div>
              <label>Email</label>
              <input name="ownerEmail" value="${escapeHtml(state.profile.ownerEmail)}" />
            </div>
            <div>
              <label>Telefono</label>
              <input name="ownerPhone" value="${escapeHtml(state.profile.ownerPhone)}" />
            </div>
          </div>

          <label>Direccion</label>
          <input name="companyAddress" value="${escapeHtml(state.profile.companyAddress)}" />

          <div class="cp-grid-2">
            <div>
              <label>Ciudad</label>
              <input name="companyCity" value="${escapeHtml(state.profile.companyCity)}" />
            </div>
            <div>
              <label>Pais</label>
              <input name="companyCountry" value="${escapeHtml(state.profile.companyCountry)}" />
            </div>
          </div>

          <label>Nueva contrasena de acceso (opcional)</label>
          <input name="clientPassword" type="password" placeholder="Dejar vacio para no cambiar" />

          <div class="cp-actions">
            <button class="cp-btn primary" type="submit">Guardar datos</button>
          </div>
        </form>
      </article>

      <article class="cp-card">
        <h3>Plan activo</h3>
        <div class="cp-kv"><span>Tipo</span><b>${escapeHtml(state.plan.planLabel)}</b></div>
        <div class="cp-kv"><span>Canal</span><b>${escapeHtml(state.plan.channelLabel)}</b></div>
        <div class="cp-kv"><span>Clase bot</span><b>${escapeHtml(state.plan.botClass)}</b></div>
        <div class="cp-kv"><span>Estado</span><b>${escapeHtml(state.subscription.status)}</b></div>
        <div class="cp-kv"><span>Renueva</span><b>${escapeHtml(formatDateLabel(state.subscription.renewalAt))}</b></div>
      </article>
    </section>
  `;

  res.type("text/html").send(renderClientPage({
    company,
    active: "cuenta",
    title: "Cuenta",
    subtitle: `${company.name || company.id} - datos personales y acceso`,
    bodyHtml,
  }));
});

app.post("/panel/cuenta/save", requireClientAuth, requireClientSectionAccess("cuenta"), async (req, res) => {
  const company = req.company;
  const id = company.id;
  const currentRules = parseJsonSafe(company.rulesJson || "{}", {});
  const rules = currentRules && typeof currentRules === "object" ? currentRules : {};

  rules.ownerName = String(req.body.ownerName || "").trim();
  rules.ownerRole = String(req.body.ownerRole || "").trim();
  rules.ownerEmail = String(req.body.ownerEmail || "").trim();
  rules.ownerPhone = String(req.body.ownerPhone || "").trim();
  rules.companyAddress = String(req.body.companyAddress || "").trim();
  rules.companyCity = String(req.body.companyCity || "").trim();
  rules.companyCountry = String(req.body.companyCountry || "").trim();

  const newPassword = String(req.body.clientPassword || "").trim();
  if (newPassword) {
    assignClientPassword(rules, newPassword);
  }

  try {
    await api(`/api/companies/${encodeURIComponent(id)}/save`, {
      method: "POST",
      body: {
        name: company.name || id,
        prompt: company.prompt || "",
        catalogJson: company.catalogJson || "[]",
        rulesJson: JSON.stringify(rules),
      },
    });

    res.redirect("/panel/cuenta?saved=1");
  } catch (e) {
    res.redirect(`/panel/cuenta?error=${encodeURIComponent(e?.message || e)}`);
  }
});

app.get("/panel/logout", (req, res) => {
  clearCookie(res, "client");
  res.redirect("/panel/login");
});

app.get("/", (_, res) => res.send("OK"));
app.get("/__whoami", (req, res) => {
  res.json({
    bootFile: import.meta.url,
    pwd: process.cwd(),
    node: process.version,
    hasPostAdminLogin: typeof app?._router?.stack?.some?.(
      (l) => l?.route?.path === "/admin/login" && l?.route?.methods?.post
    ) === "boolean" ? "unknown" : "unknown"
  });
});

app.get("/__routes", (req, res) => {
  function extractRoutes(router) {
    const stack = router?.stack || [];
    const routes = [];

    for (const layer of stack) {
      // En algunos casos hay sub-routers
      if (layer?.handle?.stack) {
        routes.push(...extractRoutes(layer.handle));
      }

      if (!layer.route) continue;
      const path = layer.route.path;
      const methods = Object.keys(layer.route.methods || {})
        .filter((m) => layer.route.methods[m])
        .map((m) => m.toUpperCase());
      routes.push({ path, methods });
    }

    return routes;
  }

  const r1 = extractRoutes(app._router);
  const r2 = extractRoutes(app.router);

  const info = {
    expressRouterKeys: {
      has_app__router: !!app._router,
      app__router_stack_len: app._router?.stack?.length ?? null,
      has_app_router: !!app.router,
      app_router_stack_len: app.router?.stack?.length ?? null,
    },
    routes: [...r1, ...r2]
      .filter((x, i, a) => a.findIndex(y => y.path === x.path && y.methods.join(",") === x.methods.join(",")) === i)
      .sort((a, b) => (a.path > b.path ? 1 : -1)),
  };

  info.count = info.routes.length;
  res.json(info);
});

app.listen(process.env.PORT || 3000, () => console.log("Dashboard running"));

