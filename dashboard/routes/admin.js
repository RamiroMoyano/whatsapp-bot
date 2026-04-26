import { Router } from "express";
import crypto from "crypto";
import {
  DASH_USER, DASH_PASS,
  BOT_CATALOG_PROVIDER_ID,
  adminLoginLimiter,
  requireDashboardAuth,
  signToken, parseCookies, setCookie, clearCookie,
  api, escapeHtml, parseJsonSafe, prettyJson,
  parseObjectJsonInput, normalizeIntegrationToneClass,
  layout, renderNotificationBell, renderSupportToolIcon,
  toCsv, toCsvRows, sendEmail,
  loadAdminCompanies, getAdminCompaniesCacheAgeMs, hasFreshAdminCompaniesCache,
  getAdminUnreadNotificationsTotal, getCompanyWhatsappMessageStats,
  saveCompanyRules, fetchCompanyIntegrations, getBotCatalogProviderCompany,
  normalizeInboxMessage, extractAdminInbox, setAdminInbox,
  countAdminUnreadMessages, countClientUnreadMessages, createInboxMessageId,
  parseClientOrdersFilters, fetchCompanyOrders,
  normalizeClientOrderState, inferClientOrderState, extractClientOrderWorkflow,
  clientOrderCategoryLabel, isOrderPaid, normalizeClientPaymentStatus,
  clientPaymentStatusLabel, clientPaymentLabel, clientPaymentMethodLabel,
  formatMoney, formatDateLabel, normalizeSupportedCurrency, SUPPORTED_CURRENCIES,
  normalizePlanTier, normalizeChannelMode, channelsFromMode,
  planLabelFromTier, channelLabelFromMode, defaultBotClassFromMode,
  tierRank, tierFromRank, findCatalogItemForTierAndChannel,
  extractCatalogEntriesForCompany, extractCatalogBotOptions, computeMonthlyCycle,
  findCatalogItemForBot, extractPlanInfo, extractCompanyProfile,
  toCheckedFlag, extractPaymentSettings,
  generateClientPassword, resolveClientPassword, assignClientPassword,
  toNumber, buildPromptFromBrandContext, extractClientState, loadClientStateWithProvider,
  buildPriceChart, buildBotActivitySeries, buildOrdersBarChartSvg,
  buildFrequentQuestions, buildOverviewAlerts, buildClientConversationSummary,
  normalizeCatalogItemRecord,
  normalizeDashboardMode, extractDashboardAccessFromRules, getDashboardAccessForCompany,
} from "../lib/helpers.js";
import { dashboardDb } from "../db.js";

const router = Router();

router.get("/admin/login", (req, res) => {
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

router.post("/admin/login", adminLoginLimiter, (req, res) => {
  const user = (req.body.user || "").trim();
  const pass = (req.body.pass || "").trim();

  if (user !== DASH_USER || pass !== DASH_PASS) {
    return res.status(401).send("Credenciales incorrectas");
  }

  const token = crypto.randomBytes(24).toString("hex");
  setCookie(res, "dash", `${token}.${signToken(token)}`);
  return res.redirect("/admin");
});

router.get("/admin/forgot", (req, res) => {
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
router.get("/admin/logout", (req, res) => {
  clearCookie(res, "dash");
  res.redirect("/admin/login");
});

// ================= EMPRESAS =================
router.get("/admin", requireDashboardAuth, async (req, res) => {
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
    const maintenanceSaved = String(req.query.maintenanceSaved || "") === "1";
    const maintenanceError = String(req.query.maintenanceError || "").trim();
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
      maintenanceSaved ? `<div class="card"><b>Modo mantenimiento actualizado.</b></div>` : "",
      maintenanceError ? `<div class="card"><b>Error:</b> ${escapeHtml(maintenanceError)}</div>` : "",
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

    const [botHealth, dbHealth, activityData, maintenanceState] = await Promise.all([
      api("/health").catch(() => ({ ok: false })),
      api("/health/db").catch(() => ({ ok: false, db: "down" })),
      api("/api/health/activity").catch(() => null),
      api("/api/admin/maintenance").catch(() => ({ maintenanceMode: false, message: "" })),
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

          <div class="admin-maintenance-widget ${maintenanceState?.maintenanceMode ? "admin-maintenance-on" : ""}">
            <div class="admin-health-title">🔧 Mantenimiento</div>
            <div class="admin-health-row" style="margin-bottom:8px">
              <span class="admin-health-dot ${maintenanceState?.maintenanceMode ? "err" : "ok"}"></span>
              <span>Bot: <b>${maintenanceState?.maintenanceMode ? "En mantenimiento" : "Operativo"}</b></span>
            </div>
            <form method="POST" action="/admin/maintenance/toggle" style="display:flex;flex-direction:column;gap:6px">
              <input type="hidden" name="enabled" value="${maintenanceState?.maintenanceMode ? "0" : "1"}" />
              <input type="text" name="message" value="${escapeHtml(maintenanceState?.message || "")}" placeholder="Mensaje para clientes..." class="admin-maintenance-input" />
              <button type="submit" class="btn ${maintenanceState?.maintenanceMode ? "secondary" : "danger"}" style="font-size:11px;padding:5px 8px">
                ${maintenanceState?.maintenanceMode ? "✅ Desactivar" : "⚠️ Activar"}
              </button>
            </form>
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
                <a class="btn secondary" href="/admin/companies.csv" download>⬇️ CSV</a>
              </div>
            </form>
            <h3 style="margin:0 0 12px;">Listado ${view !== "all" ? `(${escapeHtml(view)})` : ""}</h3>
            <div class="company-list">${rows || `<div class="muted">Aun no hay empresas.</div>`}</div>
          </div>

          <div class="card" id="admin-activity-log">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
              <h3 style="margin:0">🕐 Actividad reciente</h3>
              <span class="muted" id="admin-activity-ts" style="font-size:12px">Cargando...</span>
            </div>
            <div id="admin-activity-body">
              <div class="muted">Cargando mensajes...</div>
            </div>
          </div>
        </section>
      </div>

    </div>
    <script>
      (function() {
        var body = document.getElementById("admin-activity-body");
        var ts   = document.getElementById("admin-activity-ts");
        var POLL_MS = 30000;
        var knownIds     = new Set();
        var openCompanies = new Set();

        function fmt(at) {
          if (!at) return "-";
          var d = new Date(at);
          return d.toLocaleTimeString("es-AR", { hour:"2-digit", minute:"2-digit", second:"2-digit" }) +
                 " " + d.toLocaleDateString("es-AR", { day:"2-digit", month:"2-digit" });
        }

        function esc(v) {
          return String(v || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
        }

        function toUid(cid) {
          return "act-" + cid.replace(/[^a-z0-9]/gi, "_");
        }

        window.toggleActCompany = function(cid) {
          var id  = toUid(cid);
          var el  = document.getElementById(id);
          var arr = document.getElementById("arr-" + id);
          if (!el) return;
          var isOpen = el.style.display !== "none";
          el.style.display  = isOpen ? "none" : "";
          if (arr) arr.textContent = isOpen ? "▶" : "▼";
          if (isOpen) openCompanies.delete(cid);
          else        openCompanies.add(cid);
        };

        function renderRows(msgs) {
          if (!msgs || !msgs.length) return '<div class="muted">Sin mensajes recientes.</div>';

          var groups = {}, order = [];
          msgs.forEach(function(m) {
            var cid = m.companyId || "unknown";
            if (!groups[cid]) { groups[cid] = []; order.push(cid); }
            groups[cid].push(m);
          });

          var html = '<div class="admin-act-accordion">';
          order.forEach(function(cid) {
            var items  = groups[cid];
            var hasNew = items.some(function(m) { return !knownIds.has(String(m.id)); });
            items.forEach(function(m) { knownIds.add(String(m.id)); });
            var last   = items[0];
            var id     = toUid(cid);
            var label  = items.length === 1 ? "1 mensaje" : items.length + " mensajes";
            html += '<div class="admin-act-group' + (hasNew ? " admin-act-group-new" : "") + '">';
            html += '<div class="admin-act-header" onclick="toggleActCompany(' + JSON.stringify(cid) + ')">';
            html += '<span class="admin-act-cname">' + esc(cid) + '</span>';
            html += '<span class="admin-act-meta">';
            html += '<span class="admin-act-count">' + label + '</span>';
            html += '<span class="admin-act-time muted">' + fmt(last.at) + '</span>';
            html += '<span class="admin-act-arrow" id="arr-' + id + '">▶</span>';
            html += '</span></div>';
            html += '<div class="admin-act-detail" id="' + id + '" style="display:none">';
            html += '<table class="admin-activity-table"><thead><tr><th>Hora</th><th>Numero</th><th>Mensaje</th></tr></thead><tbody>';
            items.forEach(function(m) {
              html += '<tr><td>' + fmt(m.at) + '</td><td>' + esc(m.from) + '</td><td class="admin-activity-content">' + esc(m.content) + '</td></tr>';
            });
            html += '</tbody></table></div></div>';
          });
          html += '</div>';
          return html;
        }

        function load() {
          fetch("/admin/api/activity", { credentials: "same-origin" })
            .then(function(r) { return r.ok ? r.json() : null; })
            .then(function(data) {
              if (!data || !data.ok) return;
              body.innerHTML = renderRows(data.messages);
              openCompanies.forEach(function(cid) {
                var id = toUid(cid);
                var el  = document.getElementById(id);
                var arr = document.getElementById("arr-" + id);
                if (el)  el.style.display = "";
                if (arr) arr.textContent  = "▼";
              });
              ts.textContent = "Actualizado " + new Date().toLocaleTimeString("es-AR");
            })
            .catch(function() { ts.textContent = "Error al cargar"; });
        }

        load();
        setInterval(load, POLL_MS);
      })();
    </script>
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

router.get("/admin/company/new", requireDashboardAuth, (req, res) => {
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

router.post("/admin/company/new", requireDashboardAuth, async (req, res) => {
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
router.get("/admin/company/:id", requireDashboardAuth, async (req, res) => {
  const id = req.params.id;

  try {
    let c = null;
    if (dashboardDb.enabled) {
      c = await dashboardDb.getCompanyById(id);
    }
    if (!c) {
      c = await api(`/api/companies/${encodeURIComponent(id)}`);
    }
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const [adminUnreadNotifications, providerCompany, integrations, monthlyOrders, msgStats] = await Promise.all([
      getAdminUnreadNotificationsTotal(),
      getBotCatalogProviderCompany(c),
      fetchCompanyIntegrations(id).catch(() => []),
      fetchCompanyOrders(id, monthStart, "", 500).catch(() => []),
      api(`/api/companies/${encodeURIComponent(id)}/whatsapp-messages/stats`).catch(() => ({ total: 0, last30Days: 0 })),
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

      ${(() => {
        const pendingOrders = monthlyOrders.filter((o) => {
          const ws = String(o.workflowState || o.category || o.orderStatus || "").toLowerCase();
          return !ws.includes("completed") && !ws.includes("rejected") && !ws.includes("archived");
        });
        const monthRevenue = monthlyOrders.reduce((acc, o) => acc + toNumber(o.total), 0);
        const uniqueCustomers = new Set(monthlyOrders.map((o) => String(o.fromNumber || o.contact || "").toLowerCase()).filter(Boolean));
        const monthLabel = now.toLocaleDateString("es-AR", { month: "long", year: "numeric" });
        return `
      <div class="admin-metrics-strip">
        <div class="admin-metric">
          <div class="admin-metric-label">📦 Pedidos del mes</div>
          <div class="admin-metric-value">${monthlyOrders.length}</div>
          <div class="admin-metric-hint">${escapeHtml(monthLabel)}</div>
        </div>
        <div class="admin-metric">
          <div class="admin-metric-label">⏳ Pendientes</div>
          <div class="admin-metric-value">${pendingOrders.length}</div>
          <div class="admin-metric-hint">sin completar</div>
        </div>
        <div class="admin-metric">
          <div class="admin-metric-label">💰 Ingresos est.</div>
          <div class="admin-metric-value">${formatMoney(monthRevenue, "USD")}</div>
          <div class="admin-metric-hint">sumatoria de totales</div>
        </div>
        <div class="admin-metric">
          <div class="admin-metric-label">👥 Clientes únicos</div>
          <div class="admin-metric-value">${uniqueCustomers.size}</div>
          <div class="admin-metric-hint">este mes</div>
        </div>
        <div class="admin-metric">
          <div class="admin-metric-label">💬 Mensajes 30d</div>
          <div class="admin-metric-value">${Number(msgStats.last30Days || 0)}</div>
          <div class="admin-metric-hint">entrantes al bot</div>
        </div>
        <div class="admin-metric">
          <div class="admin-metric-label">📋 Mensajes total</div>
          <div class="admin-metric-value">${Number(msgStats.total || 0).toLocaleString("es-AR")}</div>
          <div class="admin-metric-hint">histórico</div>
        </div>
      </div>`;
      })()}

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

router.post("/admin/company/:id/save", requireDashboardAuth, async (req, res) => {
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

router.post("/admin/company/:id/integrations", requireDashboardAuth, async (req, res) => {
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

router.post("/admin/company/:id/integrations/:integrationId/save", requireDashboardAuth, async (req, res) => {
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

router.post("/admin/company/:id/integrations/:integrationId/test", requireDashboardAuth, async (req, res) => {
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

router.post("/admin/company/:id/integrations/:integrationId/delete", requireDashboardAuth, async (req, res) => {
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

router.post("/admin/company/:id/dashboard/save", requireDashboardAuth, async (req, res) => {
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

router.post("/admin/company/:id/subscription/save", requireDashboardAuth, async (req, res) => {
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

router.post("/admin/company/:id/delete", requireDashboardAuth, async (req, res) => {
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

router.post("/admin/company/:id/profile/save", requireDashboardAuth, async (req, res) => {
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

router.post("/admin/company/:id/bot/save", requireDashboardAuth, async (req, res) => {
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

router.post("/admin/company/:id/reset-password", requireDashboardAuth, async (req, res) => {
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

// ================= MAINTENANCE MODE =================
router.get("/admin/maintenance", requireDashboardAuth, async (req, res) => {
  try {
    const data = await api("/api/admin/maintenance");
    return res.json(data);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

router.post("/admin/maintenance/toggle", requireDashboardAuth, async (req, res) => {
  try {
    const enabled = String(req.body.enabled || "").trim() === "1";
    const message = String(req.body.message || "").trim();
    await api("/api/admin/maintenance", {
      method: "POST",
      body: { enabled, message: message || undefined },
    });
    return res.redirect("/admin?maintenanceSaved=1");
  } catch (e) {
    return res.redirect(`/admin?maintenanceError=${encodeURIComponent(e?.message || e)}`);
  }
});

// ================= ADMIN ACTIVITY FEED =================
router.get("/admin/api/activity", requireDashboardAuth, async (req, res) => {
  try {
    const data = await api("/api/messages/recent?limit=25");
    return res.json(data);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ================= EXPORTAR EMPRESAS CSV =================
router.get("/admin/companies.csv", requireDashboardAuth, async (req, res) => {
  try {
    const { items: companies } = await loadAdminCompanies({ allowStale: true, preferCache: true });
    const escape = (v) => {
      const s = String(v || "").replace(/"/g, '""');
      return /[",\n\r]/.test(s) ? `"${s}"` : s;
    };
    const headers = ["ID", "Nombre", "Dueno", "Email", "Telefono", "Bot", "Plan", "Dashboard", "Suscripcion", "Fin suscripcion", "Creado"];
    const rows = (Array.isArray(companies) ? companies : []).map((c) => {
      const rules = parseJsonSafe(c.rulesJson || "{}", {});
      const plan = extractPlanInfo(c, rules);
      const profile = extractCompanyProfile(rules);
      const dashAccess = extractDashboardAccessFromRules(rules);
      const dashLabel = !dashAccess.enabled ? "Inactivo" : dashAccess.mode === "limited" ? "Limitado" : "Completo";
      const subStatus = String(rules?.subscriptionStatus || "Activa");
      const subEnd = rules?.subscriptionCurrentEnd ? new Date(rules.subscriptionCurrentEnd).toLocaleDateString("es-AR") : "";
      const createdAt = c.createdAt ? new Date(c.createdAt).toLocaleDateString("es-AR") : "";
      return [c.id, c.name, profile.ownerName, profile.ownerEmail, profile.ownerPhone, plan.botClass, plan.fullLabel, dashLabel, subStatus, subEnd, createdAt].map(escape).join(",");
    });
    const csv = [headers.join(","), ...rows].join("\r\n");
    const filename = `empresas_${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send("\uFEFF" + csv); // BOM for Excel
  } catch (e) {
    res.status(500).send("Error exportando CSV");
  }
});

// ================= ASIGNAR CLIENTES =================
router.get("/admin/assign", requireDashboardAuth, async (req, res) => {
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

router.post("/admin/assign", requireDashboardAuth, async (req, res) => {
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

router.post("/admin/assign/delete", requireDashboardAuth, async (req, res) => {
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

router.get("/admin/messages", requireDashboardAuth, async (req, res) => {
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

router.post("/admin/messages/state", requireDashboardAuth, async (req, res) => {
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

router.post("/admin/messages/reply", requireDashboardAuth, async (req, res) => {
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

router.post("/admin/messages/reset", requireDashboardAuth, async (req, res) => {
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
router.get("/admin/orders", requireDashboardAuth, async (req, res) => {
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
      dashboardDb.enabled
        ? dashboardDb.getAllOrders({ q, companyId: filterCompanyId, limit })
        : api(`/api/orders?${params.toString()}`),
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
router.get("/admin/orders/export.csv", requireDashboardAuth, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const limit = Math.min(Math.max(Number(req.query.limit || 200), 10), 500);

    const params = new URLSearchParams();
    if (q) params.set("q", q);
    params.set("limit", String(limit));

    const orders = dashboardDb.enabled
      ? await dashboardDb.getAllOrders({ q, limit })
      : await api(`/api/orders?${params.toString()}`);
    const csv = toCsv(orders);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="orders_${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch (e) {
    res.status(500).send(`Error exportando CSV: ${e?.message || e}`);
  }
});


export default router;
