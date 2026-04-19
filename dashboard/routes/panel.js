import { Router } from "express";
import * as XLSX from "xlsx";
import {
  clientLoginLimiter,
  requireClientAuth, loadClientIntegrationFlag, requireClientSectionAccess,
  api, escapeHtml, parseJsonSafe, prettyJson,
  parseObjectJsonInput, normalizeIntegrationToneClass,
  renderClientPage, renderClientLoginPage, handleClientLogin,
  renderNotificationBell, renderSupportToolIcon,
  sendEmail, saveCompanyRules, fetchCompanyIntegrations,
  normalizeInboxMessage, extractAdminInbox, setAdminInbox,
  countClientUnreadMessages, createInboxMessageId,
  parseClientOrdersFilters, fetchCompanyOrders,
  normalizeClientOrderState, inferClientOrderState, extractClientOrderWorkflow,
  clientOrderCategoryLabel, isOrderPaid, normalizeClientPaymentStatus,
  clientPaymentStatusLabel, clientPaymentLabel, clientPaymentMethodLabel,
  fetchClientOrderDetailPayload, truncateConversationText,
  getConversationStatusFromOrder, isSameCalendarDay,
  buildBotActivitySeries, buildOrdersBarChartSvg,
  buildFrequentQuestions, buildOverviewAlerts, buildClientConversationSummary,
  formatMoney, formatDateLabel, normalizeSupportedCurrency, SUPPORTED_CURRENCIES,
  normalizePlanTier, normalizeChannelMode, channelsFromMode,
  planLabelFromTier, channelLabelFromMode, defaultBotClassFromMode,
  extractCatalogEntriesForCompany, extractCatalogBotOptions,
  findCatalogItemForBot, extractPlanInfo, extractCompanyProfile,
  toCheckedFlag, extractPaymentSettings,
  generateClientPassword, resolveClientPassword, assignClientPassword,
  toNumber, buildPromptFromBrandContext, extractClientState, loadClientStateWithProvider,
  buildPriceChart, canAccessClientSection, extractDashboardAccessFromRules,
  getDashboardAccessForCompany, normalizeDashboardMode,
  normalizeCatalogItemRecord, extractCatalogItemsFromSheet, parseCatalogPrice,
  computeMonthlyCycle, setCookie, clearCookie,
  parseCookies, signClient, DASH_COOKIE_SECRET,
  buildSupportMessageSubject,
  fetchClientIntegrationModules, renderClientIntegrationModulesSection,
  getBotCatalogProviderCompany,
} from "../lib/helpers.js";

const router = Router();

router.get("/panel/login", (req, res) => {
  const reset = String(req.query.reset || "") === "1";
  res.type("text/html").send(renderClientLoginPage({ reset }));
});
router.get("/c/login", (req, res) => {
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

router.get("/panel/forgot", (req, res) => res.type("text/html").send(renderForgotPage()));
router.get("/c/forgot", (req, res) => res.redirect("/panel/forgot"));

router.post("/panel/forgot", clientLoginLimiter, async (req, res) => {
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

router.get("/panel/reset", async (req, res) => {
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

router.post("/panel/reset", async (req, res) => {
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

router.post("/panel/login", clientLoginLimiter, handleClientLogin);
router.post("/c/login", clientLoginLimiter, handleClientLogin);

router.get("/panel", requireClientAuth, loadClientIntegrationFlag, requireClientSectionAccess("inicio"), async (req, res) => {
  const company = req.company;
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).toISOString();
  const last30Start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29).toISOString();
  const [{ state }, monthlyOrders, weeklyOrders, last30Orders, msgStats] = await Promise.all([
    loadClientStateWithProvider(company),
    fetchCompanyOrders(company.id, monthStart, "", 500).catch(() => []),
    fetchCompanyOrders(company.id, weekStart, "", 500).catch(() => []),
    fetchCompanyOrders(company.id, last30Start, "", 500).catch(() => []),
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
  const ordersChartSvg = buildOrdersBarChartSvg(last30Orders, 30);
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

      <article class="cp-card cp-span-3 cp-overview-block">
        <div class="cp-card-head">
          <h3>📦 Pedidos por dia</h3>
          <span>ultimos 30 dias</span>
        </div>
        <div class="cp-bar-chart-wrap">
          ${ordersChartSvg}
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

      <article class="cp-card cp-span-3 cp-share-widget cp-share-widget-duo">
        ${profile.botPhone ? `
        <div class="cp-share-inner cp-share-inner-wa">
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
        ` : ""}
        <div class="cp-share-inner cp-share-inner-menu">
          <div class="cp-share-icon">🍽️</div>
          <div class="cp-share-body">
            <div class="cp-share-title">Menú público de tu negocio</div>
            <div class="cp-share-number">/menu/${escapeHtml(company.id)}</div>
            <div class="cp-share-hint">Página con tu catálogo para compartir en redes o web</div>
          </div>
          <div class="cp-share-actions">
            <a class="cp-btn primary" href="/menu/${encodeURIComponent(company.id)}" target="_blank" rel="noopener">Ver menú</a>
            <button class="cp-btn" type="button" onclick="navigator.clipboard.writeText(window.location.origin+'/menu/${encodeURIComponent(company.id)}').then(()=>{this.textContent='Copiado';setTimeout(()=>this.textContent='Copiar link',2000)})">Copiar link</button>
          </div>
        </div>
      </article>

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

router.get("/panel/catalogo/template", requireClientAuth, requireClientSectionAccess("catalogo"), async (req, res) => {
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
router.get("/c/catalogo/template", (req, res) => res.redirect("/panel/catalogo/template"));

router.get("/panel/catalogo", requireClientAuth, loadClientIntegrationFlag, requireClientSectionAccess("catalogo"), async (req, res) => {
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

router.post("/panel/catalogo/save", requireClientAuth, requireClientSectionAccess("catalogo"), async (req, res) => {
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

router.post("/panel/catalogo/currency", requireClientAuth, requireClientSectionAccess("catalogo"), async (req, res) => {
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

router.post("/panel/catalogo/import", requireClientAuth, requireClientSectionAccess("catalogo"), async (req, res) => {
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


// ── helpers defined mid-section (hoisted) ──

// Lightweight polling endpoint: returns count of orders created after `since`
router.get("/panel/api/new-orders", requireClientAuth, async (req, res) => {
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

router.get("/panel/pedidos", requireClientAuth, loadClientIntegrationFlag, requireClientSectionAccess("pedidos"), async (req, res) => {
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
  const preparingCount = ordersWithWorkflow.filter((order) => order.workflow.state === "preparing").length;
  const readyCount = ordersWithWorkflow.filter((order) => order.workflow.state === "ready").length;
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
            <option value="pending"    ${order.workflow.state === "pending"    ? "selected" : ""}>Pendiente</option>
            <option value="preparing"  ${order.workflow.state === "preparing"  ? "selected" : ""}>En preparacion</option>
            <option value="ready"      ${order.workflow.state === "ready"      ? "selected" : ""}>Listo para entregar</option>
            <option value="completed"  ${order.workflow.state === "completed"  ? "selected" : ""}>Completado</option>
            <option value="rejected"   ${order.workflow.state === "rejected"   ? "selected" : ""}>Rechazado</option>
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
                <option value="all"       ${selectedStatus === "all"       ? "selected" : ""}>Todas</option>
                <option value="pending"   ${selectedStatus === "pending"   ? "selected" : ""}>${pendingCount > 0 ? `Pendientes (${pendingCount})` : "Pendientes"}</option>
                <option value="preparing" ${selectedStatus === "preparing" ? "selected" : ""}>${preparingCount > 0 ? `En preparacion (${preparingCount})` : "En preparacion"}</option>
                <option value="ready"     ${selectedStatus === "ready"     ? "selected" : ""}>${readyCount > 0 ? `Listos (${readyCount})` : "Listos"}</option>
                <option value="completed" ${selectedStatus === "completed" ? "selected" : ""}>Completados</option>
                <option value="rejected"  ${selectedStatus === "rejected"  ? "selected" : ""}>Rechazados</option>
                <option value="archived"  ${selectedStatus === "archived"  ? "selected" : ""}>Archivados</option>
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

router.get("/panel/pedidos/:id/detail", requireClientAuth, requireClientSectionAccess("pedidos"), async (req, res) => {
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

router.get("/panel/pedidos/ver/:id", requireClientAuth, loadClientIntegrationFlag, requireClientSectionAccess("pedidos"), async (req, res) => {
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

router.post("/panel/pedidos/payment", requireClientAuth, requireClientSectionAccess("pedidos"), async (req, res) => {
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

router.post("/panel/pedidos/category", requireClientAuth, requireClientSectionAccess("pedidos"), async (req, res) => {
  const company = req.company;
  const orderId = String(req.body.orderId || "").trim();
  const rawState = String(req.body.state || req.body.category || "").trim().toLowerCase();
  const normalizedState = normalizeClientOrderState(rawState);
  const state = ["pending", "preparing", "ready", "completed", "rejected"].includes(normalizedState) ? normalizedState : "";
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

router.get("/panel/soporte", requireClientAuth, loadClientIntegrationFlag, requireClientSectionAccess("soporte"), async (req, res) => {
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

router.get("/panel/conversaciones", requireClientAuth, loadClientIntegrationFlag, requireClientSectionAccess("conversaciones"), async (req, res) => {
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

router.get("/panel/integraciones", requireClientAuth, loadClientIntegrationFlag, requireClientSectionAccess("integraciones"), async (req, res) => {
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

router.post("/panel/soporte/messages", requireClientAuth, requireClientSectionAccess("soporte"), async (req, res) => {
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

router.post("/panel/pedidos/messages", requireClientAuth, async (req, res) => {
  return res.redirect("/panel/soporte");
});

router.get("/panel/pedidos/export", requireClientAuth, requireClientSectionAccess("pedidos"), async (req, res) => {
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

router.get("/panel/suscripcion", requireClientAuth, loadClientIntegrationFlag, requireClientSectionAccess("suscripcion"), async (req, res) => {
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

router.post("/panel/suscripcion/action", requireClientAuth, requireClientSectionAccess("suscripcion"), async (req, res) => {
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

router.get("/panel/cuenta", requireClientAuth, loadClientIntegrationFlag, requireClientSectionAccess("cuenta"), async (req, res) => {
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

              <details class="cp-company-details cp-form-section">
                <summary><span>Configuracion del bot</span><span class="cp-details-hint">Respuestas y horario</span></summary>
                <div class="cp-company-details-body">
                  <label>Mensaje de bienvenida</label>
                  <textarea name="welcomeMessage" rows="3" placeholder="Ej: ¡Hola! Soy el asistente de Tienda X. ¿En qué te puedo ayudar?">${escapeHtml(String(state.rules?.welcomeMessage || ""))}</textarea>
                  <p class="cp-note" style="margin:4px 0 12px">Si lo dejás vacío, el bot usa el saludo predeterminado.</p>

                  <label>Horario de atención</label>
                  <input name="businessHoursText" value="${escapeHtml(String(state.rules?.businessHoursText || ""))}" placeholder="Ej: Lunes a Viernes 9:00-18:00, Sábados 9:00-13:00" />
                  <p class="cp-note" style="margin:4px 0 12px">El bot menciona este horario cuando el cliente lo pregunta.</p>

                  <label>Descripcion del negocio</label>
                  <textarea name="companyDescription" rows="3" placeholder="Ej: Somos una tienda de ropa deportiva con envíos a todo el país.">${escapeHtml(String(state.rules?.companyDescription || ""))}</textarea>
                  <p class="cp-note" style="margin:4px 0 12px">El asistente IA usa este texto para responder preguntas sobre tu negocio.</p>

                  <label>Tono del bot</label>
                  <select name="botTone">
                    <option value="neutral"   ${(state.rules?.tone || "neutral") === "neutral"   ? "selected" : ""}>Neutral</option>
                    <option value="amigable"  ${state.rules?.tone === "amigable"  ? "selected" : ""}>Amigable y cercano</option>
                    <option value="formal"    ${state.rules?.tone === "formal"    ? "selected" : ""}>Formal y profesional</option>
                    <option value="divertido" ${state.rules?.tone === "divertido" ? "selected" : ""}>Divertido y casual</option>
                  </select>
                </div>
              </details>

              <details class="cp-company-details cp-form-section">
                <summary><span>Horario de atención</span><span class="cp-details-hint">Respuesta automática fuera de horario</span></summary>
                <div class="cp-company-details-body">
                  <div class="cp-toggle-row">
                    <label class="cp-toggle-label" for="businessHoursEnabledToggle">
                      <span>Activar horario de atención</span>
                      <span class="cp-note">El bot responde con un mensaje automático fuera del horario configurado.</span>
                    </label>
                    <label class="cp-toggle-switch">
                      <input type="checkbox" id="businessHoursEnabledToggle" name="businessHoursEnabled" value="true" ${state.rules?.businessHoursEnabled ? "checked" : ""} />
                      <span class="cp-toggle-track"></span>
                    </label>
                  </div>

                  <div style="margin-top:16px">
                    <label>Días de atención</label>
                    <div class="cp-days-grid">
                      ${[
                        { val: 1, label: "Lunes" },
                        { val: 2, label: "Martes" },
                        { val: 3, label: "Miercoles" },
                        { val: 4, label: "Jueves" },
                        { val: 5, label: "Viernes" },
                        { val: 6, label: "Sabado" },
                        { val: 0, label: "Domingo" },
                      ].map((d) => {
                        const days = Array.isArray(state.rules?.businessHoursDays) ? state.rules.businessHoursDays.map(Number) : [1,2,3,4,5];
                        const checked = days.includes(d.val) ? "checked" : "";
                        return `<label class="cp-day-check"><input type="checkbox" name="businessHoursDays" value="${d.val}" ${checked}/> ${d.label}</label>`;
                      }).join("")}
                    </div>
                  </div>

                  <div class="cp-grid-2" style="margin-top:12px">
                    <div>
                      <label>Desde</label>
                      <input type="time" name="businessHoursStart" value="${escapeHtml(String(state.rules?.businessHoursStart || "09:00"))}" />
                    </div>
                    <div>
                      <label>Hasta</label>
                      <input type="time" name="businessHoursEnd" value="${escapeHtml(String(state.rules?.businessHoursEnd || "21:00"))}" />
                    </div>
                  </div>

                  <div style="margin-top:12px">
                    <label>Zona horaria</label>
                    <select name="businessHoursTz">
                      ${[
                        ["America/Argentina/Buenos_Aires", "Argentina (UTC-3)"],
                        ["America/Santiago", "Chile (UTC-3/-4)"],
                        ["America/Bogota", "Colombia (UTC-5)"],
                        ["America/Lima", "Peru (UTC-5)"],
                        ["America/Mexico_City", "Mexico (UTC-6)"],
                        ["America/New_York", "New York (UTC-5/-4)"],
                        ["UTC", "UTC"],
                      ].map(([tz, label]) => `<option value="${tz}" ${(state.rules?.businessHoursTz || "America/Argentina/Buenos_Aires") === tz ? "selected" : ""}>${label}</option>`).join("")}
                    </select>
                  </div>

                  <div style="margin-top:12px">
                    <label>Mensaje fuera de horario</label>
                    <textarea name="businessHoursOutsideText" rows="2" placeholder="Ej: Estamos fuera de horario. Te respondemos de lunes a viernes de 9 a 21hs.">${escapeHtml(String(state.rules?.businessHoursOutsideText || ""))}</textarea>
                    <p class="cp-note" style="margin:4px 0 0">Si se deja vacío, el bot usa un mensaje predeterminado.</p>
                  </div>
                </div>
              </details>

              <details class="cp-company-details cp-form-section">
                <summary><span>Preguntas frecuentes (FAQ)</span><span class="cp-details-hint">Respuestas sin IA</span></summary>
                <div class="cp-company-details-body">
                  <p class="cp-note" style="margin-bottom:12px">El bot responde estas preguntas directamente, sin usar IA. Formato: <b>pregunta | respuesta</b> (una por línea).</p>
                  <textarea name="faqItemsRaw" rows="8" placeholder="¿Cuáles son los horarios? | Atendemos de lunes a viernes de 9 a 18hs.\n¿Hacen envíos? | Sí, a todo el país por Correo Argentino.">${
                    escapeHtml(
                      Array.isArray(state.rules?.faqItems)
                        ? state.rules.faqItems.map((f) => `${f.question || ""} | ${f.answer || ""}`).join("\n")
                        : ""
                    )
                  }</textarea>
                </div>
              </details>

              <details class="cp-company-details cp-form-section">
                <summary><span>Entrega</span><span class="cp-details-hint">Datos adicionales del checkout</span></summary>
                <div class="cp-company-details-body">
                  <div class="cp-toggle-row">
                    <label class="cp-toggle-label" for="requireDeliveryAddressToggle">
                      <span>Solicitar dirección de entrega en el checkout</span>
                      <span class="cp-note">El bot pedirá la dirección antes de elegir el medio de pago.</span>
                    </label>
                    <label class="cp-toggle-switch">
                      <input type="checkbox" id="requireDeliveryAddressToggle" name="requireDeliveryAddress" value="true" ${state.rules?.requireDeliveryAddress ? "checked" : ""} />
                      <span class="cp-toggle-track"></span>
                    </label>
                  </div>
                </div>
              </details>

              <details class="cp-company-details cp-form-section">
                <summary><span>Limite de mensajes</span><span class="cp-details-hint">Proteccion contra spam</span></summary>
                <div class="cp-company-details-body">
                  <label>Mensajes maximos por hora (por cliente)</label>
                  <input type="number" name="rateLimitPerHour" min="0" max="200" value="${escapeHtml(String(state.rules?.rateLimitPerHour || "0"))}" />
                  <p class="cp-note" style="margin:4px 0 0">0 = sin límite. Recomendado: 20-30 para clientes normales. Al superar el límite, el bot avisa una vez y luego ignora silenciosamente hasta que pase 1 hora.</p>
                </div>
              </details>

              <details class="cp-company-details cp-form-section">
                <summary><span>Notificaciones</span><span class="cp-details-hint">Avisos automaticos a clientes</span></summary>
                <div class="cp-company-details-body">
                  <div class="cp-toggle-row">
                    <label class="cp-toggle-label" for="notifyCustomerToggle">
                      <span>Notificar al cliente por WhatsApp al cambiar el estado del pedido</span>
                      <span class="cp-note">El bot les avisa automáticamente cuando el pedido pasa a "En preparacion", "Listo para entregar" o "Completado".</span>
                    </label>
                    <label class="cp-toggle-switch">
                      <input type="checkbox" id="notifyCustomerToggle" name="notifyCustomerOnStateChange" value="true" ${state.rules?.notifyCustomerOnStateChange === true || String(state.rules?.notifyCustomerOnStateChange || "") === "true" ? "checked" : ""} />
                      <span class="cp-toggle-track"></span>
                    </label>
                  </div>
                  <p class="cp-note" style="margin-top:12px">⚠️ Requiere que el número del bot (<b>Teléfono del bot</b>) esté configurado en Contacto principal y que la cuenta de Twilio tenga habilitado el envío de mensajes salientes.</p>
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

router.post("/panel/cuenta/save", requireClientAuth, requireClientSectionAccess("cuenta"), async (req, res) => {
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

  rules.welcomeMessage = String(req.body.welcomeMessage || "").trim();
  rules.businessHoursText = String(req.body.businessHoursText || "").trim();
  rules.companyDescription = String(req.body.companyDescription || "").trim();
  rules.tone = String(req.body.botTone || "neutral").trim();
  rules.notifyCustomerOnStateChange = req.body.notifyCustomerOnStateChange === "true";

  // Business hours
  rules.businessHoursEnabled = req.body.businessHoursEnabled === "true";
  const rawDays = req.body.businessHoursDays;
  rules.businessHoursDays = (Array.isArray(rawDays) ? rawDays : rawDays ? [rawDays] : []).map(Number).filter((n) => n >= 0 && n <= 6);
  rules.businessHoursStart = String(req.body.businessHoursStart || "09:00").trim();
  rules.businessHoursEnd = String(req.body.businessHoursEnd || "21:00").trim();
  rules.businessHoursTz = String(req.body.businessHoursTz || "America/Argentina/Buenos_Aires").trim();
  rules.businessHoursOutsideText = String(req.body.businessHoursOutsideText || "").trim();

  // FAQ items
  const faqRaw = String(req.body.faqItemsRaw || "").trim();
  rules.faqItems = faqRaw
    ? faqRaw.split("\n").map((line) => {
        const sep = line.indexOf("|");
        if (sep < 0) return null;
        const question = line.slice(0, sep).trim();
        const answer = line.slice(sep + 1).trim();
        return question && answer ? { question, answer } : null;
      }).filter(Boolean)
    : [];

  // Delivery address
  rules.requireDeliveryAddress = req.body.requireDeliveryAddress === "true";

  // Rate limiting
  const rlRaw = Number(req.body.rateLimitPerHour);
  rules.rateLimitPerHour = Number.isFinite(rlRaw) && rlRaw >= 0 ? Math.floor(rlRaw) : 0;

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

// ── Public menu page ──
// ─── Public menu page ────────────────────────────────────────────────────────
router.get("/menu/:id", async (req, res) => {
  const companyId = String(req.params.id || "").trim().toLowerCase();
  if (!companyId) return res.status(404).send("No encontrado");

  try {
    const company = await api(`/api/companies/${encodeURIComponent(companyId)}`).catch(() => null);
    if (!company || !company.id) return res.status(404).send("Negocio no encontrado");

    const { state } = await loadClientStateWithProvider(company);
    const rules = parseJsonSafe(company.rulesJson || "{}", {});
    const catalog = Array.isArray(state.catalog) ? state.catalog : [];
    const companyName = escapeHtml(company.name || company.id);
    const description = escapeHtml(String(rules.companyDescription || "").trim());
    const botPhone = escapeHtml(String(rules.botPhone || "").trim());
    const waLink = botPhone ? `https://wa.me/${botPhone.replace(/\D/g, "")}` : "";

    // Group by category
    const grouped = new Map();
    for (const item of catalog) {
      const cat = String(item.categoria || item.category || item.seccion || "General").trim() || "General";
      if (!grouped.has(cat)) grouped.set(cat, []);
      grouped.get(cat).push(item);
    }

    const formatPrice = (price) => {
      const n = Number(price || 0);
      if (!n) return "";
      try { return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(n); }
      catch { return "$" + Math.round(n); }
    };

    const categoryHtml = [...grouped.entries()].map(([cat, items]) => `
      <section class="menu-section">
        <h2 class="menu-cat">${escapeHtml(cat)}</h2>
        <div class="menu-items">
          ${items.filter((item) => String(item.stock || "").toLowerCase() !== "sin stock").map((item) => `
            <article class="menu-item">
              <div class="menu-item-body">
                <div class="menu-item-name">${escapeHtml(item.producto || item.name || "Producto")}</div>
                ${item.descripcion ? `<div class="menu-item-desc">${escapeHtml(String(item.descripcion).slice(0, 120))}</div>` : ""}
                ${item.talle || item.color ? `<div class="menu-item-tags">${[item.talle && `Talle: ${item.talle}`, item.color && `Color: ${item.color}`].filter(Boolean).map((t) => `<span>${escapeHtml(t)}</span>`).join("")}</div>` : ""}
              </div>
              <div class="menu-item-price">${formatPrice(item.precio)}</div>
            </article>
          `).join("")}
        </div>
      </section>
    `).join("");

    const emptyHtml = catalog.length === 0 ? `<div class="menu-empty">Este negocio aún no tiene productos publicados.</div>` : "";

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${companyName} — Menú</title>
  <meta name="description" content="${description || `Menú y catálogo de ${companyName}`}"/>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }
    .menu-header { background: linear-gradient(135deg, #1a2744 0%, #0f172a 100%); padding: 32px 20px 24px; text-align: center; border-bottom: 1px solid #1e293b; }
    .menu-logo { font-size: 40px; margin-bottom: 12px; }
    .menu-header h1 { font-size: 28px; font-weight: 800; color: #f1f5f9; letter-spacing: -0.5px; }
    .menu-header p { color: #94a3b8; font-size: 15px; margin-top: 8px; max-width: 480px; margin-left: auto; margin-right: auto; }
    .menu-wa-btn { display: inline-flex; align-items: center; gap: 8px; margin-top: 20px; background: #25d366; color: #fff; font-weight: 700; font-size: 15px; padding: 12px 24px; border-radius: 999px; text-decoration: none; }
    .menu-wa-btn:hover { background: #1ebe5a; }
    .menu-wa-icon { font-size: 18px; }
    .menu-body { max-width: 720px; margin: 0 auto; padding: 24px 16px 64px; }
    .menu-section { margin-bottom: 32px; }
    .menu-cat { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.5px; color: #22d3ee; border-bottom: 1px solid #1e293b; padding-bottom: 8px; margin-bottom: 16px; }
    .menu-items { display: flex; flex-direction: column; gap: 2px; }
    .menu-item { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 14px 16px; background: #1e293b; border-radius: 10px; margin-bottom: 4px; transition: background 0.15s; }
    .menu-item:hover { background: #243147; }
    .menu-item-body { flex: 1; min-width: 0; }
    .menu-item-name { font-size: 15px; font-weight: 600; color: #f1f5f9; }
    .menu-item-desc { font-size: 13px; color: #94a3b8; margin-top: 4px; line-height: 1.4; }
    .menu-item-tags { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
    .menu-item-tags span { font-size: 11px; background: #0f172a; color: #64748b; border-radius: 4px; padding: 2px 6px; }
    .menu-item-price { font-size: 16px; font-weight: 800; color: #22d3ee; white-space: nowrap; padding-top: 2px; }
    .menu-empty { text-align: center; color: #475569; padding: 48px 0; font-size: 16px; }
    .menu-footer { text-align: center; color: #334155; font-size: 12px; padding: 24px; border-top: 1px solid #1e293b; }
    @media (max-width: 480px) {
      .menu-header h1 { font-size: 22px; }
      .menu-item { padding: 12px; }
      .menu-item-name { font-size: 14px; }
      .menu-item-price { font-size: 15px; }
    }
  </style>
</head>
<body>
  <header class="menu-header">
    <div class="menu-logo">🛒</div>
    <h1>${companyName}</h1>
    ${description ? `<p>${description}</p>` : ""}
    ${waLink ? `<a class="menu-wa-btn" href="${escapeHtml(waLink)}" target="_blank" rel="noopener"><span class="menu-wa-icon">💬</span> Hacer un pedido por WhatsApp</a>` : ""}
  </header>
  <main class="menu-body">
    ${categoryHtml}
    ${emptyHtml}
  </main>
  <footer class="menu-footer">Powered by BabySteps Bots</footer>
</body>
</html>`;

    res.type("text/html").send(html);
  } catch (e) {
    res.status(500).send("Error al cargar el menú");
  }
});

router.get("/panel/logout", (req, res) => {
  clearCookie(res, "client");
  res.redirect("/panel/login");
});
export default router;
