import dotenv from "dotenv";
import crypto from "crypto";
import * as XLSX from "xlsx";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { dashboardDb } from "../db.js";

dotenv.config();

// ====================== CONFIG / CONSTANTES ======================

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

// ====================== SHARED STATE / CACHES ======================

const ADMIN_COMPANIES_CACHE_TTL_MS = Number(process.env.ADMIN_COMPANIES_CACHE_TTL_MS || 180000);
let adminCompaniesCache = {
  items: [],
  updatedAt: 0,
};


// ====================== CORE HELPERS (PART 1) ======================

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

let _dashMaintenanceCache = null;
let _dashMaintenanceCacheAt = 0;
const DASH_MAINTENANCE_TTL = 30 * 1000;

async function getDashMaintenanceMode() {
  const now = Date.now();
  if (_dashMaintenanceCache !== null && now - _dashMaintenanceCacheAt < DASH_MAINTENANCE_TTL) {
    return _dashMaintenanceCache;
  }
  try {
    const data = await api("/api/admin/maintenance");
    _dashMaintenanceCache = data?.maintenanceMode === true;
    _dashMaintenanceCacheAt = now;
    return _dashMaintenanceCache;
  } catch {
    return false;
  }
}

function renderMaintenancePage() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Mantenimiento</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .box { background: #1e293b; border: 1px solid #334155; border-radius: 16px; padding: 48px 40px; max-width: 480px; width: 100%; text-align: center; }
    .icon { font-size: 56px; margin-bottom: 20px; }
    h1 { font-size: 22px; font-weight: 800; color: #f1f5f9; margin-bottom: 12px; }
    p { color: #94a3b8; font-size: 15px; line-height: 1.6; margin-bottom: 8px; }
    .badge { display: inline-block; margin-top: 20px; background: rgba(251,191,36,0.12); border: 1px solid rgba(251,191,36,0.3); color: #fbbf24; border-radius: 999px; padding: 6px 16px; font-size: 12px; font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase; }
    .retry { margin-top: 24px; }
    .retry a { color: #38bdf8; text-decoration: none; font-size: 14px; }
    .retry a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="box">
    <div class="icon">🔧</div>
    <h1>Estamos realizando mantenimiento</h1>
    <p>El panel estará disponible nuevamente en breve.</p>
    <p>Disculpá las molestias.</p>
    <div class="badge">En mantenimiento</div>
    <div class="retry"><a href="">Reintentar →</a></div>
  </div>
</body>
</html>`;
}

async function requireClientAuth(req, res, next) {
  if (!DASH_COOKIE_SECRET) {
    return res.status(500).send("Falta env: DASH_COOKIE_SECRET");
  }

  // Maintenance mode: show maintenance page instead of panel (except login)
  if (!req.path.startsWith("/panel/login") && !req.path.startsWith("/panel/logout")) {
    const inMaintenance = await getDashMaintenanceMode().catch(() => false);
    if (inMaintenance) {
      return res.status(503).type("text/html").send(renderMaintenancePage());
    }
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

function sanitizeRules(raw) {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw)) ? { ...raw } : {};

  // --- Booleans ---
  const BOOL_FIELDS = [
    "aiEnabled", "businessHoursEnabled", "deliveryAddressEnabled",
    "notifyCustomerOnStateChange", "dashboardEnabled", "autoRenew", "allowHuman",
    "orderConfirmationEnabled",
  ];
  for (const k of BOOL_FIELDS) {
    if (k in r) {
      const v = r[k];
      if (typeof v === "boolean") continue;
      if (v === "true" || v === "1" || v === "on") { r[k] = true; continue; }
      if (v === "false" || v === "0" || v === "off" || v === null || v === undefined) { r[k] = false; continue; }
      delete r[k]; // unparseable — drop so default kicks in at read time
    }
  }

  // --- Numbers ---
  const NUM_FIELDS = [
    "rateLimitPerHour", "subscriptionAmount", "subscriptionNextAmount",
    "subscriptionProrationDueNow", "monthlyPrice",
  ];
  for (const k of NUM_FIELDS) {
    if (k in r) {
      const n = Number(r[k]);
      if (Number.isFinite(n)) { r[k] = n; } else { delete r[k]; }
    }
  }

  // --- Strings ---
  const STR_FIELDS = [
    "botClass", "planTier", "channelMode", "dashboardMode", "catalogCurrency",
    "subscriptionCurrency", "businessHoursStart", "businessHoursEnd", "businessHoursTz",
    "businessHoursText", "businessHoursOutsideText",
    "welcomeMessage", "tone", "companyDescription", "botPhone",
    "subscriptionId", "subscriptionStatus", "subscriptionPeriodEnd",
  ];
  for (const k of STR_FIELDS) {
    if (k in r) {
      const v = r[k];
      if (v === null || v === undefined) { delete r[k]; continue; }
      if (typeof v !== "string") r[k] = String(v);
    }
  }

  // --- Arrays ---
  const ARR_FIELDS = ["channels", "businessHoursDays", "faqItems", "adminInbox"];
  for (const k of ARR_FIELDS) {
    if (k in r) {
      if (!Array.isArray(r[k])) r[k] = [];
    }
  }

  // --- Objects ---
  const OBJ_FIELDS = ["paymentMethods", "paymentTransfer"];
  for (const k of OBJ_FIELDS) {
    if (k in r) {
      const v = r[k];
      if (v === null || typeof v !== "object" || Array.isArray(v)) r[k] = {};
    }
  }

  // Unknown fields are left untouched for forward compatibility.
  return r;
}

async function saveCompanyRules(company, rules) {
  const safeRules = sanitizeRules(rules);
  if (dashboardDb.enabled) {
    await dashboardDb.saveCompanyById(company.id, {
      name: company.name || company.id,
      prompt: company.prompt || "",
      catalogJson: company.catalogJson || "[]",
      rulesJson: JSON.stringify(safeRules),
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
      rulesJson: JSON.stringify(safeRules),
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
  const selectedStatus = ["all", "pending", "preparing", "ready", "completed", "rejected", "archived"].includes(selectedStatusRaw)
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
  if (raw.includes("listo") || raw.includes("ready") || raw.includes("preparado") || raw === "listo") return "ready";
  if (raw.includes("prepar") || raw.includes("preparing") || raw.includes("proceso") || raw.includes("cocina")) return "preparing";
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
  if (category === "rejected") return "Rechazado/Cancelado";
  if (category === "preparing") return "En preparacion";
  if (category === "ready") return "Listo para entregar";
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

// ====================== CLIENT/PANEL HELPERS (PART 2) ======================

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

// ====================== ANALYTICS/CONVERSATION HELPERS (PART 3) ======================

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

function buildOrdersBarChartSvg(orders, days = 30) {
  const series = buildBotActivitySeries(orders, days);
  const buckets = series.buckets;
  const maxCount = Math.max(series.max, 1);
  const W = 600;
  const H = 130;
  const padL = 6;
  const padR = 6;
  const padTop = 18;
  const padBot = 28;
  const plotW = W - padL - padR;
  const plotH = H - padTop - padBot;
  const barW = Math.max(2, Math.floor(plotW / buckets.length) - 2);
  const gap = Math.floor(plotW / buckets.length);
  const todayKey = new Date().toISOString().slice(0, 10);

  const bars = buckets.map((bucket, i) => {
    const barH = Math.max(bucket.count > 0 ? 3 : 0, Math.round((bucket.count / maxCount) * plotH));
    const x = padL + i * gap + Math.floor((gap - barW) / 2);
    const y = padTop + plotH - barH;
    const isToday = bucket.key === todayKey;
    const fill = isToday ? "#22d3ee" : "#3b82f6";
    const opacity = bucket.count > 0 ? "1" : "0.15";
    const label = bucket.count > 0 ? `<text x="${x + barW / 2}" y="${y - 3}" text-anchor="middle" font-size="8" fill="#94a3b8">${bucket.count}</text>` : "";
    return `<rect x="${x}" y="${y}" width="${barW}" height="${Math.max(barH, 2)}" rx="2" fill="${fill}" opacity="${opacity}"/>${label}`;
  }).join("");

  const labels = buckets.map((bucket, i) => {
    const showLabel = i % 5 === 0 || i === buckets.length - 1;
    if (!showLabel) return "";
    const x = padL + i * gap + gap / 2;
    return `<text x="${x}" y="${H - 6}" text-anchor="middle" font-size="9" fill="#64748b">${bucket.shortLabel}</text>`;
  }).join("");

  const axisY = padTop + plotH;
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" class="cp-bar-chart-svg" aria-hidden="true">
    <line x1="${padL}" y1="${axisY}" x2="${W - padR}" y2="${axisY}" stroke="#1e293b" stroke-width="1"/>
    ${bars}
    ${labels}
  </svg>`;
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

// ====================== EXPORTS ======================
export {
  // email
  sendEmail,
  // config constants
  DASH_USER, DASH_PASS, DASH_COOKIE_SECRET,
  API_BASE_URL, API_TOKEN, BOT_CATALOG_PROVIDER_ID,
  ADMIN_INBOX_MAX_ITEMS,
  ADMIN_COMPANIES_CACHE_TTL_MS, adminCompaniesCache,
  // rate limiters
  adminLoginLimiter, clientLoginLimiter,
  // auth / cookies
  sleep, signToken, parseCookies, setCookie, clearCookie,
  requireDashboardAuth, signClient,
  getDashMaintenanceMode, renderMaintenancePage, requireClientAuth,
  // api wrapper
  api,
  // caches
  getCachedClientCompany, setCachedClientCompany,
  getCachedClientIntegrationFlag, setCachedClientIntegrationFlag,
  _clientCompanyCache, _clientIntegrationFlagCache,
  getBotCatalogProviderCompany,
  // inbox/message helpers
  escapeHtml, createInboxMessageId, normalizeInboxMessage,
  extractAdminInbox, setAdminInbox, countAdminUnreadMessages,
  countClientUnreadMessages, getClientUnreadNotificationCount,
  getAdminUnreadNotificationsTotal,
  // company/admin helpers
  getAdminCompaniesCacheAgeMs, hasFreshAdminCompaniesCache, loadAdminCompanies,
  getCompanyWhatsappMessageStats, renderNotificationBell, renderSupportToolIcon,
  sanitizeRules, saveCompanyRules, prettyJson, parseObjectJsonInput, normalizeIntegrationToneClass,
  fetchCompanyIntegrations,
  // layout / CSV
  layout, toCsv, toCsvRows,
  // order helpers
  parseClientOrdersFilters, fetchCompanyOrders,
  normalizeClientOrderState, inferClientOrderState, extractClientOrderWorkflow,
  clientOrderCategoryLabel, isOrderPaid, normalizeClientPaymentStatus,
  clientPaymentStatusLabel, clientPaymentLabel, clientPaymentMethodLabel,
  // client/panel helpers (second block)
  parseJsonSafe, renderClientLoginPage, handleClientLogin,
  toNumber, normalizeCatalogHeader, cleanCatalogText, isCatalogTextDefined,
  splitCatalogTags, buildCatalogCategoryPath, normalizeCatalogItemRecord,
  parseCatalogPrice, getCatalogFieldByHeader, extractCatalogItemsFromSheet,
  buildSupportMessageSubject,
  SUPPORTED_CURRENCIES, normalizeSupportedCurrency, formatMoney, formatDateLabel,
  normalizePlanTier, normalizeChannelMode, channelsFromMode,
  planLabelFromTier, channelLabelFromMode, defaultBotClassFromMode,
  tierRank, tierFromRank, findCatalogItemForTierAndChannel,
  extractCatalogEntriesForCompany, extractCatalogBotOptions,
  parseDateSafe, monthRefFromShift, clampDayOfMonth, buildUtcDate, computeMonthlyCycle,
  findCatalogItemForBot, extractPlanInfo, extractCompanyProfile,
  toCheckedFlag, extractPaymentSettings,
  generateClientPassword, resolveClientPassword, assignClientPassword,
  buildPromptFromBrandContext, extractClientState, loadClientStateWithProvider,
  buildPriceChart, renderClientPage,
  normalizeDashboardMode, extractDashboardAccessFromRules, getDashboardAccessForCompany,
  canAccessClientSection, renderClientAccessDeniedPage,
  loadClientIntegrationFlag, fetchClientIntegrationModules,
  renderClientIntegrationModulesSection, requireClientSectionAccess,
  // analytics / conversation helpers (third block)
  fetchClientOrderDetailPayload, truncateConversationText, getConversationStatusFromOrder,
  isSameCalendarDay, buildBotActivitySeries, buildOrdersBarChartSvg,
  FAQ_TOPIC_DEFINITIONS, buildFrequentQuestions, buildOverviewAlerts,
  buildClientConversationSummary,
};
