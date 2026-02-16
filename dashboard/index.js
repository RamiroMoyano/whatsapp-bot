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

const DASH_USER = (process.env.DASH_USER || "").trim();
const DASH_PASS = (process.env.DASH_PASS || "").trim();
const DASH_COOKIE_SECRET = (process.env.DASH_COOKIE_SECRET || "").trim();

const API_BASE_URL = (process.env.API_BASE_URL || "").trim();
const API_TOKEN = (process.env.API_TOKEN || "").trim();

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
      <div class="bs-bg" style="background-image:url('/img/robot.png')"></div>
      <div class="bs-vignette"></div>

      <div class="bs-card">
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

    const rows = companies.map(c => `
      <div class="company-item">
        <div>
          <div><b>${c.id}</b> - ${c.name || ""}</div>
          <div class="muted">Creada: ${c.createdAt || "-"}</div>
        </div>
        <a class="btn secondary" href="/admin/company/${encodeURIComponent(c.id)}">Editar</a>
      </div>
    `).join("");

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

// ===== ADMIN: Editar empresa =====
app.get("/admin/company/:id", requireDashboardAuth, async (req, res) => {
  const id = req.params.id;

  const c = await api(`/api/companies/${encodeURIComponent(id)}`);

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
        <div class="nav">
          <a href="/admin"><- Volver</a>
          <a href="/admin/logout">Logout</a>
        </div>
      </div>

      <div class="card">
        <form method="POST" action="/admin/company/${encodeURIComponent(c.id)}/save" class="form">
          <label>Nombre visible</label>
          <input name="name" value="${(c.name || "").replaceAll('"', "&quot;")}" />

          <label>Prompt</label>
          <textarea name="prompt" rows="6">${c.prompt || ""}</textarea>

          <label>Catalog JSON</label>
          <textarea name="catalogJson" rows="8">${c.catalogJson || "[]"}</textarea>

          <label>Rules JSON</label>
          <textarea name="rulesJson" rows="8">${c.rulesJson || "{}"}</textarea>

          <div class="actions">
            <button class="btn primary" type="submit">Guardar</button>
            <a class="btn secondary" href="/admin">Cancelar</a>
          </div>
        </form>
      </div>
    </div>
  </body>
</html>`);
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
      <div class="bs-bg" style="background-image:url('/img/robot.png')"></div>
      <div class="bs-vignette"></div>

      <div class="bs-card">
        <div class="admin-login-avatar">
          <img src="/img/admin-login-avatar.jpeg" alt="Admin avatar" onerror="this.style.display='none'" />
        </div>

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
    return res.redirect("/c");
  } catch {
    return res.status(401).send("Credenciales incorrectas");
  }
}

function renderClientPage({ company, active, title, bodyHtml }) {
  const nav = [
    { key: "inicio", label: "Inicio", href: "/panel" },
    { key: "catalogo", label: "Catalogo", href: "/panel/catalogo" },
    { key: "pedidos", label: "Pedidos", href: "/panel/pedidos" },
    { key: "suscripcion", label: "Suscripcion", href: "/panel/suscripcion" },
  ];

  const navHtml = nav.map((item) => `
    <a class="sb-link ${active === item.key ? "active" : ""}" href="${item.href}">
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
    <body class="dark">
      <div class="container">
        <header class="app-header">
          <div class="brand">
            <img src="/img/logo.png" alt="BabySteps" onerror="this.style.display='none'" />
            <div>
              <div class="title">${escapeHtml(company?.name || company?.id || "Panel")}</div>
              <div class="subtitle">Panel de cliente</div>
            </div>
          </div>
          <a class="btn secondary" href="/panel/logout">Salir</a>
        </header>

        <div class="client-layout">
          <aside class="sidebar">
            <div class="sb-title">${escapeHtml(company?.name || company?.id || "Cuenta")}</div>
            <div class="sb-sub">Menu</div>
            <nav class="sb-nav">${navHtml}</nav>
          </aside>

          <main class="main-area">
            ${bodyHtml}
          </main>
        </div>
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
  const catalogRaw = parseJsonSafe(company.catalogJson || "[]", []);
  const catalog = Array.isArray(catalogRaw) ? catalogRaw : [];
  const rulesRaw = parseJsonSafe(company.rulesJson || "{}", {});
  const rules = rulesRaw && typeof rulesRaw === "object" ? rulesRaw : {};

  const catalogRows = catalog.map((item) => `
    <tr>
      <td>${escapeHtml(item?.id ?? "")}</td>
      <td>${escapeHtml(item?.name ?? "")}</td>
      <td>${escapeHtml(item?.price ?? "")}</td>
    </tr>
  `).join("");

  const bodyHtml = `
    <div class="kpis">
      <div class="kpi"><div class="label">Empresa</div><div class="value">${escapeHtml(company.id)}</div><div class="hint">ID</div></div>
      <div class="kpi"><div class="label">Catalogo</div><div class="value">${catalog.length}</div><div class="hint">items</div></div>
      <div class="kpi"><div class="label">Humano</div><div class="value">${rules.allowHuman ? "Si" : "No"}</div><div class="hint">derivacion</div></div>
      <div class="kpi"><div class="label">Tono</div><div class="value">${escapeHtml(rules.tone || "-")}</div><div class="hint">regla</div></div>
    </div>

    <div class="grid">
      <div class="card">
        <h2 style="margin:0 0 10px;">Tu configuracion</h2>
        <div class="muted">Prompt</div>
        <p style="margin:10px 0 0;">${escapeHtml(company.prompt || "")}</p>
      </div>

      <div class="card">
        <h2 style="margin:0 0 10px;">Catalogo</h2>
        <table class="table">
          <thead>
            <tr><th>ID</th><th>Producto</th><th>Precio</th></tr>
          </thead>
          <tbody>
            ${catalogRows || `<tr><td colspan="3" class="muted">Sin productos.</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  `;

  res.type("text/html").send(renderClientPage({
    company,
    active: "inicio",
    title: `${company.name || company.id} - Inicio`,
    bodyHtml,
  }));
});

app.get("/panel/catalogo", requireClientAuth, async (req, res) => {
  const company = req.company;
  res.type("text/html").send(renderClientPage({
    company,
    active: "catalogo",
    title: `${company.name || company.id} - Catalogo`,
    bodyHtml: `<div class="card"><h2 style="margin:0 0 10px;">Catalogo</h2><div class="muted">Proximo paso: editar, agregar o quitar productos.</div></div>`,
  }));
});

app.get("/panel/pedidos", requireClientAuth, async (req, res) => {
  const company = req.company;
  res.type("text/html").send(renderClientPage({
    company,
    active: "pedidos",
    title: `${company.name || company.id} - Pedidos`,
    bodyHtml: `<div class="card"><h2 style="margin:0 0 10px;">Pedidos</h2><div class="muted">Proximo paso: ver completados, en espera y cancelados.</div></div>`,
  }));
});

app.get("/panel/suscripcion", requireClientAuth, async (req, res) => {
  const company = req.company;
  res.type("text/html").send(renderClientPage({
    company,
    active: "suscripcion",
    title: `${company.name || company.id} - Suscripcion`,
    bodyHtml: `<div class="card"><h2 style="margin:0 0 10px;">Suscripcion</h2><div class="muted">Proximo paso: plan, fechas y precio del proximo periodo.</div></div>`,
  }));
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

