import express from "express";
import twilio from "twilio";
import dotenv from "dotenv";
import OpenAI from "openai";
import { db } from "./db.js";
import fetch from "node-fetch";
import crypto from "crypto";

dotenv.config();

console.log("BOOT VERSION:", "2026-02-03-INDEX-DASH-V1");
console.log("BOOT FILE:", import.meta.url);
console.log("PWD:", process.cwd());

const app = express();
app.use(express.urlencoded({ extended: false }));

// ================= TELEGRAM (UNICO, ARRIBA) =================
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const TELEGRAM_CHAT_ID = (process.env.TELEGRAM_CHAT_ID || "").trim();

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("Telegram not configured (missing TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID)");
    return false;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);

    const r = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true,
      }),
    });

    clearTimeout(t);

    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.ok === false) {
      console.error("Telegram API error:", r.status, data);
      return false;
    }

    return true;
  } catch (e) {
    console.error("Telegram notify failed:", e?.message || e);
    return false;
  }
}

// ================= MIGRATIONS =================
db.exec(`
CREATE TABLE IF NOT EXISTS customer_company (
  fromNumber TEXT PRIMARY KEY,
  companyId TEXT NOT NULL,
  updatedAt TEXT
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token TEXT PRIMARY KEY,
  createdAt TEXT
);

CREATE TABLE IF NOT EXISTS ai_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fromNumber TEXT,
  role TEXT,
  content TEXT,
  createdAt TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT,
  prompt TEXT,
  catalogJson TEXT,
  rulesJson TEXT,
  createdAt TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  fromNumber TEXT PRIMARY KEY,
  state TEXT,
  cartJson TEXT,
  dataJson TEXT,
  lastOrderId TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  createdAt TEXT,
  fromNumber TEXT,
  companyId TEXT,
  name TEXT,
  contact TEXT,
  notes TEXT,
  itemsJson TEXT,
  itemsDetailedJson TEXT,
  total REAL,
  paymentStatus TEXT,
  paymentMethod TEXT,
  orderStatus TEXT,
  deliveredAt TEXT
);
`);

// ================= DEFAULT COMPANIES =================
db.exec(`
INSERT OR IGNORE INTO companies VALUES
(
  'babystepsbots',
  'Babystepsbots',
  'Sos el asistente comercial de Babystepsbots. Español Argentina, claro, directo, vendedor.',
  '[{"id":1,"name":"Bot WhatsApp","price":120},{"id":2,"name":"Bot Instagram","price":100},{"id":3,"name":"Bot Unificado","price":200}]',
  '{"tone":"comercial","allowHuman":true}',
  CURRENT_TIMESTAMP
),
(
  'veterinaria_sm',
  'Veterinaria San Miguel',
  'Sos asistente de una veterinaria. Empático, calmado, priorizás urgencias.',
  '[{"id":1,"name":"Consulta","price":5000},{"id":2,"name":"Vacunación","price":8000}]',
  '{"tone":"empatico","emergencyKeywords":["urgente","accidente"],"allowHuman":true}',
  CURRENT_TIMESTAMP
);
`);

// ================= OPENAI =================
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const AI_GLOBAL = (process.env.AI_GLOBAL || "on").trim().toLowerCase();

// ================= ADMIN =================
const ADMIN_NUMBER = (process.env.ADMIN_NUMBER || "").trim();
const isAdmin = (from) => ADMIN_NUMBER && from === ADMIN_NUMBER;

// ================= DB HELPERS =================
const getSetting = (k) => db.prepare(`SELECT value FROM settings WHERE key=?`).get(k)?.value || "";
const setSetting = (k, v) =>
  db.prepare(`
    INSERT INTO settings(key,value) VALUES (?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(k, String(v ?? ""));

const getCompany = (id) => {
  const r = db.prepare(`SELECT * FROM companies WHERE id=?`).get(id);
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    prompt: r.prompt,
    catalog: JSON.parse(r.catalogJson || "[]"),
    rules: JSON.parse(r.rulesJson || "{}"),
  };
};

function getCompanySafe(session) {
  const fallback = getCompany("babystepsbots");
  const id = String(session?.data?.companyId || "babystepsbots").toLowerCase();
  return getCompany(id) || fallback;
}

// ================= SESSION =================
function getSession(from) {
  const r = db.prepare(`SELECT * FROM sessions WHERE fromNumber=?`).get(from);

  const base = {
    companyId: "babystepsbots",
    aiMode: "off",
    aiCount: 0,
    aiCountDate: "",
    lastAiAt: 0,
    humanNotified: false,
  };

  if (!r) return { fromNumber: from, state: "MENU", cart: [], data: base, lastOrderId: null };

  return {
    fromNumber: from,
    state: r.state || "MENU",
    cart: JSON.parse(r.cartJson || "[]"),
    data: { ...base, ...(JSON.parse(r.dataJson || "{}") || {}) },
    lastOrderId: r.lastOrderId || null,
  };
}

function saveSession(s) {
  db.prepare(`
    INSERT INTO sessions(fromNumber,state,cartJson,dataJson,lastOrderId)
    VALUES (?,?,?,?,?)
    ON CONFLICT(fromNumber) DO UPDATE SET
      state=excluded.state,
      cartJson=excluded.cartJson,
      dataJson=excluded.dataJson,
      lastOrderId=excluded.lastOrderId
  `).run(
    s.fromNumber,
    s.state,
    JSON.stringify(s.cart || []),
    JSON.stringify(s.data || {}),
    s.lastOrderId || null
  );
}

// ================= TEXT HELPERS =================
const menuText = (c) => `👋 Hola! Soy el asistente de ${c.name}
• catalogo
• carrito
• checkout
• humano`;

const catalogText = (c) =>
  `🛒 ${c.name}\n` +
  (c.catalog || []).map((p) => `${p.id}) ${p.name} — $${p.price}`).join("\n");

const cartText = (s) => {
  const c = getCompanySafe(s);
  if (!s.cart.length) return "🧺 Carrito vacío.";
  let total = 0;
  const out = {};
  s.cart.forEach((id) => (out[id] = (out[id] || 0) + 1));
  const lines = Object.entries(out).map(([id, q]) => {
    const p = (c.catalog || []).find((x) => Number(x.id) === Number(id));
    const unit = Number(p?.price || 0);
    const sub = unit * q;
    total += sub;
    return `• ${p?.name || "Producto"} x${q} — $${sub}`;
  });
  return `🧾 ${c.name}\n${lines.join("\n")}\nTotal: $${total}`;
};

// ================= AI =================
async function aiReply(session, from, text) {
  if (!openai || AI_GLOBAL === "off") return "IA no disponible.";
  if (!["lite", "pro"].includes(String(session.data.aiMode || "").toLowerCase())) return null;

  const today = new Date().toISOString().slice(0, 10);
  if (session.data.aiCountDate !== today) {
    session.data.aiCountDate = today;
    session.data.aiCount = 0;
  }

  const limit = String(session.data.aiMode).toLowerCase() === "pro" ? 120 : 40;
  if (Number(session.data.aiCount || 0) >= limit) return "⚠️ Límite diario de IA alcanzado. Escribí humano.";

  const c = getCompanySafe(session);
  const prompt = `
${c.prompt || ""}

CATÁLOGO:
${(c.catalog || []).map((p) => `${p.id}) ${p.name}: $${p.price}`).join("\n")}

Reglas:
- Tono: ${(c.rules || {}).tone || "neutral"}
- No inventar datos
- Siempre cerrar con pregunta
`;

  const resp = await openai.responses.create({
    model: "gpt-4o-mini",
    input: [{ role: "user", content: text }],
    instructions: prompt,
  });

  session.data.aiCount = Number(session.data.aiCount || 0) + 1;
  saveSession(session);

  return (resp.output_text || "").trim();
}

// ================= UTILIDADES =================
const newOrderId = () => "PED-" + Math.random().toString(36).slice(2, 8).toUpperCase();

const isReserved = (t) =>
  [
    "menu","hola","catalogo","carrito","checkout",
    "pago","pagar","pagado","confirmar","cancelar","ayuda",
    "humano","asesor","hablar con humano"
  ].includes(t);

const isHumanTrigger = (t) => ["humano","asesor","hablar con humano"].includes(t);

// ================= DASHBOARD (ADMIN WEB) =================
const DASH_USER = (process.env.DASH_USER || "").trim();
const DASH_PASS = (process.env.DASH_PASS || "").trim();
const DASH_COOKIE_SECRET = (process.env.DASH_COOKIE_SECRET || "").trim();

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
    return res.status(500).send("Dashboard no configurado. Seteá DASH_USER, DASH_PASS y DASH_COOKIE_SECRET.");
  }
  const cookies = parseCookies(req);
  const cookie = cookies["dash"];
  if (!cookie) return res.redirect("/admin/login");

  const [token, sig] = cookie.split(".");
  if (!token || !sig) return res.redirect("/admin/login");
  if (signToken(token) !== sig) return res.redirect("/admin/login");

  const row = db.prepare(`SELECT token FROM admin_sessions WHERE token=?`).get(token);
  if (!row) return res.redirect("/admin/login");
  next();
}
function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function prettyJson(s) {
  try { return JSON.stringify(JSON.parse(s || "{}"), null, 2); } catch { return String(s || ""); }
}
function layout(title, body) {
  return `<!doctype html>
<html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root{
    --bg:#0b1220;
    --panel:#0f1a30;
    --panel2:#0c162a;
    --border:#203255;
    --text:#e8eefc;
    --muted:#a8b3cc;
    --brand:#2d6cdf;     /* azul principal */
    --brand2:#1f57c6;
    --danger:#ef4444;
    --ok:#22c55e;
    --shadow: 0 12px 30px rgba(0,0,0,.35);
  }

  *{box-sizing:border-box}
  body{
    margin:20px;
    background: radial-gradient(1200px 600px at 20% 0%, rgba(45,108,223,.16), transparent 60%),
                radial-gradient(900px 500px at 90% 20%, rgba(45,108,223,.10), transparent 55%),
                var(--bg);
    color:var(--text);
    font-family: Inter, system-ui, Segoe UI, Arial;
    line-height:1.35;
  }

  a{color:#9fc2ff;text-decoration:none}
  a:hover{text-decoration:underline}

  .top{
    display:flex;gap:12px;align-items:center;justify-content:space-between;
    margin-bottom:16px;
  }

  .card{
    background: linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,.01));
    border:1px solid var(--border);
    border-radius:16px;
    padding:16px;
    margin:14px 0;
    box-shadow: var(--shadow);
  }

  input,textarea,select{
    width:100%;
    padding:10px 12px;
    border-radius:12px;
    border:1px solid rgba(255,255,255,.10);
    background: rgba(5,10,20,.55);
    color:var(--text);
    outline:none;
  }
  input:focus,textarea:focus,select:focus{
    border-color: rgba(45,108,223,.65);
    box-shadow: 0 0 0 4px rgba(45,108,223,.18);
  }

  textarea{
    min-height:170px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono","Courier New", monospace;
    resize:vertical;
  }

  button{
    padding:10px 14px;
    border-radius:12px;
    border:1px solid rgba(255,255,255,.10);
    background: linear-gradient(180deg, var(--brand), var(--brand2));
    color:white;
    cursor:pointer;
    font-weight:600;
    transition: transform .05s ease, filter .15s ease;
  }
  button:hover{filter:brightness(1.05)}
  button:active{transform:translateY(1px)}
  button.secondary{
    background: rgba(255,255,255,.06);
    border:1px solid rgba(255,255,255,.12);
  }
  button.danger{
    background: linear-gradient(180deg, var(--danger), #c81e1e);
  }

  .row{
    display:grid;
    grid-template-columns:1fr 1fr;
    gap:12px;
  }
  @media (max-width: 900px){
    .row{grid-template-columns:1fr}
    .top{flex-direction:column;align-items:flex-start}
  }

  .muted{color:var(--muted);font-size:13px}
  code{
    background: rgba(255,255,255,.06);
    border:1px solid rgba(255,255,255,.12);
    padding:3px 8px;
    border-radius:999px;
    color:#dbe7ff;
  }

  table{width:100%;border-collapse:collapse}
  td,th{
    border-bottom:1px solid rgba(255,255,255,.10);
    padding:10px;
    text-align:left;
  }
  th{color:#dbe7ff;font-weight:700}

  .pill{
    display:inline-flex;
    align-items:center;
    gap:8px;
    padding:8px 12px;
    border-radius:999px;
    border:1px solid rgba(255,255,255,.12);
    background: rgba(255,255,255,.06);
    color:#dbe7ff;
    font-size:13px;
  }
  .pill:hover{filter:brightness(1.05);text-decoration:none}

  .top a{margin-left:10px}
</style>
</head>
<body>
  <div class="top">
    <div>
      <div style="font-size:20px;font-weight:700">${escapeHtml(title)}</div>
      <div class="muted">Dashboard de empresas (catálogo + manual + reglas)</div>
    </div>
    <div style="display:flex;gap:10px;align-items:center">
      <a class="pill" href="/admin/company/...">Editar</a></td>
      <a href="/admin/assign">Asignar clientes</a>
      <a href="/admin/logout" class="pill">Logout</a>
    </div>
  </div>
  ${body}
</body></html>`;
}

// Login
app.get("/admin/login", (req, res) => {
  const body = `
  <div class="card">
    <form method="POST" action="/admin/login">
      <div class="row">
        <div>
          <label class="muted">Usuario</label>
          <input name="user" autocomplete="username"/>
        </div>
        <div>
          <label class="muted">Contraseña</label>
          <input name="pass" type="password" autocomplete="current-password"/>
        </div>
      </div>
      <div style="margin-top:12px"><button>Entrar</button></div>
    </form>
  </div>`;
  res.type("text/html").send(layout("Login", body));
});

app.post("/admin/login", (req, res) => {
  const user = (req.body.user || "").trim();
  const pass = (req.body.pass || "").trim();
  if (user !== DASH_USER || pass !== DASH_PASS) {
    return res.status(401).type("text/html").send(layout("Login", `<div class="card">❌ Credenciales incorrectas</div>`));
  }
  const token = crypto.randomBytes(24).toString("hex");
  db.prepare(`INSERT OR REPLACE INTO admin_sessions(token, createdAt) VALUES(?,?)`).run(token, new Date().toISOString());
  setCookie(res, "dash", `${token}.${signToken(token)}`);
  res.redirect("/admin");
});

app.get("/admin/logout", (req, res) => {
  const cookies = parseCookies(req);
  const cookie = cookies["dash"];
  if (cookie) {
    const [token] = cookie.split(".");
    if (token) db.prepare(`DELETE FROM admin_sessions WHERE token=?`).run(token);
  }
  clearCookie(res, "dash");
  res.redirect("/admin/login");
});

// List companies
app.get("/admin", requireDashboardAuth, (req, res) => {
  const rows = db.prepare(`SELECT id,name,createdAt FROM companies ORDER BY id`).all();
  const list = rows.length
    ? `<div class="card">
        <table>
          <thead><tr><th>ID</th><th>Nombre</th><th>Acción</th></tr></thead>
          <tbody>
            ${rows.map(r => `
              <tr>
                <td><code>${escapeHtml(r.id)}</code></td>
                <td>${escapeHtml(r.name || "")}</td>
                <td><a href="/admin/company/${encodeURIComponent(r.id)}">Editar</a></td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>`
    : `<div class="card">No hay empresas.</div>`;

  const create = `
  <div class="card">
    <form method="POST" action="/admin/company/create">
      <div class="row">
        <div>
          <label class="muted">Company ID (ej: veterinaria_sm)</label>
          <input name="id" placeholder="empresa_id"/>
        </div>
        <div>
          <label class="muted">Nombre visible</label>
          <input name="name" placeholder="Nombre Empresa"/>
        </div>
      </div>
      <div style="margin-top:12px"><button>Crear empresa</button></div>
    </form>
  </div>`;

  res.type("text/html").send(layout("Empresas", create + list));
});

app.post("/admin/company/create", requireDashboardAuth, (req, res) => {
  const id = String(req.body.id || "").trim().toLowerCase();
  const name = String(req.body.name || "").trim();

  if (!id.match(/^[a-z0-9_-]{3,40}$/)) {
    return res.status(400).type("text/html").send(layout("Error", `<div class="card">ID inválido.</div>`));
  }

  db.prepare(`
    INSERT OR IGNORE INTO companies(id,name,prompt,catalogJson,rulesJson,createdAt)
    VALUES(?,?,?,?,?,?)
  `).run(
    id,
    name || id,
    "Sos el asistente de la empresa. Respondés acorde al manual de marca.",
    "[]",
    JSON.stringify({ tone: "neutral", allowHuman: true }),
    new Date().toISOString()
  );

  res.redirect(`/admin/company/${encodeURIComponent(id)}`);
});

app.get("/admin/company/:id", requireDashboardAuth, (req, res) => {
  const id = req.params.id;
  const row = db.prepare(`SELECT * FROM companies WHERE id=?`).get(id);
  if (!row) return res.status(404).type("text/html").send(layout("No existe", `<div class="card">Empresa no encontrada.</div>`));

  const body = `
  <div class="card">
    <div class="muted">ID: <code>${escapeHtml(row.id)}</code></div>
    <form method="POST" action="/admin/company/${encodeURIComponent(row.id)}/save">
      <div class="row">
        <div>
          <label class="muted">Nombre</label>
          <input name="name" value="${escapeHtml(row.name || "")}"/>
        </div>
        <div>
          <label class="muted">Tip</label>
          <input value="Editá catalogJson / rulesJson" disabled/>
        </div>
      </div>

      <div style="margin-top:12px">
        <label class="muted">Manual de marca / Prompt</label>
        <textarea name="prompt">${escapeHtml(row.prompt || "")}</textarea>
      </div>

      <div style="margin-top:12px" class="row">
        <div>
          <label class="muted">Catalog JSON (array)</label>
          <textarea name="catalogJson">${escapeHtml(prettyJson(row.catalogJson))}</textarea>
        </div>
        <div>
          <label class="muted">Rules JSON (objeto)</label>
          <textarea name="rulesJson">${escapeHtml(prettyJson(row.rulesJson))}</textarea>
        </div>
      </div>

      <div style="display:flex;gap:10px;margin-top:12px">
        <button>Guardar</button>
        <a href="/admin" class="pill">Volver</a>
      </div>
    </form>
  </div>

  <div class="card">
    <form method="POST" action="/admin/company/${encodeURIComponent(row.id)}/delete" onsubmit="return confirm('¿Borrar empresa?');">
      <button class="danger">Borrar empresa</button>
      <div class="muted" style="margin-top:8px">⚠️ Solo borra el registro de companies.</div>
    </form>
  </div>`;

  res.type("text/html").send(layout(`Editar empresa: ${row.name}`, body));
});

app.post("/admin/company/:id/save", requireDashboardAuth, (req, res) => {
  const id = req.params.id;
  const name = String(req.body.name || "").trim();
  const prompt = String(req.body.prompt || "");
  const catalogJson = String(req.body.catalogJson || "[]");
  const rulesJson = String(req.body.rulesJson || "{}");

  try {
    const c = JSON.parse(catalogJson);
    if (!Array.isArray(c)) throw new Error("catalogJson debe ser un array");
  } catch (e) {
    return res.status(400).type("text/html").send(layout("Error JSON", `<div class="card">❌ Catalog JSON inválido: ${escapeHtml(e.message)}</div>`));
  }

  try {
    const r = JSON.parse(rulesJson);
    if (r === null || Array.isArray(r) || typeof r !== "object") throw new Error("rulesJson debe ser un objeto");
  } catch (e) {
    return res.status(400).type("text/html").send(layout("Error JSON", `<div class="card">❌ Rules JSON inválido: ${escapeHtml(e.message)}</div>`));
  }

  db.prepare(`UPDATE companies SET name=?, prompt=?, catalogJson=?, rulesJson=? WHERE id=?`).run(
    name || id, prompt, catalogJson, rulesJson, id
  );

  res.redirect(`/admin/company/${encodeURIComponent(id)}`);
});

app.post("/admin/company/:id/delete", requireDashboardAuth, (req, res) => {
  const id = req.params.id;
  db.prepare(`DELETE FROM companies WHERE id=?`).run(id);
  res.redirect("/admin");
});

app.get("/admin/assign", requireDashboardAuth, (req, res) => {
  const companies = db.prepare(`SELECT id,name FROM companies ORDER BY id`).all();
  const mappings = db.prepare(`
    SELECT fromNumber, companyId, updatedAt
    FROM customer_company
    ORDER BY datetime(updatedAt) DESC
    LIMIT 50
  `).all();

  const form = `
  <div class="card">
    <form method="POST" action="/admin/assign">
      <div class="row">
        <div>
          <label class="muted">Cliente (whatsapp:+54...)</label>
          <input name="fromNumber" placeholder="whatsapp:+549381..." />
        </div>
        <div>
          <label class="muted">Empresa</label>
          <select name="companyId">
            ${companies.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.id)} — ${escapeHtml(c.name || "")}</option>`).join("")}
          </select>
        </div>
      </div>
      <div style="margin-top:12px"><button>Asignar</button></div>
    </form>
  </div>`;

  const list = `
  <div class="card">
    <div class="muted" style="margin-bottom:8px">Últimas asignaciones</div>
    <table>
      <thead><tr><th>Cliente</th><th>Empresa</th><th>Acción</th></tr></thead>
      <tbody>
        ${mappings.map(m => `
          <tr>
            <td><code>${escapeHtml(m.fromNumber)}</code></td>
            <td><code>${escapeHtml(m.companyId)}</code></td>
            <td>
              <form method="POST" action="/admin/assign/delete" style="margin:0">
                <input type="hidden" name="fromNumber" value="${escapeHtml(m.fromNumber)}"/>
                <button class="secondary" type="submit">Quitar</button>
              </form>
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  </div>`;

  res.type("text/html").send(layout("Asignar empresa a cliente", form + list));
});

app.post("/admin/assign", requireDashboardAuth, (req, res) => {
  let fromNumber = String(req.body.fromNumber || "").trim();
  const companyId = String(req.body.companyId || "").trim();

  if (!fromNumber.startsWith("whatsapp:")) {
    if (fromNumber.startsWith("+")) fromNumber = `whatsapp:${fromNumber}`;
    else if (fromNumber.match(/^\d+$/)) fromNumber = `whatsapp:+${fromNumber}`;
  }

  const exists = db.prepare(`SELECT id FROM companies WHERE id=?`).get(companyId);
  if (!exists) return res.status(400).type("text/html").send(layout("Error", `<div class="card">Empresa no existe.</div>`));

  db.prepare(`
    INSERT INTO customer_company(fromNumber, companyId, updatedAt)
    VALUES(?,?,?)
    ON CONFLICT(fromNumber) DO UPDATE SET
      companyId=excluded.companyId,
      updatedAt=excluded.updatedAt
  `).run(fromNumber, companyId, new Date().toISOString());

  // también actualizo session si existe
  const s = db.prepare(`SELECT dataJson FROM sessions WHERE fromNumber=?`).get(fromNumber);
  if (s) {
    const data = JSON.parse(s.dataJson || "{}");
    data.companyId = companyId;
    db.prepare(`UPDATE sessions SET dataJson=? WHERE fromNumber=?`).run(JSON.stringify(data), fromNumber);
  }

  res.redirect("/admin/assign");
});

app.post("/admin/assign/delete", requireDashboardAuth, (req, res) => {
  const fromNumber = String(req.body.fromNumber || "").trim();
  db.prepare(`DELETE FROM customer_company WHERE fromNumber=?`).run(fromNumber);
  res.redirect("/admin/assign");
});

// ================== FIN PARTE 1: PEGAR PARTE 2 DESDE AQUÍ ==================
// ================= WEBHOOK =================
app.post("/whatsapp", async (req, res) => {
  const from = req.body.From || "unknown";
  const body = (req.body.Body || "").trim();
  const text = body.toLowerCase();
  const cmd = body.replace(/\s+/g, " ").toLowerCase();

  // Guardar último cliente (para admin sin número)
  if (from && !cmd.startsWith("admin")) setSetting("last_customer", from);

  const session = getSession(from);

  // ✅ imponer empresa asignada por dashboard (customer_company)
  const map = db.prepare(`SELECT companyId FROM customer_company WHERE fromNumber=?`).get(from);
  if (map?.companyId) {
    session.data.companyId = map.companyId;
    saveSession(session);
  }

  let reply = "No entendí 😅. Escribí: menu / catalogo / ayuda";

  // ================= HUMANO =================
  if (isHumanTrigger(text)) {
    session.state = "HUMAN";
    session.data.humanNotified = true;
    saveSession(session);

    await sendTelegram(
      `🙋‍♂️ HUMANO SOLICITADO\n` +
      `Empresa: ${getCompanySafe(session).name}\n` +
      `Cliente: ${from}\n` +
      `Mensaje: ${body}`
    );

    return respond(
      res,
      "✅ Listo. Un asesor fue notificado y te va a responder en breve.\n\nMientras tanto podés escribir *menu* para volver al bot."
    );
  }

  // ===== SALIR DE HUMANO CON MENU / HOLA =====
  if (session.state === "HUMAN" && (text === "menu" || text === "hola")) {
    session.state = "MENU";
    session.data.humanNotified = false;
    saveSession(session);
    return respond(res, menuText(getCompanySafe(session)));
  }

  // ===== BLOQUEO HUMANO (solo si NO pidió menu/hola) =====
  if (session.state === "HUMAN" && !cmd.startsWith("admin")) {
    return respond(res, "⏳ Un asesor ya fue notificado. Escribí *menu* para volver.");
  }

  // ================= ADMIN =================
  if (cmd.startsWith("admin")) {
    if (!isAdmin(from)) return respond(res, "⛔ Comando restringido.");

    if (cmd === "admin whoami") return respond(res, `ADMIN OK: ${from}`);

    if (cmd === "admin company list") {
      const rows = db.prepare(`SELECT id,name FROM companies ORDER BY id`).all();
      return respond(
        res,
        rows.length ? "📋 Empresas:\n" + rows.map(r => `• ${r.id} — ${r.name}`).join("\n") : "No hay empresas."
      );
    }

    // admin company set <companyId> [whatsapp:+...]
    const companySet = cmd.match(/^admin company set ([a-z0-9_-]+)(?:\s+(.+))?$/i);
    if (companySet) {
      const companyId = companySet[1].toLowerCase();
      let target = (companySet[2] || "").trim();

      const row = db.prepare("SELECT id, name FROM companies WHERE id = ?").get(companyId);
      if (!row) return respond(res, `No existe la empresa '${companyId}'.`);

      if (!target) target = getSetting("last_customer");
      if (!target) return respond(res, "No tengo 'último cliente' todavía. Hacé que un cliente mande un mensaje primero.");

      if (!target.startsWith("whatsapp:")) {
        if (target.startsWith("+")) target = `whatsapp:${target}`;
        else if (target.match(/^\d+$/)) target = `whatsapp:+${target}`;
      }

      // ✅ guardar asignación persistente
      db.prepare(`
        INSERT INTO customer_company(fromNumber, companyId, updatedAt)
        VALUES(?,?,?)
        ON CONFLICT(fromNumber) DO UPDATE SET
          companyId=excluded.companyId,
          updatedAt=excluded.updatedAt
      `).run(target, companyId, new Date().toISOString());

      // opcional: también session
      const s2 = getSession(target);
      s2.data.companyId = companyId;
      saveSession(s2);

      return respond(res, `🏢 Empresa para ${target}: ${row.id} (${row.name}) ✅`);
    }

    // admin ai set off|lite|pro [numero]
    const mAi = cmd.match(/^admin ai set (off|lite|pro)(?:\s+(.+))?$/i);
    if (mAi) {
      let target = (mAi[2] || "").trim() || getSetting("last_customer");
      if (!target) return respond(res, "No hay cliente activo.");

      if (!target.startsWith("whatsapp:")) {
        if (target.startsWith("+")) target = `whatsapp:${target}`;
        else if (target.match(/^\d+$/)) target = `whatsapp:+${target}`;
      }

      const s2 = getSession(target);
      s2.data.aiMode = mAi[1].toLowerCase();
      saveSession(s2);
      return respond(res, `🤖 IA ${mAi[1].toUpperCase()} para ${target}`);
    }

    // admin ai status
    const mStatus = cmd.match(/^admin ai status(?:\s+(.+))?$/i);
    if (mStatus) {
      let target = (mStatus[1] || "").trim() || getSetting("last_customer");
      if (!target) return respond(res, "No hay cliente activo.");

      if (!target.startsWith("whatsapp:")) {
        if (target.startsWith("+")) target = `whatsapp:${target}`;
        else if (target.match(/^\d+$/)) target = `whatsapp:+${target}`;
      }

      const s2 = getSession(target);
      return respond(res, `🤖 IA: ${(s2.data.aiMode || "off").toUpperCase()}`);
    }

    return respond(res, "Admin OK");
  }

  // ================= MENU / CATALOGO / CARRITO / AGREGAR =================
  if (text === "menu" || text === "hola") {
    session.state = "MENU";
    session.data.humanNotified = false;
    saveSession(session);
    return respond(res, menuText(getCompanySafe(session)));
  }

  if (text === "catalogo") return respond(res, catalogText(getCompanySafe(session)));
  if (text === "carrito") return respond(res, cartText(session));

  const mAdd = text.match(/^agregar\s+(\d+)$/);
  if (mAdd) {
    const id = Number(mAdd[1]);
    const company = getCompanySafe(session);
    const p = (company.catalog || []).find((x) => Number(x.id) === id);
    if (!p) return respond(res, "Ese producto no existe. Escribí catalogo y elegí una opción válida.");
    session.cart.push(id);
    saveSession(session);
    return respond(res, `✅ Agregado ${p.name}\n\n${cartText(session)}\n\nPara finalizar: checkout`);
  }

  // ================= IA =================
  if (["lite","pro"].includes(String(session.data.aiMode || "").toLowerCase()) && session.state === "MENU" && !isReserved(text)) {
    const ai = await aiReply(session, from, body);
    if (ai) return respond(res, ai);
  }

  // ================= CHECKOUT =================
  if (text === "checkout") {
    if (!session.cart.length) return respond(res, "Carrito vacío.");
    session.state = "ASK_NAME";
    saveSession(session);
    return respond(res, "¿A nombre de quién va el pedido?");
  }

  if (session.state === "ASK_NAME" && !isReserved(text)) {
    session.data.name = body;
    session.state = "ASK_CONTACT";
    saveSession(session);
    return respond(res, "Pasame un contacto.");
  }

  if (session.state === "ASK_CONTACT" && !isReserved(text)) {
    session.data.contact = body;
    session.state = "READY";
    saveSession(session);
    return respond(res, `Resumen:\n${cartText(session)}\nConfirmar: confirmar`);
  }

  // ================= CONFIRMAR =================
  if (text === "confirmar" && session.state === "READY") {
    const company = getCompanySafe(session);
    const items = [...session.cart];

    let total = 0;
    const detailed = {};
    items.forEach((id) => (detailed[id] = (detailed[id] || 0) + 1));

    const itemsDetailed = Object.entries(detailed).map(([id, q]) => {
      const p = (company.catalog || []).find((x) => Number(x.id) === Number(id));
      const unit = Number(p?.price || 0);
      const sub = unit * q;
      total += sub;
      return { id: Number(id), name: p?.name || "Producto", qty: q, unit, subtotal: sub };
    });

    const orderId = newOrderId();
    db.prepare(`INSERT INTO orders VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      orderId,
      new Date().toISOString(),
      from,
      company.id,
      session.data.name || "",
      session.data.contact || "",
      "",
      JSON.stringify(items),
      JSON.stringify(itemsDetailed),
      total,
      "pending",
      "",
      "confirmed",
      null
    );

    session.cart = [];
    session.state = "MENU";
    session.lastOrderId = orderId;
    saveSession(session);

    return respond(res, `🎉 Pedido ${orderId} confirmado.\nTotal: $${total}`);
  }

  // ================= DEFAULT =================
  saveSession(session);
  return respond(res, reply);
});

// ================= RESPUESTA =================
function respond(res, text) {
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(text);
  res.type("text/xml").send(twiml.toString());
}

// ================= HEALTH =================
app.get("/", (_, res) => res.send("OK"));
app.get("/health", (_, res) => res.json({ ok: true }));

app.listen(process.env.PORT || 3000, () => console.log("🚀 Bot corriendo"));
