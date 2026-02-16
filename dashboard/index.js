import express from "express";
import dotenv from "dotenv";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

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
app.get("/c/suscripcion", (req, res) => res.redirect("/panel/suscripcion"));
app.get("/c/cuenta", (req, res) => res.redirect("/panel/cuenta"));

const DASH_USER = (process.env.DASH_USER || "").trim();
const DASH_PASS = (process.env.DASH_PASS || "").trim();
const DASH_COOKIE_SECRET = (process.env.DASH_COOKIE_SECRET || "").trim();

const API_BASE_URL = (process.env.API_BASE_URL || "").trim();
const API_TOKEN = (process.env.API_TOKEN || "").trim();
const BOT_CATALOG_PROVIDER_ID = (process.env.BOT_CATALOG_PROVIDER_ID || "babystepsbots").trim().toLowerCase();

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

function layout({ title, active, body }) {
  const nav = `
    <a class="btn ${active === "companies" ? "primary" : "secondary"}" href="/admin">Empresas</a>
    <a class="btn ${active === "orders" ? "primary" : "secondary"}" href="/admin/orders">Pedidos</a>
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
            <button type="button" class="icon-btn" id="togglePass" aria-label="Ver contrasena">eye</button>
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
        btn.addEventListener("click", () => {
          pass.type = pass.type === "password" ? "text" : "password";
        });
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
    const companies = await api("/api/companies");

    const rows = companies.map((c) => {
      const rules = parseJsonSafe(c.rulesJson || "{}", {});
      const plan = extractPlanInfo(c, rules);
      const profile = extractCompanyProfile(rules);
      return `
      <div class="company-item">
        <div>
          <div><b>${c.id}</b> - ${c.name || ""}</div>
          <div class="muted">Creada: ${c.createdAt || "-"}</div>
          <div class="muted">Dueno: ${escapeHtml(profile.ownerName || "-")} | Email: ${escapeHtml(profile.ownerEmail || "-")}</div>
          <div class="muted">Bot: ${escapeHtml(plan.botClass)} | Plan: ${escapeHtml(plan.fullLabel)}</div>
        </div>
        <a class="btn secondary" href="/admin/company/${encodeURIComponent(c.id)}">Editar</a>
      </div>
    `;
    }).join("");

    res.type("text/html").send(`
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <link rel="stylesheet" href="/dashboard.css" />
    <title>BabySteps - Admin</title>
  </head>
  <body>
    <div class="container">

      <div class="admin-header">
        <div class="brand">
          <img src="/img/logo.png" alt="BabySteps" />
          <div>
            <div class="title">BabySteps</div>
            <div class="subtitle">Admin Console</div>
          </div>
        </div>

        <div class="nav-tabs">
          <a class="btn primary" href="/admin">Empresas</a>
          <a class="btn secondary" href="/admin/company/new">Nueva empresa</a>
          <a class="btn secondary" href="/admin/assign">Asignar clientes</a>
          <a class="btn secondary" href="/admin/logout">Logout</a>
        </div>
      </div>

      <div class="kpis">
        <div class="kpi">
          <div class="label">Empresas</div>
          <div class="value">${companies.length}</div>
          <div class="hint">Total activas</div>
        </div>
        <div class="kpi">
          <div class="label">Pedidos hoy</div>
          <div class="value">-</div>
          <div class="hint">Luego conectamos</div>
        </div>
        <div class="kpi">
          <div class="label">Clientes</div>
          <div class="value">-</div>
          <div class="hint">Luego conectamos</div>
        </div>
        <div class="kpi">
          <div class="label">Bots online</div>
          <div class="value">-</div>
          <div class="hint">Luego conectamos</div>
        </div>
      </div>

      <div class="card">
        <h3 style="margin:0 0 12px;">Listado</h3>
        <div class="company-list">${rows || `<div class="muted">Aun no hay empresas.</div>`}</div>
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
    rules.clientPassword = providedPassword || rules.clientPassword || generateClientPassword();

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

    res.redirect(`/admin/company/${encodeURIComponent(id)}?created=1`);
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
    if (!String(rules.botClass || "").trim()) {
      rules.botClass = defaultBotClassFromMode(channelMode);
    }

    const manualPassword = String(req.body.clientPassword || "").trim();
    if (manualPassword) {
      rules.clientPassword = manualPassword;
    }

    await api(`/api/companies/${encodeURIComponent(id)}/save`, {
      method: "POST",
      body: {
        name: String(req.body.name || company.name || id).trim() || id,
        prompt: company.prompt || "",
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

    const catalogOptions = extractCatalogBotOptions(providerForPricing);
    const selectedCatalog = catalogOptions.find((item) => item.name.toLowerCase() === botClass.toLowerCase());
    if (selectedCatalog?.id) {
      rules.botCatalogId = selectedCatalog.id;
    }

    const syncPlan = String(req.body.syncPlan || "") === "1";
    if (syncPlan) {
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
    rules.clientPassword = nextPassword;

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
            <button type="button" class="icon-btn" aria-label="Ver contrasena" onclick="
              const i=document.getElementById('clientPass');
              i.type = (i.type==='password'?'text':'password');
            ">eye</button>
          </div>

          <div class="login-actions">
            <button class="btn primary">Entrar</button>
            <a class="btn secondary" href="/admin/login">Soy Admin</a>
          </div>
        </form>
      </div>
    </div>
  </body>
</html>`;
}

async function handleClientLogin(req, res) {
  try {
    const companyId = (req.body.companyId || "").trim();
    const pass = (req.body.pass || "").trim();
    if (!companyId || !pass) return res.status(400).send("Faltan datos");

    const company = await api(`/api/companies/${encodeURIComponent(companyId)}`);
    const rules = parseJsonSafe(company.rulesJson || "{}", {});
    const expected = String(rules.clientPassword || company.clientPassword || "").trim();

    if (!expected) {
      return res.status(400).send("La empresa no tiene password de cliente configurada");
    }

    if (pass !== expected) {
      return res.status(401).send("Credenciales incorrectas");
    }

    setCookie(res, "client", `${companyId}.${signClient(companyId)}`);
    return res.redirect("/panel");
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
  if (raw.includes("basic") || raw.includes("basico") || raw.includes("sin ai")) return "BASICO";
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

  const rawTier =
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

function extractClientState(company, options = {}) {
  const rulesRaw = parseJsonSafe(company?.rulesJson || "{}", {});
  const rules = rulesRaw && typeof rulesRaw === "object" ? rulesRaw : {};
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

function renderClientPage({ company, active, title, subtitle, bodyHtml }) {
  const nav = [
    { key: "inicio", label: "Resumen", href: "/panel" },
    { key: "catalogo", label: "Catalogo", href: "/panel/catalogo" },
    { key: "pedidos", label: "Pedidos", href: "/panel/pedidos" },
    { key: "suscripcion", label: "Suscripcion", href: "/panel/suscripcion" },
    { key: "cuenta", label: "Cuenta", href: "/panel/cuenta" },
  ];

  const navHtml = nav.map((item) => `
    <a class="cp-nav-link ${active === item.key ? "active" : ""}" href="${item.href}">
      ${item.label}
    </a>
  `).join("");

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
            <h1>${escapeHtml(title)}</h1>
            <p>${escapeHtml(subtitle || "")}</p>
          </header>
          ${bodyHtml}
        </main>
      </div>
    </body>
  </html>`;
}

app.get("/panel/login", (req, res) => {
  res.type("text/html").send(renderClientLoginPage());
});
app.get("/c/login", (req, res) => {
  res.type("text/html").send(renderClientLoginPage());
});

app.post("/panel/login", handleClientLogin);
app.post("/c/login", handleClientLogin);

app.get("/panel", requireClientAuth, async (req, res) => {
  const company = req.company;
  const { state } = await loadClientStateWithProvider(company);
  const toHtmlText = (value) => escapeHtml(value).replace(/\r?\n/g, "<br/>");
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
  const catalogRows = state.catalog.slice(0, 6).map((item) => `
    <tr>
      <td>${escapeHtml(item.id)}</td>
      <td>${escapeHtml(item.name)}</td>
      <td>${formatMoney(item.price, state.subscription.currency)}</td>
    </tr>
  `).join("");

  const stats = [
    { label: "Productos", value: state.catalog.length, hint: "items en catalogo" },
    { label: "Valor catalogo", value: formatMoney(state.totalCatalogValue, state.subscription.currency), hint: "suma precios" },
    { label: "Precio promedio", value: formatMoney(state.avgPrice, state.subscription.currency), hint: "ticket estimado" },
    { label: "Plan activo", value: escapeHtml(state.plan.planLabel), hint: escapeHtml(state.plan.channelLabel) },
  ];

  const statsHtml = stats.map((item) => `
    <article class="cp-stat">
      <div class="cp-stat-label">${item.label}</div>
      <div class="cp-stat-value">${item.value}</div>
      <div class="cp-stat-hint">${item.hint}</div>
    </article>
  `).join("");

  const bodyHtml = `
    <section class="cp-stats">${statsHtml}</section>

    <section class="cp-grid">
      <article class="cp-card cp-span-2">
        <div class="cp-card-head">
          <h3>Informacion de la empresa</h3>
          <span>Manual y proposito</span>
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
      </article>

      <article class="cp-card">
        <h3>Suscripcion</h3>
        <div class="cp-kv"><span>Plan</span><b>${escapeHtml(state.plan.planLabel)}</b></div>
        <div class="cp-kv"><span>Canal</span><b>${escapeHtml(state.plan.channelLabel)}</b></div>
        <div class="cp-kv"><span>Estado</span><b>${escapeHtml(state.subscription.status)}</b></div>
        <div class="cp-kv"><span>Monto</span><b>${formatMoney(state.subscription.amount, state.subscription.currency)}</b></div>
        <div class="cp-kv"><span>Renueva</span><b>${escapeHtml(formatDateLabel(state.subscription.renewalAt))}</b></div>
      </article>

      <article class="cp-card cp-span-2">
        <div class="cp-card-head">
          <h3>Catalogo reciente</h3>
          <a href="/panel/catalogo">Ver completo</a>
        </div>
        <table class="cp-table">
          <thead><tr><th>ID</th><th>Producto</th><th>Precio</th></tr></thead>
          <tbody>${catalogRows || `<tr><td colspan="3">Sin productos cargados.</td></tr>`}</tbody>
        </table>
      </article>

      <article class="cp-card">
        <h3>Configuracion bot</h3>
        <div class="cp-kv"><span>Empresa</span><b>${escapeHtml(company.id)}</b></div>
        <div class="cp-kv"><span>Clase bot</span><b>${escapeHtml(state.plan.botClass)}</b></div>
        <div class="cp-kv"><span>Derivacion humana</span><b>${state.rules.allowHuman ? "Activa" : "Inactiva"}</b></div>
        <div class="cp-kv"><span>Tono</span><b>${escapeHtml(state.rules.tone || "No definido")}</b></div>
        <div class="cp-kv"><span>Ultima fecha</span><b>${escapeHtml(formatDateLabel(company.updatedAt || company.createdAt))}</b></div>
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

app.get("/panel/catalogo", requireClientAuth, async (req, res) => {
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

app.post("/panel/catalogo/save", requireClientAuth, async (req, res) => {
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

app.get("/panel/pedidos", requireClientAuth, async (req, res) => {
  const company = req.company;
  let orders = [];
  let fetchError = "";

  try {
    const params = new URLSearchParams();
    params.set("q", String(company.id));
    params.set("limit", "100");
    const data = await api(`/api/orders?${params.toString()}`);
    const all = Array.isArray(data) ? data : [];
    orders = all.filter((o) => String(o.companyId || "") === String(company.id));
  } catch (e) {
    fetchError = e?.message || String(e);
  }

  const paidCount = orders.filter((o) => String(o.paymentStatus || "").toLowerCase() === "paid").length;
  const deliveredCount = orders.filter((o) => String(o.orderStatus || "").toLowerCase() === "delivered").length;
  const totalRevenue = orders.reduce((acc, o) => acc + toNumber(o.total), 0);

  const rows = orders.map((o) => `
    <tr>
      <td>${escapeHtml(o.id || "-")}</td>
      <td>${escapeHtml(formatDateLabel(o.createdAt))}</td>
      <td>${escapeHtml(o.name || o.contact || "-")}</td>
      <td>${formatMoney(toNumber(o.total), "USD")}</td>
      <td>${escapeHtml(o.paymentStatus || "-")}</td>
      <td>${escapeHtml(o.orderStatus || "-")}</td>
    </tr>
  `).join("");

  const bodyHtml = `
    <section class="cp-stats">
      <article class="cp-stat"><div class="cp-stat-label">Pedidos</div><div class="cp-stat-value">${orders.length}</div><div class="cp-stat-hint">ultimos 100</div></article>
      <article class="cp-stat"><div class="cp-stat-label">Pagados</div><div class="cp-stat-value">${paidCount}</div><div class="cp-stat-hint">paymentStatus=paid</div></article>
      <article class="cp-stat"><div class="cp-stat-label">Entregados</div><div class="cp-stat-value">${deliveredCount}</div><div class="cp-stat-hint">orderStatus=delivered</div></article>
      <article class="cp-stat"><div class="cp-stat-label">Facturacion</div><div class="cp-stat-value">${formatMoney(totalRevenue, "USD")}</div><div class="cp-stat-hint">estimada</div></article>
    </section>

    <section class="cp-grid">
      <article class="cp-card cp-span-3">
        <div class="cp-card-head"><h3>Listado de pedidos</h3><span>${orders.length} resultados</span></div>
        ${fetchError ? `<div class="cp-empty">No se pudo cargar /api/orders: ${escapeHtml(fetchError)}</div>` : ""}
        <table class="cp-table">
          <thead><tr><th>ID</th><th>Fecha</th><th>Cliente</th><th>Total</th><th>Pago</th><th>Estado</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="6">Sin pedidos para esta empresa.</td></tr>`}</tbody>
        </table>
      </article>
    </section>
  `;

  res.type("text/html").send(renderClientPage({
    company,
    active: "pedidos",
    title: "Pedidos",
    subtitle: `${company.name || company.id} - seguimiento operativo`,
    bodyHtml,
  }));
});

app.get("/panel/suscripcion", requireClientAuth, async (req, res) => {
  const company = req.company;
  const { state } = await loadClientStateWithProvider(company);

  const bodyHtml = `
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

app.get("/panel/cuenta", requireClientAuth, async (req, res) => {
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

app.post("/panel/cuenta/save", requireClientAuth, async (req, res) => {
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
    rules.clientPassword = newPassword;
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

