import express from "express";
import dotenv from "dotenv";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import * as XLSX from "xlsx";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { dashboardDb } from "./db.js";

dotenv.config();

// ================= EMAIL =================
const RESEND_API_KEY = (process.env.RESEND_API_KEY || "").trim();
const EMAIL_FROM = (process.env.EMAIL_FROM || "Bot <no-reply@resend.dev>").trim();

async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) {
    console.log("[email] RESEND_API_KEY no configurado — email omitido");
    return { ok: false };
  }
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) console.error("[email] Resend error:", r.status, data?.message);
    return { ok: r.ok, id: data?.id };
  } catch (e) {
    console.error("[email] sendEmail failed:", e?.message || e);
    return { ok: false };
  }
}

const app = express();
app.use(express.urlencoded({ extended: false, limit: "10mb" }));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, "public")));

// ===== Compat: alias legado (/c) al panel cliente real (/panel) =====
app.get("/c", (req, res) => res.redirect("/panel"));
app.get("/c/logout", (req, res) => res.redirect("/panel/logout"));
app.get("/c/catalogo", (req, res) => res.redirect("/panel/catalogo"));
app.get("/c/pedidos", (req, res) => res.redirect("/panel/pedidos"));
app.get("/c/pedidos/export", (req, res) => res.redirect("/panel/pedidos/export"));
app.get("/c/soporte", (req, res) => res.redirect("/panel/soporte"));
app.get("/c/conversaciones", (req, res) => res.redirect("/panel/conversaciones"));
app.get("/c/integraciones", (req, res) => res.redirect("/panel/integraciones"));
app.get("/c/suscripcion", (req, res) => res.redirect("/panel/suscripcion"));
app.get("/c/cuenta", (req, res) => res.redirect("/panel/cuenta"));

const DASH_USER = (process.env.DASH_USER || "").trim();
const DASH_PASS = (process.env.DASH_PASS || "").trim();
const DASH_COOKIE_SECRET = (process.env.DASH_COOKIE_SECRET || "").trim();

const API_BASE_URL = (process.env.API_BASE_URL || "").trim();
const API_TOKEN = (process.env.API_TOKEN || "").trim();
const BOT_CATALOG_PROVIDER_ID = (process.env.BOT_CATALOG_PROVIDER_ID || "babystepsbots").trim().toLowerCase();
const ADMIN_INBOX_MAX_ITEMS = 300;
const API_RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const API_MAX_ATTEMPTS = 4;
const API_REQUEST_TIMEOUT_MS = 12000;

// Rate limiters para login
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Demasiados intentos. Intentá de nuevo en 15 minutos.",
  skipSuccessfulRequests: true,
});

const clientLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Demasiados intentos. Intentá de nuevo en 15 minutos.",
  skipSuccessfulRequests: true,
});
const ADMIN_COMPANIES_CACHE_TTL_MS = Number(process.env.ADMIN_COMPANIES_CACHE_TTL_MS || 180000);
let adminCompaniesCache = {
  items: [],
  updatedAt: 0,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

  // En writes (POST/PUT) invalidar caches para que el proximo GET vea datos frescos
  if (req.method !== "GET") {
    _clientCompanyCache.delete(companyId);
    _clientIntegrationFlagCache.delete(companyId);
  }

  // Cargamos la empresa para usar en el panel cliente (con cache de 60s)
  const cached = getCachedClientCompany(companyId);
  if (cached) {
    req.company = cached;
    req.companyId = companyId;
    return next();
  }
  try {
    let company = null;
    if (dashboardDb.enabled) {
      company = await dashboardDb.getCompanyById(companyId);
    }
    if (!company) {
      company = await api(`/api/companies/${encodeURIComponent(companyId)}`);
    }
    setCachedClientCompany(company);
    req.company = company;
    req.companyId = companyId;
    next();
  } catch (e) {
    return res.redirect("/panel/login");
  }
}

async function api(pathname, { method = "GET", body } = {}) {
  if (!API_BASE_URL || !API_TOKEN) throw new Error("API_BASE_URL/API_TOKEN faltan en dashboard");
  let lastError = null;

  for (let attempt = 1; attempt <= API_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_REQUEST_TIMEOUT_MS);

    try {
      const r = await fetch(`${API_BASE_URL}${pathname}`, {
        method,
        headers: {
          Authorization: `Bearer ${API_TOKEN}`,
          "Cache-Control": "no-store",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const raw = await r.text();
      let data = {};
      if (raw) {
        try {
          data = JSON.parse(raw);
        } catch {
          data = { raw };
        }
      }

      if (!r.ok) {
        const message = data?.error || data?.message || `API error ${r.status}`;
        const err = new Error(message);
        err.status = r.status;
        lastError = err;

        if (API_RETRYABLE_STATUS.has(r.status) && attempt < API_MAX_ATTEMPTS) {
          await sleep(350 * attempt + 450 * attempt * attempt);
          continue;
        }
        throw err;
      }

      return data;
    } catch (error) {
      clearTimeout(timeout);

      const isAbort = error?.name === "AbortError";
      const status = Number(error?.status || 0);
      const retryable = isAbort || API_RETRYABLE_STATUS.has(status);
      lastError = error;

      if (retryable && attempt < API_MAX_ATTEMPTS) {
        await sleep(350 * attempt + 450 * attempt * attempt);
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error("No se pudo conectar con la API");
}

// Cache de empresa cliente (evita re-fetch en cada page load del panel)
const _clientCompanyCache = new Map(); // companyId -> { company, expiresAt }
const CLIENT_COMPANY_CACHE_TTL_MS = 60_000;

function getCachedClientCompany(id) {
  const hit = _clientCompanyCache.get(id);
  if (hit && hit.expiresAt > Date.now()) return hit.company;
  _clientCompanyCache.delete(id);
  return null;
}

function setCachedClientCompany(company) {
  if (!company?.id) return;
  _clientCompanyCache.set(String(company.id), { company, expiresAt: Date.now() + CLIENT_COMPANY_CACHE_TTL_MS });
}

// Cache de flag de integraciones por empresa (evita 1 API call por page load)
const _clientIntegrationFlagCache = new Map(); // companyId -> { hasIntegrations, expiresAt }
const CLIENT_INTEGRATION_FLAG_TTL_MS = 5 * 60_000;

function getCachedClientIntegrationFlag(id) {
  const hit = _clientIntegrationFlagCache.get(id);
  if (hit && hit.expiresAt > Date.now()) return hit.hasIntegrations;
  _clientIntegrationFlagCache.delete(id);
  return null;
}

function setCachedClientIntegrationFlag(id, hasIntegrations) {
  _clientIntegrationFlagCache.set(String(id), { hasIntegrations, expiresAt: Date.now() + CLIENT_INTEGRATION_FLAG_TTL_MS });
}

// Cache de empresa proveedora de catalogo (babystepsbots — siempre la misma)
let _providerCompanyCache = null;
let _providerCompanyCacheAt = 0;
const PROVIDER_COMPANY_CACHE_TTL_MS = 5 * 60_000;

async function getBotCatalogProviderCompany(currentCompany) {
  const currentId = String(currentCompany?.id || "").trim().toLowerCase();
  if (currentCompany && currentId === BOT_CATALOG_PROVIDER_ID) {
    return currentCompany;
  }
  if (_providerCompanyCache && (Date.now() - _providerCompanyCacheAt) < PROVIDER_COMPANY_CACHE_TTL_MS) {
    return _providerCompanyCache;
  }
  if (dashboardDb.enabled) {
    try {
      const company = await dashboardDb.getCompanyById(BOT_CATALOG_PROVIDER_ID);
      if (company) {
        _providerCompanyCache = company;
        _providerCompanyCacheAt = Date.now();
        return company;
      }
    } catch {}
  }
  try {
    const company = await api(`/api/companies/${encodeURIComponent(BOT_CATALOG_PROVIDER_ID)}`);
    _providerCompanyCache = company;
    _providerCompanyCacheAt = Date.now();
    return company;
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
  const subject = String(item.subject || "").trim();
  const createdAt = String(item.createdAt || item.at || new Date().toISOString());
  const statusRaw = String(item.status || "").trim().toLowerCase();
  const status = statusRaw === "resolved" ? "resolved" : "open";
  return {
    id: String(item.id || `msg_${index + 1}`),
    sender,
    subject,
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
    const { items: list } = await loadAdminCompanies({ allowStale: true, preferCache: true });
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

function getAdminCompaniesCacheAgeMs() {
  if (!adminCompaniesCache.updatedAt) return Number.POSITIVE_INFINITY;
  return Date.now() - adminCompaniesCache.updatedAt;
}

function hasFreshAdminCompaniesCache() {
  return adminCompaniesCache.items.length > 0 && getAdminCompaniesCacheAgeMs() <= ADMIN_COMPANIES_CACHE_TTL_MS;
}

async function loadAdminCompanies({ allowStale = true, preferCache = false } = {}) {
  if (preferCache && hasFreshAdminCompaniesCache()) {
    return {
      items: adminCompaniesCache.items,
      stale: false,
      cached: true,
      updatedAt: adminCompaniesCache.updatedAt,
      error: null,
    };
  }

  try {
    let items = [];
    if (dashboardDb.enabled) {
      items = await dashboardDb.getAdminCompaniesLite();
    } else {
      const payload = await api("/api/admin-company-list");
      items = Array.isArray(payload) ? payload : [];
    }
    adminCompaniesCache = {
      items,
      updatedAt: Date.now(),
    };
    return {
      items,
      stale: false,
      cached: false,
      updatedAt: adminCompaniesCache.updatedAt,
      error: null,
    };
  } catch (error) {
    if (allowStale && adminCompaniesCache.items.length > 0) {
      return {
        items: adminCompaniesCache.items,
        stale: true,
        cached: true,
        updatedAt: adminCompaniesCache.updatedAt,
        error,
      };
    }
    return {
      items: [],
      stale: true,
      cached: false,
      updatedAt: adminCompaniesCache.updatedAt,
      error,
    };
  }
}

async function getCompanyWhatsappMessageStats(companyId) {
  const id = String(companyId || "").trim();
  if (!id) return { total: 0, last30Days: 0 };
  try {
    const data = await api(`/api/companies/${encodeURIComponent(id)}/whatsapp-messages/stats`);
    return {
      total: Number(data?.total || 0),
      last30Days: Number(data?.last30Days || 0),
    };
  } catch {
    return { total: 0, last30Days: 0 };
  }
}

function renderNotificationBell({ href, count = 0, className = "", title = "Notificaciones" }) {
  const safeCount = Number.isFinite(Number(count)) ? Math.max(0, Number(count)) : 0;
  const classes = `notify-bell ${className}`.trim();
  const badge = safeCount > 0
    ? `<span class="notify-badge">${safeCount > 99 ? "99+" : safeCount}</span>`
    : "";
  return `<a class="${classes}" href="${href}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">&#128276;${badge}</a>`;
}

function renderSupportToolIcon({ href, count = 0, className = "", title = "Soporte" }) {
  const safeCount = Number.isFinite(Number(count)) ? Math.max(0, Number(count)) : 0;
  const classes = `notify-bell cp-support-tool ${className}`.trim();
  const badge = safeCount > 0
    ? `<span class="notify-badge">${safeCount > 99 ? "99+" : safeCount}</span>`
    : "";
  return `<a class="${classes}" href="${href}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">&#128736;${badge}</a>`;
}

async function saveCompanyRules(company, rules) {
  if (dashboardDb.enabled) {
    await dashboardDb.saveCompanyById(company.id, {
      name: company.name || company.id,
      prompt: company.prompt || "",
      catalogJson: company.catalogJson || "[]",
      rulesJson: JSON.stringify(rules || {}),
    });
    adminCompaniesCache.updatedAt = 0;
    return;
  }
  await api(`/api/companies/${encodeURIComponent(company.id)}/save`, {
    method: "POST",
    body: {
      name: company.name || company.id,
      prompt: company.prompt || "",
      catalogJson: company.catalogJson || "[]",
      rulesJson: JSON.stringify(rules || {}),
    },
  });
  adminCompaniesCache.updatedAt = 0;
}

function prettyJson(value, fallback = "{}") {
  try {
    return JSON.stringify(value ?? JSON.parse(fallback), null, 2);
  } catch {
    return fallback;
  }
}

function parseObjectJsonInput(raw, fieldName) {
  const parsed = parseJsonSafe(String(raw || "").trim() || "{}", null);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${fieldName} debe ser un objeto JSON`);
  }
  return parsed;
}

function normalizeIntegrationToneClass(toneRaw) {
  const tone = String(toneRaw || "").trim().toLowerCase();
  if (tone === "success") return "cp-tone-green";
  if (tone === "warning") return "cp-tone-amber-soft";
  if (tone === "danger") return "cp-tone-purple";
  return "cp-tone-cyan";
}

async function fetchCompanyIntegrations(companyId) {
  if (dashboardDb.enabled) {
    try {
      const rows = await dashboardDb.getCompanyIntegrations(companyId);
      if (Array.isArray(rows)) return rows;
    } catch {}
  }
  const data = await api(`/api/companies/${encodeURIComponent(companyId)}/integrations`);
  return Array.isArray(data) ? data : [];
}

function layout({ title, active, body, notifications = 0 }) {
  const nav = `
    <a class="btn ${active === "companies" ? "primary" : "secondary"}" href="/admin">🏢 Empresas</a>
    <a class="btn ${active === "new-company" ? "primary" : "secondary"}" href="/admin/company/new">✨ Nueva empresa</a>
    <a class="btn ${active === "messages" ? "primary" : "secondary"}" href="/admin/messages">📨 Mensajes</a>
    <a class="btn ${active === "assign" ? "primary" : "secondary"}" href="/admin/assign">🔗 Asignar clientes</a>
  `;

  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <link rel="stylesheet" href="/dashboard.css" />
      <title>${escapeHtml(title)}</title>
    </head>
    <body class="admin-light-ui">
      <div class="container">
        <header class="top">
          <div style="display:flex;flex-direction:column;gap:6px">
            <h2 style="margin:0">${escapeHtml(title)}</h2>
            <div style="display:flex;gap:10px;flex-wrap:wrap">${nav}</div>
          </div>
          <div style="display:flex;gap:10px;align-items:center">
            ${renderNotificationBell({ href: "/admin/messages", count: notifications, className: "admin-notify-bell", title: "Mensajes y notificaciones" })}
            <a class="btn secondary" href="/admin/logout">🚪 Logout</a>
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
  if (dashboardDb.enabled) {
    try {
      return await dashboardDb.getCompanyOrders(companyId, {
        from: filterFrom || null,
        to: filterTo || null,
        limit,
      });
    } catch {
      // fallback a API si la consulta directa falla
    }
  }
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

function normalizeClientPaymentStatus(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "pending";
  if (["paid", "pagado", "approved", "aprobado", "settled", "cobrado"].some((v) => raw.includes(v))) return "paid";
  if (["failed", "fallido", "rechazado", "cancelado", "voided", "chargeback", "refunded"].some((v) => raw.includes(v))) return "failed";
  return "pending";
}

function clientPaymentStatusLabel(statusRaw) {
  const status = normalizeClientPaymentStatus(statusRaw);
  if (status === "paid") return "Pagado";
  if (status === "failed") return "Fallido";
  return "No pagado";
}

function clientPaymentLabel(order) {
  return clientPaymentStatusLabel(order?.paymentStatus || "");
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

app.post("/admin/login", adminLoginLimiter, (req, res) => {
  const user = (req.body.user || "").trim();
  const pass = (req.body.pass || "").trim();

  if (user !== DASH_USER || pass !== DASH_PASS) {
    return res.status(401).send("Credenciales incorrectas");
  }

  const token = crypto.randomBytes(24).toString("hex");
  setCookie(res, "dash", `${token}.${signToken(token)}`);
  return res.redirect("/admin");
});

app.get("/admin/forgot", (req, res) => {
  res.type("text/html").send(`
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <link rel="stylesheet" href="/dashboard.css" />
    <title>Recuperar acceso admin</title>
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
            <div class="bs-subtitle">Admin Console</div>
          </div>
        </div>

        <h2 class="bs-h2">Recuperar acceso admin</h2>
        <p class="muted">La password del admin se controla desde las variables de entorno del servicio <b>whatsapp-dashboard</b> en Render.</p>
        <p class="muted">Si no recuerdas el acceso, revisa o restablece <code>DASH_USER</code> y <code>DASH_PASS</code> en el entorno del dashboard.</p>

        <div class="login-actions">
          <a class="btn secondary" href="/admin/login">Volver al login</a>
        </div>
      </div>
    </div>
  </body>
</html>
  `);
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
    const companiesState = await loadAdminCompanies({ allowStale: true, preferCache: true });
    const companies = Array.isArray(companiesState.items) ? companiesState.items : [];
    const flashCompany = String(req.query.company || "").trim();
    const dashboardSaved = String(req.query.dashboardSaved || "") === "1";
    const deleted = String(req.query.deleted || "") === "1";
    const dashboardError = String(req.query.dashboardError || "").trim();
    const deleteError = String(req.query.deleteError || "").trim();
    const cacheSyncLabel = companiesState.updatedAt
      ? new Date(companiesState.updatedAt).toLocaleString("es-AR")
      : "";
    const flashHtml = [
      companiesState.error && companiesState.cached
        ? `<div class="card"><b>Usando datos en cache:</b> el backend respondio lento, pero mantenemos el panel operativo.<br><span class="muted">Ultima sincronizacion: ${escapeHtml(cacheSyncLabel || "hace instantes")}.</span></div>`
        : "",
      companiesState.error && !companiesState.cached
        ? `<div class="card"><b>Sincronizacion pendiente:</b> no pudimos refrescar el listado de empresas todavia.<br><span class="muted">El admin sigue accesible y puedes reintentar en unos segundos.</span></div>`
        : "",
      dashboardSaved ? `<div class="card"><b>Dashboard actualizado:</b> ${escapeHtml(flashCompany || "empresa")}</div>` : "",
      deleted ? `<div class="card"><b>Empresa eliminada:</b> ${escapeHtml(flashCompany || "empresa")}</div>` : "",
      dashboardError ? `<div class="card"><b>Error guardando dashboard:</b> ${escapeHtml(dashboardError)}</div>` : "",
      deleteError ? `<div class="card"><b>Error eliminando empresa:</b> ${escapeHtml(deleteError)}</div>` : "",
    ].join("");

    const nowForSub = new Date();
    const in7Days = new Date(nowForSub.getTime() + 7 * 24 * 60 * 60 * 1000);

    const rowsData = companies.map((c) => {
      const rules = parseJsonSafe(c.rulesJson || "{}", {});
      const plan = extractPlanInfo(c, rules);
      const profile = extractCompanyProfile(rules);
      const subStatus = String(rules?.subscriptionStatus || "Activa").trim().toLowerCase();
      const subEnd = rules?.subscriptionCurrentEnd;
      const subEndDate = subEnd ? new Date(subEnd) : null;
      const subExpired = subEndDate && !isNaN(subEndDate) && subEndDate < nowForSub;
      const subExpiringSoon = subEndDate && !isNaN(subEndDate) && !subExpired && subEndDate < in7Days;
      const subInactive = ["inactiva", "cancelada", "suspendida", "inactive", "cancelled", "canceled", "suspended"].includes(subStatus);
      const subAtRisk = subInactive || subExpired || subExpiringSoon;
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
      const dotClass = !dashboardAccess.enabled ? "company-dot-inactive" : dashboardAccess.mode === "limited" ? "company-dot-limited" : "company-dot-active";
      const subBadgeHtml = subInactive
        ? `<span class="admin-sub-badge admin-sub-inactive">Inactiva</span>`
        : subExpired
          ? `<span class="admin-sub-badge admin-sub-expired">Vencida</span>`
          : subExpiringSoon
            ? `<span class="admin-sub-badge admin-sub-soon">Vence pronto</span>`
            : "";
      const html = `
      <a class="company-item company-item-link ${subAtRisk ? "company-item-atrisk" : ""}" href="/admin/company/${encodeURIComponent(c.id)}">
        <span class="company-dot ${dotClass}" title="Dashboard: ${accessLabel}"></span>
        <div class="admin-company-meta">
          <div class="admin-company-name"><b>${escapeHtml(c.id)}</b> — ${escapeHtml(c.name || "")} ${subBadgeHtml}</div>
          <div class="muted">Dueno: ${escapeHtml(profile.ownerName || "-")} | ${escapeHtml(profile.ownerEmail || "-")}</div>
          <div class="muted">Bot: ${escapeHtml(plan.botClass)} | Plan: ${escapeHtml(plan.fullLabel)} | Dashboard: ${accessLabel}${subEnd ? ` | Sub hasta: ${new Date(subEnd).toLocaleDateString("es-AR")}` : ""}</div>
        </div>
        <span class="company-item-arrow">→</span>
      </a>
    `;
      return { html, searchText, dashboardAccess, unreadAdminMessages, companyId: c.id, companyName: c.name || c.id, subAtRisk, subInactive, subExpired, subExpiringSoon };
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
    const subActiveCount = rowsData.filter((r) => !r.subInactive && !r.subExpired).length;
    const subExpiredCount = rowsData.filter((r) => r.subExpired && !r.subInactive).length;
    const subInactiveCount = rowsData.filter((r) => r.subInactive).length;
    const subSoonCount = rowsData.filter((r) => r.subExpiringSoon).length;
    const buildAdminHref = (nextView) => {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (nextView && nextView !== "all") params.set("view", nextView);
      const query = params.toString();
      return query ? `/admin?${query}` : "/admin";
    };
    const kpiClass = (key) => `kpi kpi-filter ${view === key ? "active" : ""}`;
    const clearSearchHref = view !== "all" ? `/admin?view=${encodeURIComponent(view)}` : "/admin";

    const [botHealth, dbHealth, activityData] = await Promise.all([
      api("/health").catch(() => ({ ok: false })),
      api("/health/db").catch(() => ({ ok: false, db: "down" })),
      api("/api/health/activity").catch(() => null),
    ]);

    res.type("text/html").send(`
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <link rel="stylesheet" href="/dashboard.css" />
    <title>BabySteps - Admin</title>
  </head>
  <body class="admin-home-page admin-light-ui">
    <div class="container">

      <div class="admin-header admin-home-header">
        <div class="brand">
          <div>
            <div class="title">🛰️ BabySteps</div>
            <div class="subtitle">Admin Console</div>
          </div>
        </div>
        <div class="admin-header-actions">
          ${renderNotificationBell({ href: "/admin/messages", count: unreadAdminNotifications, className: "admin-notify-bell", title: "Mensajes del buzon" })}
          <a class="btn secondary" href="/admin/logout">🚪 Logout</a>
        </div>
      </div>

      <div class="admin-home-shell">
        <aside class="card admin-side-menu">
          <h3 style="margin:0">🧭 Menu</h3>
          <a class="btn primary" href="/admin/company/new">✨ Agregar +</a>
          <a class="btn secondary" href="/admin/messages">📨 Mensajes ${unreadAdminNotifications > 0 ? `<span class="admin-side-badge">${unreadAdminNotifications > 99 ? "99+" : unreadAdminNotifications}</span>` : ""}</a>
          <a class="btn secondary" href="/admin/orders">📦 Pedidos</a>
          <a class="btn secondary" href="/admin/assign">🔗 Asignar clientes</a>

          <div class="admin-health-widget">
            <div class="admin-health-title">🩺 Estado del sistema</div>
            ${(() => {
              const botOk = botHealth?.ok === true;
              const dbOk = dbHealth?.ok === true && dbHealth?.db === "up";
              const activity = activityData;
              const lastIn = activity?.lastInbound;
              const mins1h = Number(activity?.messagesLast1h || 0);
              const mins24h = Number(activity?.messagesLast24h || 0);
              const lastInAgo = lastIn?.at
                ? (() => {
                    const ms = Date.now() - new Date(lastIn.at).getTime();
                    if (ms < 60000) return "hace menos de 1 min";
                    if (ms < 3600000) return `hace ${Math.floor(ms / 60000)} min`;
                    if (ms < 86400000) return `hace ${Math.floor(ms / 3600000)}h`;
                    return `hace ${Math.floor(ms / 86400000)}d`;
                  })()
                : null;
              return `
              <div class="admin-health-row">
                <span class="admin-health-dot ${botOk ? "ok" : "err"}"></span>
                <span>Bot API: <b>${botOk ? "Online" : "Sin respuesta"}</b></span>
              </div>
              <div class="admin-health-row">
                <span class="admin-health-dot ${dbOk ? "ok" : "err"}"></span>
                <span>Base de datos: <b>${dbOk ? "Activa" : dbHealth?.db || "Error"}</b></span>
              </div>
              ${lastInAgo ? `
              <div class="admin-health-row">
                <span class="admin-health-dot ok"></span>
                <span>Ultimo msg: <b>${escapeHtml(lastInAgo)}</b></span>
              </div>` : ""}
              <div class="admin-health-stats">
                <span><b>${mins1h}</b> msgs/1h</span>
                <span><b>${mins24h}</b> msgs/24h</span>
              </div>`;
            })()}
          </div>
        </aside>

        <section class="admin-home-main">
          ${flashHtml}

          <div class="kpis">
            <a class="${kpiClass("all")}" href="${buildAdminHref("all")}">
              <div class="label">🏢 Empresas</div>
              <div class="value">${rowsData.length}</div>
              <div class="hint">de ${companies.length} registradas</div>
            </a>
            <a class="${kpiClass("full")}" href="${buildAdminHref("full")}">
              <div class="label">🧠 Dashboard completo</div>
              <div class="value">${fullCount}</div>
              <div class="hint">acceso total</div>
            </a>
            <a class="${kpiClass("limited")}" href="${buildAdminHref("limited")}">
              <div class="label">🔒 Dashboard limitado</div>
              <div class="value">${limitedCount}</div>
              <div class="hint">solo catalogo/suscripcion/cuenta</div>
            </a>
            <a class="${kpiClass("inactive")}" href="${buildAdminHref("inactive")}">
              <div class="label">⏸️ Dashboard inactivo</div>
              <div class="value">${disabledCount}</div>
              <div class="hint">sin acceso</div>
            </a>
          </div>

          <div class="kpis admin-sub-kpis">
            <div class="kpi">
              <div class="label">✅ Suscripciones activas</div>
              <div class="value">${subActiveCount}</div>
              <div class="hint">al dia</div>
            </div>
            <div class="kpi ${subExpiredCount > 0 ? "kpi-warn" : ""}">
              <div class="label">🔴 Vencidas</div>
              <div class="value">${subExpiredCount}</div>
              <div class="hint">sin renovar</div>
            </div>
            <div class="kpi ${subSoonCount > 0 ? "kpi-warn" : ""}">
              <div class="label">🟡 Vence en 7 dias</div>
              <div class="value">${subSoonCount}</div>
              <div class="hint">atención requerida</div>
            </div>
            <div class="kpi ${subInactiveCount > 0 ? "kpi-warn" : ""}">
              <div class="label">⛔ Inactivas</div>
              <div class="value">${subInactiveCount}</div>
              <div class="hint">canceladas o suspendidas</div>
            </div>
          </div>

          ${(() => {
            const withUnread = rowsData
              .filter(r => r.unreadAdminMessages > 0)
              .sort((a, b) => b.unreadAdminMessages - a.unreadAdminMessages)
              .slice(0, 8);
            if (!withUnread.length) return "";
            const items = withUnread.map(r => `
              <a class="admin-pending-item" href="/admin/messages?companyId=${encodeURIComponent(r.companyId)}">
                <span class="admin-pending-name">${escapeHtml(r.companyName || r.companyId)}</span>
                <span class="admin-pending-badge">${r.unreadAdminMessages > 99 ? "99+" : r.unreadAdminMessages}</span>
              </a>`).join("");
            return `
            <div class="card admin-pending-card">
              <div class="admin-pending-head">
                <span>📬 Mensajes sin leer</span>
                <a href="/admin/messages?read=unread">Ver todos →</a>
              </div>
              <div class="admin-pending-list">${items}</div>
            </div>`;
          })()}

          ${(() => {
            const atRisk = rowsData.filter(r => r.subAtRisk).slice(0, 10);
            if (!atRisk.length) return "";
            const items = atRisk.map(r => {
              const tag = r.subInactive ? "Inactiva" : r.subExpired ? "Vencida" : "Vence pronto";
              const cls = r.subInactive || r.subExpired ? "admin-sub-expired" : "admin-sub-soon";
              return `
              <a class="admin-pending-item" href="/admin/company/${encodeURIComponent(r.companyId)}">
                <span class="admin-pending-name">${escapeHtml(r.companyName || r.companyId)}</span>
                <span class="admin-sub-badge ${cls}">${tag}</span>
              </a>`;
            }).join("");
            return `
            <div class="card admin-pending-card">
              <div class="admin-pending-head">
                <span>⚠️ Suscripciones en riesgo</span>
              </div>
              <div class="admin-pending-list">${items}</div>
            </div>`;
          })()}

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
    const fallbackMessage = escapeHtml(String(e?.message || e || "Fallo cargando el panel admin"));
    res.status(200).type("text/html").send(`
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <link rel="stylesheet" href="/dashboard.css" />
    <title>BabySteps - Admin</title>
  </head>
  <body class="admin-home-page admin-light-ui">
    <div class="container">
      <div class="admin-header admin-home-header">
        <div class="brand">
          <div>
            <div class="title">🛰️ BabySteps</div>
            <div class="subtitle">Admin Console</div>
          </div>
        </div>
        <div class="admin-header-actions">
          <a class="btn secondary" href="/admin/logout">🚪 Logout</a>
        </div>
      </div>

      <div class="admin-home-shell">
        <aside class="card admin-side-menu">
          <h3 style="margin:0">🧭 Menu</h3>
          <a class="btn primary" href="/admin/company/new">✨ Agregar +</a>
          <a class="btn secondary" href="/admin/messages">📨 Mensajes</a>
          <a class="btn secondary" href="/admin/assign">🔗 Asignar clientes</a>
        </aside>

        <section class="admin-home-main">
          <div class="card">
            <h3 style="margin:0 0 10px;">Backend temporalmente no disponible</h3>
            <div class="muted">El panel admin sigue accesible, pero no pudimos cargar el listado completo de empresas en este momento.</div>
            <pre style="white-space:pre-wrap; margin-top:10px;">${fallbackMessage}</pre>
            <div class="actions" style="margin-top:12px;">
              <a class="btn primary" href="/admin">Reintentar</a>
              <a class="btn secondary" href="/admin/company/new">Nueva empresa</a>
              <a class="btn secondary" href="/admin/messages">Mensajes</a>
            </div>
          </div>

          <div class="kpis">
            <div class="kpi">
              <div class="label">🏢 Empresas</div>
              <div class="value">-</div>
              <div class="hint">sin datos por el momento</div>
            </div>
            <div class="kpi">
              <div class="label">🧠 Dashboard completo</div>
              <div class="value">-</div>
              <div class="hint">pendiente de carga</div>
            </div>
            <div class="kpi">
              <div class="label">🔒 Dashboard limitado</div>
              <div class="value">-</div>
              <div class="hint">pendiente de carga</div>
            </div>
            <div class="kpi">
              <div class="label">⏸️ Dashboard inactivo</div>
              <div class="value">-</div>
              <div class="hint">pendiente de carga</div>
            </div>
          </div>

          <div class="card" id="admin-company-list">
            <h3 style="margin:0 0 12px;">Listado</h3>
            <div class="muted">Todavia no se pudo consultar la API. Este fallback evita que el acceso al admin se bloquee mientras el backend se estabiliza.</div>
          </div>
        </section>
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
    rules.botPhone = String(req.body.botPhone || "").trim();
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
    await assignClientPassword(rules, assignedPassword);

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

    // Email de bienvenida si la empresa tiene email registrado
    const ownerEmail = String(rules.ownerEmail || "").trim();
    if (ownerEmail) {
      const baseUrl = `${req.protocol}://${req.get("host")}`;
      sendEmail({
        to: ownerEmail,
        subject: `Bienvenido a tu panel de gestión — ${name}`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:24px">
            <h2 style="color:#1a1f36">¡Bienvenido, ${escapeHtml(rules.ownerName || name)}!</h2>
            <p>Tu cuenta fue creada exitosamente. Ya podés acceder al panel de gestión de tu bot de WhatsApp.</p>
            <div style="background:#f8f9fa;border-radius:8px;padding:16px;margin:20px 0">
              <p style="margin:0 0 8px"><b>Empresa:</b> ${escapeHtml(name)}</p>
              <p style="margin:0 0 8px"><b>ID de acceso:</b> <code>${escapeHtml(id)}</code></p>
              <p style="margin:0"><b>Contraseña:</b> <code>${escapeHtml(assignedPassword)}</code></p>
            </div>
            <div style="text-align:center;margin:28px 0">
              <a href="${baseUrl}/panel/login" style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">
                Acceder al panel
              </a>
            </div>
            <p style="color:#666;font-size:12px">Podés cambiar tu contraseña desde la sección Cuenta dentro del panel.</p>
          </div>
        `,
      }).catch((e) => console.error("[email] welcome email failed:", e?.message));
    }

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
    let c = null;
    if (dashboardDb.enabled) {
      c = await dashboardDb.getCompanyById(id);
    }
    if (!c) {
      c = await api(`/api/companies/${encodeURIComponent(id)}`);
    }
    const [adminUnreadNotifications, providerCompany, integrations] = await Promise.all([
      getAdminUnreadNotificationsTotal(),
      getBotCatalogProviderCompany(c),
      fetchCompanyIntegrations(id).catch(() => []),
    ]);
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
    const dashboardAccess = extractDashboardAccessFromRules(state.rules);
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
    const integrationsHtml = integrations.length
      ? integrations.map((integration) => {
        const config = parseJsonSafe(integration.configJson || "{}", {});
        const secrets = parseJsonSafe(integration.secretsJson || "{}", {});
        const method = String(config.method || "GET").trim().toUpperCase() === "POST" ? "POST" : "GET";
        const authType = ["none", "bearer", "header"].includes(String(config.authType || "").trim().toLowerCase())
          ? String(config.authType || "").trim().toLowerCase()
          : "none";
        const authHeaderName = String(config.authHeaderName || "x-api-key").trim() || "x-api-key";
        return `
          <div class="card" style="margin-top:18px">
            <form method="POST" action="/admin/company/${encodeURIComponent(c.id)}/integrations/${encodeURIComponent(integration.id)}/save" class="form">
              <div class="grid2">
                <div>
                  <label>Nombre</label>
                  <input name="name" value="${escapeHtml(integration.name || "")}" />
                </div>
                <div>
                  <label>Provider</label>
                  <select name="provider">
                    <option value="custom_api" ${String(integration.provider || "") === "custom_api" ? "selected" : ""}>custom_api</option>
                  </select>
                </div>
              </div>

              <label style="display:flex;align-items:center;gap:8px;margin-top:6px">
                <input type="checkbox" name="enabled" value="1" ${integration.enabled ? "checked" : ""} style="width:auto" />
                Integracion activa
              </label>

              <div class="grid2">
                <div>
                  <label>Base URL</label>
                  <input name="baseUrl" value="${escapeHtml(String(config.baseUrl || ""))}" placeholder="https://api.cliente.com" />
                </div>
                <div>
                  <label>Path</label>
                  <input name="path" value="${escapeHtml(String(config.path || ""))}" placeholder="/stock/resumen" />
                </div>
              </div>

              <div class="grid2">
                <div>
                  <label>Metodo</label>
                  <select name="method">
                    <option value="GET" ${method === "GET" ? "selected" : ""}>GET</option>
                    <option value="POST" ${method === "POST" ? "selected" : ""}>POST</option>
                  </select>
                </div>
                <div>
                  <label>Auth type</label>
                  <select name="authType">
                    <option value="none" ${authType === "none" ? "selected" : ""}>none</option>
                    <option value="bearer" ${authType === "bearer" ? "selected" : ""}>bearer</option>
                    <option value="header" ${authType === "header" ? "selected" : ""}>header</option>
                  </select>
                </div>
              </div>

              <div class="grid2">
                <div>
                  <label>Header de auth</label>
                  <input name="authHeaderName" value="${escapeHtml(authHeaderName)}" placeholder="x-api-key" />
                </div>
                <div>
                  <label>Token / secreto</label>
                  <input name="token" value="${escapeHtml(String(secrets.token || ""))}" placeholder="Se guarda en secretsJson" />
                </div>
              </div>

              <label>Headers JSON</label>
              <textarea name="headersJson" rows="4">${escapeHtml(prettyJson(config.headers || {}, "{}"))}</textarea>

              <label>Body JSON (opcional)</label>
              <textarea name="bodyJson" rows="4">${escapeHtml(prettyJson(config.bodyJson || {}, "{}"))}</textarea>

              <div class="muted">
                ID: <code>${escapeHtml(integration.id)}</code> | Actualizado: ${escapeHtml(integration.updatedAt || integration.createdAt || "-")}
              </div>

              <div class="actions">
                <button class="btn primary" type="submit">Guardar integracion</button>
              </div>
            </form>
            <div class="actions" style="margin-top:12px">
              <form method="POST" action="/admin/company/${encodeURIComponent(c.id)}/integrations/${encodeURIComponent(integration.id)}/test">
                <button class="btn secondary" type="submit">Probar conexion</button>
              </form>
              <form method="POST" action="/admin/company/${encodeURIComponent(c.id)}/integrations/${encodeURIComponent(integration.id)}/delete" onsubmit="return confirm('Se eliminara la integracion. Continuar?')">
                <button class="btn danger" type="submit">Eliminar integracion</button>
              </form>
            </div>
          </div>
        `;
      }).join("")
      : `<div class="muted">No hay integraciones privadas configuradas todavia.</div>`;

    const alerts = [
      String(req.query.created || "") === "1" ? `<div class="card"><b>Empresa creada correctamente.</b></div>` : "",
      String(req.query.updated || "") === "1" ? `<div class="card"><b>Datos actualizados.</b></div>` : "",
      String(req.query.botUpdated || "") === "1" ? `<div class="card"><b>Clase de bot actualizada.</b></div>` : "",
      String(req.query.manualPwd || "") === "1" ? `<div class="card"><b>Password actualizada manualmente.</b></div>` : "",
      String(req.query.generatedPwd || "") ? `<div class="card"><b>Nueva password generada:</b> <code>${escapeHtml(String(req.query.generatedPwd || ""))}</code></div>` : "",
      String(req.query.botError || "") ? `<div class="card"><b>Error al cambiar bot:</b> ${escapeHtml(String(req.query.botError || ""))}</div>` : "",
      String(req.query.integrationCreated || "") === "1" ? `<div class="card"><b>Integracion creada.</b></div>` : "",
      String(req.query.integrationUpdated || "") === "1" ? `<div class="card"><b>Integracion actualizada.</b></div>` : "",
      String(req.query.integrationDeleted || "") === "1" ? `<div class="card"><b>Integracion eliminada.</b></div>` : "",
      String(req.query.integrationTestOk || "") === "1" ? `<div class="card"><b>Conexion correcta.</b> Cards: ${escapeHtml(String(req.query.cards || "0"))} | Alertas: ${escapeHtml(String(req.query.alerts || "0"))} | Tabla: ${String(req.query.hasTable || "") === "1" ? "si" : "no"}</div>` : "",
      String(req.query.integrationError || "") ? `<div class="card"><b>Error en integracion:</b> ${escapeHtml(String(req.query.integrationError || ""))}</div>` : "",
      String(req.query.subscriptionSaved || "") === "1" ? `<div class="card"><b>Suscripcion actualizada correctamente.</b></div>` : "",
      String(req.query.subscriptionError || "") ? `<div class="card"><b>Error al actualizar suscripcion:</b> ${escapeHtml(String(req.query.subscriptionError || ""))}</div>` : "",
    ].join("");

    res.type("text/html").send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <link rel="stylesheet" href="/dashboard.css" />
    <title>Editar ${c.id}</title>
  </head>
  <body class="admin-light-ui admin-edit-page">
    <div class="container">
      <div class="app-header">
        <div class="brand">
          <img src="/img/logo.png" alt="BabySteps" onerror="this.style.display='none'"/>
          <div>
            <div class="title">🛠️ Editar empresa</div>
            <div class="subtitle">${c.id}</div>
          </div>
        </div>
        <div class="nav admin-nav-actions">
          ${renderNotificationBell({ href: "/admin/messages", count: adminUnreadNotifications, className: "admin-notify-bell", title: "Mensajes del buzon" })}
          <a class="btn secondary" href="/admin">⬅️ Volver</a>
          <span class="admin-nav-divider" aria-hidden="true"></span>
          <a class="btn secondary" href="/admin/logout">🚪 Logout</a>
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
              <label>Telefono del dueno</label>
              <input name="ownerPhone" value="${escapeHtml(profile.ownerPhone)}" />
            </div>
          </div>

          <div class="grid2">
            <div>
              <label>Numero de WhatsApp del bot</label>
              <input name="botPhone" value="${escapeHtml(profile.botPhone)}" placeholder="+5491112345678" />
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
        <h3 style="margin-top:0">Integraciones</h3>
        <form method="POST" action="/admin/company/${encodeURIComponent(c.id)}/integrations" class="form">
          <div class="grid2">
            <div>
              <label>Nombre de la integracion</label>
              <input name="name" placeholder="Ej: Stock ERP" />
            </div>
            <div>
              <label>Provider</label>
              <select name="provider">
                <option value="custom_api">custom_api</option>
              </select>
            </div>
          </div>
          <div class="actions">
            <button class="btn primary" type="submit">Crear integracion</button>
          </div>
        </form>
        ${integrationsHtml}
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

      <div class="card admin-toggle-card">
        <h3 style="margin-top:0">Suscripcion</h3>
        ${(() => {
          const subStatus = String(state.subscription.status || "Activa");
          const subEnd = String(state.rules?.subscriptionCurrentEnd || state.subscription.endAt || "");
          const subEndValue = subEnd ? new Date(subEnd).toISOString().slice(0, 10) : "";
          const statuses = ["Activa", "Inactiva", "Cancelada", "Suspendida"];
          const opts = statuses.map((s) => `<option value="${s}" ${subStatus === s ? "selected" : ""}>${s}</option>`).join("");
          return `
          <div class="muted" style="margin-bottom:12px">
            Estado actual: <b>${escapeHtml(subStatus)}</b>
            ${subEnd ? ` | Fin ciclo: <b>${new Date(subEnd).toLocaleDateString("es-AR")}</b>` : ""}
            ${state.subscription.renewalAt ? ` | Renovacion: <b>${formatDateLabel(state.subscription.renewalAt)}</b>` : ""}
          </div>
          <form method="POST" action="/admin/company/${escapeHtml(c.id)}/subscription/save" class="form">
            <div class="grid2">
              <div>
                <label>Estado de suscripcion</label>
                <select name="subscriptionStatus">${opts}</select>
              </div>
              <div>
                <label>Fin del ciclo actual</label>
                <input type="date" name="subscriptionCurrentEnd" value="${escapeHtml(subEndValue)}" />
              </div>
            </div>
            <div class="actions">
              <button class="btn primary" type="submit">Guardar</button>
              <button class="btn secondary" type="submit" name="renew1m" value="1">↺ Renovar 1 mes</button>
            </div>
          </form>`;
        })()}
      </div>

      <div class="card admin-toggle-card">
        <h3 style="margin-top:0">Acceso al panel</h3>
        <form method="POST" action="/admin/company/${encodeURIComponent(c.id)}/dashboard/save" class="form">
          <div class="grid2">
            <div>
              <label>Dashboard del cliente</label>
              <select name="dashboardEnabled">
                <option value="1" ${dashboardAccess?.enabled ? "selected" : ""}>Activo</option>
                <option value="0" ${dashboardAccess?.enabled ? "" : "selected"}>Inactivo</option>
              </select>
            </div>
            <div>
              <label>Nivel de acceso</label>
              <select name="dashboardMode">
                <option value="full"    ${dashboardAccess?.mode === "full"    ? "selected" : ""}>Completo</option>
                <option value="limited" ${dashboardAccess?.mode === "limited" ? "selected" : ""}>Limitado</option>
              </select>
            </div>
          </div>
          <div class="actions">
            <button class="btn primary" type="submit">Guardar acceso</button>
          </div>
        </form>
      </div>

      <div class="card admin-toggle-card">
        <h3 style="margin-top:0">Zona peligrosa</h3>
        <p class="muted">Esta accion es irreversible. Se eliminara la empresa y toda su configuracion.</p>
        <form method="POST" action="/admin/company/${encodeURIComponent(c.id)}/delete" onsubmit="return confirm('Se eliminara la empresa y su configuracion. Esta accion no se puede deshacer. Continuar?')">
          <div class="actions">
            <button class="btn danger" type="submit">Eliminar empresa</button>
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

  if (dashboardDb.enabled) {
    await dashboardDb.saveCompanyById(id, {
      name: req.body.name,
      prompt: req.body.prompt,
      catalogJson: req.body.catalogJson,
      rulesJson: req.body.rulesJson,
    });
    adminCompaniesCache.updatedAt = 0;
  } else {
    await api(`/api/companies/${encodeURIComponent(id)}/save`, {
      method: "POST",
      body: {
        name: req.body.name,
        prompt: req.body.prompt,
        catalogJson: req.body.catalogJson,
        rulesJson: req.body.rulesJson,
      },
    });
    adminCompaniesCache.updatedAt = 0;
  }

  res.redirect(`/admin/company/${encodeURIComponent(id)}`);
});

app.post("/admin/company/:id/integrations", requireDashboardAuth, async (req, res) => {
  const id = req.params.id;
  try {
    await api(`/api/companies/${encodeURIComponent(id)}/integrations`, {
      method: "POST",
      body: {
        name: String(req.body.name || "").trim() || "Nueva integracion",
        provider: String(req.body.provider || "custom_api").trim() || "custom_api",
      },
    });
    res.redirect(`/admin/company/${encodeURIComponent(id)}?integrationCreated=1`);
  } catch (e) {
    res.redirect(`/admin/company/${encodeURIComponent(id)}?integrationError=${encodeURIComponent(e?.message || e)}`);
  }
});

app.post("/admin/company/:id/integrations/:integrationId/save", requireDashboardAuth, async (req, res) => {
  const id = req.params.id;
  const integrationId = req.params.integrationId;
  try {
    const config = {
      baseUrl: String(req.body.baseUrl || "").trim(),
      path: String(req.body.path || "").trim(),
      method: String(req.body.method || "GET").trim().toUpperCase() === "POST" ? "POST" : "GET",
      headers: parseObjectJsonInput(req.body.headersJson, "Headers JSON"),
      authType: ["none", "bearer", "header"].includes(String(req.body.authType || "").trim().toLowerCase())
        ? String(req.body.authType || "").trim().toLowerCase()
        : "none",
      authHeaderName: String(req.body.authHeaderName || "x-api-key").trim() || "x-api-key",
      bodyJson: parseObjectJsonInput(req.body.bodyJson, "Body JSON"),
    };
    const secrets = {
      token: String(req.body.token || "").trim(),
    };
    await api(`/api/companies/${encodeURIComponent(id)}/integrations/${encodeURIComponent(integrationId)}/save`, {
      method: "POST",
      body: {
        name: String(req.body.name || "").trim(),
        provider: String(req.body.provider || "custom_api").trim() || "custom_api",
        enabled: req.body.enabled ? 1 : 0,
        configJson: JSON.stringify(config),
        secretsJson: JSON.stringify(secrets),
      },
    });
    res.redirect(`/admin/company/${encodeURIComponent(id)}?integrationUpdated=1`);
  } catch (e) {
    res.redirect(`/admin/company/${encodeURIComponent(id)}?integrationError=${encodeURIComponent(e?.message || e)}`);
  }
});

app.post("/admin/company/:id/integrations/:integrationId/test", requireDashboardAuth, async (req, res) => {
  const id = req.params.id;
  const integrationId = req.params.integrationId;
  try {
    const test = await api(`/api/companies/${encodeURIComponent(id)}/integrations/${encodeURIComponent(integrationId)}/test`, {
      method: "POST",
    });
    const preview = test?.preview || {};
    const params = new URLSearchParams({
      integrationTestOk: "1",
      cards: String(preview.cards || 0),
      alerts: String(preview.alerts || 0),
      hasTable: preview.hasTable ? "1" : "0",
    });
    res.redirect(`/admin/company/${encodeURIComponent(id)}?${params.toString()}`);
  } catch (e) {
    res.redirect(`/admin/company/${encodeURIComponent(id)}?integrationError=${encodeURIComponent(e?.message || e)}`);
  }
});

app.post("/admin/company/:id/integrations/:integrationId/delete", requireDashboardAuth, async (req, res) => {
  const id = req.params.id;
  const integrationId = req.params.integrationId;
  try {
    await api(`/api/companies/${encodeURIComponent(id)}/integrations/${encodeURIComponent(integrationId)}/delete`, {
      method: "POST",
    });
    res.redirect(`/admin/company/${encodeURIComponent(id)}?integrationDeleted=1`);
  } catch (e) {
    res.redirect(`/admin/company/${encodeURIComponent(id)}?integrationError=${encodeURIComponent(e?.message || e)}`);
  }
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
    let company = null;
    if (dashboardDb.enabled) {
      company = await dashboardDb.getCompanyById(id);
    }
    if (!company) {
      company = await api(`/api/companies/${encodeURIComponent(id)}`);
    }
    const rulesRaw = parseJsonSafe(company.rulesJson || "{}", {});
    const rules = rulesRaw && typeof rulesRaw === "object" ? rulesRaw : {};
    rules.dashboardEnabled = dashboardEnabled;
    rules.dashboardMode = dashboardMode;

    if (dashboardDb.enabled) {
      await dashboardDb.saveCompanyById(id, {
        name: company.name || id,
        prompt: company.prompt || "",
        catalogJson: company.catalogJson || "[]",
        rulesJson: JSON.stringify(rules),
      });
    } else {
      await api(`/api/companies/${encodeURIComponent(id)}/save`, {
        method: "POST",
        body: {
          name: company.name || id,
          prompt: company.prompt || "",
          catalogJson: company.catalogJson || "[]",
          rulesJson: JSON.stringify(rules),
        },
      });
    }
    adminCompaniesCache.updatedAt = 0;

    params.set("dashboardSaved", "1");
    return res.redirect(`/admin?${params.toString()}`);
  } catch (e) {
    params.set("dashboardError", String(e?.message || e));
    return res.redirect(`/admin?${params.toString()}`);
  }
});

app.post("/admin/company/:id/subscription/save", requireDashboardAuth, async (req, res) => {
  const id = req.params.id;
  const redirectBack = `/admin/company/${encodeURIComponent(id)}?subscriptionSaved=1`;
  const redirectErr = (msg) => res.redirect(`/admin/company/${encodeURIComponent(id)}?subscriptionError=${encodeURIComponent(msg)}`);

  try {
    let company = dashboardDb.enabled ? await dashboardDb.getCompanyById(id) : null;
    if (!company) company = await api(`/api/companies/${encodeURIComponent(id)}`);

    const rules = parseJsonSafe(company.rulesJson || "{}", {});
    const validStatuses = ["Activa", "Inactiva", "Cancelada", "Suspendida"];
    const newStatus = validStatuses.includes(req.body.subscriptionStatus)
      ? req.body.subscriptionStatus
      : "Activa";

    const renew1m = String(req.body.renew1m || "").trim() === "1";

    let newEnd = "";
    if (renew1m) {
      // Renovar 1 mes desde hoy
      const base = new Date();
      base.setMonth(base.getMonth() + 1);
      newEnd = base.toISOString();
    } else {
      const dateInput = String(req.body.subscriptionCurrentEnd || "").trim();
      if (dateInput) {
        const parsed = new Date(dateInput);
        if (!isNaN(parsed.getTime())) newEnd = parsed.toISOString();
      }
    }

    rules.subscriptionStatus = renew1m ? "Activa" : newStatus;
    if (newEnd) {
      rules.subscriptionCurrentEnd = newEnd;
      rules.subscriptionRenewal = newEnd;
    }

    if (dashboardDb.enabled) {
      await dashboardDb.saveCompanyById(id, {
        name: company.name || id,
        prompt: company.prompt || "",
        catalogJson: company.catalogJson || "[]",
        rulesJson: JSON.stringify(rules),
      });
    } else {
      await api(`/api/companies/${encodeURIComponent(id)}/save`, {
        method: "POST",
        body: {
          name: company.name || id,
          prompt: company.prompt || "",
          catalogJson: company.catalogJson || "[]",
          rulesJson: JSON.stringify(rules),
        },
      });
    }
    adminCompaniesCache.updatedAt = 0;
    _clientCompanyCache.delete(String(id));
    return res.redirect(redirectBack);
  } catch (e) {
    return redirectErr(String(e?.message || e));
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
    let company = null;
    if (dashboardDb.enabled) {
      company = await dashboardDb.getCompanyById(id);
    }
    if (!company) {
      company = await api(`/api/companies/${encodeURIComponent(id)}`);
    }
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
    rules.botPhone = String(req.body.botPhone || "").trim();
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
      await assignClientPassword(rules, manualPassword);
    }

    const nextName = String(req.body.name || company.name || id).trim() || id;
    const nextPrompt = buildPromptFromBrandContext({
      companyName: nextName,
      brandManual: rules.brandManual,
      companyPurpose: rules.companyPurpose,
      fallbackPrompt: company.prompt || "",
    });

    if (dashboardDb.enabled) {
      await dashboardDb.saveCompanyById(id, {
        name: nextName,
        prompt: nextPrompt,
        catalogJson: company.catalogJson || "[]",
        rulesJson: JSON.stringify(rules),
      });
    } else {
      await api(`/api/companies/${encodeURIComponent(id)}/save`, {
        method: "POST",
        body: {
          name: nextName,
          prompt: nextPrompt,
          catalogJson: company.catalogJson || "[]",
          rulesJson: JSON.stringify(rules),
        },
      });
    }
    adminCompaniesCache.updatedAt = 0;

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
    let company = null;
    if (dashboardDb.enabled) {
      company = await dashboardDb.getCompanyById(id);
    }
    if (!company) {
      company = await api(`/api/companies/${encodeURIComponent(id)}`);
    }
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

    if (dashboardDb.enabled) {
      await dashboardDb.saveCompanyById(id, {
        name: company.name || id,
        prompt: company.prompt || "",
        catalogJson: company.catalogJson || "[]",
        rulesJson: JSON.stringify(rules),
      });
    } else {
      await api(`/api/companies/${encodeURIComponent(id)}/save`, {
        method: "POST",
        body: {
          name: company.name || id,
          prompt: company.prompt || "",
          catalogJson: company.catalogJson || "[]",
          rulesJson: JSON.stringify(rules),
        },
      });
    }
    adminCompaniesCache.updatedAt = 0;

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
    let company = null;
    if (dashboardDb.enabled) {
      company = await dashboardDb.getCompanyById(id);
    }
    if (!company) {
      company = await api(`/api/companies/${encodeURIComponent(id)}`);
    }
    const rulesRaw = parseJsonSafe(company.rulesJson || "{}", {});
    const rules = rulesRaw && typeof rulesRaw === "object" ? rulesRaw : {};
    await assignClientPassword(rules, nextPassword);

    if (dashboardDb.enabled) {
      await dashboardDb.saveCompanyById(id, {
        name: company.name || id,
        prompt: company.prompt || "",
        catalogJson: company.catalogJson || "[]",
        rulesJson: JSON.stringify(rules),
      });
    } else {
      await api(`/api/companies/${encodeURIComponent(id)}/save`, {
        method: "POST",
        body: {
          name: company.name || id,
          prompt: company.prompt || "",
          catalogJson: company.catalogJson || "[]",
          rulesJson: JSON.stringify(rules),
        },
      });
    }
    adminCompaniesCache.updatedAt = 0;

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
    const { items: companies } = await loadAdminCompanies({ allowStale: true, preferCache: true });
    const mappings = dashboardDb.enabled
      ? await dashboardDb.getAssignments()
      : await api("/api/assignments");

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
    if (dashboardDb.enabled) {
      await dashboardDb.saveAssignment(req.body.fromNumber, req.body.companyId);
    } else {
      await api("/api/assignments", {
        method: "POST",
        body: {
          fromNumber: req.body.fromNumber,
          companyId: req.body.companyId,
        }
      });
    }
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
    if (dashboardDb.enabled) {
      await dashboardDb.deleteAssignment(req.body.fromNumber);
    } else {
      await api("/api/assignments/delete", { method: "POST", body: { fromNumber: req.body.fromNumber } });
    }
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

    const { items: companies } = await loadAdminCompanies({ allowStale: true, preferCache: true });
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

    const renderMsg = (msg) => {
      const readByAdmin = msg.sender === "client" ? !!msg.readByAdmin : !!msg.readByClient;
      return `
        <article class="admin-msg-item ${msg.sender === "admin" ? "from-admin" : "from-client"}">
          <div class="admin-msg-meta">
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
    };

    // Vista agrupada por empresa cuando no hay filtro de empresa
    const useGrouped = !companyFilter;
    let buzónHtml;

    if (useGrouped) {
      const groupMap = new Map();
      for (const msg of filtered) {
        if (!groupMap.has(msg.companyId)) {
          groupMap.set(msg.companyId, { companyId: msg.companyId, companyName: msg.companyName, msgs: [], unread: 0 });
        }
        const g = groupMap.get(msg.companyId);
        g.msgs.push(msg);
        if (msg.sender === "client" && !msg.readByAdmin) g.unread++;
      }
      const sortedGroups = [...groupMap.values()].sort((a, b) => {
        if (b.unread !== a.unread) return b.unread - a.unread;
        return new Date(b.msgs[0]?.createdAt || 0) - new Date(a.msgs[0]?.createdAt || 0);
      });
      buzónHtml = sortedGroups.length
        ? sortedGroups.map((g) => `
          <details class="admin-msg-group" ${g.unread > 0 ? "open" : ""}>
            <summary class="admin-msg-group-head">
              <span class="admin-msg-group-name">${escapeHtml(g.companyName)}</span>
              ${g.unread > 0 ? `<span class="admin-msg-group-badge">${g.unread} sin leer</span>` : ""}
              <span class="admin-msg-group-count">${g.msgs.length} mensaje${g.msgs.length !== 1 ? "s" : ""}</span>
              <a class="admin-msg-group-link" href="/admin/messages?companyId=${encodeURIComponent(g.companyId)}" onclick="event.stopPropagation()">Ver empresa →</a>
            </summary>
            <div class="admin-msg-group-body">
              <div class="admin-msg-list">${g.msgs.map(renderMsg).join("")}</div>
            </div>
          </details>`).join("")
        : `<div class="muted">Sin mensajes para este filtro.</div>`;
    } else {
      const rows = filtered.map(renderMsg).join("");
      buzónHtml = `<div class="admin-msg-list">${rows || `<div class="muted">Sin mensajes para este filtro.</div>`}</div>`;
    }

    const infoSaved = String(req.query.saved || "") === "1";
    const infoReplied = String(req.query.replied || "") === "1";
    const infoReset = String(req.query.reset || "") === "1";
    const resetUpdated = Number(req.query.updated || 0);
    const errorMsg = String(req.query.error || "").trim();

    const body = `
      ${infoSaved ? `<div class="card"><b>Mensaje actualizado.</b></div>` : ""}
      ${infoReplied ? `<div class="card"><b>Respuesta enviada a la empresa.</b></div>` : ""}
      ${infoReset ? `<div class="card"><b>Contadores reseteados.</b> Empresas actualizadas: ${Number.isFinite(resetUpdated) ? resetUpdated : 0}</div>` : ""}
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
        <form method="POST" action="/admin/messages/reset" style="margin-top:12px;display:flex;justify-content:flex-end">
          <button class="btn secondary" type="submit">Resetear sin leer a 0</button>
        </form>
      </div>

      <div class="card">
        <div class="admin-buzon-head">
          <h3 style="margin:0">Buzon ${useGrouped ? "<span class='admin-buzon-mode'>agrupado por empresa</span>" : ""}</h3>
          ${!useGrouped ? `<a class="btn secondary small" href="/admin/messages">Ver todas las empresas</a>` : ""}
        </div>
        <div class="admin-buzon-body">${buzónHtml}</div>
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

app.post("/admin/messages/reset", requireDashboardAuth, async (req, res) => {
  try {
    const { items: companies } = await loadAdminCompanies({ allowStale: true, preferCache: true });
    const companyList = Array.isArray(companies) ? companies : [];
    let updated = 0;

    for (const company of companyList) {
      const rulesRaw = parseJsonSafe(company?.rulesJson || "{}", {});
      const rules = rulesRaw && typeof rulesRaw === "object" ? rulesRaw : {};
      const inbox = extractAdminInbox(rules);
      if (!inbox.length) continue;

      let changed = false;
      const normalized = inbox.map((item) => {
        const next = { ...item, readByAdmin: true, readByClient: true };
        if (!item.readByAdmin || !item.readByClient) changed = true;
        return next;
      });
      if (!changed) continue;

      setAdminInbox(rules, normalized);
      await saveCompanyRules(company, rules);
      updated += 1;
    }

    return res.redirect(`/admin/messages?reset=1&updated=${updated}`);
  } catch (e) {
    return res.redirect(`/admin/messages?error=${encodeURIComponent(e?.message || e)}`);
  }
});

// ================= PEDIDOS + ESTADISTICAS + BUSCADOR + CSV =================
app.get("/admin/orders", requireDashboardAuth, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const filterCompanyId = String(req.query.companyId || "").trim();
    const limit = Math.min(Math.max(Number(req.query.limit || 50), 10), 200);

    // requiere backend /api/orders
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (filterCompanyId) params.set("companyId", filterCompanyId);
    params.set("limit", String(limit));

    const [orders, companiesResult] = await Promise.all([
      api(`/api/orders?${params.toString()}`),
      loadAdminCompanies({ preferCache: true }),
    ]);
    const companies = companiesResult.items || [];

    const totalOrders = orders.length;
    const totalRevenue = orders.reduce((acc, o) => acc + Number(o.total || 0), 0);
    const avgTicket = totalOrders ? (totalRevenue / totalOrders) : 0;

    const cards = `
      <div class="kpis">
        <div class="kpi"><div class="label">📦 Pedidos</div><div class="value">${totalOrders}</div><div class="hint">en este listado</div></div>
        <div class="kpi"><div class="label">💸 Ventas totales</div><div class="value">$${Math.round(totalRevenue).toLocaleString("es-AR")}</div><div class="hint">suma de totales</div></div>
        <div class="kpi"><div class="label">🎯 Ticket promedio</div><div class="value">$${Math.round(avgTicket).toLocaleString("es-AR")}</div><div class="hint">por pedido</div></div>
        <div class="kpi"><div class="label">✅ Con pago</div><div class="value">${orders.filter(o => ["paid","pagado","transferencia","efectivo"].includes(String(o.paymentStatus||o.orderStatus||"").toLowerCase())).length}</div><div class="hint">estado pago confirmado</div></div>
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
          <div class="grid2" style="margin-top:8px">
            <div>
              <label>Empresa</label>
              <select name="companyId">
                <option value="">Todas las empresas</option>
                ${companies.map(c => `<option value="${escapeHtml(c.id)}" ${c.id === filterCompanyId ? "selected" : ""}>${escapeHtml(c.name || c.id)}</option>`).join("")}
              </select>
            </div>
          </div>
          <div class="actions" style="display:flex;gap:10px;flex-wrap:wrap;margin-top:8px">
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

function renderClientLoginPage({ reset = false } = {}) {
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
        ${reset ? `<p style="color:#22c55e;font-weight:600;margin-bottom:12px">Contraseña actualizada. Ya podés ingresar.</p>` : ""}

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
    let companyId = "";
    let access = { enabled: true, mode: "full" };

    if (dashboardDb.enabled) {
      const company = await dashboardDb.findCompanyByIdentifier(companyInput);
      if (!company) {
        return res.status(401).send("Empresa no encontrada o credenciales incorrectas");
      }
      const rules = parseJsonSafe(company.rulesJson || "{}", {});
      const expectedPassword = String(resolveClientPassword(rules, company) || "").trim();
      if (!expectedPassword) {
        return res.status(400).send("La empresa no tiene password de cliente configurada");
      }
      if (expectedPassword !== pass) {
        return res.status(401).send("Empresa no encontrada o credenciales incorrectas");
      }
      companyId = String(company.id || "").trim();
      access = extractDashboardAccessFromRules(rules);
    } else {
      const auth = await api("/api/client-auth", {
        method: "POST",
        body: {
          companyId: companyInput,
          password: pass,
        },
      });
      companyId = String(auth?.companyId || "").trim();
      access = auth?.access && typeof auth.access === "object"
        ? auth.access
        : { enabled: true, mode: "full" };
    }

    if (!companyId) {
      return res.status(401).send("Empresa no encontrada o credenciales incorrectas");
    }
    const nextPath = canAccessClientSection(access, "inicio")
      ? "/panel"
      : canAccessClientSection(access, "catalogo")
        ? "/panel/catalogo"
        : "/panel";

    setCookie(res, "client", `${companyId}.${signClient(companyId)}`);
    return res.redirect(nextPath);
  } catch (e) {
    const message = String(e?.message || "").trim();
    if (message) {
      if (/password de cliente/i.test(message)) return res.status(400).send(message);
      if (/credenciales|empresa no encontrada/i.test(message)) return res.status(401).send(message);
    }
    return res.status(503).send("No se pudo validar el acceso en este momento");
  }
}

function toNumber(value) {
  const n = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function normalizeCatalogHeader(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function cleanCatalogText(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function isCatalogTextDefined(value) {
  const raw = cleanCatalogText(value).toLowerCase();
  return !!raw && !["-", "n/a", "na", "null", "undefined", "sin dato", "s/d"].includes(raw);
}

function splitCatalogTags(value) {
  if (Array.isArray(value)) {
    const unique = [];
    const seen = new Set();
    for (const rawTag of value) {
      const tag = cleanCatalogText(rawTag);
      if (!isCatalogTextDefined(tag)) continue;
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(tag);
    }
    return unique;
  }

  const text = cleanCatalogText(value);
  if (!isCatalogTextDefined(text)) return [];
  const unique = [];
  const seen = new Set();
  for (const part of text.split(/[|,;]+/g)) {
    const tag = cleanCatalogText(part);
    if (!isCatalogTextDefined(tag)) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(tag);
  }
  return unique;
}

function buildCatalogCategoryPath(partsRaw = []) {
  const parts = [];
  const seen = new Set();
  for (const rawPart of partsRaw) {
    const part = cleanCatalogText(rawPart);
    if (!isCatalogTextDefined(part)) continue;
    const key = part.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(part);
  }
  return parts.length ? parts.join(" > ") : "-";
}

function normalizeCatalogItemRecord(itemRaw, idx = 0, previousRaw = null) {
  const item = itemRaw && typeof itemRaw === "object" ? itemRaw : {};
  const previous = previousRaw && typeof previousRaw === "object" ? previousRaw : {};

  const rubro = cleanCatalogText(item.rubro ?? item.segment ?? previous.rubro ?? "");
  const seccion = cleanCatalogText(item.seccion ?? item.section ?? previous.seccion ?? "");
  const subseccion = cleanCatalogText(item.subseccion ?? item.subsection ?? previous.subseccion ?? "");
  const categoryDirect = cleanCatalogText(item.category ?? item.type ?? previous.category ?? previous.type ?? "");
  const category = isCatalogTextDefined(categoryDirect)
    ? categoryDirect
    : buildCatalogCategoryPath([rubro, seccion, subseccion]);

  const idRaw = cleanCatalogText(item.id ?? previous.id ?? "");
  const nameRaw = cleanCatalogText(item.name ?? item.title ?? previous.name ?? previous.title ?? "");
  const stockRaw = cleanCatalogText(item.stock ?? item.qty ?? previous.stock ?? previous.qty ?? "-");
  const skuRaw = cleanCatalogText(item.sku ?? item.codigo ?? previous.sku ?? previous.codigo ?? "");
  const colorRaw = cleanCatalogText(item.color ?? previous.color ?? "");
  const talleRaw = cleanCatalogText(item.talle ?? item.size ?? previous.talle ?? previous.size ?? "");
  const descriptionRaw = cleanCatalogText(
    item.description ??
    item.descripcion ??
    item.details ??
    item.detail ??
    item.summary ??
    previous.description ??
    previous.descripcion ??
    previous.details ??
    ""
  );

  const tags = splitCatalogTags(item.tags ?? item.tag ?? previous.tags ?? previous.tag ?? "");
  const normalized = {
    id: idRaw || String(idx + 1),
    name: nameRaw || `Producto ${idx + 1}`,
    price: toNumber(item.price ?? item.amount ?? previous.price ?? previous.amount ?? 0),
    stock: isCatalogTextDefined(stockRaw) ? stockRaw : "-",
    category,
  };

  if (isCatalogTextDefined(rubro)) normalized.rubro = rubro;
  if (isCatalogTextDefined(seccion)) normalized.seccion = seccion;
  if (isCatalogTextDefined(subseccion)) normalized.subseccion = subseccion;
  if (isCatalogTextDefined(skuRaw)) normalized.sku = skuRaw;
  if (isCatalogTextDefined(colorRaw)) normalized.color = colorRaw;
  if (isCatalogTextDefined(talleRaw)) normalized.talle = talleRaw;
  if (isCatalogTextDefined(descriptionRaw)) normalized.description = descriptionRaw;
  if (tags.length) normalized.tags = tags;

  return normalized;
}

function parseCatalogPrice(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return 0;
  const cleaned = raw.replace(/[^\d,.-]/g, "");
  if (!cleaned) return 0;

  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  let normalized = cleaned;
  if (lastComma > lastDot) {
    normalized = cleaned.replace(/\./g, "").replace(",", ".");
  } else {
    normalized = cleaned.replace(/,/g, "");
  }
  const amount = Number(normalized);
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : NaN;
}

function getCatalogFieldByHeader(row, aliases) {
  if (!row || typeof row !== "object") return "";
  const entries = Object.entries(row);
  for (const [key, value] of entries) {
    const normalizedKey = normalizeCatalogHeader(key);
    if (aliases.some((alias) => normalizedKey === alias || normalizedKey.includes(alias))) {
      return value;
    }
  }
  return "";
}

function extractCatalogItemsFromSheet(sheet) {
  const aliases = {
    id: ["id", "codigo", "codigoproducto", "sku", "code"],
    name: ["producto", "nombre", "name", "item", "producto_variante"],
    price: ["precio", "price", "monto", "valor", "importe"],
    stock: ["stock", "cantidad", "existencia", "qty"],
    category: ["categoria", "category", "rubro", "tipo"],
    rubro: ["rubro", "segmento", "linea", "familia"],
    seccion: ["seccion", "seccion1", "seccion2", "categoria2"],
    subseccion: ["subseccion", "subcategoria", "subrubro", "sublinea"],
    talle: ["talle", "size", "tamano", "tamaño"],
    color: ["color", "variantcolor", "colores"],
    sku: ["sku", "codigointerno", "codigo_sku", "codigoitem"],
    description: ["descripcion", "detalle", "description", "resumen"],
    tags: ["tags", "etiquetas", "keywords", "palabrasclave"],
  };

  const rowsAsObjects = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
  const items = [];

  for (let idx = 0; idx < rowsAsObjects.length; idx += 1) {
    const row = rowsAsObjects[idx];
    const idRaw = String(getCatalogFieldByHeader(row, aliases.id) || "").trim();
    const nameRaw = String(getCatalogFieldByHeader(row, aliases.name) || "").trim();
    const priceRaw = getCatalogFieldByHeader(row, aliases.price);
    const stockRaw = String(getCatalogFieldByHeader(row, aliases.stock) || "").trim();
    const categoryRaw = String(getCatalogFieldByHeader(row, aliases.category) || "").trim();
    const rubroRaw = String(getCatalogFieldByHeader(row, aliases.rubro) || "").trim();
    const seccionRaw = String(getCatalogFieldByHeader(row, aliases.seccion) || "").trim();
    const subseccionRaw = String(getCatalogFieldByHeader(row, aliases.subseccion) || "").trim();
    const talleRaw = String(getCatalogFieldByHeader(row, aliases.talle) || "").trim();
    const colorRaw = String(getCatalogFieldByHeader(row, aliases.color) || "").trim();
    const skuRaw = String(getCatalogFieldByHeader(row, aliases.sku) || "").trim();
    const descriptionRaw = String(getCatalogFieldByHeader(row, aliases.description) || "").trim();
    const tagsRaw = getCatalogFieldByHeader(row, aliases.tags);
    const categoryComputed = isCatalogTextDefined(categoryRaw)
      ? categoryRaw
      : buildCatalogCategoryPath([rubroRaw, seccionRaw, subseccionRaw]);
    const hasData = idRaw || nameRaw || String(priceRaw || "").trim() || stockRaw || categoryComputed !== "-" || skuRaw || descriptionRaw || talleRaw || colorRaw;
    if (!hasData) continue;

    const price = parseCatalogPrice(priceRaw);
    if (!Number.isFinite(price) || price < 0) {
      throw new Error(`Precio invalido en fila ${idx + 2}`);
    }

    items.push(normalizeCatalogItemRecord({
      id: idRaw,
      name: nameRaw,
      price,
      stock: stockRaw || "-",
      category: categoryComputed,
      rubro: rubroRaw,
      seccion: seccionRaw,
      subseccion: subseccionRaw,
      talle: talleRaw,
      color: colorRaw,
      sku: skuRaw,
      description: descriptionRaw,
      tags: tagsRaw,
    }, idx));
  }

  if (items.length) return items;

  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
  if (!Array.isArray(matrix) || !matrix.length) return [];

  const flatAliases = new Set(Object.values(aliases).flat());
  const firstRow = Array.isArray(matrix[0]) ? matrix[0] : [];
  const looksLikeHeader = firstRow.some((cell) => flatAliases.has(normalizeCatalogHeader(cell)));
  const dataRows = matrix.slice(looksLikeHeader ? 1 : 0);
  const fallbackItems = [];

  for (let idx = 0; idx < dataRows.length; idx += 1) {
    const row = Array.isArray(dataRows[idx]) ? dataRows[idx] : [];
    const idRaw = String(row[0] || "").trim();
    const nameRaw = String(row[1] || "").trim();
    const priceRaw = row[2];
    const stockRaw = String(row[3] || "").trim();
    const categoryRaw = String(row[4] || "").trim();
    const rubroRaw = String(row[5] || "").trim();
    const seccionRaw = String(row[6] || "").trim();
    const subseccionRaw = String(row[7] || "").trim();
    const talleRaw = String(row[8] || "").trim();
    const colorRaw = String(row[9] || "").trim();
    const skuRaw = String(row[10] || "").trim();
    const descriptionRaw = String(row[11] || "").trim();
    const tagsRaw = row[12];
    const categoryComputed = isCatalogTextDefined(categoryRaw)
      ? categoryRaw
      : buildCatalogCategoryPath([rubroRaw, seccionRaw, subseccionRaw]);
    const hasData = idRaw || nameRaw || String(priceRaw || "").trim() || stockRaw || categoryComputed !== "-" || talleRaw || colorRaw || skuRaw || descriptionRaw;
    if (!hasData) continue;

    const price = parseCatalogPrice(priceRaw);
    if (!Number.isFinite(price) || price < 0) {
      throw new Error(`Precio invalido en fila ${idx + 1 + (looksLikeHeader ? 2 : 1)}`);
    }

    fallbackItems.push(normalizeCatalogItemRecord({
      id: idRaw,
      name: nameRaw,
      price,
      stock: stockRaw || "-",
      category: categoryComputed,
      rubro: rubroRaw,
      seccion: seccionRaw,
      subseccion: subseccionRaw,
      talle: talleRaw,
      color: colorRaw,
      sku: skuRaw,
      description: descriptionRaw,
      tags: tagsRaw,
    }, idx));
  }
  return fallbackItems;
}

function buildSupportMessageSubject(item) {
  const explicit = String(item?.subject || "").trim();
  if (explicit) return explicit;
  const firstLine = String(item?.text || "").split(/\r?\n/)[0].trim();
  const shortLine = firstLine ? firstLine.slice(0, 100) : "";
  const orderId = String(item?.orderId || "").trim();
  if (orderId && shortLine) return `Pedido ${orderId}: ${shortLine}`;
  if (orderId) return `Consulta sobre pedido ${orderId}`;
  if (shortLine) return shortLine;
  return item?.sender === "admin" ? "Respuesta del admin" : "Consulta de soporte";
}

const SUPPORTED_CURRENCIES = ["ARS", "USD", "EUR", "GBP", "BRL"];

function normalizeSupportedCurrency(value, fallback = "USD") {
  const raw = String(value || "").trim().toUpperCase();
  if (SUPPORTED_CURRENCIES.includes(raw)) return raw;
  return fallback;
}

function formatMoney(value, currency = "USD") {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "-";
  const safeCurrency = normalizeSupportedCurrency(currency, "USD");
  try {
    return new Intl.NumberFormat("es-AR", {
      style: "currency",
      currency: safeCurrency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${safeCurrency} ${Math.round(amount)}`;
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
  return catalogBase.map((item, idx) => normalizeCatalogItemRecord(item, idx));
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
    botPhone: String(rules?.botPhone || rules?.whatsappBotPhone || ""),
    companyAddress: String(rules?.companyAddress || rules?.address || ""),
    companyCity: String(rules?.companyCity || rules?.city || ""),
    companyCountry: String(rules?.companyCountry || rules?.country || ""),
  };
}

function toCheckedFlag(value) {
  if (value === true) return true;
  const raw = String(value || "").trim().toLowerCase();
  return ["1", "true", "on", "si", "yes"].includes(raw);
}

function extractPaymentSettings(rulesRaw) {
  const rules = rulesRaw && typeof rulesRaw === "object" ? rulesRaw : {};
  const methods = rules.paymentMethods && typeof rules.paymentMethods === "object"
    ? rules.paymentMethods
    : {};
  const transferRaw = rules.paymentTransfer && typeof rules.paymentTransfer === "object"
    ? rules.paymentTransfer
    : {};

  const payment = {
    cash: toCheckedFlag(methods.cash ?? methods.efectivo ?? rules.paymentCash ?? rules.paymentEfectivo),
    debit: toCheckedFlag(methods.debit ?? methods.debito ?? rules.paymentDebit ?? rules.paymentDebito),
    transfer: toCheckedFlag(
      methods.transfer ??
      methods.transferencia ??
      rules.paymentTransferEnabled ??
      rules.paymentTransfer
    ),
    credit: toCheckedFlag(methods.credit ?? methods.credito ?? rules.paymentCredit ?? rules.paymentCredito),
    transferBankName: String(transferRaw.bankName || rules.paymentTransferBankName || rules.paymentTransferBank || "").trim(),
    transferAccountHolder: String(
      transferRaw.accountHolder ||
      rules.paymentTransferAccountHolder ||
      rules.razonSocial ||
      rules.businessName ||
      ""
    ).trim(),
    transferTaxId: String(
      transferRaw.taxId ||
      rules.paymentTransferTaxId ||
      rules.paymentTransferCuit ||
      rules.cuit ||
      rules.taxId ||
      ""
    ).trim(),
    transferCbu: String(transferRaw.cbu || rules.paymentTransferCbu || rules.cbu || "").trim(),
    transferAlias: String(transferRaw.alias || rules.paymentTransferAlias || rules.alias || "").trim(),
    transferAccountType: String(transferRaw.accountType || rules.paymentTransferAccountType || "").trim(),
    transferNote: String(transferRaw.note || rules.paymentTransferNote || "").trim(),
    instructions: String(rules.paymentInstructions || rules.paymentPublicNote || "").trim(),
  };

  if (
    payment.transferCbu ||
    payment.transferAlias ||
    payment.transferAccountHolder ||
    payment.transferBankName
  ) {
    payment.transfer = true;
  }

  return payment;
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

async function assignClientPassword(rules, password) {
  const normalized = String(password || "").trim();
  if (!normalized || !rules || typeof rules !== "object") return;
  const hash = await bcrypt.hash(normalized, 10);
  rules.clientPassword = hash;
  // Limpiar claves legado para no guardar texto plano
  delete rules.clientPass;
  delete rules.password;
  delete rules.pass;
  delete rules.accessPassword;
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
    currency: normalizeSupportedCurrency(
      rules.catalogCurrency ||
      company?.subscriptionCurrency ||
      rules.subscriptionCurrency ||
      "USD"
    ),
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

function renderClientPage({ company, active, title, subtitle, bodyHtml, dashboardAccess, showIntegrationsNav = false }) {
  const access = dashboardAccess || getDashboardAccessForCompany(company);
  const companyRules = parseJsonSafe(company?.rulesJson || "{}", {});
  const subStatus = String(companyRules?.subscriptionStatus || "Activa").trim().toLowerCase();
  const subEnd = companyRules?.subscriptionCurrentEnd;
  const subExpired = subEnd ? (new Date(subEnd) < new Date()) : false;
  const subInactive = ["inactiva", "cancelada", "suspendida", "inactive", "cancelled", "canceled", "suspended"].includes(subStatus);
  const subBanner = (subInactive || subExpired) ? `
    <div class="cp-subscription-banner" role="alert">
      <span>⚠️ Tu suscripcion esta <strong>${subInactive ? "inactiva" : "vencida"}</strong>. El bot no está respondiendo actualmente.</span>
      ${active !== "cuenta" ? `<a href="/panel/cuenta" class="cp-sub-banner-link">Ir a Cuenta →</a>` : ""}
    </div>
  ` : "";
  const supportUnread = getClientUnreadNotificationCount(company);
  const nav = [
    { key: "inicio", label: "Resumen", href: "/panel" },
    { key: "catalogo", label: "Catalogo", href: "/panel/catalogo" },
    { key: "pedidos", label: "Pedidos", href: "/panel/pedidos" },
    { key: "conversaciones", label: "Conversaciones", href: "/panel/conversaciones" },
  ];
  if (showIntegrationsNav) {
    nav.push({ key: "integraciones", label: "Integraciones", href: "/panel/integraciones" });
  }

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
    <body class="client-ui client-saas-ui">
      <div class="cp-shell">
        <aside class="cp-sidebar">
          <div class="cp-brand">
            <img src="/img/logo.png" alt="BabySteps" onerror="this.style.display='none'" />
            <div>
              <div class="cp-brand-title">${escapeHtml(company?.name || company?.id || "Panel")}</div>
              <div class="cp-brand-sub">Panel de cliente</div>
            </div>
            <a class="cp-account-gear ${active === "cuenta" ? "active" : ""}" href="/panel/cuenta" title="Cuenta y configuracion" aria-label="Cuenta y configuracion">&#9881;</a>
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
              <div class="cp-header-icon-stack">
                ${renderSupportToolIcon({ href: "/panel/soporte#cp-inbox", count: supportUnread, className: `cp-tool-bell ${active === "soporte" ? "active" : ""}`, title: "Soporte con admin" })}
                ${renderNotificationBell({ href: "/panel/conversaciones", count: 0, className: "cp-notify-bell", title: "Notificaciones" })}
              </div>
              <div class="cp-header-visual" aria-hidden="true"></div>
            </div>
          </header>
          ${subBanner}
          ${bodyHtml}
        </main>
      </div>
      <script>
      (function() {
        var POLL_MS = 30000;
        var STORAGE_KEY = 'bs_orders_viewed_at';
        var bell = document.querySelector('.cp-notify-bell');
        var isOnPedidos = window.location.pathname === '/panel/pedidos';

        function setCount(n) {
          if (!bell) return;
          var badge = bell.querySelector('.notify-badge');
          if (n > 0) {
            if (!badge) { badge = document.createElement('span'); badge.className = 'notify-badge'; bell.appendChild(badge); }
            badge.textContent = n > 99 ? '99+' : n;
            bell.setAttribute('title', n + ' pedido' + (n === 1 ? '' : 's') + ' nuevo' + (n === 1 ? '' : 's'));
          } else {
            if (badge) badge.remove();
            bell.setAttribute('title', 'Notificaciones');
          }
        }

        function getViewedAt() {
          var v = localStorage.getItem(STORAGE_KEY);
          if (v) return v;
          return new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
        }

        function poll() {
          var since = getViewedAt();
          fetch('/panel/api/new-orders?since=' + encodeURIComponent(since))
            .then(function(r) { return r.ok ? r.json() : { count: 0 }; })
            .then(function(d) { setCount(d.count || 0); })
            .catch(function() {});
        }

        if (isOnPedidos) {
          localStorage.setItem(STORAGE_KEY, new Date().toISOString());
          setCount(0);
        } else {
          poll();
          setInterval(poll, POLL_MS);
        }
      })();
      </script>
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
  return ["catalogo", "suscripcion", "cuenta", "soporte", "conversaciones", "integraciones"].includes(sectionKey);
}

function renderClientAccessDeniedPage({ company, sectionKey, dashboardAccess }) {
  const labelMap = {
    inicio: "Resumen",
    pedidos: "Pedidos",
    soporte: "Soporte",
    conversaciones: "Conversaciones",
    integraciones: "Integraciones",
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
    showIntegrationsNav: !!company?.__hasClientIntegrations,
  });
}

async function loadClientIntegrationFlag(req, res, next) {
  const companyId = String(req.company?.id || "").trim();
  req.clientHasIntegrations = false;
  req.company.__hasClientIntegrations = false;
  if (!companyId) return next();

  const cached = getCachedClientIntegrationFlag(companyId);
  if (cached !== null) {
    req.clientHasIntegrations = cached;
    req.company.__hasClientIntegrations = cached;
    return next();
  }

  try {
    const payload = await api(`/api/companies/${encodeURIComponent(companyId)}/integrations`);
    const items = Array.isArray(payload?.items) ? payload.items : [];
    const hasEnabled = items.some((item) => item && item.enabled !== false);
    setCachedClientIntegrationFlag(companyId, hasEnabled);
    req.clientHasIntegrations = hasEnabled;
    req.company.__hasClientIntegrations = hasEnabled;
  } catch {
    req.clientHasIntegrations = false;
    req.company.__hasClientIntegrations = false;
  }
  return next();
}

async function fetchClientIntegrationModules(companyId) {
  try {
    const integrationRender = await api(`/api/companies/${encodeURIComponent(companyId)}/integrations/render`);
    return Array.isArray(integrationRender?.modules) ? integrationRender.modules : [];
  } catch {
    return [];
  }
}

function renderClientIntegrationModulesSection(integrationModules) {
  const moduleCount = integrationModules.length;
  const alertCount = integrationModules.reduce((acc, module) => acc + (Array.isArray(module?.alerts) ? module.alerts.length : 0), 0);
  const tableCount = integrationModules.reduce((acc, module) => acc + (module?.table && Array.isArray(module.table.rows) && module.table.rows.length ? 1 : 0), 0);
  const integrationCards = integrationModules.flatMap((module) => {
    const cards = Array.isArray(module?.cards) ? module.cards : [];
    return cards.map((card) => `
      <article class="cp-stat cp-performance-stat cp-integration-stat ${normalizeIntegrationToneClass(card.tone)}">
        <div class="cp-integration-chip">${escapeHtml(module.name || module.provider || "Integracion")}</div>
        <div class="cp-stat-label">${escapeHtml(card.title || "Indicador")}</div>
        <div class="cp-stat-value">${escapeHtml(String(card.value ?? "-"))}</div>
        <div class="cp-stat-hint">dato sincronizado en vivo</div>
      </article>
    `);
  }).join("");
  const integrationAlerts = integrationModules.flatMap((module) => {
    const items = Array.isArray(module?.alerts) ? module.alerts : [];
    return items.map((text) => `
      <li class="cp-alert-line warning">
        <span class="cp-alert-line-icon" aria-hidden="true">!</span>
        <span><b>${escapeHtml(module.name || module.provider || "Integracion")}:</b> ${escapeHtml(text)}</span>
      </li>
    `);
  }).join("");
  const integrationErrors = integrationModules
    .filter((module) => String(module?.error || "").trim())
    .map((module) => `
      <li class="cp-alert-line danger">
        <span class="cp-alert-line-icon" aria-hidden="true">!</span>
        <span><b>${escapeHtml(module.name || module.provider || "Integracion")}:</b> ${escapeHtml(String(module.error || ""))}</span>
      </li>
    `).join("");
  const integrationTables = integrationModules
    .filter((module) => module?.table && Array.isArray(module.table.columns) && Array.isArray(module.table.rows) && module.table.rows.length)
    .map((module) => {
      const columns = module.table.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("");
      const rowsHtml = module.table.rows.map((row) => `
        <tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>
      `).join("");
      return `
        <article class="cp-card cp-span-3 cp-overview-block cp-integration-table-card">
          <div class="cp-card-head">
            <h3>${escapeHtml(module.table.title || module.name || "Tabla externa")}</h3>
            <span class="cp-integration-chip subtle">${escapeHtml(module.name || module.provider || "Integracion")}</span>
          </div>
          <div class="cp-table-wrap">
            <table class="cp-table cp-conv-table">
              <thead><tr>${columns}</tr></thead>
              <tbody>${rowsHtml}</tbody>
            </table>
          </div>
        </article>
      `;
    }).join("");
  if (!(integrationCards || integrationAlerts || integrationErrors || integrationTables)) {
    return `
      <section class="cp-grid">
        <article class="cp-card cp-span-3 cp-overview-block cp-integrations-empty">
          <div class="cp-card-head">
            <h3>🧩 Integraciones</h3>
            <span>sin modulos activos</span>
          </div>
          <p class="cp-note">No hay integraciones activas o todavia no devolvieron datos para mostrar en este dashboard.</p>
        </article>
      </section>
    `;
  }
  return `
    <section class="cp-grid cp-overview-grid">
      <article class="cp-card cp-span-3 cp-overview-heading-card cp-integrations-hero">
        <div class="cp-card-head">
          <h3>🧩 Integraciones conectadas</h3>
          <span>${moduleCount} modulos</span>
        </div>
        <p class="cp-note">Este modulo muestra datos externos privados de tu empresa conectados en tiempo real.</p>
        <div class="cp-integrations-meta">
          <div class="cp-integrations-meta-item">
            <span>Modulos</span>
            <b>${moduleCount}</b>
          </div>
          <div class="cp-integrations-meta-item">
            <span>Alertas</span>
            <b>${alertCount}</b>
          </div>
          <div class="cp-integrations-meta-item">
            <span>Tablas</span>
            <b>${tableCount}</b>
          </div>
        </div>
      </article>

      ${integrationCards ? `<section class="cp-stats cp-span-3 cp-performance-stats-grid">${integrationCards}</section>` : ""}

      ${(integrationAlerts || integrationErrors) ? `
        <article class="cp-card cp-span-3 cp-overview-block cp-alerts-panel cp-tone-amber-soft cp-integrations-alerts">
          <div class="cp-card-head">
            <h3>⚠️ Alertas externas</h3>
            <span>integraciones</span>
          </div>
          <ul class="cp-alert-lines">
            ${integrationAlerts || ""}
            ${integrationErrors || ""}
          </ul>
        </article>
      ` : ""}

      ${integrationTables}
    </section>
  `;
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
  const reset = String(req.query.reset || "") === "1";
  res.type("text/html").send(renderClientLoginPage({ reset }));
});
app.get("/c/login", (req, res) => {
  const reset = String(req.query.reset || "") === "1";
  res.type("text/html").send(renderClientLoginPage({ reset }));
});

function renderForgotPage({ error = "", success = false } = {}) {
  return `<!doctype html>
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
        ${success
          ? `<p style="color:#22c55e;font-weight:600">Si el email esta registrado, recibirás un link para restablecer tu contraseña en los próximos minutos.</p>`
          : `<p class="muted">Ingresá el email con el que te registraste. Te enviamos un link para crear una nueva contraseña.</p>
             ${error ? `<p style="color:#f87171;font-size:13px">${escapeHtml(error)}</p>` : ""}
             <form method="POST" action="/panel/forgot" class="form" style="margin-top:16px">
               <input name="email" type="email" placeholder="tu@email.com" required autocomplete="email" style="margin-bottom:12px" />
               <div class="login-actions">
                 <button class="btn primary" type="submit">Enviar link</button>
                 <a class="btn secondary" href="/panel/login">Volver</a>
               </div>
             </form>`
        }
        ${success ? `<div class="login-actions" style="margin-top:16px"><a class="btn secondary" href="/panel/login">Volver al login</a></div>` : ""}
      </div>
    </div>
  </body>
</html>`;
}

app.get("/panel/forgot", (req, res) => res.type("text/html").send(renderForgotPage()));
app.get("/c/forgot", (req, res) => res.redirect("/panel/forgot"));

app.post("/panel/forgot", clientLoginLimiter, async (req, res) => {
  const emailInput = String(req.body.email || "").trim().toLowerCase();
  if (!emailInput) return res.type("text/html").send(renderForgotPage({ error: "Ingresá tu email." }));

  try {
    // Buscar empresa por ownerEmail (sin confirmar si existe para evitar enumeración)
    const companies = await loadAdminCompanies({ preferCache: true });
    const match = (companies.items || []).find((c) => {
      const rules = parseJsonSafe(c.rulesJson || "{}", {});
      return String(rules?.ownerEmail || "").trim().toLowerCase() === emailInput;
    });

    if (match) {
      const rules = parseJsonSafe(match.rulesJson || "{}", {});
      const token = crypto.randomBytes(32).toString("hex");
      rules.pwdResetToken = token;
      rules.pwdResetTokenExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

      await saveCompanyRules(match, rules);
      _clientCompanyCache.delete(String(match.id));

      const baseUrl = `${req.protocol}://${req.get("host")}`;
      const resetLink = `${baseUrl}/panel/reset?token=${token}&cid=${encodeURIComponent(match.id)}`;

      sendEmail({
        to: emailInput,
        subject: "Restablecé tu contraseña de acceso al panel",
        html: `
          <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px">
            <h2 style="color:#1a1f36">Restablecé tu contraseña</h2>
            <p>Hola, recibimos una solicitud para restablecer la contraseña de <b>${escapeHtml(match.name || match.id)}</b>.</p>
            <p>Hacé click en el botón para crear una nueva contraseña. El link es válido por <b>1 hora</b>.</p>
            <div style="text-align:center;margin:28px 0">
              <a href="${resetLink}" style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">
                Restablecer contraseña
              </a>
            </div>
            <p style="color:#666;font-size:12px">Si no solicitaste esto, ignorá este mensaje. Tu contraseña no cambia.</p>
            <p style="color:#666;font-size:12px">O copiá este link: ${resetLink}</p>
          </div>
        `,
      }).catch((e) => console.error("[email] forgot password email failed:", e?.message));
    }
  } catch (e) {
    console.error("[forgot] error:", e?.message || e);
  }

  // Siempre responder igual para no revelar si el email existe
  return res.type("text/html").send(renderForgotPage({ success: true }));
});

app.get("/panel/reset", async (req, res) => {
  const token = String(req.query.token || "").trim();
  const cid = String(req.query.cid || "").trim();
  if (!token || !cid) return res.redirect("/panel/forgot");

  const company = await api(`/api/companies/${encodeURIComponent(cid)}`).catch(() => null);
  if (!company) return res.redirect("/panel/forgot");

  const rules = parseJsonSafe(company.rulesJson || "{}", {});
  const storedToken = String(rules?.pwdResetToken || "");
  const expiresAt = String(rules?.pwdResetTokenExpiresAt || "");
  const isValid = storedToken === token && expiresAt && new Date(expiresAt) > new Date();

  if (!isValid) {
    return res.type("text/html").send(`<!doctype html>
<html><head><meta charset="utf-8"><link rel="stylesheet" href="/dashboard.css"><title>Link expirado</title></head>
<body><div class="bs-login"><div class="bs-card">
  <h2 class="bs-h2">Link expirado</h2>
  <p class="muted">Este link ya fue usado o expiró. Solicitá uno nuevo.</p>
  <div class="login-actions"><a class="btn primary" href="/panel/forgot">Pedir nuevo link</a></div>
</div></div></body></html>`);
  }

  const errorMsg = String(req.query.error || "").trim();
  return res.type("text/html").send(`<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/dashboard.css"><title>Nueva contraseña</title></head>
<body>
  <div class="bs-login">
    <div class="bs-bg" style="background-image:url('/img/login-tech-bg.png')"></div>
    <div class="bs-vignette"></div>
    <div class="bs-card">
      <div class="bs-brand"><div class="bs-dot"></div><div><div class="bs-title">BabySteps</div><div class="bs-subtitle">Acceso clientes</div></div></div>
      <h2 class="bs-h2">Nueva contraseña</h2>
      <p class="muted">Empresa: <b>${escapeHtml(company.name || cid)}</b></p>
      ${errorMsg ? `<p style="color:#f87171;font-size:13px">${escapeHtml(errorMsg)}</p>` : ""}
      <form method="POST" action="/panel/reset" class="form" style="margin-top:16px">
        <input type="hidden" name="token" value="${escapeHtml(token)}" />
        <input type="hidden" name="cid" value="${escapeHtml(cid)}" />
        <label style="font-size:13px;margin-bottom:4px;display:block">Nueva contraseña</label>
        <input name="password" type="password" required minlength="6" placeholder="Mínimo 6 caracteres" style="margin-bottom:8px" />
        <label style="font-size:13px;margin-bottom:4px;display:block">Confirmar contraseña</label>
        <input name="password2" type="password" required minlength="6" placeholder="Repetí la contraseña" style="margin-bottom:16px" />
        <div class="login-actions">
          <button class="btn primary" type="submit">Guardar contraseña</button>
        </div>
      </form>
    </div>
  </div>
</body></html>`);
});

app.post("/panel/reset", async (req, res) => {
  const token = String(req.body.token || "").trim();
  const cid = String(req.body.cid || "").trim();
  const password = String(req.body.password || "").trim();
  const password2 = String(req.body.password2 || "").trim();
  const redirectBack = `/panel/reset?token=${encodeURIComponent(token)}&cid=${encodeURIComponent(cid)}`;

  if (!token || !cid) return res.redirect("/panel/forgot");
  if (!password || password.length < 6) return res.redirect(`${redirectBack}&error=${encodeURIComponent("La contraseña debe tener al menos 6 caracteres.")}`);
  if (password !== password2) return res.redirect(`${redirectBack}&error=${encodeURIComponent("Las contraseñas no coinciden.")}`);

  try {
    const company = await api(`/api/companies/${encodeURIComponent(cid)}`);
    const rules = parseJsonSafe(company.rulesJson || "{}", {});
    const storedToken = String(rules?.pwdResetToken || "");
    const expiresAt = String(rules?.pwdResetTokenExpiresAt || "");
    const isValid = storedToken === token && expiresAt && new Date(expiresAt) > new Date();

    if (!isValid) return res.redirect("/panel/forgot");

    await assignClientPassword(rules, password);
    delete rules.pwdResetToken;
    delete rules.pwdResetTokenExpiresAt;
    await saveCompanyRules(company, rules);
    _clientCompanyCache.delete(String(cid));

    return res.redirect("/panel/login?reset=1");
  } catch (e) {
    return res.redirect(`${redirectBack}&error=${encodeURIComponent("Error al guardar. Intentá de nuevo.")}`);
  }
});

app.post("/panel/login", clientLoginLimiter, handleClientLogin);
app.post("/c/login", clientLoginLimiter, handleClientLogin);

app.get("/panel", requireClientAuth, loadClientIntegrationFlag, requireClientSectionAccess("inicio"), async (req, res) => {
  const company = req.company;
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).toISOString();
  const [{ state }, monthlyOrders, weeklyOrders, msgStats] = await Promise.all([
    loadClientStateWithProvider(company),
    fetchCompanyOrders(company.id, monthStart, "", 500).catch(() => []),
    fetchCompanyOrders(company.id, weekStart, "", 500).catch(() => []),
    api(`/api/companies/${encodeURIComponent(company.id)}/whatsapp-messages/stats`).catch(() => ({ total: 0, last30Days: 0 })),
  ]);
  const profile = extractCompanyProfile(state.rules);
  const rules = parseJsonSafe(company.rulesJson || "{}", {});
  const planInfo = extractPlanInfo(company, rules);
  const aiDailyLimit = planInfo.tier === "PRO" ? 120 : planInfo.tier === "LITE" ? 40 : 0;
  const payment = extractPaymentSettings(rules);

  const monthlyCustomers = new Set(
    monthlyOrders
      .map((order) => String(order?.contact || order?.fromNumber || order?.name || "").trim().toLowerCase())
      .filter(Boolean)
  );
  const estimatedSales = monthlyOrders.reduce((acc, order) => acc + toNumber(order?.total), 0);
  const savedMinutes = (monthlyCustomers.size * 6) + (monthlyOrders.length * 14);
  const savedHours = savedMinutes > 0 ? (savedMinutes / 60) : 0;
  const monthlyLabel = now.toLocaleDateString("es-AR", { month: "long", year: "numeric" });
  const activitySeries = buildBotActivitySeries(weeklyOrders, 7);
  const alerts = buildOverviewAlerts({ state, payment, monthlyOrders });
  const activityRows = activitySeries.buckets.map((bucket) => `
    <div class="cp-activity-row">
      <span class="cp-activity-day">${escapeHtml(bucket.label)}</span>
      <div class="cp-activity-track">
        <div class="cp-activity-bar" style="width:${bucket.width}%"></div>
      </div>
      <span class="cp-activity-count">${bucket.count}</span>
    </div>
  `).join("");
  const alertRows = alerts.map((alert) => `
    <li class="cp-alert-line ${escapeHtml(alert.level)}">
      <span class="cp-alert-line-icon" aria-hidden="true">${alert.level === "ok" ? "✓" : "!"}</span>
      <span>${escapeHtml(alert.text)}</span>
    </li>
  `).join("");

  const hasCatalog = Array.isArray(state.catalog) && state.catalog.length > 0;
  const hasPayment = !!(payment.cash || payment.debit || payment.transfer || payment.mercadopago || payment.otro);
  const hasEmail = !!profile.ownerEmail;
  const onboardingSteps = [
    { done: hasCatalog, label: "Cargá tu catálogo de productos", href: "/panel/catalogo", hint: `${hasCatalog ? (state.catalog.length + " productos cargados") : "El bot necesita productos para tomar pedidos"}` },
    { done: hasPayment, label: "Configurá los métodos de pago", href: "/panel/cuenta", hint: hasPayment ? "Configurado" : "Indicá cómo aceptas pagos (efectivo, transferencia, etc.)" },
    { done: hasEmail, label: "Registrá tu email de notificaciones", href: "/panel/cuenta", hint: hasEmail ? profile.ownerEmail : "Recibí alertas de nuevos pedidos por email" },
  ];
  const onboardingPending = onboardingSteps.filter((s) => !s.done);
  const onboardingCard = onboardingPending.length > 0 ? `
    <article class="cp-card cp-span-3 cp-onboarding-card">
      <div class="cp-card-head">
        <h3>🎯 Primeros pasos</h3>
        <span>${onboardingPending.length} pendiente${onboardingPending.length === 1 ? "" : "s"}</span>
      </div>
      <p class="cp-note" style="margin-bottom:16px">Completá estos pasos para activar tu bot al 100%.</p>
      <ul class="cp-onboarding-list">
        ${onboardingSteps.map((step) => `
          <li class="cp-onboarding-step ${step.done ? "done" : "pending"}">
            <span class="cp-onboarding-icon">${step.done ? "✓" : "○"}</span>
            <div class="cp-onboarding-body">
              <span class="cp-onboarding-label">${escapeHtml(step.label)}</span>
              <span class="cp-onboarding-hint">${escapeHtml(step.hint)}</span>
            </div>
            ${!step.done ? `<a class="cp-btn primary" href="${step.href}">Completar</a>` : ""}
          </li>
        `).join("")}
      </ul>
    </article>
  ` : "";

  const bodyHtml = `
    <section class="cp-grid cp-overview-grid">
      ${onboardingCard}

      <article class="cp-card cp-span-3 cp-overview-heading-card">
        <div class="cp-card-head">
          <h3>🚀 Rendimiento del bot este mes</h3>
          <span>${escapeHtml(monthlyLabel)}</span>
        </div>
      </article>

      <section class="cp-stats cp-span-3 cp-performance-stats-grid">
        <article class="cp-stat cp-performance-stat cp-tone-blue">
          <div class="cp-stat-label">👥 Clientes atendidos</div>
          <div class="cp-stat-value">${monthlyCustomers.size}</div>
          <div class="cp-stat-hint">mes en curso</div>
        </article>
        <article class="cp-stat cp-performance-stat cp-tone-cyan">
          <div class="cp-stat-label">📦 Pedidos generados</div>
          <div class="cp-stat-value">${monthlyOrders.length}</div>
          <div class="cp-stat-hint">registrados este mes</div>
        </article>
        <article class="cp-stat cp-performance-stat cp-tone-green">
          <div class="cp-stat-label">💸 Ventas estimadas</div>
          <div class="cp-stat-value">${formatMoney(estimatedSales, state.subscription.currency)}</div>
          <div class="cp-stat-hint">facturacion del periodo</div>
        </article>
        <article class="cp-stat cp-performance-stat cp-tone-purple">
          <div class="cp-stat-label">⏱️ Tiempo ahorrado</div>
          <div class="cp-stat-value">${savedHours.toFixed(savedHours >= 10 ? 0 : 1)} h</div>
          <div class="cp-stat-hint">automatizacion estimada</div>
        </article>
      </section>

      <article class="cp-card cp-span-2 cp-overview-block cp-tone-cyan-soft">
        <div class="cp-card-head">
          <h3>📈 Actividad del bot por dia</h3>
          <span>ultimos 7 dias</span>
        </div>
        <div class="cp-activity-chart">
          ${activityRows}
        </div>
      </article>

      <article class="cp-card cp-span-3 cp-overview-block cp-alerts-panel cp-tone-amber-soft">
        <div class="cp-card-head">
          <h3>⚠️ Alertas importantes</h3>
          <span>revision rapida</span>
        </div>
        <ul class="cp-alert-lines">
          ${alertRows}
        </ul>
      </article>

      ${profile.botPhone ? `
      <article class="cp-card cp-span-3 cp-share-widget">
        <div class="cp-share-inner">
          <div class="cp-share-icon">💬</div>
          <div class="cp-share-body">
            <div class="cp-share-title">Compartí tu bot de WhatsApp</div>
            <div class="cp-share-number">${escapeHtml(profile.botPhone)}</div>
            <div class="cp-share-hint">Enviá este link a tus clientes para que puedan escribirte</div>
          </div>
          <div class="cp-share-actions">
            <a class="cp-btn primary" href="https://wa.me/${encodeURIComponent(profile.botPhone.replace(/\D/g, ""))}" target="_blank" rel="noopener">Abrir chat</a>
            <button class="cp-btn" type="button" onclick="navigator.clipboard.writeText('https://wa.me/${encodeURIComponent(profile.botPhone.replace(/\D/g, ""))}').then(()=>{this.textContent='Copiado';setTimeout(()=>this.textContent='Copiar link',2000)})">Copiar link</button>
          </div>
        </div>
      </article>
      ` : ""}

      <article class="cp-card cp-span-3 cp-overview-block">
        <div class="cp-card-head">
          <h3>📊 Uso del servicio</h3>
          <span>${escapeHtml(planInfo.fullLabel)}</span>
        </div>
        <section class="cp-stats cp-performance-stats-grid" style="margin-top:16px">
          <article class="cp-stat cp-performance-stat cp-tone-blue">
            <div class="cp-stat-label">💬 Consultas al bot</div>
            <div class="cp-stat-value">${Number(msgStats.last30Days || 0).toLocaleString("es-AR")}</div>
            <div class="cp-stat-hint">ultimos 30 dias</div>
          </article>
          <article class="cp-stat cp-performance-stat cp-tone-purple">
            <div class="cp-stat-label">📋 Total historico</div>
            <div class="cp-stat-value">${Number(msgStats.total || 0).toLocaleString("es-AR")}</div>
            <div class="cp-stat-hint">desde el inicio</div>
          </article>
          <article class="cp-stat cp-performance-stat ${planInfo.aiEnabled ? "cp-tone-cyan" : "cp-tone-amber"}">
            <div class="cp-stat-label">🤖 IA asistente</div>
            <div class="cp-stat-value">${planInfo.aiEnabled ? "Activa" : "No incluida"}</div>
            <div class="cp-stat-hint">${planInfo.aiEnabled ? (aiDailyLimit ? `hasta ${aiDailyLimit} consultas/dia` : "sin limite diario") : "disponible en planes LITE y PRO"}</div>
          </article>
          <article class="cp-stat cp-performance-stat cp-tone-green">
            <div class="cp-stat-label">📦 Plan activo</div>
            <div class="cp-stat-value">${escapeHtml(planInfo.planLabel)}</div>
            <div class="cp-stat-hint">${escapeHtml(planInfo.channelLabel)}</div>
          </article>
        </section>
      </article>
    </section>
  `;

  res.type("text/html").send(renderClientPage({
    company,
    active: "inicio",
    title: "Overview",
    subtitle: `${company.name || company.id} - resumen operativo`,
    bodyHtml,
    showIntegrationsNav: req.clientHasIntegrations,
  }));
});

app.get("/panel/catalogo/template", requireClientAuth, requireClientSectionAccess("catalogo"), async (req, res) => {
  const templateRows = [
    {
      id: "1",
      producto: "Bot WhatsApp Base",
      precio: "70",
      stock: "Disponible",
      categoria: "Bots",
      rubro: "Tecnologia",
      seccion: "Automatizacion",
      subseccion: "WhatsApp",
      talle: "",
      color: "",
      sku: "BOT-WA-BASE",
      descripcion: "Bot inicial para WhatsApp con flujo base.",
      tags: "bot,whatsapp,base",
    },
    {
      id: "2",
      producto: "Bot WhatsApp AI Pro",
      precio: "230",
      stock: "Disponible",
      categoria: "Bots",
      rubro: "Tecnologia",
      seccion: "Automatizacion",
      subseccion: "WhatsApp",
      talle: "",
      color: "",
      sku: "BOT-WA-PRO",
      descripcion: "Bot con AI y mas contexto de memoria.",
      tags: "bot,whatsapp,ai,pro",
    },
    {
      id: "3",
      producto: "Almendras 100g",
      precio: "4.5",
      stock: "25",
      categoria: "Frutos secos",
      rubro: "Alimentos",
      seccion: "Granel",
      subseccion: "Frutos secos",
      talle: "",
      color: "",
      sku: "ALM-100",
      descripcion: "Bolsa de almendras por 100 gramos.",
      tags: "almendras,100g,granel",
    },
  ];
  const headers = [
    "id",
    "producto",
    "precio",
    "stock",
    "categoria",
    "rubro",
    "seccion",
    "subseccion",
    "talle",
    "color",
    "sku",
    "descripcion",
    "tags",
  ];
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(templateRows, { header: headers });
  XLSX.utils.book_append_sheet(workbook, worksheet, "Catalogo");
  const fileBuffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="catalogo-plantilla.xlsx"');
  res.send(fileBuffer);
});
app.get("/c/catalogo/template", (req, res) => res.redirect("/panel/catalogo/template"));

app.get("/panel/catalogo", requireClientAuth, loadClientIntegrationFlag, requireClientSectionAccess("catalogo"), async (req, res) => {
  const company = req.company;
  const { state } = await loadClientStateWithProvider(company);
  const rules = parseJsonSafe(company.rulesJson || "{}", {});
  const selectedCatalogCurrency = normalizeSupportedCurrency(
    rules?.catalogCurrency || rules?.subscriptionCurrency || state.subscription.currency || "USD"
  );
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
  const groupedCatalogMap = state.catalog.reduce((acc, item) => {
    const category = cleanCatalogText(item?.category || "-") || "-";
    if (!acc[category]) acc[category] = [];
    acc[category].push(item);
    return acc;
  }, {});
  const groupedRows = Object.entries(groupedCatalogMap)
    .sort(([a], [b]) => a.localeCompare(b, "es", { sensitivity: "base" }))
    .map(([category, items]) => {
      const itemRows = items.map((item) => `
        <tr>
          <td>${escapeHtml(item.id)}</td>
          <td>${escapeHtml(item.name)}</td>
          <td>${formatMoney(item.price, state.subscription.currency)}</td>
          <td>${escapeHtml(item.stock)}</td>
          <td>${escapeHtml(item.category)}</td>
        </tr>
      `).join("");
      return `
        <tr class="cp-table-group-row">
          <td colspan="5"><b>${escapeHtml(category)}</b> <span class="cp-details-hint">(${items.length})</span></td>
        </tr>
        ${itemRows}
      `;
    })
    .join("");
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
    ...(item.sku ? { sku: String(item.sku) } : {}),
    ...(item.description ? { description: String(item.description) } : {}),
    ...(item.rubro ? { rubro: String(item.rubro) } : {}),
    ...(item.seccion ? { seccion: String(item.seccion) } : {}),
    ...(item.subseccion ? { subseccion: String(item.subseccion) } : {}),
    ...(item.talle ? { talle: String(item.talle) } : {}),
    ...(item.color ? { color: String(item.color) } : {}),
    ...(Array.isArray(item.tags) && item.tags.length ? { tags: item.tags } : {}),
  })));
  const currencyOptions = SUPPORTED_CURRENCIES.map((code) => (
    `<option value="${code}" ${selectedCatalogCurrency === code ? "selected" : ""}>${code}</option>`
  )).join("");

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
        <div class="cp-card-head"><h3>Moneda de cobro del catalogo</h3><span>${escapeHtml(selectedCatalogCurrency)}</span></div>
        <form method="POST" action="/panel/catalogo/currency" class="cp-form">
          <label>Moneda</label>
          <select name="currency">${currencyOptions}</select>
          <p class="cp-note">Esta moneda se aplica al panel y al bot cuando muestra precios.</p>
          <div class="cp-actions">
            <button class="cp-btn primary" type="submit">Guardar moneda</button>
          </div>
        </form>
      </article>

      <details class="cp-card cp-span-3 cp-card-toggle" id="catalogo-completo">
        <summary>
          <span>Catalogo completo</span>
          <span class="cp-details-hint">${state.catalog.length} filas</span>
        </summary>
        <div class="cp-card-toggle-body">
          <div class="cp-table-wrap">
            <table class="cp-table cp-catalog-table">
              <thead><tr><th>ID</th><th>Producto</th><th>Precio</th><th>Stock</th><th>Categoria</th></tr></thead>
              <tbody>${groupedRows || rows || `<tr><td colspan="5">No hay productos cargados.</td></tr>`}</tbody>
            </table>
          </div>
        </div>
      </details>

      <details class="cp-card cp-span-3 cp-card-toggle" id="importar-catalogo">
        <summary>
          <span>Importar catalogo (Excel)</span>
          <span class="cp-details-hint">Carga masiva</span>
        </summary>
        <div class="cp-card-toggle-body">
          <form id="catalogImportForm" method="POST" action="/panel/catalogo/import" class="cp-form">
            <p class="cp-note">Sube .xlsx/.xls/.csv. Encabezados soportados: ID, producto, precio, stock, categoria, rubro, seccion, subseccion, talle, color, sku, descripcion, tags.</p>
            <div class="cp-actions">
              <a class="cp-btn secondary" href="/panel/catalogo/template">Descargar plantilla de ejemplo</a>
            </div>
            <label>Archivo Excel</label>
            <input id="catalogExcelFile" type="file" accept=".xlsx,.xls,.csv" required />
            <input id="catalogExcelBase64" type="hidden" name="excelBase64" value="" />
            <input id="catalogExcelName" type="hidden" name="excelFileName" value="" />
            <label>Modo de importacion</label>
            <select name="importMode">
              <option value="replace">Reemplazar catalogo actual</option>
              <option value="append">Agregar al catalogo actual</option>
            </select>
            <div id="catalogImportStatus" class="cp-note" aria-live="polite"></div>
            <div class="cp-actions">
              <button class="cp-btn primary" type="submit">Importar catalogo</button>
            </div>
          </form>
        </div>
      </details>

      <details class="cp-card cp-span-3 cp-card-toggle" id="editar-catalogo">
        <summary>
          <span>Editar catalogo manual</span>
          <span class="cp-details-hint">Sin escribir JSON</span>
        </summary>
        <div class="cp-card-toggle-body">
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
        </div>
      </details>
    </section>

    <script>
      (function () {
        const form = document.getElementById("catalogEditorForm");
        const body = document.getElementById("catalogEditorBody");
        const hidden = document.getElementById("catalogJsonInput");
        const addBtn = document.getElementById("catalogAddRowBtn");
        const status = document.getElementById("catalogEditorStatus");
        const counter = document.getElementById("catalogEditorCount");
        if (form && body && hidden && addBtn && status && counter) {
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
        }

        const importForm = document.getElementById("catalogImportForm");
        const importFile = document.getElementById("catalogExcelFile");
        const importBase64 = document.getElementById("catalogExcelBase64");
        const importName = document.getElementById("catalogExcelName");
        const importStatus = document.getElementById("catalogImportStatus");
        if (importForm && importFile && importBase64 && importName && importStatus) {
          function setImportStatus(message, isError) {
            importStatus.textContent = message || "";
            importStatus.classList.toggle("error", !!isError);
          }

          importFile.addEventListener("change", () => {
            const file = importFile.files && importFile.files[0];
            importBase64.value = "";
            importName.value = "";
            if (!file) {
              setImportStatus("", false);
              return;
            }
            importName.value = String(file.name || "");
            const reader = new FileReader();
            reader.onload = () => {
              const result = String(reader.result || "");
              const base64 = result.includes(",") ? result.split(",").pop() : "";
              if (!base64) {
                setImportStatus("No se pudo leer el archivo.", true);
                return;
              }
              importBase64.value = base64;
              setImportStatus("Archivo listo para importar: " + (file.name || "archivo"), false);
            };
            reader.onerror = () => {
              setImportStatus("No se pudo leer el archivo seleccionado.", true);
            };
            reader.readAsDataURL(file);
          });

          importForm.addEventListener("submit", (event) => {
            if (!importBase64.value) {
              event.preventDefault();
              setImportStatus("Selecciona un archivo Excel antes de importar.", true);
            }
          });
        }
      })();
    </script>
  `;

  res.type("text/html").send(renderClientPage({
    company,
    active: "catalogo",
    title: "Catalogo",
    subtitle: `${company.name || company.id} - gestion de productos`,
    bodyHtml,
    showIntegrationsNav: req.clientHasIntegrations,
  }));
});

app.post("/panel/catalogo/save", requireClientAuth, requireClientSectionAccess("catalogo"), async (req, res) => {
  const company = req.company;
  const id = company.id;
  const catalogJson = String(req.body.catalogJson || "[]");

  try {
    const parsed = JSON.parse(catalogJson);
    if (!Array.isArray(parsed)) throw new Error("catalogJson debe ser un array");
    const existingCatalogRaw = parseJsonSafe(company.catalogJson || "[]", []);
    const existingCatalog = Array.isArray(existingCatalogRaw)
      ? existingCatalogRaw.map((item, idx) => normalizeCatalogItemRecord(item, idx))
      : [];
    const existingById = new Map(
      existingCatalog
        .map((item) => [cleanCatalogText(item?.id || ""), item])
        .filter(([key]) => !!key)
    );

    const normalized = parsed.map((item, idx) => {
      const key = cleanCatalogText(item?.id || "");
      const previous = key ? existingById.get(key) : null;
      return normalizeCatalogItemRecord(item, idx, previous);
    });

    await api(`/api/companies/${encodeURIComponent(id)}/save`, {
      method: "POST",
      body: {
        name: company.name || id,
        prompt: company.prompt || "",
        catalogJson: JSON.stringify(normalized),
        rulesJson: company.rulesJson || "{}",
      },
    });

    res.redirect("/panel/catalogo?saved=1");
  } catch (e) {
    res.redirect(`/panel/catalogo?error=${encodeURIComponent(e?.message || e)}`);
  }
});

app.post("/panel/catalogo/currency", requireClientAuth, requireClientSectionAccess("catalogo"), async (req, res) => {
  const company = req.company;
  const id = company.id;
  const selectedCurrency = normalizeSupportedCurrency(String(req.body.currency || "").trim(), "USD");

  try {
    const rules = parseJsonSafe(company.rulesJson || "{}", {});
    rules.catalogCurrency = selectedCurrency;
    // Keep subscription currency aligned for panel totals/montos.
    rules.subscriptionCurrency = selectedCurrency;

    await api(`/api/companies/${encodeURIComponent(id)}/save`, {
      method: "POST",
      body: {
        name: company.name || id,
        prompt: company.prompt || "",
        catalogJson: company.catalogJson || "[]",
        rulesJson: JSON.stringify(rules),
      },
    });

    return res.redirect("/panel/catalogo?saved=1");
  } catch (e) {
    return res.redirect(`/panel/catalogo?error=${encodeURIComponent(e?.message || e)}`);
  }
});

app.post("/panel/catalogo/import", requireClientAuth, requireClientSectionAccess("catalogo"), async (req, res) => {
  const company = req.company;
  const id = company.id;
  const excelBase64 = String(req.body.excelBase64 || "").trim();
  const importMode = String(req.body.importMode || "replace").trim().toLowerCase() === "append" ? "append" : "replace";

  if (!excelBase64) {
    return res.redirect(`/panel/catalogo?error=${encodeURIComponent("Selecciona un archivo Excel para importar")}`);
  }

  try {
    const buffer = Buffer.from(excelBase64, "base64");
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const firstSheetName = Array.isArray(workbook.SheetNames) ? workbook.SheetNames[0] : "";
    if (!firstSheetName) throw new Error("El archivo no tiene hojas");

    const sheet = workbook.Sheets[firstSheetName];
    const importedItemsRaw = extractCatalogItemsFromSheet(sheet);
    if (!importedItemsRaw.length) {
      throw new Error("No se detectaron filas validas para importar");
    }

    const importedItems = importedItemsRaw.map((item, idx) => normalizeCatalogItemRecord(item, idx));

    const existingCatalog = parseJsonSafe(company.catalogJson || "[]", []);
    const existingItems = (Array.isArray(existingCatalog) ? existingCatalog : []).map((item, idx) =>
      normalizeCatalogItemRecord(item, idx)
    );

    const merged = importMode === "append"
      ? [...existingItems, ...importedItems]
      : importedItems;

    const normalized = merged.map((item, idx) => normalizeCatalogItemRecord(item, idx));

    await api(`/api/companies/${encodeURIComponent(id)}/save`, {
      method: "POST",
      body: {
        name: company.name || id,
        prompt: company.prompt || "",
        catalogJson: JSON.stringify(normalized),
        rulesJson: company.rulesJson || "{}",
      },
    });

    return res.redirect("/panel/catalogo?saved=1");
  } catch (e) {
    return res.redirect(`/panel/catalogo?error=${encodeURIComponent(e?.message || e)}`);
  }
});

async function fetchClientOrderDetailPayload(company, orderId, limit = 120) {
  const companyIdParam = encodeURIComponent(String(company.id || ""));
  const order = await api(`/api/orders/${encodeURIComponent(orderId)}?companyId=${companyIdParam}`);
  if (!order || String(order.companyId || "").trim() !== String(company.id || "").trim()) {
    const err = new Error("Pedido no pertenece a esta empresa");
    err.statusCode = 403;
    throw err;
  }

  let itemsDetailed = parseJsonSafe(order.itemsDetailedJson || "[]", []);
  if (!Array.isArray(itemsDetailed)) itemsDetailed = [];
  if (!itemsDetailed.length) {
    const rawItems = parseJsonSafe(order.itemsJson || "[]", []);
    const grouped = {};
    (Array.isArray(rawItems) ? rawItems : []).forEach((rawId) => {
      const key = String(rawId || "").trim();
      if (!key) return;
      grouped[key] = (grouped[key] || 0) + 1;
    });
    itemsDetailed = Object.entries(grouped).map(([id, qty]) => ({
      id,
      name: `Producto ${id}`,
      qty,
      unit: 0,
      subtotal: 0,
    }));
  }

  let messages = [];
  try {
    const history = await api(`/api/orders/${encodeURIComponent(orderId)}/messages?companyId=${companyIdParam}&limit=${Math.max(1, Math.min(500, Number(limit) || 120))}`);
    messages = Array.isArray(history?.messages) ? history.messages : [];
  } catch {
    messages = [];
  }

  return {
    order: {
      id: String(order.id || ""),
      createdAt: order.createdAt || "",
      fromNumber: String(order.fromNumber || ""),
      companyId: String(order.companyId || ""),
      name: String(order.name || ""),
      contact: String(order.contact || ""),
      notes: String(order.notes || ""),
      total: toNumber(order.total),
      paymentStatus: String(order.paymentStatus || ""),
      paymentMethod: String(order.paymentMethod || ""),
      orderStatus: String(order.orderStatus || ""),
      workflowState: String(order.workflowState || ""),
      archived: !!order.archived,
    },
    itemsDetailed,
    messages: messages.map((msg) => ({
      id: Number(msg?.id || 0),
      createdAt: msg?.createdAt || "",
      direction: String(msg?.direction || "").toLowerCase() === "out" ? "out" : "in",
      role: String(msg?.role || "").toLowerCase() === "assistant" ? "assistant" : "user",
      content: String(msg?.content || ""),
      mediaUrl: String(msg?.mediaUrl || ""),
      mediaContentType: String(msg?.mediaContentType || ""),
      twilioSid: String(msg?.twilioSid || ""),
    })),
  };
}

function truncateConversationText(value, max = 96) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  if (!text) return "Sin mensaje reciente.";
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function getConversationStatusFromOrder(order, lastDirection = "in") {
  const workflow = extractClientOrderWorkflow(order);
  const paymentState = normalizeClientPaymentStatus(order?.paymentStatus);
  if (workflow.archived || workflow.state === "rejected") {
    return { key: "closed", label: "Cerrado" };
  }
  if (workflow.state === "completed" || paymentState === "paid") {
    return { key: "generated", label: "Pedido generado" };
  }
  if (String(lastDirection || "").toLowerCase() === "out") {
    return { key: "bot", label: "Bot respondiendo" };
  }
  return { key: "process", label: "En proceso" };
}

function isSameCalendarDay(value, reference = new Date()) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return false;
  return (
    d.getFullYear() === reference.getFullYear() &&
    d.getMonth() === reference.getMonth() &&
    d.getDate() === reference.getDate()
  );
}

function buildBotActivitySeries(orders, days = 7) {
  const totalDays = Math.max(1, Number(days) || 7);
  const today = new Date();
  const buckets = [];
  const counts = new Map();

  for (let offset = totalDays - 1; offset >= 0; offset -= 1) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
    const key = date.toISOString().slice(0, 10);
    counts.set(key, 0);
    buckets.push({
      key,
      label: date.toLocaleDateString("es-AR", { weekday: "long" }),
      shortLabel: date.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit" }),
      count: 0,
    });
  }

  for (const order of Array.isArray(orders) ? orders : []) {
    const createdAt = String(order?.createdAt || "");
    const key = createdAt.slice(0, 10);
    if (!counts.has(key)) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  let max = 0;
  for (const bucket of buckets) {
    bucket.count = counts.get(bucket.key) || 0;
    if (bucket.count > max) max = bucket.count;
  }

  return {
    max,
    buckets: buckets.map((bucket) => ({
      ...bucket,
      width: max > 0 ? Math.max(8, Math.round((bucket.count / max) * 100)) : 8,
    })),
  };
}

const FAQ_TOPIC_DEFINITIONS = [
  { key: "price", label: "Precio", regex: /\b(precio|sale|cu[aá]nto|costo|vale|valor)\b/i },
  { key: "shipping", label: "Envios", regex: /\b(env[ií]o|envian|env[oí]an|retiro|delivery)\b/i },
  { key: "payment", label: "Metodos de pago", regex: /\b(pago|transferencia|transferir|efectivo|tarjeta|debito|cr[eé]dito)\b/i },
  { key: "schedule", label: "Horarios", regex: /\b(horario|horarios|hora|abren|cierran|atienden)\b/i },
];

function buildFrequentQuestions(rows, limit = 4) {
  const counters = new Map(FAQ_TOPIC_DEFINITIONS.map((topic) => [topic.key, { label: topic.label, count: 0 }]));
  for (const row of Array.isArray(rows) ? rows : []) {
    for (const msg of Array.isArray(row?.messages) ? row.messages : []) {
      if (String(msg?.direction || "").toLowerCase() === "out") continue;
      const content = String(msg?.content || "").trim();
      if (!content) continue;
      for (const topic of FAQ_TOPIC_DEFINITIONS) {
        if (topic.regex.test(content)) {
          counters.get(topic.key).count += 1;
          break;
        }
      }
    }
  }

  const ranked = Array.from(counters.values())
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "es"));

  if (!ranked.length) {
    return FAQ_TOPIC_DEFINITIONS.slice(0, limit).map((topic) => ({ label: topic.label, count: 0 }));
  }
  return ranked.slice(0, limit);
}

function buildOverviewAlerts({ state, payment, monthlyOrders }) {
  const alerts = [];
  const catalog = Array.isArray(state?.catalog) ? state.catalog : [];
  const missingPrice = catalog.filter((item) => toNumber(item?.price) <= 0).length;
  const enabledMethods = ["cash", "debit", "transfer", "credit"].filter((key) => !!payment?.[key]).length;
  const transferConfigured = !!payment?.transfer;
  const missingTransferData = transferConfigured && !(
    String(payment?.transferCbu || "").trim() ||
    String(payment?.transferAlias || "").trim()
  );

  if (catalog.length === 0) {
    alerts.push({ level: "warn", text: "Tu catalogo todavia no tiene productos cargados." });
  }
  if (missingPrice > 0) {
    alerts.push({ level: "warn", text: `Tu catalogo tiene ${missingPrice} producto${missingPrice === 1 ? "" : "s"} sin precio.` });
  }
  if (enabledMethods === 0) {
    alerts.push({ level: "warn", text: "No tienes metodos de pago configurados para el bot." });
  }
  if (missingTransferData) {
    alerts.push({ level: "warn", text: "Tienes transferencia activa pero faltan CBU o alias para cobrar." });
  }
  if (!["whatsapp", "combinado"].includes(String(state?.plan?.channelMode || "").toLowerCase())) {
    alerts.push({ level: "warn", text: "WhatsApp no esta activo en el plan actual del bot." });
  }

  if (!alerts.length && !monthlyOrders.length) {
    alerts.push({ level: "info", text: "Todavia no se generaron pedidos en el mes en curso." });
  }

  return alerts.length
    ? alerts
    : [{ level: "ok", text: "No hay alertas importantes por ahora. El bot se ve estable." }];
}

async function buildClientConversationSummary(company, options = {}) {
  const {
    limitRows = 24,
    includeMessages = false,
    filterFrom = null,
    filterTo = null,
  } = options;
  const orders = await fetchCompanyOrders(company.id, filterFrom, filterTo, 500);
  const uniqueOrders = [];
  const seenCustomers = new Set();
  for (const order of orders) {
    const customerKey = String(order?.contact || order?.fromNumber || order?.name || order?.id || "")
      .trim()
      .toLowerCase();
    if (!customerKey || seenCustomers.has(customerKey)) continue;
    seenCustomers.add(customerKey);
    uniqueOrders.push(order);
    if (uniqueOrders.length >= limitRows * 3) break;
  }

  const companyIdParam = encodeURIComponent(String(company.id || ""));
  const summaryRowsRaw = await Promise.all(uniqueOrders.map(async (order) => {
    let historyMessages = [];
    try {
      const history = await api(`/api/orders/${encodeURIComponent(order.id)}/messages?companyId=${companyIdParam}&limit=120`);
      historyMessages = Array.isArray(history?.messages) ? history.messages : [];
    } catch {
      historyMessages = [];
    }
    const latestMessage = historyMessages.length ? historyMessages[historyMessages.length - 1] : null;
    const lastDirection = String(latestMessage?.direction || "").toLowerCase() === "out" ? "out" : "in";
    const status = getConversationStatusFromOrder(order, lastDirection);
    const customerName = String(order?.name || order?.contact || order?.fromNumber || "-").trim() || "-";
    const rawLastText = String(latestMessage?.content || "").trim() || String(order?.notes || "").trim();
    const interactionAt = String(latestMessage?.createdAt || order?.createdAt || "");
    return {
      orderId: String(order?.id || ""),
      customerName,
      lastMessage: truncateConversationText(rawLastText),
      statusKey: status.key,
      statusLabel: status.label,
      createdAt: order?.createdAt || "",
      interactionAt,
      paymentMethod: String(order?.paymentMethod || ""),
      total: toNumber(order?.total),
      messages: includeMessages
        ? historyMessages.map((msg) => ({
            createdAt: msg?.createdAt || "",
            direction: String(msg?.direction || "").toLowerCase() === "out" ? "out" : "in",
            content: String(msg?.content || ""),
            mediaUrl: String(msg?.mediaUrl || ""),
            mediaContentType: String(msg?.mediaContentType || ""),
          }))
        : [],
    };
  }));

  const summaryRows = summaryRowsRaw.slice(0, limitRows);
  summaryRows.sort((a, b) => (Date.parse(b.interactionAt || b.createdAt) || 0) - (Date.parse(a.interactionAt || a.createdAt) || 0));
  return summaryRows;
}

// Lightweight polling endpoint: returns count of orders created after `since`
app.get("/panel/api/new-orders", requireClientAuth, async (req, res) => {
  const company = req.company;
  const since = String(req.query.since || "").trim();
  const sinceDate = since ? new Date(since) : null;
  if (!sinceDate || isNaN(sinceDate.getTime())) {
    return res.json({ count: 0 });
  }
  try {
    const orders = await fetchCompanyOrders(company.id, sinceDate.toISOString(), "", 500);
    return res.json({ count: orders.length });
  } catch {
    return res.json({ count: 0 });
  }
});

app.get("/panel/pedidos", requireClientAuth, loadClientIntegrationFlag, requireClientSectionAccess("pedidos"), async (req, res) => {
  const company = req.company;
  let orders = [];
  let fetchError = "";
  const updatedCategory = String(req.query.updatedCategory || "") === "1";
  const updatedPayment = String(req.query.updatedPayment || "") === "1";
  const errorMsg = String(req.query.error || "").trim();
  const searchQuery = String(req.query.q || "").trim();
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

  const statusFiltered = selectedStatus === "all"
    ? ordersWithWorkflow.filter((order) => !order.workflow.archived)
    : selectedStatus === "archived"
      ? ordersWithWorkflow.filter((order) => order.workflow.archived)
      : ordersWithWorkflow.filter((order) => !order.workflow.archived && order.workflow.state === selectedStatus);

  const searchLower = searchQuery.toLowerCase();
  const visibleOrders = searchLower
    ? statusFiltered.filter((order) => {
        const haystack = [order.name, order.contact, order.fromNumber, order.id]
          .filter(Boolean).join(" ").toLowerCase();
        return haystack.includes(searchLower);
      })
    : statusFiltered;

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
  if (searchQuery) exportParams.set("q", searchQuery);
  const exportXlsxHref = `/panel/pedidos/export?format=xlsx&${exportParams.toString()}`;

  const rows = visibleOrders.map((order) => {
    const safeOrderId = escapeHtml(order.id || "");
    const encodedOrderId = encodeURIComponent(String(order.id || ""));
    const paymentState = normalizeClientPaymentStatus(order.paymentStatus);
    return `
    <tr class="cp-order-row" data-order-id="${safeOrderId}" tabindex="0" role="button" aria-expanded="false">
      <td><a class="cp-order-link" href="/panel/pedidos/ver/${encodedOrderId}" data-no-toggle="1">${escapeHtml(order.id || "-")}</a></td>
      <td>${escapeHtml(formatDateLabel(order.createdAt))}</td>
      <td>${escapeHtml(order.name || order.contact || "-")}</td>
      <td>${formatMoney(toNumber(order.total), "USD")}</td>
      <td>
        <form method="POST" action="/panel/pedidos/payment" class="cp-payment-form" data-no-toggle="1">
          <input type="hidden" name="orderId" value="${safeOrderId}" />
          <input type="hidden" name="range" value="${escapeHtml(selectedRange)}" />
          <input type="hidden" name="status" value="${escapeHtml(selectedStatus)}" />
          <input type="hidden" name="from" value="${escapeHtml(fromInput)}" />
          <input type="hidden" name="to" value="${escapeHtml(toInput)}" />
          <select name="paymentStatus" class="cp-category-select cp-status-${escapeHtml(paymentState)}" onchange="this.form.submit()">
            <option value="pending" ${paymentState === "pending" ? "selected" : ""}>No pagado</option>
            <option value="paid" ${paymentState === "paid" ? "selected" : ""}>Pagado</option>
            <option value="failed" ${paymentState === "failed" ? "selected" : ""}>Fallido</option>
          </select>
        </form>
      </td>
      <td>${escapeHtml(clientPaymentMethodLabel(order))}</td>
      <td>
        <form method="POST" action="/panel/pedidos/category" class="cp-category-form" data-no-toggle="1">
          <input type="hidden" name="orderId" value="${safeOrderId}" />
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
        <form method="POST" action="/panel/pedidos/category" class="cp-archive-form" data-no-toggle="1">
          <input type="hidden" name="orderId" value="${safeOrderId}" />
          <input type="hidden" name="range" value="${escapeHtml(selectedRange)}" />
          <input type="hidden" name="status" value="${escapeHtml(selectedStatus)}" />
          <input type="hidden" name="from" value="${escapeHtml(fromInput)}" />
          <input type="hidden" name="to" value="${escapeHtml(toInput)}" />
          <input type="hidden" name="state" value="${escapeHtml(order.workflow.state)}" />
          <button
            type="submit"
            name="archived"
            value="${order.workflow.archived ? "0" : "1"}"
            class="cp-archive-toggle cp-archive-toggle-btn"
            data-no-toggle="1"
            title="${order.workflow.archived ? "Desarchivar pedido" : "Archivar pedido"}"
          >
            <span class="cp-archive-box">${order.workflow.archived ? "✓" : ""}</span>
            <span>${order.workflow.archived ? "Si" : "No"}</span>
          </button>
        </form>
      </td>
    </tr>
    <tr class="cp-order-detail-row cp-hidden" data-order-detail="${safeOrderId}">
      <td colspan="8">
        <div class="cp-order-detail-shell">
          <div class="cp-order-detail-loading">Click en el pedido para ver detalle y conversacion.</div>
        </div>
      </td>
    </tr>
  `;
  }).join("");

  const bodyHtml = `
    ${updatedCategory ? `<div class="cp-alert success">Estado de pedido actualizado.</div>` : ""}
    ${updatedPayment ? `<div class="cp-alert success">Estado de pago actualizado.</div>` : ""}
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

          <div>
            <label>Buscar cliente</label>
            <input type="text" name="q" value="${escapeHtml(searchQuery)}" placeholder="Nombre, contacto o ID de pedido..." />
          </div>

          <div class="cp-actions">
            <button class="cp-btn primary" type="submit">Aplicar filtros</button>
            <a class="cp-btn" href="/panel/pedidos">Limpiar</a>
            <a class="cp-btn" href="${exportXlsxHref}">Exportar XLSX</a>
            <a class="cp-btn" href="${exportXlsxHref.replace('format=xlsx', 'format=csv')}">Exportar CSV</a>
          </div>
        </form>
      </article>

      <article class="cp-card cp-span-3">
        <div class="cp-card-head"><h3>Listado de pedidos</h3><span>${visibleOrders.length} resultados</span></div>
        <div class="cp-note">Click en la fila para expandir detalle rapido o entra por ID para ver la ficha completa del pedido.</div>
        ${fetchError ? `<div class="cp-empty">No se pudo cargar pedidos: ${escapeHtml(fetchError)}</div>` : ""}
        <div class="cp-table-wrap">
          <table class="cp-table cp-orders-table">
            <thead><tr><th>ID</th><th>Fecha</th><th>Cliente</th><th>Total</th><th>Pago</th><th>Medio de pago</th><th>Estado</th><th>Archivado</th></tr></thead>
            <tbody class="cp-orders-body">${rows || `<tr><td colspan="8">Sin pedidos para este filtro.</td></tr>`}</tbody>
          </table>
        </div>
      </article>

    </section>
    <script>
      (() => {
        const range = document.getElementById("ordersRangeSelect");
        const custom = document.getElementById("ordersCustomRange");
        if (range && custom) {
          const sync = () => {
            if (range.value === "custom") custom.classList.remove("cp-hidden");
            else custom.classList.add("cp-hidden");
          };
          range.addEventListener("change", sync);
          sync();
        }

        const escapeHtml = (value) => String(value || "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#039;");

        const formatDateTime = (value) => {
          if (!value) return "-";
          const d = new Date(value);
          if (Number.isNaN(d.getTime())) return String(value);
          return d.toLocaleString("es-AR");
        };

        const formatMoney = (value) => {
          const amount = Number(value || 0);
          try {
            return new Intl.NumberFormat("es-AR", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(amount);
          } catch {
            return "$" + Math.round(amount || 0);
          }
        };

        const renderDetail = (payload) => {
          const order = payload && payload.order ? payload.order : {};
          const items = payload && Array.isArray(payload.itemsDetailed) ? payload.itemsDetailed : [];
          const messages = payload && Array.isArray(payload.messages) ? payload.messages : [];
          const itemsHtml = items.length
            ? '<ul class="cp-order-items">' + items.map((item) => (
              '<li><span>' + escapeHtml(item.name || ("Producto " + item.id)) + '</span>' +
              '<span>x' + escapeHtml(item.qty || 1) + ' - ' + formatMoney(
                typeof item.subtotal !== "undefined" ? item.subtotal : (typeof item.unit !== "undefined" ? item.unit : 0)
              ) + '</span></li>'
            )).join("") + "</ul>"
            : '<div class="cp-empty">Sin items detallados.</div>';

          const messagesHtml = messages.length
            ? '<div class="cp-order-chat">' + messages.map((msg) => {
              const isOut = String(msg.direction || "").toLowerCase() === "out";
              const bubbleClass = isOut ? "out" : "in";
              const mediaType = String(msg.mediaContentType || "").trim();
              const mediaUrl = String(msg.mediaUrl || "").trim();
              const hasImage = mediaUrl && mediaType.toLowerCase().startsWith("image/");
              return (
                '<article class="cp-order-msg ' + bubbleClass + '">' +
                  '<div class="cp-order-msg-meta">' +
                    '<span>' + (isOut ? "Bot" : "Cliente") + "</span>" +
                    '<span>' + escapeHtml(formatDateTime(msg.createdAt)) + "</span>" +
                  "</div>" +
                  (msg.content ? ('<p class="cp-order-msg-text">' + escapeHtml(msg.content).replace(/\r?\n/g, "<br/>") + "</p>") : "") +
                  (mediaUrl
                    ? ('<div class="cp-order-msg-media">' +
                        '<span>' + escapeHtml(mediaType || "adjunto") + "</span>" +
                        '<a href="' + escapeHtml(mediaUrl) + '" target="_blank" rel="noopener noreferrer">Abrir adjunto</a>' +
                        (hasImage ? ('<img src="' + escapeHtml(mediaUrl) + '" alt="Adjunto pedido" loading="lazy" />') : "") +
                      "</div>")
                    : "") +
                "</article>"
              );
            }).join("") + "</div>"
            : '<div class="cp-empty">Sin conversacion para este pedido.</div>';

          return (
            '<div class="cp-order-detail-grid">' +
              '<section class="cp-order-detail-card">' +
                '<h4>Datos del pedido</h4>' +
                '<div class="cp-kv"><span>ID</span><b>' + escapeHtml(order.id || "-") + '</b></div>' +
                '<div class="cp-kv"><span>Fecha</span><b>' + escapeHtml(formatDateTime(order.createdAt)) + '</b></div>' +
                '<div class="cp-kv"><span>Cliente</span><b>' + escapeHtml(order.name || order.contact || "-") + '</b></div>' +
                '<div class="cp-kv"><span>Total</span><b>' + formatMoney(order.total || 0) + '</b></div>' +
                '<div class="cp-kv"><span>Pago</span><b>' + escapeHtml(order.paymentStatus || "-") + '</b></div>' +
                '<div class="cp-kv"><span>Medio de pago</span><b>' + escapeHtml(order.paymentMethod || "-") + '</b></div>' +
                '<div class="cp-kv"><span>Estado</span><b>' + escapeHtml(order.workflowState || order.orderStatus || "-") + '</b></div>' +
                '<div class="cp-kv"><span>Notas</span><b>' + escapeHtml(order.notes || "-") + '</b></div>' +
              '</section>' +
              '<section class="cp-order-detail-card">' +
                '<h4>Items</h4>' +
                itemsHtml +
              '</section>' +
              '<section class="cp-order-detail-card cp-order-chat-card">' +
                '<h4>Conversacion</h4>' +
                messagesHtml +
              '</section>' +
            '</div>'
          );
        };

        const detailCache = new Map();
        const ordersBody = document.querySelector(".cp-orders-body");

        const closeOtherOrderDetails = (exceptOrderId) => {
          document.querySelectorAll(".cp-order-detail-row").forEach((detailRow) => {
            const rowOrderId = String(detailRow.getAttribute("data-order-detail") || "").trim();
            if (exceptOrderId && rowOrderId === exceptOrderId) return;
            detailRow.classList.add("cp-hidden");
          });
          document.querySelectorAll(".cp-order-row").forEach((row) => {
            const rowOrderId = String(row.getAttribute("data-order-id") || "").trim();
            if (exceptOrderId && rowOrderId === exceptOrderId) return;
            row.classList.remove("active");
            row.setAttribute("aria-expanded", "false");
          });
        };

        const findDetailRowForOrder = (orderId) => {
          if (!orderId) return null;
          const selector = '.cp-order-detail-row[data-order-detail="' + orderId + '"]';
          return document.querySelector(selector);
        };

        const toggleOrderDetail = async (row) => {
          if (!row) return;
          const orderId = String(row.getAttribute("data-order-id") || "").trim();
          if (!orderId) return;
          const detailRow = findDetailRowForOrder(orderId);
          if (!detailRow) return;
          const shell = detailRow.querySelector(".cp-order-detail-shell");
          if (!shell) return;

          const isOpen = !detailRow.classList.contains("cp-hidden");
          closeOtherOrderDetails(orderId);

          if (isOpen) {
            detailRow.classList.add("cp-hidden");
            row.classList.remove("active");
            row.setAttribute("aria-expanded", "false");
            return;
          }

          detailRow.classList.remove("cp-hidden");
          row.classList.add("active");
          row.setAttribute("aria-expanded", "true");

          if (detailCache.has(orderId)) {
            shell.innerHTML = renderDetail(detailCache.get(orderId));
            return;
          }

          shell.innerHTML = '<div class="cp-order-detail-loading">Cargando detalle...</div>';
          try {
            const response = await fetch('/panel/pedidos/' + encodeURIComponent(orderId) + '/detail', {
              headers: { Accept: "application/json" },
              credentials: "same-origin",
            });
            if (!response.ok) {
              const text = await response.text();
              throw new Error(text || ("Error " + response.status));
            }
            const payload = await response.json();
            detailCache.set(orderId, payload);
            shell.innerHTML = renderDetail(payload);
          } catch (err) {
            const errText = err && err.message ? err.message : String(err);
            shell.innerHTML = '<div class="cp-empty">No se pudo cargar el detalle: ' + escapeHtml(errText) + '</div>';
          }
        };

        const getEventTargetElement = (event) => {
          const target = event && event.target;
          if (!target) return null;
          if (target instanceof Element) return target;
          if (typeof Node !== "undefined" && target instanceof Node) return target.parentElement || null;
          return null;
        };

        const shouldSkipToggle = (element) => {
          if (!element) return false;
          return !!element.closest("form,button,input,select,label,a,[data-no-toggle='1']");
        };

        const bindOrderRow = (row) => {
          if (!(row instanceof Element)) return;

          row.addEventListener("click", (event) => {
            const target = getEventTargetElement(event);
            if (shouldSkipToggle(target)) return;
            toggleOrderDetail(row);
          });

          row.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            const target = getEventTargetElement(event);
            if (shouldSkipToggle(target)) return;
            event.preventDefault();
            toggleOrderDetail(row);
          });
        };

        if (ordersBody) {
          const orderRows = Array.from(ordersBody.querySelectorAll(".cp-order-row"));
          orderRows.forEach((row) => bindOrderRow(row));
        }

      })();
    </script>
  `;

  res.type("text/html").send(renderClientPage({
    company,
    active: "pedidos",
    title: "Pedidos",
    subtitle: `${company.name || company.id} - seguimiento operativo`,
    bodyHtml,
    showIntegrationsNav: req.clientHasIntegrations,
  }));
});

app.get("/panel/pedidos/:id/detail", requireClientAuth, requireClientSectionAccess("pedidos"), async (req, res) => {
  const company = req.company;
  const orderId = String(req.params.id || "").trim();
  if (!orderId) return res.status(400).json({ error: "orderId requerido" });

  try {
    const payload = await fetchClientOrderDetailPayload(company, orderId, 120);
    return res.json(payload);
  } catch (e) {
    if (Number(e?.statusCode || 0) === 403) return res.status(403).json({ error: "Pedido no pertenece a esta empresa" });
    const msg = String(e?.message || e);
    if (msg.includes("404")) return res.status(404).json({ error: "Pedido no encontrado" });
    return res.status(500).json({ error: msg });
  }
});

app.get("/panel/pedidos/ver/:id", requireClientAuth, loadClientIntegrationFlag, requireClientSectionAccess("pedidos"), async (req, res) => {
  const company = req.company;
  const orderId = String(req.params.id || "").trim();
  if (!orderId) return res.redirect("/panel/pedidos");

  try {
    const payload = await fetchClientOrderDetailPayload(company, orderId, 250);
    const order = payload.order || {};
    const itemsDetailed = Array.isArray(payload.itemsDetailed) ? payload.itemsDetailed : [];
    const messages = Array.isArray(payload.messages) ? payload.messages : [];

    const itemsHtml = itemsDetailed.length
      ? `<ul class="cp-order-items">${
          itemsDetailed.map((item) => `
            <li>
              <span>${escapeHtml(item.name || `Producto ${item.id || "-"}`)}</span>
              <span>x${escapeHtml(item.qty || 1)} - ${formatMoney(toNumber(item.subtotal || item.unit || 0), "USD")}</span>
            </li>
          `).join("")
        }</ul>`
      : `<div class="cp-empty">Sin items detallados.</div>`;

    const conversationHtml = messages.length
      ? `<div class="cp-order-chat">${
          messages.map((msg) => {
            const isOut = String(msg.direction || "").toLowerCase() === "out";
            const mediaUrl = String(msg.mediaUrl || "").trim();
            const mediaType = String(msg.mediaContentType || "").trim();
            const isImage = mediaUrl && mediaType.toLowerCase().startsWith("image/");
            return `
              <article class="cp-order-msg ${isOut ? "out" : "in"}">
                <div class="cp-order-msg-meta">
                  <span>${isOut ? "Bot" : "Cliente"}</span>
                  <span>${escapeHtml(formatDateLabel(msg.createdAt))}</span>
                </div>
                ${msg.content ? `<p class="cp-order-msg-text">${escapeHtml(msg.content).replace(/\r?\n/g, "<br/>")}</p>` : ""}
                ${mediaUrl ? `
                  <div class="cp-order-msg-media">
                    <span>${escapeHtml(mediaType || "adjunto")}</span>
                    <a href="${escapeHtml(mediaUrl)}" target="_blank" rel="noopener noreferrer">Abrir adjunto</a>
                    ${isImage ? `<img src="${escapeHtml(mediaUrl)}" alt="Adjunto pedido" loading="lazy" />` : ""}
                  </div>
                ` : ""}
              </article>
            `;
          }).join("")
        }</div>`
      : `<div class="cp-empty">Sin conversacion para este pedido.</div>`;

    const bodyHtml = `
      <section class="cp-grid">
        <article class="cp-card cp-span-3">
          <div class="cp-card-head">
            <h3>Detalle de pedido ${escapeHtml(order.id || "-")}</h3>
            <a class="cp-btn" href="/panel/pedidos">Volver al listado</a>
          </div>
          <div class="cp-order-detail-grid">
            <section class="cp-order-detail-card">
              <h4>Datos del pedido</h4>
              <div class="cp-kv"><span>ID</span><b>${escapeHtml(order.id || "-")}</b></div>
              <div class="cp-kv"><span>Fecha</span><b>${escapeHtml(formatDateLabel(order.createdAt))}</b></div>
              <div class="cp-kv"><span>Cliente</span><b>${escapeHtml(order.name || order.contact || "-")}</b></div>
              <div class="cp-kv"><span>Total</span><b>${formatMoney(toNumber(order.total || 0), "USD")}</b></div>
              <div class="cp-kv"><span>Pago</span><b>${escapeHtml(clientPaymentStatusLabel(order.paymentStatus || ""))}</b></div>
              <div class="cp-kv"><span>Medio de pago</span><b>${escapeHtml(clientPaymentMethodLabel(order))}</b></div>
              <div class="cp-kv"><span>Estado</span><b>${escapeHtml(clientOrderCategoryLabel(extractClientOrderWorkflow(order).state))}</b></div>
              <div class="cp-kv"><span>Notas</span><b>${escapeHtml(order.notes || "-")}</b></div>
            </section>
            <section class="cp-order-detail-card">
              <h4>Items</h4>
              ${itemsHtml}
            </section>
            <section class="cp-order-detail-card cp-order-chat-card">
              <h4>Conversacion</h4>
              ${conversationHtml}
            </section>
          </div>
        </article>
      </section>
    `;

    return res.type("text/html").send(renderClientPage({
      company,
      active: "pedidos",
      title: `Pedido ${order.id || orderId}`,
      subtitle: `${company.name || company.id} - detalle operativo`,
      bodyHtml,
      showIntegrationsNav: req.clientHasIntegrations,
    }));
  } catch (e) {
    const message = String(e?.message || e);
    return res.status(500).type("text/html").send(renderClientPage({
      company,
      active: "pedidos",
      title: "Detalle de pedido",
      subtitle: `${company.name || company.id} - seguimiento operativo`,
      bodyHtml: `
        <section class="cp-grid">
          <article class="cp-card cp-span-3">
            <div class="cp-alert error">No se pudo cargar el pedido: ${escapeHtml(message)}</div>
            <a class="cp-btn" href="/panel/pedidos">Volver</a>
          </article>
        </section>
      `,
      showIntegrationsNav: req.clientHasIntegrations,
    }));
  }
});

app.post("/panel/pedidos/payment", requireClientAuth, requireClientSectionAccess("pedidos"), async (req, res) => {
  const company = req.company;
  const orderId = String(req.body.orderId || "").trim();
  const paymentStatus = String(req.body.paymentStatus || "").trim().toLowerCase();

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

  if (!orderId || !["pending", "paid", "failed"].includes(paymentStatus)) {
    const next = redirectBase();
    return res.redirect(`${next}${next.includes("?") ? "&" : "?"}error=${encodeURIComponent("Datos invalidos para actualizar pago")}`);
  }

  try {
    const params = new URLSearchParams();
    params.set("companyId", String(company.id));
    params.set("q", orderId);
    params.set("limit", "25");
    const orders = await api(`/api/orders?${params.toString()}`);
    const match = (Array.isArray(orders) ? orders : []).find((item) => String(item.id || "") === orderId);
    if (!match) throw new Error("El pedido no pertenece a esta empresa");

    await api(`/api/orders/${encodeURIComponent(orderId)}/payment-status`, {
      method: "POST",
      body: { paymentStatus },
    });

    const next = redirectBase();
    return res.redirect(`${next}${next.includes("?") ? "&" : "?"}updatedPayment=1`);
  } catch (e) {
    const next = redirectBase();
    return res.redirect(`${next}${next.includes("?") ? "&" : "?"}error=${encodeURIComponent(e?.message || e)}`);
  }
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

app.get("/panel/soporte", requireClientAuth, loadClientIntegrationFlag, requireClientSectionAccess("soporte"), async (req, res) => {
  const company = req.company;
  const messageSent = String(req.query.messageSent || "") === "1";
  const supportError = String(req.query.supportError || req.query.error || "").trim();
  const toHtmlText = (value) => escapeHtml(value || "").replace(/\r?\n/g, "<br/>");

  try {
    // Usamos el company cacheado (ya disponible en req.company desde requireClientAuth).
    // Si hay mensajes no leídos, los marcamos como leídos e invalidamos el caché
    // para que el próximo load vea el estado actualizado.
    const rulesRaw = parseJsonSafe(company.rulesJson || "{}", {});
    const rules = rulesRaw && typeof rulesRaw === "object" ? rulesRaw : {};
    let inbox = extractAdminInbox(rules);

    const hasUnreadAdminMessages = inbox.some((item) => item.sender === "admin" && !item.readByClient);
    if (hasUnreadAdminMessages) {
      inbox = inbox.map((item) => (item.sender === "admin" ? { ...item, readByClient: true } : item));
      setAdminInbox(rules, inbox);
      try {
        await saveCompanyRules(company, rules);
        // Actualizar el company cacheado con el inbox ya marcado como leído
        const updatedCompany = { ...company, rulesJson: JSON.stringify(rules) };
        setCachedClientCompany(updatedCompany);
      } catch {
        // no-op
      }
    }

    const openCount = inbox.filter((item) => item.status === "open").length;
    const resolvedCount = inbox.filter((item) => item.status === "resolved").length;
    const unreadCount = inbox.filter((item) => item.sender === "admin" && !item.readByClient).length;
    const inboxRows = inbox
      .slice()
      .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))
      .map((item) => {
        const subject = buildSupportMessageSubject(item);
        return `
        <details class="cp-msg-item ${item.sender === "admin" ? "from-admin" : "from-client"}">
          <summary class="cp-msg-summary">
            <span class="cp-msg-subject" title="${escapeHtml(subject)}">${escapeHtml(subject)}</span>
            <span class="cp-msg-meta">
              <span class="cp-msg-date">${escapeHtml(formatDateLabel(item.createdAt))}</span>
              <span class="cp-msg-state ${item.status === "resolved" ? "resolved" : "open"}">${item.status === "resolved" ? "Resuelto" : "Abierto"}</span>
            </span>
          </summary>
          <div class="cp-msg-body">
            <div class="cp-msg-head">
              <span class="cp-msg-who">${item.sender === "admin" ? "Admin" : "Empresa"}</span>
              ${item.orderId ? `<span class="cp-msg-order">Pedido: ${escapeHtml(item.orderId)}</span>` : ""}
            </div>
            <p class="cp-msg-text">${toHtmlText(item.text)}</p>
          </div>
        </details>
      `;
      })
      .join("");

    const bodyHtml = `
      ${messageSent ? `<div class="cp-alert success">Mensaje enviado al admin.</div>` : ""}
      ${supportError ? `<div class="cp-alert error">${escapeHtml(supportError)}</div>` : ""}

      <section class="cp-stats">
        <article class="cp-stat"><div class="cp-stat-label">Mensajes</div><div class="cp-stat-value">${inbox.length}</div><div class="cp-stat-hint">total historial</div></article>
        <article class="cp-stat"><div class="cp-stat-label">Abiertos</div><div class="cp-stat-value">${openCount}</div><div class="cp-stat-hint">pendientes de gestion</div></article>
        <article class="cp-stat"><div class="cp-stat-label">Resueltos</div><div class="cp-stat-value">${resolvedCount}</div><div class="cp-stat-hint">cerrados</div></article>
        <article class="cp-stat"><div class="cp-stat-label">Sin leer</div><div class="cp-stat-value">${unreadCount}</div><div class="cp-stat-hint">respuestas del admin</div></article>
      </section>

      <section class="cp-grid">
        <article class="cp-card cp-span-3" id="cp-inbox">
          <div class="cp-card-head"><h3>Conversaciones</h3><span>${inbox.length} mensajes</span></div>
          <form method="POST" action="/panel/soporte/messages" class="cp-form">
            <div class="cp-grid-2">
              <div>
                <label>Asunto</label>
                <input name="messageSubject" maxlength="120" placeholder="Ej: Cambio de plan / Error de pedidos" />
              </div>
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
            <label>Mensaje</label>
            <textarea name="messageText" rows="3" maxlength="1000" placeholder="Describe tu consulta, incidencia o solicitud"></textarea>
            <div class="cp-actions">
              <button class="cp-btn primary" type="submit">Enviar</button>
            </div>
          </form>
          <div class="cp-msg-list">
            ${inboxRows || `<div class="cp-empty">Sin mensajes todavia.</div>`}
          </div>
        </article>
      </section>
    `;

    return res.type("text/html").send(renderClientPage({
      company,
      active: "soporte",
      title: "Soporte",
      subtitle: `${company.name || company.id} - soporte con admin`,
      bodyHtml,
      showIntegrationsNav: req.clientHasIntegrations,
    }));
  } catch (e) {
    return res.status(500).send(`No se pudo cargar soporte: ${escapeHtml(e?.message || e)}`);
  }
});

app.get("/panel/conversaciones", requireClientAuth, loadClientIntegrationFlag, requireClientSectionAccess("conversaciones"), async (req, res) => {
  const company = req.company;
  const {
    selectedRange,
    filterFrom,
    filterTo,
    rangeLabel,
    fromInput,
    toInput,
  } = parseClientOrdersFilters({ ...req.query, range: req.query.range || "today" });
  let rows = [];
  let fetchError = "";
  try {
    rows = await buildClientConversationSummary(company, {
      limitRows: 50,
      includeMessages: true,
      filterFrom,
      filterTo,
    });
  } catch (e) {
    fetchError = e?.message || String(e);
  }

  const counts = rows.reduce((acc, row) => {
    const key = row.statusKey || "process";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, { process: 0, closed: 0, bot: 0, generated: 0 });

  const conversationRows = rows.map((row) => {
    const messagesHtml = Array.isArray(row.messages) && row.messages.length
      ? row.messages.map((msg) => `
        <div class="cp-order-msg ${msg.direction === "out" ? "out" : "in"}">
          <div class="cp-order-msg-meta">
            <span>${msg.direction === "out" ? "Bot" : "Cliente"}</span>
            <span>${escapeHtml(formatDateLabel(msg.createdAt))}</span>
          </div>
          <div class="cp-order-msg-text">${escapeHtml(msg.content || "(sin texto)")}</div>
          ${msg.mediaUrl ? `<div class="cp-order-msg-media"><a href="${escapeHtml(msg.mediaUrl)}" target="_blank" rel="noreferrer">Abrir adjunto</a></div>` : ""}
        </div>
      `).join("")
      : `<div class="cp-empty">Sin mensajes asociados para esta conversacion.</div>`;
    const interactionLabel = row.interactionAt
      ? new Date(row.interactionAt).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
      : "-";
    return `
      <details class="cp-card cp-span-3 cp-conversation-item">
        <summary class="cp-conversation-summary">
          <span class="cp-conversation-client">${escapeHtml(row.customerName)}</span>
          <span class="cp-conversation-last">${escapeHtml(row.lastMessage)}</span>
          <span class="cp-conv-status ${escapeHtml(row.statusKey)}">
            <span class="cp-conv-dot" aria-hidden="true"></span>
            ${escapeHtml(row.statusLabel)}
          </span>
          <span class="cp-conversation-time">${escapeHtml(interactionLabel)}</span>
        </summary>
        <div class="cp-conversation-body">
          <div class="cp-conversation-meta">
            <span>Pedido: ${row.orderId ? `<a class="cp-order-link" href="/panel/pedidos/ver/${encodeURIComponent(row.orderId)}">${escapeHtml(row.orderId)}</a>` : "-"}</span>
            <span>Total: ${formatMoney(row.total, "USD")}</span>
            <span>Medio: ${escapeHtml(clientPaymentMethodLabel({ paymentMethod: row.paymentMethod }))}</span>
          </div>
          <div class="cp-order-detail-shell cp-conversation-shell">
            ${messagesHtml}
          </div>
        </div>
      </details>
    `;
  }).join("");

  const bodyHtml = `
    ${fetchError ? `<div class="cp-alert error">No se pudo cargar conversaciones: ${escapeHtml(fetchError)}</div>` : ""}

    <section class="cp-grid">
      <article class="cp-card cp-span-3">
        <div class="cp-card-head"><h3>Filtros</h3><span>${escapeHtml(rangeLabel)}</span></div>
        <form method="GET" action="/panel/conversaciones" class="cp-form">
          <div class="cp-grid-2">
            <div>
              <label>Periodo</label>
              <select id="convRangeSelect" name="range">
                <option value="today" ${selectedRange === "today" ? "selected" : ""}>Del dia</option>
                <option value="week" ${selectedRange === "week" ? "selected" : ""}>De la semana</option>
                <option value="month" ${selectedRange === "month" ? "selected" : ""}>Ultimo mes</option>
                <option value="3months" ${selectedRange === "3months" ? "selected" : ""}>Ultimos 3 meses</option>
                <option value="custom" ${selectedRange === "custom" ? "selected" : ""}>Personalizado</option>
              </select>
            </div>
          </div>
          <div id="convCustomRange" class="cp-grid-2 ${selectedRange === "custom" ? "" : "cp-hidden"}">
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
            <a class="cp-btn" href="/panel/conversaciones">Limpiar</a>
          </div>
        </form>
      </article>

      <article class="cp-card cp-span-3">
        <div class="cp-card-head"><h3>💬 Conversaciones</h3><span>${rows.length} registros &mdash; ${escapeHtml(rangeLabel)}</span></div>
        <div class="cp-conversation-list">
          ${conversationRows || `<div class="cp-empty">Sin conversaciones para este periodo.</div>`}
        </div>
      </article>
    </section>
    <script>
      (() => {
        const range = document.getElementById("convRangeSelect");
        const custom = document.getElementById("convCustomRange");
        if (range && custom) {
          const sync = () => {
            if (range.value === "custom") custom.classList.remove("cp-hidden");
            else custom.classList.add("cp-hidden");
          };
          range.addEventListener("change", sync);
          sync();
        }
      })();
    </script>
  `;

  return res.type("text/html").send(renderClientPage({
    company,
    active: "conversaciones",
    title: "Conversaciones",
    subtitle: `${company.name || company.id} - resumen de interacciones con clientes`,
    bodyHtml,
    showIntegrationsNav: req.clientHasIntegrations,
  }));
});

app.get("/panel/integraciones", requireClientAuth, loadClientIntegrationFlag, requireClientSectionAccess("integraciones"), async (req, res) => {
  const company = req.company;
  const integrationModules = await fetchClientIntegrationModules(company.id);
  const bodyHtml = renderClientIntegrationModulesSection(integrationModules);
  return res.type("text/html").send(renderClientPage({
    company,
    active: "integraciones",
    title: "Integraciones",
    subtitle: `${company.name || company.id} - paneles y datos externos`,
    bodyHtml,
    showIntegrationsNav: req.clientHasIntegrations,
  }));
});

app.post("/panel/soporte/messages", requireClientAuth, requireClientSectionAccess("soporte"), async (req, res) => {
  const company = req.company;
  const id = String(company?.id || "").trim();
  const messageSubject = String(req.body.messageSubject || "").trim();
  const messageText = String(req.body.messageText || "").trim();
  const orderId = String(req.body.orderId || "").trim();
  const statusRaw = String(req.body.statusMessage || "").trim().toLowerCase();
  const status = statusRaw === "resolved" ? "resolved" : "open";

  if (messageSubject.length > 120) {
    return res.redirect(`/panel/soporte?supportError=${encodeURIComponent("El asunto supera 120 caracteres")}#cp-inbox`);
  }

  if (!messageText) {
    return res.redirect(`/panel/soporte?supportError=${encodeURIComponent("Escribe un mensaje antes de enviar")}#cp-inbox`);
  }

  if (messageText.length > 1000) {
    return res.redirect(`/panel/soporte?supportError=${encodeURIComponent("El mensaje supera 1000 caracteres")}#cp-inbox`);
  }

  try {
    const currentCompany = await api(`/api/companies/${encodeURIComponent(id)}`);
    const rulesRaw = parseJsonSafe(currentCompany.rulesJson || "{}", {});
    const rules = rulesRaw && typeof rulesRaw === "object" ? rulesRaw : {};
    const inbox = extractAdminInbox(rules);

    inbox.push({
      id: createInboxMessageId(),
      sender: "client",
      subject: messageSubject,
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
    return res.redirect(`/panel/soporte?supportError=${encodeURIComponent(e?.message || e)}#cp-inbox`);
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

app.get("/panel/suscripcion", requireClientAuth, loadClientIntegrationFlag, requireClientSectionAccess("suscripcion"), async (req, res) => {
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
    ${requested ? `<div class="cp-alert success">Solicitud de ${escapeHtml(actionLabel)} enviada. El admin la revisara y aplicara el cambio.</div>` : ""}
    ${errorMsg ? `<div class="cp-alert error">${escapeHtml(errorMsg)}</div>` : ""}

    <section class="cp-stats">
      <article class="cp-stat">
        <div class="cp-stat-label">Plan activo</div>
        <div class="cp-stat-value">${escapeHtml(state.plan.planLabel)}</div>
        <div class="cp-stat-hint">${escapeHtml(state.plan.channelLabel)}</div>
      </article>
      <article class="cp-stat">
        <div class="cp-stat-label">Estado</div>
        <div class="cp-stat-value">${escapeHtml(state.subscription.status)}</div>
        <div class="cp-stat-hint">cuenta</div>
      </article>
      <article class="cp-stat">
        <div class="cp-stat-label">Monto mensual</div>
        <div class="cp-stat-value">${formatMoney(state.subscription.amount, state.subscription.currency)}</div>
        <div class="cp-stat-hint">${escapeHtml(state.subscription.cycle)}</div>
      </article>
      <article class="cp-stat">
        <div class="cp-stat-label">Proxima renovacion</div>
        <div class="cp-stat-value" style="font-size:18px">${escapeHtml(formatDateLabel(state.subscription.renewalAt))}</div>
        <div class="cp-stat-hint">${formatMoney(state.subscription.nextAmount, state.subscription.currency)}</div>
      </article>
    </section>

    <section class="cp-grid">
      <article class="cp-card cp-span-2">
        <h3>Detalle del plan</h3>
        <div class="cp-kv"><span>Plan</span><b>${escapeHtml(state.plan.planLabel)}</b></div>
        <div class="cp-kv"><span>Canales incluidos</span><b>${escapeHtml(state.plan.channelLabel)}</b></div>
        <div class="cp-kv"><span>Estado</span><b>${escapeHtml(state.subscription.status)}</b></div>
        <div class="cp-kv"><span>Inicio del ciclo actual</span><b>${escapeHtml(formatDateLabel(state.subscription.startAt))}</b></div>
        <div class="cp-kv"><span>Fin del ciclo actual</span><b>${escapeHtml(formatDateLabel(state.subscription.endAt))}</b></div>
        <div class="cp-kv"><span>Monto actual</span><b>${formatMoney(state.subscription.amount, state.subscription.currency)}</b></div>
        <div class="cp-kv"><span>Proximo cobro</span><b>${formatMoney(state.subscription.nextAmount, state.subscription.currency)} — ${escapeHtml(formatDateLabel(state.subscription.renewalAt))}</b></div>
        <div class="cp-kv"><span>Renovacion</span><b>${state.subscription.autoRenew ? "Automatica" : "Manual"}</b></div>
        <p class="cp-note" style="margin-top:12px">Los cambios de plan requieren aprobacion del equipo. Te contactaremos para confirmar.</p>
        <div class="cp-actions" style="margin-top:12px">
          <form method="POST" action="/panel/suscripcion/action">
            <input type="hidden" name="action" value="upgrade" />
            <button class="cp-btn primary" type="submit">Solicitar upgrade</button>
          </form>
          <form method="POST" action="/panel/suscripcion/action">
            <input type="hidden" name="action" value="downgrade" />
            <button class="cp-btn" type="submit">Solicitar downgrade</button>
          </form>
          <form method="POST" action="/panel/suscripcion/action" onsubmit="return confirm('Se enviara una solicitud de cancelacion. Continuar?')">
            <input type="hidden" name="action" value="cancel" />
            <button class="cp-btn danger" type="submit">Solicitar cancelacion</button>
          </form>
        </div>
      </article>

      <article class="cp-card">
        <h3>Tu bot</h3>
        <div class="cp-kv"><span>Productos configurados</span><b>${state.catalog.length}</b></div>
        <div class="cp-kv"><span>Atencion humana</span><b>${state.rules.allowHuman ? "Activa" : "Inactiva"}</b></div>
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
    showIntegrationsNav: req.clientHasIntegrations,
  }));
});

app.post("/panel/suscripcion/action", requireClientAuth, requireClientSectionAccess("suscripcion"), async (req, res) => {
  const company = req.company;
  const action = String(req.body.action || "").trim().toLowerCase();
  if (!["upgrade", "downgrade", "cancel"].includes(action)) {
    return res.redirect("/panel/cuenta");
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

    res.redirect(`/panel/cuenta?requested=1&action=${encodeURIComponent(action)}`);
  } catch (e) {
    res.redirect(`/panel/cuenta?error=${encodeURIComponent(e?.message || e)}`);
  }
});

app.get("/panel/cuenta", requireClientAuth, loadClientIntegrationFlag, requireClientSectionAccess("cuenta"), async (req, res) => {
  const company = req.company;
  const saved = String(req.query.saved || "") === "1";
  const errorMsg = String(req.query.error || "").trim();
  const requested = String(req.query.requested || "") === "1";
  const requestedAction = String(req.query.action || "").trim().toLowerCase();
  const actionLabel = requestedAction === "upgrade"
    ? "Upgrade"
    : requestedAction === "downgrade"
      ? "Downgrade"
      : requestedAction === "cancel"
        ? "Cancelacion"
        : "Actualizacion";

  try {
    const { state } = await loadClientStateWithProvider(company);
    const payment = extractPaymentSettings(state.rules || {});

    const bodyHtml = `
      ${saved ? `<div class="cp-alert success">Datos de cuenta actualizados.</div>` : ""}
      ${errorMsg ? `<div class="cp-alert error">${escapeHtml(errorMsg)}</div>` : ""}
      ${requested ? `<div class="cp-alert success">Solicitud de ${escapeHtml(actionLabel)} enviada al admin para revision.</div>` : ""}

      <section class="cp-grid">
        <details class="cp-card cp-span-2 cp-card-toggle">
          <summary>
            <span>Datos de cuenta</span>
            <span class="cp-details-hint">${escapeHtml(company.id)}</span>
          </summary>
          <div class="cp-card-toggle-body">
            <form method="POST" action="/panel/cuenta/save" class="cp-form cp-form-sections">
              <details class="cp-company-details cp-form-section">
                <summary><span>Contacto principal</span><span class="cp-details-hint">Responsable</span></summary>
                <div class="cp-company-details-body">
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
                </div>
              </details>

              <details class="cp-company-details cp-form-section">
                <summary><span>Ubicacion</span><span class="cp-details-hint">Empresa</span></summary>
                <div class="cp-company-details-body">
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
                </div>
              </details>

              <details class="cp-company-details cp-form-section">
                <summary><span>Acceso</span><span class="cp-details-hint">Seguridad</span></summary>
                <div class="cp-company-details-body">
                  <label>Nueva contrasena de acceso (opcional)</label>
                  <input name="clientPassword" type="password" placeholder="Dejar vacio para no cambiar" />
                </div>
              </details>

              <details class="cp-company-details cp-form-section">
                <summary><span>Medios de pago</span><span class="cp-details-hint">Opciones para clientes</span></summary>
                <div class="cp-company-details-body">
                  <p class="cp-note" style="margin-top:0">Configura los medios para que el bot los ofrezca al cliente. El comprobante de transferencia es opcional.</p>
                  <div class="cp-grid-2">
                    <label><input type="checkbox" name="paymentCash" value="1" ${payment.cash ? "checked" : ""} /> Efectivo</label>
                    <label><input type="checkbox" name="paymentDebit" value="1" ${payment.debit ? "checked" : ""} /> Debito</label>
                    <label><input type="checkbox" name="paymentTransfer" value="1" ${payment.transfer ? "checked" : ""} /> Transferencia</label>
                    <label><input type="checkbox" name="paymentCredit" value="1" ${payment.credit ? "checked" : ""} /> Tarjeta de credito</label>
                  </div>
                </div>
              </details>

              <details class="cp-company-details cp-form-section">
                <summary><span>Datos para transferencia</span><span class="cp-details-hint">CBU / Alias / Titular</span></summary>
                <div class="cp-company-details-body">
                  <div class="cp-grid-2">
                    <div>
                      <label>Banco</label>
                      <input name="paymentTransferBankName" value="${escapeHtml(payment.transferBankName)}" />
                    </div>
                    <div>
                      <label>Tipo de cuenta</label>
                      <input name="paymentTransferAccountType" value="${escapeHtml(payment.transferAccountType)}" placeholder="Caja de ahorro / Cuenta corriente" />
                    </div>
                    <div>
                      <label>Razon social / Titular</label>
                      <input name="paymentTransferAccountHolder" value="${escapeHtml(payment.transferAccountHolder)}" />
                    </div>
                    <div>
                      <label>CUIT/CUIL</label>
                      <input name="paymentTransferTaxId" value="${escapeHtml(payment.transferTaxId)}" />
                    </div>
                    <div>
                      <label>CBU</label>
                      <input name="paymentTransferCbu" value="${escapeHtml(payment.transferCbu)}" />
                    </div>
                    <div>
                      <label>Alias</label>
                      <input name="paymentTransferAlias" value="${escapeHtml(payment.transferAlias)}" />
                    </div>
                  </div>

                  <label>Nota para transferencia (opcional)</label>
                  <input name="paymentTransferNote" value="${escapeHtml(payment.transferNote)}" placeholder="Ej: enviar comprobante por este chat" />
                </div>
              </details>

              <details class="cp-company-details cp-form-section">
                <summary><span>Instrucciones generales</span><span class="cp-details-hint">Texto para el bot</span></summary>
                <div class="cp-company-details-body">
                  <label>Instrucciones generales de pago</label>
                  <textarea name="paymentInstructions" rows="3" placeholder="Ej: horario de caja, aclaraciones, etc.">${escapeHtml(payment.instructions)}</textarea>
                </div>
              </details>

              <div class="cp-actions">
                <button class="cp-btn primary" type="submit">Guardar datos</button>
              </div>
            </form>
          </div>
        </details>

        <details class="cp-card cp-card-toggle" open>
          <summary>
            <span>Suscripcion</span>
            <span class="cp-details-hint">${escapeHtml(state.plan.planLabel)}</span>
          </summary>
          <div class="cp-card-toggle-body">
            <div class="cp-kv"><span>Tipo</span><b>${escapeHtml(state.plan.planLabel)}</b></div>
            <div class="cp-kv"><span>Canal</span><b>${escapeHtml(state.plan.channelLabel)}</b></div>
            <div class="cp-kv"><span>Clase bot</span><b>${escapeHtml(state.plan.botClass)}</b></div>
            <div class="cp-kv"><span>Estado</span><b>${escapeHtml(state.subscription.status)}</b></div>
            <div class="cp-kv"><span>Renueva</span><b>${escapeHtml(formatDateLabel(state.subscription.renewalAt))}</b></div>
            <div class="cp-actions" style="margin-top:12px">
              <form method="POST" action="/panel/suscripcion/action">
                <input type="hidden" name="action" value="downgrade" />
                <button class="cp-btn" type="submit">Bajar plan</button>
              </form>
              <form method="POST" action="/panel/suscripcion/action">
                <input type="hidden" name="action" value="upgrade" />
                <button class="cp-btn primary" type="submit">Subir plan</button>
              </form>
              <form method="POST" action="/panel/suscripcion/action" onsubmit="return confirm('Se enviara una solicitud de cancelacion al admin. Continuar?')">
                <input type="hidden" name="action" value="cancel" />
                <button class="cp-btn danger" type="submit">Cancelar suscripcion</button>
              </form>
            </div>
          </div>
        </details>
      </section>
    `;

    return res.type("text/html").send(renderClientPage({
      company,
      active: "cuenta",
      title: "Cuenta",
      subtitle: `${company.name || company.id} - datos personales y suscripcion`,
      bodyHtml,
      showIntegrationsNav: req.clientHasIntegrations,
    }));
  } catch (e) {
    return res.status(500).send(`No se pudo cargar cuenta: ${escapeHtml(e?.message || e)}`);
  }
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

  const asBool = (value) => {
    const raw = String(value || "").trim().toLowerCase();
    return ["1", "true", "on", "si", "yes"].includes(raw);
  };

  const paymentMethods = {
    cash: asBool(req.body.paymentCash),
    debit: asBool(req.body.paymentDebit),
    transfer: asBool(req.body.paymentTransfer),
    credit: asBool(req.body.paymentCredit),
  };

  const paymentTransfer = {
    bankName: String(req.body.paymentTransferBankName || "").trim(),
    accountType: String(req.body.paymentTransferAccountType || "").trim(),
    accountHolder: String(req.body.paymentTransferAccountHolder || "").trim(),
    taxId: String(req.body.paymentTransferTaxId || "").trim(),
    cbu: String(req.body.paymentTransferCbu || "").trim(),
    alias: String(req.body.paymentTransferAlias || "").trim(),
    note: String(req.body.paymentTransferNote || "").trim(),
  };

  if (paymentTransfer.cbu || paymentTransfer.alias || paymentTransfer.accountHolder || paymentTransfer.bankName) {
    paymentMethods.transfer = true;
  }

  rules.paymentMethods = paymentMethods;
  rules.paymentTransfer = paymentTransfer;
  rules.paymentTransferEnabled = paymentMethods.transfer;
  rules.paymentInstructions = String(req.body.paymentInstructions || "").trim();

  const newPassword = String(req.body.clientPassword || "").trim();
  if (newPassword) {
    await assignClientPassword(rules, newPassword);
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

const PORT = Number(process.env.PORT || 3001);
app.listen(PORT, () => console.log(`Dashboard running on port ${PORT}`));
