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
app.get("/admin", requireDashboardAuth, async (req, res) => {
  const companies = await api("/api/companies");

  const companiesCount = companies.length;

  // KPIs simples (por ahora)
  const kpiHtml = `
    <div class="kpis">
      <div class="kpi">
        <div class="label">Empresas</div>
        <div class="value">${companiesCount}</div>
        <div class="hint">Creadas en el sistema</div>
      </div>
      <div class="kpi">
        <div class="label">Pedidos hoy</div>
        <div class="value">—</div>
        <div class="hint">Próximo: /api/stats</div>
      </div>
      <div class="kpi">
        <div class="label">Clientes</div>
        <div class="value">—</div>
        <div class="hint">Próximo: /api/customers</div>
      </div>
      <div class="kpi">
        <div class="label">Bots online</div>
        <div class="value">1</div>
        <div class="hint">Backend activo</div>
      </div>
    </div>
  `;

  const listOrEmpty = companiesCount
    ? `
      <table class="table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Nombre</th>
            <th style="width:140px">Acción</th>
          </tr>
        </thead>
        <tbody>
          ${companies.map(c => `
            <tr>
              <td><code>${c.id}</code></td>
              <td>${c.name || ""}</td>
              <td><a class="btn secondary" href="/admin/company/${encodeURIComponent(c.id)}">Editar</a></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `
    : `
      <div class="empty">
        <img src="/img/mascot.png" alt="Mascota" />
        <div>
          <b>Aún no hay empresas creadas</b>
          <div class="muted">Creá tu primera empresa y empezá a vender con BabySteps.</div>
        </div>
      </div>
    `;

  res.type("text/html").send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <link rel="stylesheet" href="/dashboard.css" />
    <title>BabySteps Dashboard</title>
  </head>
  <body class="dark">
    <div class="container">

      <div class="app-header">
        <div class="brand">
          <img src="/img/logo.png" alt="BabySteps" />
          <div>
            <div class="title">BabySteps</div>
            <div class="subtitle">Dashboard</div>
          </div>
        </div>

        <div class="nav">
          <a href="/admin">Empresas</a>
          <a href="/admin/orders">Pedidos</a>
          <a href="/admin/clients">Clientes</a>
          <a class="btn secondary" href="/admin/logout">Logout</a>
        </div>
      </div>

      ${kpiHtml}

      <div class="grid">
        <div class="card">
          <h3 style="margin:0 0 10px">Crear empresa</h3>
          <form method="POST" action="/admin/company/create" class="form">
            <label>Company ID</label>
            <input name="id" placeholder="ej: veterinaria_sm" />

            <label>Nombre visible</label>
            <input name="name" placeholder="Nombre Empresa" />

            <div class="actions">
              <button class="btn primary">Crear</button>
            </div>
          </form>
        </div>

        <div class="card">
          <h3 style="margin:0 0 10px">Tips rápidos</h3>
          <div class="muted">
            • Usá IDs sin espacios (a-z, 0-9, guión o guión bajo).<br/>
            • Editá el prompt + catálogo por empresa.<br/>
            • Próximo: métricas y export CSV.
          </div>
        </div>
      </div>

      <div class="card">
        <h3 style="margin:0 0 10px">Empresas</h3>
        ${listOrEmpty}
      </div>

      <img class="mascot-corner" src="/img/mascot.png" alt="Mascota" />

    </div>
  </body>
</html>`);
});

// ================= EMPRESAS =================
app.get("/admin", requireDashboardAuth, async (req, res) => {
  try {
    const companies = await api("/api/companies");

    const rows = companies.map((c) => `
      <li class="company-item">
        <div>
          <b>${escapeHtml(c.id)}</b> — ${escapeHtml(c.name || "")}
        </div>
        <div>
          <a class="btn secondary" href="/admin/company/${encodeURIComponent(c.id)}">Editar</a>
        </div>
      </li>
    `).join("");

    const body = `
      <div class="card">
        <form method="POST" action="/admin/company/create" class="form">
          <label>Crear empresa</label>
          <div class="grid2">
            <input name="id" placeholder="company_id (ej: veterinaria_sm)" />
            <input name="name" placeholder="Nombre visible" />
          </div>
          <div class="actions">
            <button class="btn primary">Crear</button>
          </div>
        </form>
      </div>

      <div class="card">
        <h3 style="margin-top:0">Listado</h3>
        <ul class="company-list">${rows || "<li class='muted'>No hay empresas.</li>"}</ul>
      </div>
    `;

    res.type("text/html").send(layout({ title: "Empresas", active: "companies", body }));
  } catch (e) {
    res.status(500).type("text/html").send(layout({
      title: "Empresas",
      active: "companies",
      body: `<div class="card"><b>Error:</b><pre>${escapeHtml(e?.message || e)}</pre></div>`
    }));
  }
});

app.post("/admin/company/create", requireDashboardAuth, async (req, res) => {
  try {
    await api("/api/companies", {
      method: "POST",
      body: { id: req.body.id, name: req.body.name }
    });
    res.redirect("/admin");
  } catch (e) {
    res.status(500).type("text/html").send(layout({
      title: "Empresas",
      active: "companies",
      body: `<div class="card"><b>Error creando empresa:</b><pre>${escapeHtml(e?.message || e)}</pre></div>
             <div class="card"><a class="btn secondary" href="/admin">Volver</a></div>`
    }));
  }
});

// Edit company
app.get("/admin/company/:id", requireDashboardAuth, async (req, res) => {
  try {
    const c = await api(`/api/companies/${encodeURIComponent(req.params.id)}`);

    const body = `
      <div class="center-card large">
        <h2 style="margin-top:0">Editar ${escapeHtml(c.id)}</h2>
        <form method="POST" action="/admin/company/${encodeURIComponent(c.id)}/save" class="form">
          <label>Nombre</label>
          <input name="name" value="${escapeHtml(c.name || "")}" />

          <label>Prompt</label>
          <textarea name="prompt" rows="5">${escapeHtml(c.prompt || "")}</textarea>

          <label>Catalog JSON</label>
          <textarea name="catalogJson" rows="8">${escapeHtml(c.catalogJson || "[]")}</textarea>

          <label>Rules JSON</label>
          <textarea name="rulesJson" rows="8">${escapeHtml(c.rulesJson || "{}")}</textarea>

          <div class="actions">
            <button class="btn primary">Guardar</button>
            <a class="btn secondary" href="/admin">Volver</a>
          </div>
        </form>

        <form method="POST" action="/admin/company/${encodeURIComponent(c.id)}/delete" onsubmit="return confirm('¿Borrar empresa?');" style="margin-top:14px">
          <button class="btn danger">Borrar empresa</button>
        </form>
      </div>
    `;

    res.type("text/html").send(layout({ title: `Editar: ${c.id}`, active: "companies", body }));
  } catch (e) {
    res.status(500).type("text/html").send(layout({
      title: "Editar empresa",
      active: "companies",
      body: `<div class="card"><b>Error:</b><pre>${escapeHtml(e?.message || e)}</pre></div>`
    }));
  }
});

app.post("/admin/company/:id/save", requireDashboardAuth, async (req, res) => {
  try {
    await api(`/api/companies/${encodeURIComponent(req.params.id)}/save`, {
      method: "POST",
      body: {
        name: req.body.name,
        prompt: req.body.prompt,
        catalogJson: req.body.catalogJson,
        rulesJson: req.body.rulesJson,
      }
    });
    res.redirect(`/admin/company/${encodeURIComponent(req.params.id)}`);
  } catch (e) {
    res.status(500).type("text/html").send(layout({
      title: "Guardar empresa",
      active: "companies",
      body: `<div class="card"><b>Error:</b><pre>${escapeHtml(e?.message || e)}</pre></div>
             <div class="card"><a class="btn secondary" href="/admin">Volver</a></div>`
    }));
  }
});

app.post("/admin/company/:id/delete", requireDashboardAuth, async (req, res) => {
  try {
    await api(`/api/companies/${encodeURIComponent(req.params.id)}/delete`, { method: "POST" });
    res.redirect("/admin");
  } catch (e) {
    res.status(500).type("text/html").send(layout({
      title: "Borrar empresa",
      active: "companies",
      body: `<div class="card"><b>Error:</b><pre>${escapeHtml(e?.message || e)}</pre></div>
             <div class="card"><a class="btn secondary" href="/admin">Volver</a></div>`
    }));
  }
});

// ================= ASIGNAR CLIENTES =================
app.get("/admin/assign", requireDashboardAuth, async (req, res) => {
  try {
    const companies = await api("/api/companies");
    const mappings = await api("/api/assignments");

    const options = companies.map((c) =>
      `<option value="${escapeHtml(c.id)}">${escapeHtml(c.id)} — ${escapeHtml(c.name || "")}</option>`
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
        <h3 style="margin-top:0">Últimas asignaciones</h3>
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

// ================= PEDIDOS + ESTADÍSTICAS + BUSCADOR + CSV =================
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
              ${[10,25,50,100,200].map(n => `<option value="${n}" ${n===limit?"selected":""}>${n} últimos</option>`).join("")}
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
             <div class="card"><div class="muted">Esto suele pasar si el backend todavía no tiene <code>/api/orders</code>.</div></div>`
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

app.get("/", (_, res) => res.send("OK"));
app.listen(process.env.PORT || 3000, () => console.log("Dashboard running"));
